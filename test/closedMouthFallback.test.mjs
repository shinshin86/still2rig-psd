import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {PROJECT_ROOT,STATE_ROOT} from '../src/utils.mjs';
import {inspectPsd} from '../src/psd.mjs';

const roots=[];
const run=(...args)=>spawnSync(process.execPath,['bin/still2rig-psd.mjs',...args],{cwd:PROJECT_ROOT,encoding:'utf8',maxBuffer:20*1024*1024});
function ok(...args){const r=run(...args);assert.equal(r.status,0,r.stderr+r.stdout);return JSON.parse(r.stdout);}
function python(...args){const r=spawnSync('python3',args,{cwd:PROJECT_ROOT,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}
function fixture(mode){
 fs.mkdirSync(STATE_ROOT,{recursive:true});const root=fs.mkdtempSync(path.join(STATE_ROOT,'test-mouth-base-'));roots.push(root);const layers=path.join(root,'layers');
 python('test/generate_fixture.py','--output',layers,'--without-expressions',...(mode==='missing'?['--missing-mouth']:mode==='open'?['--open-mouth']:[]));
 const id=`mouth-base-${process.pid}-${Date.now()}`,job=ok('prepare',path.join(layers,'face.png'),'--name',id),jobRoot=path.join(STATE_ROOT,'jobs',id);roots.push(jobRoot);
 const archive=path.join(root,'fixture.zip');python('test/make_result_bundle.py','--layers',layers,'--archive',archive,'--input-sha256',job.input.sha256,'--job',id);ok('import',id,archive);
 if(mode!=='missing')ok('finalize',id);
 return{root,layers,id,jobRoot,requests:path.join(jobRoot,'expression-requests')};
}
function drawResult(f,name,bad=false){
 python('-c',`import json,sys
from pathlib import Path
from PIL import Image,ImageDraw,ImageChops
root=Path(sys.argv[1]);name=sys.argv[2];bad=sys.argv[3]=='true';r=json.loads((root/'requests.json').read_text());v=r['variants'][name];s=v['scale'];left,top,_,_=v['cropBox']
source=Image.open(root/name/'input.png').convert('RGBA');underlay=Image.open(root/name/'underlay.png').convert('RGBA');mask=ImageChops.invert(Image.open(root/name/'mask.png').getchannel('A'))
if 'mouthPlacement' in v:cx,cy=v['mouthPlacement']['center']
else:
 layers=Path(r['layerDir']);p=layers/'mouth_close.png';p=p if p.is_file() else layers/'mouth.png';box=Image.open(p).getchannel('A').getbbox();cx,cy=(box[0]+box[2])/2,(box[1]+box[3])/2
im=Image.new('RGBA',source.size) if v.get('outputMode')=='transparent-overlay' else Image.composite(underlay,source,mask)
box=((cx-8-left)*s,(cy-6-top)*s,(cx+8-left)*s,(cy+6-top)*s);d=ImageDraw.Draw(im)
if bad:d.rectangle(box,fill=(80,30,25,255))
else:d.arc(box,10,170,fill=(80,30,25,255),width=2*s)
(root/'results').mkdir(exist_ok=True);im.save(root/'results'/(name+'.png'))`,f.requests,name,String(bad));
}
afterEach(()=>{while(roots.length)fs.rmSync(roots.pop(),{recursive:true,force:true});});

for(const mode of ['missing','open'])test(`${mode} mouth is generated first, then becomes the reference for all remaining mouths`,()=>{
 const f=fixture(mode),first=ok('expression-requests',f.id,'--only','all');
 assert.equal(first.stage,'closed-mouth');assert.equal(first.closedMouth.usable,false);assert.match(first.nextSteps.resume,/--only all/);
 const request=JSON.parse(fs.readFileSync(path.join(f.requests,'requests.json')));assert.deepEqual(Object.keys(request.variants),['mouth_close']);assert.ok(first.deferredExpressions.includes('mouth_open'));
 if(mode==='missing')assert.equal(request.variants.mouth_close.mouthPlacement.source,'face-and-eyes');
 drawResult(f,'mouth_close');const imported=ok('import-expressions',f.id,'--only','mouth_close');assert.equal(imported.variants.mouth_close.closedMouth.usable,true);
 const repaired=ok('repair',f.id,'--expressions',imported.outputDir);const layers=repaired.initialAssembly?path.join(f.jobRoot,'processed/layers'):path.join(f.jobRoot,'repairs',repaired.repairId,'after/processed/layers');
 assert.ok(fs.existsSync(path.join(layers,'mouth_close.png')));assert.ok(inspectPsd(path.join(f.jobRoot,'output',`${f.id}.psd`)).layers.some(l=>l.name==='mouth_close'));
 assert.equal(repaired.qa.mouthArtwork.checks.compactCloseMouth,true);assert.equal(repaired.qa.mouthArtwork.checks.closedMouthIsLineArtwork,true);
 const next=ok('expression-requests',f.id,'--only','all'),remaining=JSON.parse(fs.readFileSync(path.join(f.requests,'requests.json')));
 assert.equal(next.stage,'expressions');assert.equal(next.closedMouth.usable,true);assert.ok(remaining.variants.mouth_open);assert.ok(remaining.variants.mouth_laugh);assert.ok(remaining.variants.mouth_round);assert.ok(!remaining.variants.mouth_close);
});

test('valid closed mouth keeps the default request pair and only explicit redos request it',()=>{
 const f=fixture('valid'),request=ok('expression-requests',f.id);assert.equal(request.closedMouth.usable,true);assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.requests,'requests.json'))).variants),['eye_close','mouth_open']);
 ok('expression-requests',f.id,'--only','mouth_close');assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.requests,'requests.json'))).variants),['mouth_close']);
});

