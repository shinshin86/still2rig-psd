"""Generated facial ownership, bounded registration and shared rig masks."""
from array import array
import json
from PIL import Image,ImageChops
from split_common import square_pad,square_unpad,dilate,erode,fill_enclosed,dump,mask
from expression_requests_common import file_hash

FACE_NAMES=['other','eyebrow','eyelash','eyewhite','irides','mouth','nose','skin']
FACE_COLORS=[(0,0,0),(255,0,0),(0,0,255),(255,255,255),(0,255,0),(255,255,0),(0,255,255),(128,128,128)]


def components(binary):
    w,h=binary.size;remaining={i for i,v in enumerate(binary.tobytes()) if v};out=[]
    while remaining:
        todo=[remaining.pop()];part=[]
        while todo:
            i=todo.pop();part.append(i);x,y=i%w,i//w
            for dy in (-1,0,1):
                for dx in (-1,0,1):
                    n=(y+dy)*w+x+dx
                    if 0<=x+dx<w and 0<=y+dy<h and n in remaining:remaining.remove(n);todo.append(n)
        out.append(part)
    return out


def bitmap(size,indices):
    data=bytearray(size[0]*size[1])
    for i in indices:data[i]=255
    return Image.frombytes('L',size,bytes(data))


def nearest_face_labels(image):
    rgb=image.convert('RGB');colours=rgb.getcolors(rgb.width*rgb.height)
    lookup={c:min(range(8),key=lambda n:sum((c[k]-FACE_COLORS[n][k])**2 for k in range(3))) for _,c in colours}
    labels=Image.frombytes('L',rgb.size,bytes(lookup[c] for c in rgb.getdata()))
    # Enclosed white islands inside an iris are its highlights, not a second
    # independently moving eye-white drawing.
    iris=labels.point(lambda n:255 if n==4 else 0);holes=ImageChops.subtract(fill_enclosed(iris),iris)
    labels.paste(4,(0,0,*labels.size),ImageChops.multiply(holes,labels.point(lambda n:255 if n==3 else 0)))
    return labels


def import_face_parts(p1,skin,landmarks,result_file,request_file,source_sha,root):
    from import_expression_results import alignment_check,compensate_result
    from split_ownership import snap_boundaries
    request=json.loads(request_file.read_text());reference_file=request_file.parent/'input.png'
    if request['stage']!='face-parts' or request['sourceSha256']!=source_sha:raise ValueError('Face-parts request source changed.')
    if file_hash(root.parent/'split/landmarks.json')!=request['landmarksSha256']:raise ValueError('Face-parts landmarks changed.')
    if file_hash(root/'p1.png')!=request['p1NativeSha256'] or file_hash(reference_file)!=request['inputSha256'] or file_hash(result_file)!=request['resultSha256']:raise ValueError('Face-parts input or result hash changed.')
    reference,padding=square_pad(p1.crop(request['cropBox']),(255,255,255,255))
    if padding!=request['padding'] or Image.open(reference_file).convert('RGBA').tobytes()!=reference.tobytes():raise ValueError('Face-parts framing changed.')
    raw=Image.open(result_file).convert('RGBA')
    if abs(raw.width/raw.height-1)>.01:raise ValueError('Face-parts map must retain square framing.')
    silhouette=fill_enclosed(nearest_face_labels(raw).point(lambda n:255 if n else 0)).convert('RGBA')
    expected,_=square_pad(skin.crop(request['cropBox']),0)
    edge=ImageChops.subtract(dilate(expected,5),erode(expected,5))
    # The map also labels neck skin. Estimate registration from forehead,
    # cheeks and ears, excluding the chin/neck boundary.
    bottom=round(landmarks['chin'][1]-request['cropBox'][1]+padding[1]-12)
    if bottom<edge.height:edge.paste(0,(0,max(0,bottom),edge.width,edge.height))
    band=Image.new('RGBA',expected.size);band.putalpha(edge)
    alignment=alignment_check(expected.convert('RGBA'),silhouette,band,24,1,12,.03)
    dump(root/'face-parts-alignment.json',alignment)
    if not alignment['pass']:raise ValueError('Face-parts alignment exceeds existing shift/scale limits.')
    aligned=compensate_result(reference,raw,alignment,1);aligned.save(root/'face-parts-aligned-square.png')
    cropped=nearest_face_labels(aligned);native=Image.new('L',p1.size)
    native.paste(square_unpad(cropped,padding),tuple(request['cropBox'][:2]))
    labels,snap,changes=snap_boundaries(p1,native,native.point(lambda n:255 if n else 0),radius=3)
    for key in ('countsBefore','countsAfter'):snap[key]=dict(zip(FACE_NAMES,snap[key].values()))
    labels.save(root/'face-parts-labels.png');changes.save(root/'face-parts-snap-changes.png')
    if any(not labels.point(lambda v:255 if v==n else 0).getbbox() for n in (1,2,3,4,7)):raise ValueError('Face-parts map is missing required eye, brow or skin classes.')
    colour=Image.new('RGB',p1.size);colour.putdata([FACE_COLORS[n] for n in labels.tobytes()]);colour.save(root/'face-parts-colours.png')
    report={'requestSha256':file_hash(request_file),'resultSha256':file_hash(result_file),'p1NativeSha256':request['p1NativeSha256'],'alignment':alignment,'boundaryRefinement':snap,'palette':dict(zip(FACE_NAMES,FACE_COLORS)),'qualityCheckedVisually':False}
    dump(root/'face-parts-import.json',report)
    return labels,report


