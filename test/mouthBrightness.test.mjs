import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {artworkStats} from '../src/qa.mjs';

for (const skin of [245,80]) {
  for (const teeth of [false,true]) test(`mouth brightness agrees across languages: skin ${skin}, teeth ${teeth}`,()=>{
    const width=96,height=96;
    const face={width,height,data:new Uint8Array(width*height*4)};
    const mouth={width,height,data:new Uint8Array(width*height*4)};
    for(let i=0;i<face.data.length;i+=4)face.data.set([skin,skin,skin,255],i);
    // A fine line surrounded by same-skin and translucent white edge pixels.
    for(let x=38;x<58;x++) {
      mouth.data.set([30,20,15,255],(48*width+x)*4);
      mouth.data.set([skin,skin,skin,255],(49*width+x)*4);
      mouth.data.set([255,255,255,100],(47*width+x)*4);
      if(teeth)mouth.data.set([255,255,255,255],(48*width+x)*4);
    }
    const js=artworkStats(mouth,16,face);
    const py=spawnSync('python3',['-c',`import json,sys
sys.path.insert(0,'scripts')
from PIL import Image
from closed_mouth import closed_mouth_quality
skin=int(sys.argv[1]);teeth=sys.argv[2]=='true'
f=Image.new('RGBA',(96,96),(skin,skin,skin,255));m=Image.new('RGBA',(96,96))
for x in range(38,58):
 m.putpixel((x,48),(255,255,255,255) if teeth else (30,20,15,255))
 m.putpixel((x,49),(skin,skin,skin,255));m.putpixel((x,47),(255,255,255,100))
q=json.load(open('configs/default.json'))['quality']
print(json.dumps(closed_mouth_quality(m,f,q)['artwork']))`,String(skin),String(teeth)],{encoding:'utf8'});
    assert.equal(py.status,0,py.stderr);
    const result=JSON.parse(py.stdout);
    for(const key of ['brightPixelRatio','skinRingLuminance','skinRingPixels','brightPixels'])assert.equal(js[key],result[key],key);
    assert.equal(js.brightPixelRatio<=.2,!teeth);
  });
}
test('missing skin ring cannot pass brightness',()=>{
 const im={width:1,height:1,data:Uint8Array.from([255,255,255,255])};
 assert.equal(artworkStats(im,16,im).brightPixelRatio,null);
});
