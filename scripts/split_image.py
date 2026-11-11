#!/usr/bin/env python3
"""Manifest-backed entry point for landmark, local split and generated split import."""
from __future__ import annotations
import argparse
import json
import shutil
import zipfile
from collections import deque
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw
from expression_requests_common import file_hash
from split_common import dump, validate_landmarks, bounds, square_pad, square_unpad, dilate, erode, colour_distance, fill_enclosed
from split_layers import split_visible, conserve_visible_pixels, ORDER
from inspect_layers import make_contact_sheet


def landmark_overlay(source,lm):
    image=source.copy(); draw=ImageDraw.Draw(image)
    for name in ('eyes','brows','ears','mouth','nose'):
        items=lm[name] if isinstance(lm[name],list) else [lm[name]]
        for i,b in enumerate(items):
            box=bounds(b); draw.rectangle(box,outline=(0,155,230),width=2); draw.text(box[:2],f'{name}-{i}',fill=(0,50,200))
    for name in ('chin','hairPart','bangTips','collar'):
        items=[lm[name]] if name in ('chin','hairPart') else lm[name]
        for x,y in items: draw.ellipse((x-4,y-4,x+4,y+4),fill=(220,0,170)); draw.text((x+5,y),name,fill=(160,0,100))
    for item in lm.get('accessories',[]): draw.rectangle(bounds(item['box']),outline=(255,0,0),width=2)
    return image


def save_candidate(root,layers,composite,report,masks):
    folder=root/'layers'; folder.mkdir(parents=True,exist_ok=True)
    for file in folder.glob('*.png'): file.unlink()
    for name,im in layers.items(): im.save(folder/f'{name}.png')
    (root/'masks').mkdir(exist_ok=True)
    for name,im in masks.items(): im.save(root/'masks'/f'{name}.png')
    composite.save(root/'composite.png')
    make_contact_sheet([folder/f'{n}.png' for n in ORDER if n in layers],root/'layers-overview.png')
    dump(root/'segmentation.json',report)


def build_request(root,source,lm,masks):
    request=root/'requests'/'without-front-hair'; request.mkdir(parents=True,exist_ok=True)
    # Source-derived front support plus margin includes cast shadows and hidden brows.
    radius=max(4,round((lm['eyes'][1]['center'][0]-lm['eyes'][0]['center'][0])*.08))
    from split_accessories import declared_accessories
    accessories=declared_accessories(source.size,lm)
    editable=ImageChops.lighter(dilate(masks['front'],radius),accessories)
    # The full head remains available for alignment; square padding is recorded explicitly.
    box=ImageChops.lighter(masks['hair'],accessories).getbbox()
    if not box: raise ValueError('髪の領域が空です。')
    pad=round(max(box[2]-box[0],box[3]-box[1])*.08)
    crop=[max(0,box[0]-pad),max(0,box[1]-pad),min(source.width,box[2]+pad),min(source.height,max(box[3],round(lm['chin'][1]))+pad)]
    reference,padding=square_pad(source.crop(crop),(255,255,255,255))
    edit_crop=editable.crop(crop)
    edit_square,_=square_pad(edit_crop,0)
    edit_square,_,_=validation_scope(source,lm,{'cropBox':crop,'padding':padding},edit_square)
    mask=Image.new('RGBA',reference.size,(255,255,255,255)); mask.putalpha(ImageChops.invert(edit_square))
    reference.save(request/'input.png'); mask.save(request/'mask.png')
    guide=reference.copy(); tint=Image.new('RGBA',reference.size,(255,40,100,0))
    tint.putalpha(edit_square.point(lambda v:round(v*.3))); guide.alpha_composite(tint)
    guide.save(request/'edit-area-preview.png')
    prompt=("Edit input.png using mask.png: transparent mask pixels are editable; opaque pixels must stay identical. "
            "Remove only the foreground bangs/fringe, including long front side locks and their cast shadow. "
            "Reveal one complete natural forehead, both complete eyebrows and upper eyelid creases continuing the original visible lines. "
            "Preserve the back hair, outer hair silhouette, ears, eyes, nose, closed mouth, face contour, clothing, colours and line style. "
            "Behind the removed front hair reconstruct the same character's hidden face and back hair; do not add a different hairstyle. "
            "Do not move, enlarge, crop or retouch the protected face. "
            "Keep every originally visible ear contour, eye, eyebrow segment and cheek pixel identical; "
            "extend hidden portions only where hair is removed. Do not redraw or enlarge the visible ears. "
            f"Return exactly {reference.width}x{reference.height} pixels, including the existing white square margins.\n")
    if accessories.getbbox():
        prompt+=' Also remove all headwear (hats and headdresses) and eyeglasses inside the editable area. Reveal the same hidden hair and head below headwear, and the complete unobstructed face and eyes below glasses. Preserve the original rear-hair silhouette; do not add accessories.\n'
    (request/'prompt.txt').write_text(prompt,encoding='utf-8')
    (root/'results').mkdir(exist_ok=True)
    record={'cropBox':crop,'padding':padding,'size':list(reference.size),'inputSha256':file_hash(request/'input.png'),'maskSha256':file_hash(request/'mask.png'),
            'result':'without-front-hair.png','purpose':'front hair difference and hidden face','service':'Codex image generation; send only after owner approval'}
    dump(root/'requests.json',record)
    return record