def clean_skin_field(image,known,target,radius):
    """Average only recorded P1 skin using integer sums, without 8-bit blur weights."""
    w,h=image.size;stride=w+1;size=stride*(h+1)
    sums=[array('I',[0])*size for _ in range(4)];rgb=list(image.convert('RGB').getdata());allowed=known.tobytes()
    for y in range(h):
        row=[0,0,0,0]
        for x in range(w):
            i=y*w+x;j=(y+1)*stride+x+1
            if allowed[i]:
                row[0]+=1
                for k in range(3):row[k+1]+=rgb[i][k]
            for k in range(4):sums[k][j]=sums[k][j-stride]+row[k]
    if not sums[0][-1]:raise ValueError('No feature-free P1 skin is available for the face backing.')
    result=image.convert('RGBA');out=result.load()
    for i,value in enumerate(target.tobytes()):
        if not value:continue
        x,y=i%w,i//w;r=radius
        while True:
            x0,y0,x1,y1=max(0,x-r),max(0,y-r),min(w,x+r+1),min(h,y+r+1)
            a,b,c,d=y1*stride+x1,y0*stride+x1,y1*stride+x0,y0*stride+x0
            totals=[s[a]-s[b]-s[c]+s[d] for s in sums]
            if totals[0]:break
            r*=2
        out[x,y]=tuple(round(v/totals[0]) for v in totals[1:])+(255,)
    return result


def select_face_parts(source,p1,labels,foreground,skin,scope,layers,parts,landmarks):
    from split_ownership import snap_boundaries
    size=source.size;w,h=size;front=labels.point(lambda n:255 if n==1 else 0)
    distance=abs(landmarks['eyes'][1]['center'][0]-landmarks['eyes'][0]['center'][0])
    part_support=parts.point(lambda n:255 if 1<=n<=6 else 0)
    known=erode(parts.point(lambda n:255 if n==7 else 0),3)
    clean=clean_skin_field(p1,known,dilate(part_support,6),max(8,round(distance*.1)))
    source_parts,_,_=snap_boundaries(source,parts,parts.point(lambda n:255 if n else 0),radius=3)
    selected=Image.new('L',size);patches=Image.new('L',size);p1_choices=patches.copy();source_choices=patches.copy();records=[]
    draw_p1=patches.copy();draw_source=patches.copy()
    front_data=front.tobytes();scope_data=scope.tobytes()
    for n in (1,2,3,4):
        for part in components(parts.point(lambda v:255 if v==n else 0)):
            component=bitmap(size,part);patch=ImageChops.multiply(dilate(component,3),ImageChops.multiply(foreground,skin))
            if not any(a and b for a,b in zip(patch.tobytes(),scope_data)):continue
            hidden=sum(bool(front_data[i]) for i in part);owner='p1' if hidden*2>len(part) else 'source'
            if owner=='p1':chosen=ImageChops.multiply(component,patch)
            else:
                chosen=ImageChops.multiply(patch,source_parts.point(lambda v:255 if v==n else 0))
                chosen=ImageChops.subtract(chosen,front)
            # The same selected part replaces both possible old drawings. The
            # backing samples only gray-labelled P1 skin, never source hair.
            selected.paste(n,(0,0,w,h),chosen);patches=ImageChops.lighter(patches,patch)
            if owner=='p1':
                p1_choices=ImageChops.lighter(p1_choices,patch);draw_p1=ImageChops.lighter(draw_p1,chosen);draw_source=ImageChops.subtract(draw_source,chosen)
            else:
                source_choices=ImageChops.lighter(source_choices,patch);draw_source=ImageChops.lighter(draw_source,chosen);draw_p1=ImageChops.subtract(draw_p1,chosen)
            records.append({'class':FACE_NAMES[n],'owner':owner,'partPixels':len(part),'underFrontPixels':hidden,'selectedPixels':sum(v>0 for v in chosen.tobytes()),'bbox':component.getbbox()})
    layers['base'].paste(clean,(0,0),patches)
    layers['base'].paste(p1,(0,0),draw_p1);layers['base'].paste(source,(0,0),draw_source)
    clear=ImageChops.subtract(patches,front);layers['front hair'].paste((0,0,0,0),(0,0,w,h),clear)
    return ImageChops.lighter(scope,patches),{'face-parts-selected':selected,'face-parts-patches':patches,'face-parts-source':source_choices,'face-parts-p1':p1_choices,'face-parts-clean-skin':clean},{'parts':records,'rule':'Generated semantic component boundaries determine each complete part. Majority under source front hair selects P1; otherwise source artwork. Only map-supported boundaries move by at most 3px. Identical selected labels drive rig extraction. Face backing samples only P1 gray skin with full-precision sums.'}


