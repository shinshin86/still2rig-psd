"""Review-only peeled-image candidate. Does not import a bundle or build a PSD."""
from __future__ import annotations
import argparse,json
from pathlib import Path
from PIL import Image,ImageChops,ImageDraw
from expression_requests_common import file_hash
from import_expression_results import alignment_check,compensate_result
from split_common import dump,square_pad,square_unpad,mask,dilate,erode,classify
from split_layers import foreground_mask
from inspect_layers import make_contact_sheet


def max_difference(a,b):
    out=Image.new('L',a.size)
    for c in ImageChops.difference(a.convert('RGB'),b.convert('RGB')).split():out=ImageChops.lighter(out,c)
    return out


def binary_difference(a,b,threshold=24):
    # Candidate extraction, not a quality gate. Keep the unfiltered difference
    # and resulting masks for review before adopting a production method.
    raw=max_difference(a,b).point(lambda v:255 if v>threshold else 0)
    return erode(dilate(dilate(erode(raw,1),1),2),2)


def peeled_layers(source,p1,p2,foreground,hair0,hair1,p2foreground):
    front=ImageChops.multiply(binary_difference(source,p1),hair0)
    original_back=ImageChops.subtract(hair0,front)
    original_base=ImageChops.subtract(foreground,hair0)
    inferred_back=ImageChops.multiply(binary_difference(p1,p2),hair1)
    # Generated artwork may remain underneath a higher original owner. Original
    # visible pixels are assigned once, without adding a source-image backdrop.
    base=p2.copy();base.putalpha(ImageChops.multiply(p2foreground,foreground));base.paste(source,(0,0),original_base)
    back=p1.copy();back.putalpha(ImageChops.multiply(inferred_back,front));back.paste(source,(0,0),original_back)
    bangs=source.copy();bangs.putalpha(front)
    layers={'base':base,'back hair':back,'front hair':bangs}
    composite=Image.new('RGBA',source.size)
    for im in layers.values():composite.alpha_composite(im)
    expected=source.copy();expected.putalpha(foreground)
    expected=Image.alpha_composite(Image.new('RGBA',source.size),expected)
    delta=ImageChops.difference(composite,expected)
    check={'pass':not any(delta.getbbox() for delta in delta.split()),
           'foregroundPixels':sum(v>0 for v in foreground.tobytes()),
           'changedPixels':sum(any(p) for p in delta.getdata()),
           'maximumChannelDifference':max(hi for lo,hi in delta.getextrema()),
           'comparison':'RGBA against independent source foreground, on transparent black',
           'edgeTreatment':'Original opaque edge pixels retained; no exterior unmatting'}
    return layers,composite,check,{'front-difference':front,'original-back':original_back,'original-base':original_base,'p1-back-difference':inferred_back}