def validation_scope(source, landmarks, item, editable):
    """Declare generated pixels consumed by face reconstruction before inspecting results."""
    distance=landmarks['eyes'][1]['center'][0]-landmarks['eyes'][0]['center'][0]
    left,right=[ear['center'][0] for ear in landmarks['ears']]
    face=Image.new('L',source.size)
    ImageDraw.Draw(face).ellipse((left-distance*.15,landmarks['hairPart'][1]+distance*.25,
                                 right+distance*.15,landmarks['chin'][1]+distance*.08),fill=255)
    from split_accessories import declared_accessories
    face=ImageChops.lighter(face,declared_accessories(source.size,landmarks))
    native=face.crop(item['cropBox'])
    padded=Image.new('L',editable.size)
    padded.paste(native,tuple(item['padding'][:2]))
    used=ImageChops.multiply(padded,editable)
    if not used.getbbox(): raise ValueError('補完に使う範囲がありません。目印を確認してください。')
    # Existing editable area can be wider than the pixels now consumed. A ring
    # within that editable area is not protected source art and cannot be used
    # as an unchanged reference. Only the actual source-facing seam is checked.
    band=ImageChops.multiply(ImageChops.subtract(dilate(editable,8),editable),dilate(used,8))
    support=ImageChops.multiply(ImageChops.subtract(dilate(editable,10),editable),dilate(used,10))
    return used,band,support


def removed_hair(reference, generated, source_hair, palettes, background=(255,255,255)):
    """Consume hair replaced by face colour, keeping background and hair edits unused."""
    hair_colours=palettes['hair']
    skin_colours=palettes['skin']+palettes.get('neck',[])
    # Quantize only for colour-family classification, retaining original RGB for
    # difference checks and imported artwork. New eyebrow ink forms closed holes.
    q=generated.convert('RGB').quantize(colors=96); palette=q.getpalette(); replacement=[]
    for n in range(256):
        color=palette[n*3:n*3+3]
        if len(color)!=3: replacement.append('unused'); continue
        distances={'skin':min(colour_distance(color,p) for p in skin_colours),
                   'hair':min(colour_distance(color,p) for p in hair_colours),
                   'background':colour_distance(color,background)}
        replacement.append(min(distances,key=distances.get))
    classified={name:bytearray(reference.width*reference.height) for name in ('skin','hair','background','unused')}
    for i,(a,b,hair,label) in enumerate(zip(reference.convert('RGB').getdata(),generated.convert('RGB').getdata(),source_hair.tobytes(),q.tobytes())):
        if hair and max(abs(a[c]-b[c]) for c in range(3))>8: classified[replacement[label]][i]=255
    masks={name:Image.frombytes('L',reference.size,bytes(data)) for name,data in classified.items()}
    used=ImageChops.multiply(fill_enclosed(masks['skin']),source_hair)
    excluded={name:ImageChops.subtract(masks[name],used) for name in ('background','hair','unused')}
    return used,excluded


def source_protected_regions(hair, used, width=8):
    """Protect non-hair only. Removing source hair is the intended edit, not a seam error."""
    nonhair=ImageChops.invert(hair)
    return ImageChops.multiply(dilate(used,width),nonhair),ImageChops.multiply(dilate(used,width+2),nonhair)


