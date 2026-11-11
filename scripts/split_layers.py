"""Visible layer separation using sparse landmarks and sampled source colours."""
from __future__ import annotations
import math
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from split_common import bounds, mask, dilate, erode, row_fill, largest_component, flat_palette, classify, darkest_path, unmatte_white, fill_enclosed

ORDER = ['back hair','topwear','neck','ears','face','eyewhite','irides','eyelash','eyebrow','nose','facedetail','mouth','eyewear','front hair','headwear']


def foreground_mask(rgb, landmarks=None):
    w,h=rgb.size; pixels=rgb.load()
    border=[pixels[x,y] for x in range(0,w,max(1,w//64)) for y in (0,h-1)] + [pixels[x,y] for y in range(0,h,max(1,h//64)) for x in (0,w-1)]
    # The largest border colour bin describes the backdrop, even when clothing touches the bottom.
    from collections import Counter
    bins=Counter(tuple(v//8 for v in p) for p in border); key=bins.most_common(1)[0][0]
    sample=[p for p in border if tuple(v//8 for v in p)==key]
    bg=tuple(sorted(p[c] for p in sample)[len(sample)//2] for c in range(3))
    tolerance=max(3,max(max(abs(p[c]-bg[c]) for c in range(3)) for p in sample)+2)
    binary=Image.new('L',rgb.size)
    binary.putdata([0 if max(abs(p[c]-bg[c]) for c in range(3))<=tolerance else 255 for p in rgb.getdata()])
    for x in range(w):
        for y in (0,h-1):
            if binary.getpixel((x,y))==0: ImageDraw.floodfill(binary,(x,y),128)
    for y in range(h):
        for x in (0,w-1):
            if binary.getpixel((x,y))==0: ImageDraw.floodfill(binary,(x,y),128)
    foreground=binary.point(lambda v:0 if v==128 else 255)
    if landmarks is not None:
        # Closed white gaps between strands use the same source-only background
        # rule during partitioning and verification. Keep white facial features,
        # garments and declared accessories; never infer this mask from layers.
        protected=Image.new('L',rgb.size); draw=ImageDraw.Draw(protected)
        left,right=[ear['center'][0] for ear in landmarks['ears']]
        draw.ellipse((left,landmarks['hairPart'][1],right,landmarks['chin'][1]),fill=255)
        for box in [*landmarks['eyes'],*landmarks['ears']]: draw.rectangle(bounds(box),fill=255)
        draw.rectangle((0,min(p[1] for p in landmarks['collar']),w,h),fill=255)
        for item in landmarks.get('accessories',[]): draw.rectangle(bounds(item['box']),fill=255)
        data=bytearray(foreground.tobytes())
        for i,(color,keep) in enumerate(zip(rgb.getdata(),protected.tobytes())):
            if not keep and max(abs(color[c]-bg[c]) for c in range(3))<=tolerance: data[i]=0
        foreground=Image.frombytes('L',rgb.size,bytes(data))
    return foreground,{'rgb':bg,'tolerance':tolerance,'closedGapsUseSourceLandmarks':landmarks is not None}


def local_skin_field(rgb, skin, radius):
    # Normalised convolution extends only sampled featureless skin, not hair/ink.
    colors=flat_palette(rgb,skin,dominant=True)
    fallback=colors[0]
    allowed=erode(skin,2)
    weight=allowed.filter(ImageFilter.GaussianBlur(radius))
    numerator=Image.composite(rgb,Image.new('RGB',rgb.size),allowed).filter(ImageFilter.GaussianBlur(radius))
    out=Image.new('RGB',rgb.size); result=[]
    for p,w in zip(numerator.getdata(),weight.tobytes()):
        result.append(tuple(min(255,round(c*255/w)) for c in p) if w>=3 else fallback)
    out.putdata(result)
    return out


def move_shadows(source, face, front, skin_field, shadow_mask):
    """Solve front RGBA over new skin while conserving the original composite."""
    s=source.load(); fp=face.load(); hp=front.load(); skin=skin_field.load()
    count=0
    for i,v in enumerate(shadow_mask.tobytes()):
        if not v: continue
        x,y=i%source.width,i//source.width
        old=hp[x,y]; base=skin[x,y]; target=s[x,y][:3]
        # Minimum physical alpha can represent both darker and lighter shadow channels.
        alpha=old[3]/255
        for c in range(3):
            delta=target[c]-base[c]
            alpha=max(alpha, -delta/max(1,base[c]) if delta<0 else delta/max(1,255-base[c]))
        alpha=min(1,max(17/255,alpha)); a=math.ceil(alpha*255); alpha=a/255
        color=tuple(round(max(0,min(255,(target[c]-base[c]*(1-alpha))/alpha))) for c in range(3))
        hp[x,y]=color+(a,); fp[x,y]=base+(255,); count+=1
    return count


def split_visible(source, lm, difference=None):
    rgb=source.convert('RGB'); size=rgb.size; w,h=size
    fg,bg=foreground_mask(rgb,lm)
    source=unmatte_white(rgb,fg)
    distance=lm['eyes'][1]['center'][0]-lm['eyes'][0]['center'][0]
    eye_y=sum(e['center'][1] for e in lm['eyes'])/2; chin=lm['chin']; part=lm['hairPart']
    left=round(lm['ears'][0]['center'][0]); right=round(lm['ears'][1]['center'][0])
    cheek=Image.new('L',size); ImageDraw.Draw(cheek).ellipse((left+distance*.18,eye_y+distance*.18,right-distance*.18,chin[1]-distance*.05),fill=255)
    cheek=ImageChops.multiply(cheek,fg)
    neck_sample=Image.new('L',size); ImageDraw.Draw(neck_sample).polygon([tuple(chin),(lm['collar'][0][0],lm['collar'][0][1]),tuple(lm['collar'][1]),tuple(lm['collar'][2])],fill=255)
    neck_sample=ImageChops.multiply(neck_sample,fg)
    hair_sample=Image.new('L',size); ImageDraw.Draw(hair_sample).rectangle((0,0,w,part[1]+(eye_y-part[1])*.55),fill=255)
    hair_sample=ImageChops.multiply(hair_sample,fg)
    cloth_sample=Image.new('L',size); ImageDraw.Draw(cloth_sample).rectangle((0,max(p[1] for p in lm['collar'])+distance*.2,w,h),fill=255)
    cloth_sample=ImageChops.multiply(cloth_sample,fg)
    palettes={'skin':flat_palette(rgb,cheek,dominant=True),'neck':flat_palette(rgb,neck_sample,dominant=True),'hair':flat_palette(rgb,hair_sample),'topwear':flat_palette(rgb,cloth_sample)}
    classes=classify(rgb,[palettes['skin']+palettes['neck'],palettes['hair'],palettes['topwear']])
    # Clothing samples can contain bare arms with the same colours as the face.
    # Do not let that unrelated palette remove visible skin from the head.
    face_classes=classify(rgb,[palettes['skin']+palettes['neck'],palettes['hair']])
    fgb=fg.tobytes(); face_data=bytearray(w*h); neck_data=bytearray(w*h)
    for i,(value,cl) in enumerate(zip(fgb,classes)):
        if not value: continue
        x,y=i%w,i//w
        if face_classes[i]==0 and left-distance*.12 <= x <= right+distance*.03 and part[1]+distance*.5 <= y <= chin[1]+2:
            face_data[i]=255
        if cl==0 and lm['collar'][0][0]-distance*.08 <= x <= lm['collar'][2][0]+distance*.08 and chin[1]-distance*.1 <= y <= lm['collar'][1][1]+distance*.08:
            neck_data[i]=255
    face_skin=largest_component(Image.frombytes('L',size,bytes(face_data)))
    enclosed_face=fill_enclosed(face_skin)
    neck_visible=largest_component(Image.frombytes('L',size,bytes(neck_data)))
    ear_visible=Image.new('L',size)
    for ear in lm['ears']:
        part_skin=ImageChops.multiply(Image.frombytes('L',size,bytes(face_data)),mask(size,[ear]))
        ear_visible=ImageChops.lighter(ear_visible,row_fill(part_skin))
    ear_visible=ImageChops.multiply(ear_visible,fg)
    face_visible=ImageChops.subtract(row_fill(face_skin),ear_visible)
    # Recover the contour ink from hair ownership, without widening the forehead fringe.
    lower=Image.new('L',size); ImageDraw.Draw(lower).rectangle((0,eye_y,w,h),fill=255)
    face_visible=ImageChops.lighter(face_visible,ImageChops.multiply(dilate(face_visible,2),lower))
    face_visible=ImageChops.subtract(ImageChops.multiply(face_visible,fg),ear_visible)
    head=Image.new('L',size); ImageDraw.Draw(head).rectangle((0,0,w,chin[1]+distance*.45),fill=255)
    hair=ImageChops.multiply(fg,head)
    hair=ImageChops.subtract(hair,ImageChops.lighter(face_visible,ImageChops.lighter(ear_visible,neck_visible)))
    # Restore foreground hair inside the row-filled forehead; below the eyes, preserve face ink.
    hp=hair.load(); fv=face_visible.load(); fs=face_skin.load()
    for y in range(max(0,round(part[1])),min(h,round(eye_y))):
        for x in range(w):
            i=y*w+x
            if fgb[i] and face_classes[i]==1 and not enclosed_face.getpixel((x,y)): hp[x,y]=255
    # Connected hair only: isolated eyebrows/eye ink remain facial features.
    hair=largest_component(dilate(hair,1)); hair=ImageChops.multiply(hair,fg)
    hair=ImageChops.subtract(hair,enclosed_face)
    hp=hair.load()
    for y in range(min(h,round(eye_y)),h):
        for x in range(w):
            if fv[x,y]: hp[x,y]=0
    hair=ImageChops.subtract(hair,ear_visible)
    inner=row_fill(ImageChops.lighter(face_skin,neck_visible))
    left_start=max(0,round(min(p[1] for p in lm['bangTips'])))
    left_stop=min(h,round(chin[1]+distance*.35))
    paths={
        'left':darkest_path(rgb,hair,inner,'left',left_start,left_stop),
        'right':darkest_path(rgb,hair,inner,'right',round(part[1]),round(max(p[1] for p in lm['bangTips'])+distance*.1),round(part[0]))
    }
    front=Image.new('L',size); fp=front.load(); hp=hair.load()
    lx={y:x for x,y in paths['left']}; rx={y:x for x,y in paths['right']}
    for y in range(h):
        left_boundary=lx.get(y,left)
        right_boundary=rx.get(y,paths['right'][0][0] if y<paths['right'][0][1] else right)
        face_row=[xx for xx in range(w) if inner.getpixel((xx,y))]
        face_left=face_row[0] if face_row else left
        for x in range(w):
            if not hp[x,y]: continue
            if y<left_start: take=x<=right_boundary
            elif y < eye_y: take=x>=left_boundary and x<=right_boundary
            else:
                take=x>=left_boundary and x<face_left and y<=left_stop
            if take: fp[x,y]=255
    # Fill only gaps between bundles on the same row, never through visible skin.
    front=ImageChops.multiply(row_fill(front),hair)
    if difference is not None:
        generated,editable,_=difference
        # The accepted surface intersection already defines the removed hair.
        # Row filling or a second colour threshold would change that domain.
        # Retain the source-derived bundle up to its root; the generated
        # surface identifies its newly revealed face, not the whole strand.
        front=ImageChops.multiply(ImageChops.lighter(front,editable),hair)
    # Each front pixel has an opaque, colour-derived back-hair underlay.
    hair_envelope=ImageChops.multiply(row_fill(hair),fg)
    hair_envelope=ImageChops.lighter(hair_envelope,front)
    hair_color=palettes['hair'][0]
    back=Image.new('RGBA',size,hair_color+(255,)); back.putalpha(hair_envelope)
    back.paste(source,(0,0),ImageChops.subtract(hair,front))
    # Preserve source under a narrow INTERNAL feather, not at the outer silhouette.
    internal=ImageChops.multiply(ImageChops.subtract(front,erode(front,2)),erode(hair,2))
    back.paste(source,(0,0),internal)
    front_layer=source.copy(); front_layer.putalpha(ImageChops.multiply(source.getchannel('A'),front))
    feather=ImageChops.subtract(front_layer.getchannel('A'),internal.point(lambda v:round(v*.4)))
    front_layer.putalpha(feather)
    feature_boxes=[*lm['eyes'],*lm['brows'],lm['nose'],lm['mouth']]
    protected=dilate(mask(size,feature_boxes),2)
    skin_known=ImageChops.subtract(face_skin,ImageChops.lighter(protected,dilate(front,max(2,round(distance*.06)))))
    field=local_skin_field(rgb,skin_known,max(8,round(distance*.1)))
    face_support=face_visible.copy()
    forehead=Image.new('L',size); ImageDraw.Draw(forehead).ellipse((left,part[1]+distance*.25,right,chin[1]),fill=255)
    face_support=ImageChops.lighter(face_support,ImageChops.multiply(forehead,hair_envelope))
    face_support=ImageChops.subtract(face_support,ear_visible)
    face=field.convert('RGBA'); face.putalpha(face_support)
    face.paste(source,(0,0),ImageChops.subtract(face_visible,front))
    if difference is not None:
        generated,editable,_=difference
        hidden=ImageChops.multiply(front,editable)
        hidden_ears=ImageChops.multiply(hidden,mask(size,lm['ears']))
        hidden_face=ImageChops.subtract(hidden,hidden_ears)
        # Use the generated surface itself, including the forehead beyond a
        # landmark ellipse. No sampled face fill may cover rejected pixels.
        face.putalpha(face_visible)
        face.paste(generated,(0,0),hidden_face)
    ear_layer=source.copy(); ear_layer.putalpha(ear_visible)
    if difference is not None: ear_layer.paste(generated,(0,0),hidden_ears)
    # Exclude landmarks' facial ink from the bang shadow band.
    band=ImageChops.subtract(dilate(front,max(2,round(distance*.06))),front)
    # Brow boxes contain fringe shadows too. Only their dark drawn ink is
    # protected from transfer; eye/nose/mouth envelopes stay fully protected.
    brow_ink=Image.new('L',size); brow_region=mask(size,lm['brows']).tobytes(); ink=bytearray(w*h)
    for i,(a,c,base) in enumerate(zip(brow_region,rgb.getdata(),field.getdata())):
        if a and max(c)<max(base)*.65: ink[i]=255
    brow_ink=Image.frombytes('L',size,bytes(ink))
    shadow_protected=dilate(ImageChops.lighter(mask(size,[*lm['eyes'],lm['nose'],lm['mouth']]),brow_ink),2)
    band=ImageChops.multiply(band,ImageChops.subtract(face_skin,shadow_protected))
    shadow=Image.new('L',size); sp=shadow.load(); rp=rgb.load(); sk=field.load()
    sample_diffs=sorted(sum(abs(a-b) for a,b in zip(c,sk[i%w,i//w]))/3 for i,(c,a) in enumerate(zip(rgb.getdata(),skin_known.tobytes())) if a)
    tolerance=max(3,sample_diffs[round((len(sample_diffs)-1)*.9)])
    for i,a in enumerate(band.tobytes()):
        if a:
            x,y=i%w,i//w
            if sum(sk[x,y])-sum(rp[x,y])>tolerance*3: sp[x,y]=255
    # Coverage recovery has already altered RGB at exterior antialias pixels.
    # A transferred shadow must reconstruct the observed source RGB over skin,
    # not reinterpret that recovered foreground colour as an opaque observation.
    shadow_count=move_shadows(rgb,face,front_layer,field,shadow)
    # Backing includes the transferred shadow, so no front pixel is unsupported.
    back.putalpha(ImageChops.lighter(back.getchannel('A'),shadow))
    body=ImageChops.subtract(fg,ImageChops.lighter(hair,ImageChops.lighter(face_visible,ear_visible)))
    neck_visible=ImageChops.multiply(row_fill(neck_visible),body)
    topmask=ImageChops.subtract(body,neck_visible)
    top=source.copy(); top.putalpha(topmask)
    neck=source.copy(); neck.putalpha(neck_visible)
    layers={'back hair':back,'topwear':top,'neck':neck,'ears':ear_layer,'face':face}
    # Extract features against local skin. The original RGB remains untouched.
    for name,boxes in [('eyebrow',lm['brows']),('nose',[lm['nose']]),('mouth',[lm['mouth']])]:
        region=ImageChops.subtract(mask(size,boxes),ImageChops.lighter(front,shadow))
        out=Image.new('RGBA',size); op=out.load()
        for i,a in enumerate(region.tobytes()):
            if a:
                x,y=i%w,i//w; c=rp[x,y]; base=sk[x,y]
                if sum(base)-sum(c)>max(9,tolerance*3): op[x,y]=c+(255,)
        layers[name]=out
    eyes=mask(size,lm['eyes']); eyes=ImageChops.subtract(eyes,ImageChops.lighter(front,shadow))
    whites=Image.new('RGBA',size); iris=Image.new('RGBA',size); lashes=Image.new('RGBA',size)
    wp,ip,lp=whites.load(),iris.load(),lashes.load()
    for box in lm['eyes']:
        x0,y0,x1,y1=bounds(box); samples=[]
        for y in range(max(0,y0),min(h,y1)):
            for x in range(max(0,x0),min(w,x1)):
                if eyes.getpixel((x,y)): samples.append(sum(rp[x,y])/3)
        if not samples: continue
        samples.sort(); dark=samples[len(samples)//5]; light=samples[round((len(samples)-1)*.85)]
        for y in range(max(0,y0),min(h,y1)):
            for x in range(max(0,x0),min(w,x1)):
                if not eyes.getpixel((x,y)): continue
                c=rp[x,y]; lum=sum(c)/3
                if lum>=light and max(c)-min(c)<max(8,max(sk[x,y])-min(sk[x,y])*.65): wp[x,y]=c+(255,)
                elif lum<dark: lp[x,y]=c+(255,)
                elif sum(sk[x,y])-sum(c)>tolerance*3: ip[x,y]=c+(255,)
    white_visible=whites.getchannel('A')
    # The preview uses the white-eye layer as the iris stencil. It needs a
    # backing behind the iris and lash, while visible white pixels stay original.
    white_support=ImageChops.lighter(white_visible,ImageChops.lighter(iris.getchannel('A'),lashes.getchannel('A')))
    white_field=local_skin_field(rgb,white_visible,max(4,round(distance*.05))).convert('RGBA')
    white_field.putalpha(white_support);white_field.paste(whites,(0,0),white_visible)
    layers.update({'eyewhite':white_field,'irides':iris,'eyelash':lashes,'facedetail':Image.new('RGBA',size),'front hair':front_layer})
    # Replace feature pixels in the face underlay with nearby skin; draws remain in their own layers.
    features=Image.new('L',size)
    for name in ('eyewhite','irides','eyelash','eyebrow','nose','mouth'): features=ImageChops.lighter(features,layers[name].getchannel('A'))
    face.paste(field.convert('RGBA'),(0,0),features)
    for item in lm.get('accessories',[]):
        region=ImageChops.multiply(mask(size,[item['box']]),fg)
        art=source.copy(); art.putalpha(region); layers[item['layer']]=art
    composite=Image.new('RGBA',size)
    for name in ORDER:
        if name in layers: composite.alpha_composite(layers[name])
    report={'background':bg,'palettes':palettes,'paths':paths,'shadowPixels':shadow_count,'shadowDistance':max(2,round(distance*.06)),
            'shadowColourTolerance':tolerance,'frontWithoutBacking':sum(a>16 and b<=16 for a,b in zip(front_layer.getchannel('A').tobytes(),back.getchannel('A').tobytes())),
            'hiddenArtwork':'generated face where validated' if difference else 'sampled local colours only; no inferred facial ink',
            'productionReady':False,'limitations':['Hidden back hair, neck and clothing are not generated in this stage.','Expressions require supplied or generated artwork.']}
    return layers,composite,report,{'foreground':fg,'hair':hair,'front':front,'face-skin':face_skin,'shadow':shadow,'protected':protected,'face-visible':face_visible,'ears-visible':ear_visible,'neck-visible':neck_visible,'topwear-visible':topmask,'eyewhite-visible':white_visible}


def conserve_visible_pixels(original, layers, masks, landmarks=None):
    """Assign every source foreground pixel once; inferred paint stays below its owner.

    This conservative candidate keeps exterior source pixels opaque. Edge
    decontamination is reported as pending rather than silently changing them.
    """
    size=original.size; w,h=size; fg=masks['foreground'].tobytes()
    names=[n for n in ORDER if n in layers]; index={n:i for i,n in enumerate(names)}
    owners=bytearray([255])*(w*h)
    visible={
        'back hair':masks['hair'], 'topwear':masks['topwear-visible'],
        'neck':masks['neck-visible'],'ears':masks['ears-visible'],
        'face':masks['face-visible'],
        **{n:masks.get(f'{n}-visible',layers[n].getchannel('A')) for n in ('eyewhite','irides','eyelash','eyebrow','nose','facedetail','mouth')},
        'front hair':ImageChops.lighter(masks['front'],masks['shadow'])}
    # These boxes are provisional source ownership for the initial candidate.
    # The generated ownership map later replaces them with the actual accessory.
    for item in (landmarks or {}).get('accessories',[]):
        name=item['layer']
        if name in index:
            region=mask(size,[item['box']])
            visible[name]=ImageChops.lighter(visible.get(name,Image.new('L',size)),region)
    for name in names:
        if name not in visible: continue
        for i,a in enumerate(visible[name].tobytes()):
            if fg[i] and a: owners[i]=index[name]
    # Unclassified visible pixels stay in the existing clothing/base layer and
    # are counted explicitly; they are never discarded or replaced by a fill.
    unclassified=0
    for i,a in enumerate(fg):
        if a and owners[i]==255: owners[i]=index['topwear'];unclassified+=1
    original_bytes=original.convert('RGBA').tobytes(); output={}; counts={}
    for name in names:
        rank=index[name]; data=bytearray(layers[name].tobytes()); owned=0;hidden=0
        for i,owner in enumerate(owners):
            offset=i*4
            if owner==rank:
                # Transferred shadows are solved RGBA over the opaque face,
                # not opaque source-colour patches that travel with the hair.
                if not (name=='front hair' and masks['shadow'].getpixel((i%w,i//w)) and not masks['front'].getpixel((i%w,i//w))):
                    data[offset:offset+4]=original_bytes[offset:offset+3]+b'\xff'
                owned+=1
            elif owner!=255 and owner>rank:
                if data[offset+3]: hidden+=1
            else: data[offset:offset+4]=b'\0\0\0\0'
        image=Image.frombytes('RGBA',size,bytes(data)); output[name]=image; counts[name]={'visible':owned,'hidden':hidden}
    composite=Image.new('RGBA',size)
    resolved_shadows=0
    for name in names:
        if name=='front hair':
            # A shadow solved over clean face skin may now sit over eyewear.
            # Re-solve only mismatching shadow pixels over the actual lower
            # layers; preserve the existing alpha and exact legacy drawings.
            predicted=Image.alpha_composite(composite,output[name])
            fix=bytearray(w*h)
            for i,a in enumerate(masks['shadow'].tobytes()):
                if a and not masks['front'].getpixel((i%w,i//w)) and owners[i]==index[name]:
                    point=(i%w,i//w)
                    if predicted.getpixel(point)!=original.getpixel(point): fix[i]=255
            if any(fix):
                resolved_shadows=move_shadows(original,composite,output[name],composite.convert('RGB'),Image.frombytes('L',size,bytes(fix)))
        composite.alpha_composite(output[name])
    # The reference mask must be independently derived from the SOURCE. Using
    # the partition's own mask would hide lost source pixels. Never composite
    # over the original character, which would conceal missing coverage too.
    source_foreground,_=foreground_mask(original.convert('RGB'),landmarks)
    expected=Image.new('RGBA',size); expected.paste(original.convert('RGBA'),(0,0),source_foreground)
    delta=ImageChops.difference(composite,expected)
    changed=sum(any(p) for p in delta.getdata())
    reference_alpha=source_foreground.tobytes(); actual_alpha=composite.getchannel('A').tobytes()
    coverage=sum(a>0 for a in reference_alpha); assigned=sum(c['visible'] for c in counts.values())
    missing=sum(f>0 and a==0 for a,f in zip(actual_alpha,reference_alpha))
    extra=sum(a>0 and not f for a,f in zip(actual_alpha,reference_alpha))
    owner_image=Image.frombytes('L',size,bytes(owners))
    check={'pass':changed==0 and assigned==coverage and extra==0,
           'shadowsResolvedOverActualUnderlay':resolved_shadows,
           'foregroundPixels':coverage,'assignedVisiblePixels':assigned,'unclassifiedPixelsAssignedToBase':unclassified,
           'changedPixels':changed,'maximumChannelDifference':max(hi for lo,hi in delta.getextrema()),
           'extraForegroundPixels':extra,'missingSourceForegroundPixels':missing,'layers':counts,
           'comparison':'RGBA against independently masked original source, on transparent black; no source-character backdrop',
           'edgeTreatment':'source opaque pixels retained; exterior unmatting not applied to this conservative candidate'}
    return output,composite,check,owner_image