def main():
    p=argparse.ArgumentParser();p.add_argument('--job-root',type=Path,required=True)
    for name in ['p1','p2','request-dir','p1-check']:p.add_argument('--'+name,type=Path,required=True)
    p.add_argument('--ownership',type=Path);p.add_argument('--ownership-request',type=Path)
    p.add_argument('--p3',type=Path);p.add_argument('--p3-request',type=Path)
    p.add_argument('--face-parts',type=Path);p.add_argument('--face-parts-request',type=Path)
    p.add_argument('--refine-ownership',action='store_true')
    p.add_argument('--p1-fringe-face',action='store_true')
    p.add_argument('--face-source',choices=['generated','original'],default='generated')
    args=p.parse_args();job=json.loads((args.job_root/'job.json').read_text());source_file=Path(job['input']['file'])
    if file_hash(source_file)!=job['input']['sha256']:raise ValueError('Source hash changed.')
    if bool(args.ownership)!=bool(args.ownership_request):raise ValueError('Provide both ownership image and request metadata.')
    if bool(args.p3)!=bool(args.p3_request) or (args.p3 and not args.ownership):raise ValueError('P3 requires its request metadata and an ownership map.')
    if args.refine_ownership and not args.p3:raise ValueError('Ownership refinement requires P3.')
    if args.p1_fringe_face and not args.refine_ownership:raise ValueError('P1 fringe-face replacement requires refined ownership and explicit review of source changes.')
    if args.p1_fringe_face:raise ValueError('Use --face-source generated for a complete generated face, or original for strict source conservation.')
    if args.refine_ownership and args.face_source=='generated' and not args.face_parts:
        args.face_parts=args.job_root/'split/generated/face-parts/result.png';args.face_parts_request=args.job_root/'split/generated/face-parts/request.json'
    if bool(args.face_parts)!=bool(args.face_parts_request):raise ValueError('Face-parts needs both its image and request metadata.')
    if args.refine_ownership and args.face_source=='generated' and (not args.face_parts.exists() or not args.face_parts_request.exists()):raise ValueError('Prepare and register split-requests --stage face-parts before adopting the generated face.')
    source=Image.open(source_file).convert('RGBA');split=args.job_root/'split';root=args.job_root/('ownership-refined-preview' if args.refine_ownership else 'ownership-p3-preview' if args.p3 else 'ownership-preview' if args.ownership else 'peel-preview');root.mkdir(exist_ok=True)
    lm=json.loads((split/'landmarks.json').read_text());item=json.loads((args.request_dir/'requests.json').read_text())
    reference,padding=square_pad(source.crop(item['cropBox']),(255,255,255,255))
    request=args.request_dir/'requests/without-front-hair'
    if padding!=item['padding'] or Image.open(request/'input.png').convert('RGBA').tobytes()!=reference.tobytes():raise ValueError('P1 request does not match original source.')
    if file_hash(request/'input.png')!=item['inputSha256'] or file_hash(request/'mask.png')!=item['maskSha256']:raise ValueError('P1 request hashes changed.')
    previous=json.loads(args.p1_check.read_text())
    if previous['resultSha256']!=file_hash(args.p1) or not previous['alignment']['pass']:raise ValueError('P1 does not match its alignment evidence.')
    for f in [args.p1,args.p2]:
        im=Image.open(f)
        if abs(im.width/im.height-1)>.01:raise ValueError('Expected the same square framing.')
    p1=compensate_result(reference,Image.open(args.p1).convert('RGBA'),previous['alignment'],1)
    facial=mask(source.size,[*lm['eyes'],*lm['brows'],lm['mouth'],lm['nose']]);native=facial.crop(item['cropBox']);band=Image.new('RGBA',reference.size);alpha=Image.new('L',reference.size);alpha.paste(native,tuple(padding[:2]));band.putalpha(alpha)
    p2raw=Image.open(args.p2).convert('RGBA');alignment=alignment_check(p1,p2raw,band,24,1,12,.03)
    dump(root/'alignment.json',{'p1':previous['alignment'],'p2':alignment})
    if not alignment['pass']:raise ValueError('P2 alignment exceeds the existing shift/scale limits.')
    p2=compensate_result(p1,p2raw,alignment,1)
    p1.save(root/'p1-aligned-square.png');p2.save(root/'p2-aligned-square.png')
    def full(im):
        out=source.copy();out.paste(square_unpad(im,padding),tuple(item['cropBox'][:2]));return out
    a,b=full(p1),full(p2);a.save(root/'p1.png');b.save(root/'p2.png')
    fg,bg=foreground_mask(source.convert('RGB'),lm);fg1,_=foreground_mask(a.convert('RGB'),lm);fg2,_=foreground_mask(b.convert('RGB'),lm)
    segmentation=json.loads((split/'segmentation.json').read_text());palettes=segmentation['palettes']
    if args.ownership:
        from split_ownership import ownership_candidate
        source_hair=None;hair_provenance={}
        if args.refine_ownership:
            if segmentation['inputSha256']!=job['input']['sha256']:raise ValueError('Original hair mask source changed.')
            hair_file=split/'masks/hair.png';source_hair=Image.open(hair_file).convert('L')
            hair_provenance={'sourceHairMaskSha256':file_hash(hair_file),'sourceHairSegmentationSha256':file_hash(split/'segmentation.json')}
        completion=None
        if args.p3:
            meta=json.loads(args.p3_request.read_text());p3input=args.p3_request.parent/'input.png'
            if meta['sourceSha256']!=job['input']['sha256'] or file_hash(p3input)!=file_hash(args.p1) or file_hash(p3input)!=meta['inputSha256'] or file_hash(args.p3)!=meta['resultSha256']:raise ValueError('P3 provenance does not match the approved P1/source.')
            p3raw=Image.open(args.p3).convert('RGBA')
            if abs(p3raw.width/p3raw.height-1)>.01:raise ValueError('P3 must retain square framing.')
            classes=classify(a.convert('RGB'),[palettes['hair'],palettes['skin']+palettes.get('neck',[]),[(255,255,255)],palettes['topwear']])
            p1hair=Image.frombytes('L',source.size,bytes(255 if v==0 else 0 for v in classes));p1hair=ImageChops.multiply(p1hair,fg1)
            head=Image.new('L',source.size);ImageDraw.Draw(head).rectangle((0,0,source.width,min(v[1] for v in lm['collar'])),fill=255)
            outer=ImageChops.multiply(ImageChops.multiply(dilate(p1hair,5),dilate(ImageChops.invert(fg1),5)),head)
            probe,_=square_pad(outer.crop(item['cropBox']),0);band3=Image.new('RGBA',reference.size);band3.putalpha(probe)
            band3.save(root/'p3-alignment-band.png');check3=alignment_check(p1,p3raw,band3,24,1,12,.03);dump(root/'p3-alignment.json',check3)
            if not check3['pass']:raise ValueError('P3 alignment exceeds existing shift/scale limits.')
            p3square=compensate_result(p1,p3raw,check3,1);p3square.save(root/'p3-aligned-square.png')
            p3=Image.new('RGBA',source.size,'white');p3.paste(square_unpad(p3square,padding),tuple(item['cropBox'][:2]));p3.save(root/'p3.png')
            fg3,_=foreground_mask(p3.convert('RGB'));completion={'image':p3,'foreground':fg3,'alignment':check3,'sha256':file_hash(args.p3)}
        result=ownership_candidate(source,a,b,fg,fg1,fg2,lm,palettes,root,args.ownership,args.ownership_request,
            {'sourceSha256':job['input']['sha256'],'p1Sha256':file_hash(args.p1),'p2Sha256':file_hash(args.p2),'p2Alignment':alignment,**hair_provenance},completion=completion,refine=args.refine_ownership,source_hair=source_hair,face_source=args.face_source if args.refine_ownership else 'original',face_parts_files=(args.face_parts,args.face_parts_request) if args.face_parts else None)
        print(json.dumps(result));return
    classes=classify(a.convert('RGB'),[palettes['hair'],palettes['skin']+palettes.get('neck',[]),[bg['rgb']],palettes['topwear']])
    hair1=Image.frombytes('L',source.size,bytes(255 if v==0 else 0 for v in classes));hair1=ImageChops.multiply(hair1,fg1)
    hair1=ImageChops.subtract(hair1,dilate(facial,2))
    head=Image.new('L',source.size);ImageDraw.Draw(head).rectangle((0,0,source.width,min(p[1] for p in lm['collar'])),fill=255)
    hair1=ImageChops.multiply(hair1,head)
    hair0=Image.open(split/'masks/hair.png').convert('L')
    layers,comp,check,masks=peeled_layers(source,a,b,fg,hair0,hair1,fg2)
    folder=root/'layers';folder.mkdir(exist_ok=True)
    for name,im in layers.items():im.save(folder/(name+'.png'))
    comp.save(root/'composite.png');(root/'masks').mkdir(exist_ok=True)
    max_difference(source,a).save(root/'difference-p0-p1.png');max_difference(a,b).save(root/'difference-p1-p2.png')
    for name,im in masks.items():im.save(root/'masks'/(name+'.png'))
    make_contact_sheet([folder/(n+'.png') for n in layers],root/'layers-overview.png')
    report={'schemaVersion':1,'purpose':'visual candidate before PSD assembly','productionReady':False,'psdBuilt':False,
       'inputSha256':job['input']['sha256'],'p1Sha256':file_hash(args.p1),'p2Sha256':file_hash(args.p2),'p1Request':item,'alignment':alignment,
       'method':{'front':'Original pixels where original/P1 max-channel difference >24, within existing source hair support; opening 1px, closing 2px.',
                 'back':'Visible pixels from original; hidden pixels from P1 where P1/P2 difference >24 and P1 has hair-colour support, only beneath foreground hair.',
                 'base':'P2 face/ears/neck/clothing, with original visible non-hair pixels restored. Kept together for this preview.',
                 'order':['base','back hair','front hair'],
                 'warning':'Difference masks remain an experimental candidate. Colour class is only mask support; no colour-field artwork is synthesized.'},
       'staticConservation':check,'artifacts':{n:{'sha256':file_hash(folder/(n+'.png')),'pixels':sum(a>0 for a in im.getchannel('A').tobytes())} for n,im in layers.items()},
       'limitations':['No PSD, facial part separation, expressions or rig motion validation.','Generated scalp is below both hair layers in this peel stack; anatomical rear-hair occlusion still needs review.','Existing source hair support can misassign contour ink.','Fine differences are not automatically a natural hair bundle; inspect shifted/rotated candidate frames.']}
    dump(root/'review.json',report)
    if not check['pass']:raise ValueError('Original visible pixels were not conserved; do not assemble.')
    print(json.dumps({'candidate':str(root/'composite.png'),'layers':str(root/'layers-overview.png'),'report':str(root/'review.json'),'productionReady':False,'psdBuilt':False}))


if __name__=='__main__':main()