def generated_face_surface(generated,palettes,landmarks,item,background=(255,255,255)):
    """Grow coherent face/ear surfaces from landmarks, not isolated skin-coloured edges."""
    rgb=generated.convert('RGB'); q=rgb.quantize(colors=96); colors=q.getpalette(); skin_labels=[]
    for n in range(256):
        c=colors[n*3:n*3+3]
        skin_labels.append(len(c)==3 and min(colour_distance(c,p) for p in palettes['skin']+palettes.get('neck',[]))
                           <min(colour_distance(c,background),min(colour_distance(c,p) for p in palettes['hair'])))
    candidate=Image.frombytes('L',rgb.size,bytes(255 if skin_labels[n] else 0 for n in q.tobytes()))
    # Opening removes thin antialiased fringes before seeds can reach them.
    # Select components before closing so a thin chin outline cannot connect the
    # entire neck/clothing to the face merely because the outline is filled in.
    opened=ImageChops.multiply(dilate(erode(candidate,2),2),candidate)
    w,h=rgb.size; allowed=opened.tobytes(); seen=bytearray(w*h); queue=deque()
    ox=item['padding'][0]-item['cropBox'][0];oy=item['padding'][1]-item['cropBox'][1]
    eye_x=sum(b['center'][0] for b in landmarks['eyes'])/2
    eye_y=sum(b['center'][1] for b in landmarks['eyes'])/2
    cx,cy=round(eye_x+ox),round((eye_y+landmarks['chin'][1])/2+oy)
    radius=max(8,round((landmarks['eyes'][1]['center'][0]-landmarks['eyes'][0]['center'][0])*.2))
    choices=[((x-cx)**2+(y-cy)**2,y*w+x) for y in range(max(0,cy-radius),min(h,cy+radius+1))
             for x in range(max(0,cx-radius),min(w,cx+radius+1)) if allowed[y*w+x]]
    if not choices: raise ValueError('顔の目印から肌の面を見つけられませんでした。')
    seed=min(choices)[1];queue.append(seed);seen[seed]=1
    # Ear landmarks are boxes: seed each substantial skin component within them,
    # including ears separated from the face by a drawn contour.
    for box in landmarks['ears']:
        x0,y0,x1,y1=bounds(box)
        for y in range(max(0,round(y0+oy)),min(h,round(y1+oy))):
            for x in range(max(0,round(x0+ox)),min(w,round(x1+ox))):
                i=y*w+x
                if allowed[i] and not seen[i]:seen[i]=1;queue.append(i)
    while queue:
        i=queue.popleft();x=i%w
        for n in (i-1,i+1,i-w,i+w):
            if 0<=n<w*h and abs(n%w-x)<=1 and allowed[n] and not seen[n]:seen[n]=1;queue.append(n)
    selected=Image.frombytes('L',rgb.size,bytes(255 if v else 0 for v in seen))
    return erode(dilate(fill_enclosed(selected),3),3)


def request_canvas(mask,item,size):
    image=Image.new('L',size)
    image.paste(mask.crop(item['cropBox']),tuple(item['padding'][:2]))
    return image