test('non-mouth drawings can be prepared without mouth ink and a closed-only repair has no resume step',()=>{
 const f=fixture('missing'),request=ok('expression-requests',f.id,'--only','eye_close,blush');
 assert.equal(request.stage,'expressions');assert.equal(request.closedMouth.usable,false);
 assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.requests,'requests.json'))).variants),['eye_close','blush']);
 const closed=ok('expression-requests',f.id,'--only','mouth_close');assert.equal(closed.stage,'closed-mouth');assert.equal(closed.nextSteps.resume,null);assert.deepEqual(closed.deferredExpressions,[]);
});

test('nearly empty mouth ink is rejected and a visible nose guides missing-mouth placement',()=>{
 const result=JSON.parse(python('-c',`import json,sys
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw
from closed_mouth import closed_mouth_quality,mouth_support
quality=json.load(open('configs/default.json'))['quality'];face=Image.new('RGBA',(96,96));ImageDraw.Draw(face).rectangle((10,10,85,85),fill='white')
mouth=Image.new('RGBA',face.size);mouth.putpixel((48,60),(30,20,20,255));nose=Image.new('RGBA',face.size);ImageDraw.Draw(nose).line((48,42,48,48),fill='black')
_,placement=mouth_support({'face':face,'nose':nose},quality)
print(json.dumps({'quality':closed_mouth_quality(mouth,face,quality),'placement':placement}))`));
 assert.equal(result.quality.usable,false);assert.equal(result.quality.checks.artworkPresent,false);
 assert.equal(result.placement.source,'face-and-nose');assert.equal(result.placement.center[0],48);assert.ok(result.placement.center[1]>49);
});

test('an open or filled generated base is rejected instead of being imported as closed ink',()=>{
 const f=fixture('open');ok('expression-requests',f.id);drawResult(f,'mouth_close',true);const result=run('import-expressions',f.id,'--only','mouth_close');assert.notEqual(result.status,0);assert.match(result.stderr,/closed mouth artwork check failed/);assert.ok(!fs.existsSync(path.join(f.jobRoot,'generated-expressions/mouth_close.png')));
});

test('mouth overlays use the mapped mouth.png reference before an override exists',()=>{
 const f=fixture('valid');assert.ok(!fs.existsSync(path.join(f.jobRoot,'processed/layers/mouth_close.png')));ok('expression-requests',f.id,'--only','mouth_frown');drawResult(f,'mouth_frown');const result=ok('import-expressions',f.id,'--only','mouth_frown','--read-only');assert.equal(result.variants.mouth_frown.status,'accepted');assert.ok(result.variants.mouth_frown.mouthRegistration);
});