def face_part_references(base,reference,selected,patches,clean):
    result={n:im.copy() for n,im in reference.items()};size=base.size
    for label,name in ((1,'eyebrow'),(2,'eyelash'),(3,'eyewhite'),(4,'irides')):
        chosen=selected.point(lambda n:255 if n==label else 0);im=result[name]
        im.paste((0,0,0,0),(0,0,*size),patches);im.paste(base,(0,0),chosen)
    white=selected.point(lambda n:255 if n==3 else 0);iris=selected.point(lambda n:255 if n==4 else 0)
    if iris.getbbox():
        backing=clean_skin_field(base,white,iris,8)
        result['eyewhite'].paste(backing,(0,0),iris)
    result['face'].paste(clean,(0,0),patches)
    return result


def generated_face(source,p1,labels,foreground,skin,layers,parts,landmarks):
    """Adopt one complete generated face; never mix source facial drawings."""
    size=p1.size
    observed=labels.point(lambda n:255 if n in (3,4,7) else 0)
    hidden=ImageChops.multiply(labels.point(lambda n:255 if n in (1,8,9) else 0),skin)
    scope=ImageChops.multiply(ImageChops.lighter(observed,hidden),foreground)
    # All visible head-face/ear pixels use the registered P1. The original
    # neck, clothing and hair owners are excluded from this declared scope.
    layers['base'].paste(p1,(0,0),scope)
    selected=ImageChops.multiply(parts,scope)
    # Move a three-pixel clearing margin with eyes/mouth so their old edge
    # cannot remain in the face backing after a drawing is replaced. Keeping
    # that margin on the drawing also preserves the exact neutral composite.
    for radius in (1,2,3):
        empty=selected.point(lambda n:255 if n in (0,7) else 0)
        for n in ((1,2,3,4,5) if radius<=2 else (2,3,4,5)):
            edge=ImageChops.multiply(dilate(parts.point(lambda v:255 if v==n else 0),radius),ImageChops.multiply(scope,empty))
            selected.paste(n,(0,0,*size),edge)
            empty=ImageChops.subtract(empty,edge)
    known=erode(parts.point(lambda n:255 if n==7 else 0),4)
    features=selected.point(lambda n:255 if 1<=n<=6 else 0)
    distance=abs(landmarks['eyes'][1]['center'][0]-landmarks['eyes'][0]['center'][0])
    clean=clean_skin_field(p1,known,features,max(8,round(distance*.1)))
    # Landmark envelopes identify components; they never cut the ear shape.
    # The generated ownership map supplies the natural face/ear boundary.
    ear_parts=components(ImageChops.multiply(scope,labels.point(lambda n:255 if n==4 else 0)))
    ear_ids=set()
    for ear in landmarks['ears']:
        cx,cy=ear['center'];rx,ry=ear['width']/2,ear['height']/2
        scored=[(sum(((i%size[0]-cx)/rx)**2+((i//size[0]-cy)/ry)**2<=1 for i in part),part) for part in ear_parts]
        if scored:
            score,part=max(scored,key=lambda item:item[0])
            if score:ear_ids.update(part)
    ears=bitmap(size,ear_ids)
    report={'source':'registered P1 for all face skin, eyes, brows, nose, mouth and ears','semanticEyeEdgeRadiusPx':3,'mouthEdgeRadiusPx':3,'noseEdgeRadiusPx':0,'scopePixels':sum(v>0 for v in scope.tobytes()),'featurePixels':sum(v>0 for v in features.tobytes()),'earPixels':len(ear_ids),'earBoundary':'Complete ear components from generated ownership map, identified by landmark overlap; no rectangular clipping.','originalFaceArtworkUsed':False,'skinBacking':'Only gray-labelled P1 skin, with full-precision sums; original skin/feature backing is discarded. Eye and mouth clearing margins move with their drawings, leaving clean skin when hidden.'}
    return scope,{'generated-face-scope':scope,'face-parts-selected':selected,'face-parts-patches':scope,'face-parts-clean-skin':clean,'generated-ears':ears},report


def generated_face_references(base,reference,selected,scope,clean):
    result={n:im.copy() for n,im in reference.items()};size=base.size
    for name in ('eyebrow','eyelash','eyewhite','irides','nose','mouth','facedetail'):
        result[name].paste((0,0,0,0),(0,0,*size),scope)
    for label,name in ((1,'eyebrow'),(2,'eyelash'),(3,'eyewhite'),(4,'irides'),(5,'mouth'),(6,'nose')):
        result[name].paste(base,(0,0),selected.point(lambda n:255 if n==label else 0))
    white=selected.point(lambda n:255 if n==3 else 0);iris=selected.point(lambda n:255 if n==4 else 0)
    if iris.getbbox():result['eyewhite'].paste(clean_skin_field(base,white,iris,8),(0,0),iris)
    result['face'].paste(clean,(0,0),scope)
    return result