def checked_result(root,result_dir,source,request_root=None):
    from import_expression_results import alignment_check,compensate_result,protected_band,protected_diff,local_band_diff
    request_root=request_root or root
    item=json.loads((request_root/'requests.json').read_text()); request=request_root/'requests'/'without-front-hair'
    report={'pass':False,'thresholds':{'mean':6,'p99':20,'local':24,'flat':12}}
    try:
        for name in ('input','mask'):
            if file_hash(request/f'{name}.png')!=item[f'{name}Sha256']: raise ValueError('生成依頼の入力またはマスクが変わっています。')
        reference=Image.open(request/'input.png').convert('RGBA'); mask=Image.open(request/'mask.png').convert('RGBA')
        expected,padding=square_pad(source.crop(item['cropBox']),(255,255,255,255))
        if padding!=item['padding'] or reference.size!=expected.size or reference.tobytes()!=expected.tobytes():
            raise ValueError('生成依頼の切り抜きが現在の元画像と一致しません。')
        file=result_dir/'without-front-hair.png'; original=Image.open(file).convert('RGBA')
        report['resultSha256']=file_hash(file)
        if abs(original.width/original.height-1)>.01: raise ValueError('生成結果は依頼と同じ正方形にしてください。')
        editable=ImageChops.invert(mask.getchannel('A'))
        landmarks=json.loads((root/'landmarks.json').read_text())
        source_hair=Image.open(root/'masks'/'hair.png').convert('L')
        segmentation=json.loads((root/'segmentation.json').read_text())
        from split_accessories import declared_accessories
        accessories=request_canvas(declared_accessories(source.size,landmarks),item,reference.size)
        hair=request_canvas(source_hair,item,reference.size)
        hair=ImageChops.lighter(hair,accessories)
        opaque=reference.getchannel('A').point(lambda v:255 if v>=240 else 0)
        # Registration uses source-derived non-hair, independently of the result.
        alignment_alpha=ImageChops.multiply(ImageChops.subtract(dilate(hair,8),hair),opaque)
        alignment_band=Image.new('RGBA',reference.size); alignment_band.putalpha(alignment_alpha)
        alignment=alignment_check(reference,original,alignment_band,24,1,12,.03); report['alignment']=alignment
        result=compensate_result(reference,original,alignment,1)
        background=segmentation.get('background',{}).get('rgb',(255,255,255))
        _,excluded=removed_hair(reference,result,hair,segmentation['palettes'],background)
        surface=generated_face_surface(result,segmentation['palettes'],landmarks,item,background)
        surface=ImageChops.lighter(surface,accessories)
        used=ImageChops.multiply(surface,hair)
        excluded={name:ImageChops.subtract(region,used) for name,region in excluded.items()}
        if not used.getbbox(): raise ValueError('元の髪が取り除かれた領域を見つけられませんでした。')
        band_alpha,support_alpha=source_protected_regions(hair,surface)
        band=Image.new('RGBA',reference.size); band.putalpha(ImageChops.multiply(band_alpha,opaque))
        support=Image.new('RGBA',reference.size); support.putalpha(ImageChops.multiply(support_alpha,opaque))
        used.save(root/'generation-used-mask.png'); band.getchannel('A').save(root/'generation-protected-band.png')
        hair.save(root/'generation-source-hair.png')
        surface.save(root/'generation-face-surface.png')
        outside_surface=ImageChops.invert(dilate(surface,8))
        outside_surface.save(root/'generation-outside-surface.png')
        for name,region in excluded.items(): region.save(root/f'generation-unused-{name}.png')
        report['scope']={'rule':'coherent generated face and ear surfaces grown from landmarks, opened by 2px, holes filled and closed by 3px; consume only source hair within those surfaces',
                         'surface':'generation-face-surface.png','surfacePixels':sum(v>0 for v in surface.tobytes()),'surfaceBounds':surface.getbbox(),
                         'outsideSurfaceAndBand':{'pixels':sum(v>0 for v in outside_surface.tobytes()),'bounds':outside_surface.getbbox(),'mask':'generation-outside-surface.png','imported':False},
                         'unusedChanges':{name:{'pixels':sum(v>0 for v in region.tobytes()),'bounds':region.getbbox(),'mask':f'generation-unused-{name}.png','imported':False} for name,region in excluded.items()},
                         'sourceHairMask':'generation-source-hair.png','sourceHairMaskSha256':file_hash(root/'generation-source-hair.png'),
                         'requestMaskDoesNotOverrideSourceNonHairProtection':True,
                         'usedMask':'generation-used-mask.png','usedMaskSha256':file_hash(root/'generation-used-mask.png'),
                         'usedPixels':sum(v>0 for v in used.tobytes()),'usedBounds':used.getbbox(),
                         'protectedBand':'generation-protected-band.png','protectedBandPixels':sum(v>0 for v in band.getchannel('A').tobytes()),
                         'bandWidth':8,'supportWidth':10,'excludedPixels':sum(v==0 for v in ImageChops.lighter(used,band.getchannel('A')).tobytes()),
                         'excludedPixelsImported':False,'padding':item['padding'],'cropBox':item['cropBox']}
        result.save(root/'aligned-result-review.png')
        report['outside']=protected_diff(reference,result,band)
        local=local_band_diff(reference,result,band,1,support); report['band']=local
        if not alignment['pass']: raise ValueError('生成結果の位置ずれが許容値を超えています。')
        # Visible pixels are copied from the original, never from this result.
        # Pixel agreement is diagnostic; revealed seams must be reviewed on the
        # assembled PSD in motion. Alignment and source conservation still gate.
        report['pixelComparison']={'gating':False,
            'withinReferenceLimits':report['outside']['meanAbsoluteDiff']<=6 and report['outside']['p99AbsoluteDiff']<=20
                and local['meanMatchedDiff']<=6 and local['p99MatchedDiff']<=20
                and local['maxLocalMeanDiff']<=24 and local['maxFlatMeanDiff']<=12}
        report['qualityReview']={'status':'pending','required':'assembled PSD seam measurements, close-ups and motion review'}
        native=square_unpad(result,item['padding']); native_edit=square_unpad(used,item['padding'])
        crop=item['cropBox']; output=source.copy(); output.paste(native,tuple(crop[:2]),native_edit)
        full_edit=Image.new('L',source.size); full_edit.paste(native_edit,tuple(crop[:2]))
        output.save(root/'aligned-without-front-hair.png')
        report.update({'pass':True,'acceptance':'aligned hidden artwork candidate; final visual quality not established'})
        return (output,full_edit,None),report
    except Exception as error:
        report['error']=str(error); raise
    finally: dump(root/'generation-check.json',report)


def bundle(root,manifest,report):
    if report.get('method')!='difference':
        raise ValueError('画像生成の分割結果だけを取り込めます。split-auto から実行し直してください。')
    files=sorted((root/'layers').glob('*.png'))
    result={'schemaVersion':1,'engine':{'name':'landmark-image-split','method':report['method'],'seeThroughExecuted':False,
            'imageGenerationUsed':True,'productionReady':False},
            'input':{'sha256':manifest['input']['sha256']},'canvas':report['canvas'],
            'artifacts':[{'file':'source/'+p.name,'bytes':p.stat().st_size,'sha256':file_hash(p)} for p in files],
            'split':{'landmarksSha256':file_hash(root/'landmarks.json'),'limitations':report['limitations']}}
    dump(root/'run-manifest.json',result)
    target=root/'bundle.zip'
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
        archive.write(root/'run-manifest.json','run-manifest.json')
        for p in files: archive.write(p,'layerdiff_output/source/'+p.name)
    return target


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('action',choices=['landmarks','auto','import'])
    parser.add_argument('--job-root',type=Path,required=True); parser.add_argument('--landmarks',type=Path)
    parser.add_argument('--method',choices=['difference'],default='difference'); parser.add_argument('--results',type=Path)
    parser.add_argument('--request-dir',type=Path)
    args=parser.parse_args(); manifest=json.loads((args.job_root/'job.json').read_text())
    source_file=Path(manifest['input']['file'])
    if file_hash(source_file)!=manifest['input']['sha256']: raise ValueError('元画像のハッシュが一致しません。')
    source=Image.open(source_file).convert('RGBA'); root=args.job_root/'split'; root.mkdir(exist_ok=True)
    mapping=json.loads(Path('configs/layer-map.json').read_text()); accessories={x['source'][:-4] for x in mapping['layers'] if x['target'] in ('headwear','eyewear','earwear')}
    if args.action=='landmarks':
        if not args.landmarks: raise ValueError('--landmarks で目印のJSONを指定してください。')
        lm=validate_landmarks(json.loads(args.landmarks.read_text()),source.size,accessories)
        dump(root/'landmarks.json',lm); landmark_overlay(source,lm).save(root/'landmarks.png')
        print(json.dumps({'landmarks':str(root/'landmarks.json'),'preview':str(root/'landmarks.png')})); return
    lm=validate_landmarks(json.loads((root/'landmarks.json').read_text()),source.size,accessories)
    if args.action=='auto':
        layers,composite,report,masks=split_visible(source,lm)
        report.update({'method':args.method,'canvas':list(source.size),'inputSha256':manifest['input']['sha256'],'landmarksSha256':file_hash(root/'landmarks.json')})
        layers,composite,conservation,owners=conserve_visible_pixels(source,layers,masks,lm)
        report['staticConservation']=conservation; owners.save(root/'visible-owners.png')
        dump(root/'static-conservation.json',conservation)
        dump(root/'segmentation.json',report)
        if not conservation['pass']: raise ValueError('元の画素の保存検査に失敗しました。画像生成へ進まないでください。')
        save_candidate(root,layers,composite,report,masks); request=build_request(root,source,lm,masks)
        print(json.dumps({'candidate':str(root/'composite.png'),'layers':str(root/'layers-overview.png'),'requests':str(root/'requests.json'),'method':args.method,'awaitingGeneration':True})); return
    report=json.loads((root/'segmentation.json').read_text())
    if report['inputSha256']!=manifest['input']['sha256'] or report['landmarksSha256']!=file_hash(root/'landmarks.json'): raise ValueError('目印が変わりました。split-auto を実行し直してください。')
    if report.get('method')!='difference':
        raise ValueError('画像生成の分割結果だけを取り込めます。split-auto から実行し直してください。')
    difference,check=checked_result(root,args.results or root/'results',source,args.request_dir)
    layers,composite,new_report,masks=split_visible(source,lm,difference)
    new_report.update({key:report[key] for key in ('method','canvas','inputSha256','landmarksSha256')})
    layers,composite,conservation,owners=conserve_visible_pixels(source,layers,masks,lm)
    new_report['staticConservation']=conservation; owners.save(root/'visible-owners.png')
    dump(root/'static-conservation.json',conservation)
    dump(root/'segmentation.json',new_report)
    if not conservation['pass']: raise ValueError('元の画素の保存検査に失敗しました。PSDの組み立てへ進まないでください。')
    save_candidate(root,layers,composite,new_report,masks); report=new_report
    archive=bundle(root,manifest,report)
    print(json.dumps({'bundle':str(archive),'preview':str(root/'composite.png'),'layers':str(root/'layers-overview.png'),'productionReady':False}))


if __name__=='__main__': main()
