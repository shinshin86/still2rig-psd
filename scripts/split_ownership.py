"""Generated visible ownership, with source-guided boundary changes limited to 3px."""
from __future__ import annotations
import json,math
from collections import deque
from pathlib import Path
from PIL import Image,ImageChops,ImageFilter,ImageDraw
from split_common import dump,square_pad,square_unpad,dilate,erode,mask,classify,unmatte_white
from expression_requests_common import file_hash
from import_expression_results import alignment_check,compensate_result
from inspect_layers import make_contact_sheet

NAMES=['background','front hair','back hair','face','ears','neck','topwear','face parts','headwear','eyewear']
COLORS=[(0,0,0),(255,0,0),(0,0,255),(0,255,0),(255,255,0),(0,255,255),(128,0,128),(255,255,255),(255,128,0),(255,128,192)]


def colorize(labels):
    im=Image.new('RGB',labels.size);im.putdata([COLORS[v] for v in labels.tobytes()]);return im


def nearest_labels(image, palette_size=8):
    rgb=image.convert('RGB');colors=rgb.getcolors(rgb.width*rgb.height)
    lookup={c:min(range(palette_size),key=lambda k:sum((c[j]-COLORS[k][j])**2 for j in range(3))) for _,c in colors}
    return Image.frombytes('L',rgb.size,bytes(lookup[c] for c in rgb.getdata()))


def label_mask(labels,values):
    return labels.point(lambda v:255 if v in values else 0)


def protect_face_owners(labels,generated,foreground,landmarks):
    """Generated facial ink and landmark-contained face cannot become hair."""
    region=mask(labels.size,[*landmarks['eyes'],*landmarks['brows'],landmarks['nose'],landmarks['mouth']])
    data=bytearray(labels.tobytes());protected=bytearray(len(data));restored=0
    for i,(original,fg,inside) in enumerate(zip(generated.tobytes(),foreground.tobytes(),region.tobytes())):
        if fg and (original==7 or (original==3 and inside)):
            protected[i]=255
            if data[i] in (1,2):data[i]=original;restored+=1
    return Image.frombytes('L',labels.size,bytes(data)),Image.frombytes('L',labels.size,bytes(protected)),{'protectedPixels':sum(v>0 for v in protected),'restoredFromHairPixels':restored,'remainingHairPixels':sum(v>0 and n in (1,2) for v,n in zip(protected,data)),'rule':'Never override generated face-parts, or generated face inside facial landmark envelopes, with front/back hair. Source-observed overlapping hair remains hair when the generated map also labels it hair. This guard runs after all ownership priorities.'}


def snap_boundaries(source,labels,foreground,radius=3):
    """Only exchange labels witnessed <=radius Euclidean pixels away.

    Local colour estimates use eroded class interiors, never a global source
    colour classifier. The source foreground independently fixes background.
    Missing labels farther away remain explicitly unassigned.
    """
    w,h=source.size;rgb=source.convert('RGB');pixels=rgb.load();raw=labels.load();fg=foreground.load()
    boundary=ImageChops.difference(labels.filter(ImageFilter.MaxFilter(2*radius+1)),labels.filter(ImageFilter.MinFilter(2*radius+1)))
    active=[(i%w,i//w) for i,v in enumerate(boundary.tobytes()) if v]
    fields=[]
    for n in range(len(COLORS)):
        core=erode(label_mask(labels,{n}),2);weight=core.filter(ImageFilter.BoxBlur(radius+3))
        numerator=Image.composite(rgb,Image.new('RGB',rgb.size),core).filter(ImageFilter.BoxBlur(radius+3))
        fields.append((weight.load(),numerator.load()))
    out=bytearray(labels.tobytes());offsets=sorted([(dx*dx+dy*dy,dx,dy) for dy in range(-radius,radius+1) for dx in range(-radius,radius+1) if dx*dx+dy*dy<=radius*radius])
    changed=[];unassigned=[];forced_background=[]
    # Outside the source silhouette is never allowed to paint new pixels.
    for i,(v,f) in enumerate(zip(labels.tobytes(),foreground.tobytes())):
        if not f and v:
            x,y=i%w,i//w;dist=next((d for d,dx,dy in offsets if 0<=x+dx<w and 0<=y+dy<h and raw[x+dx,y+dy]==0),None)
            out[i]=0
            if dist is None:forced_background.append(i)
            else:changed.append((i,v,0,math.sqrt(dist)))
        elif f and v==0:unassigned.append(i)
    for x,y in active:
        if not fg[x,y]:continue
        original=raw[x,y];c=pixels[x,y];candidates={}
        if original in (8,9):continue
        for d,dx,dy in offsets:
            xx,yy=x+dx,y+dy
            if 0<=xx<w and 0<=yy<h:
                n=raw[xx,yy]
                if n and n not in (8,9) and n not in candidates:candidates[n]=d
        if not candidates:continue
        def cost(n):
            weight,numerator=fields[n];weight=weight[x,y]
            if weight<5:return float('inf')
            mean=[min(255,v*255/weight) for v in numerator[x,y]]
            return sum((c[j]-mean[j])**2 for j in range(3))+(0 if n==original else 300+candidates[n]*12)
        best=min(candidates,key=lambda n:(cost(n),candidates[n],n))
        # A thin class without stable interior stays where the generator put it.
        if original and (not math.isfinite(cost(original)) or cost(best)>=cost(original)):best=original
        if not original and not math.isfinite(cost(best)):best=min(candidates,key=lambda n:(candidates[n],n))
        if best!=original:
            out[y*w+x]=best;changed.append((y*w+x,original,best,math.sqrt(candidates[best])))
    missing=[i for i in unassigned if out[i]==0]
    snapped=Image.frombytes('L',source.size,bytes(out));change_mask=Image.new('L',source.size);change_mask.putdata([255 if a!=b else 0 for a,b in zip(out,labels.tobytes())])
    report={'radiusPx':radius,'distanceMetric':'Euclidean, at native source scale','method':'Choose only a nearby generated label using local source-colour means of eroded class interiors; 300 squared-RGB penalty for changing a label. Source foreground fixes background independently.',
        'boundedChangedPixels':len(changed),'maximumBoundedDisplacement':max([d for _,_,_,d in changed],default=0),
        'sourceBackgroundCorrectionsBeyondRadius':len(forced_background),'unassignedVisiblePixels':len(missing),
        'completeWithinRadius':not missing and not forced_background,'unassignedPolicy':'Keep source pixels in an explicitly unassigned layer, not in a fabricated part.',
        'countsBefore':{NAMES[n]:labels.tobytes().count(n) for n in range(len(COLORS))},'countsAfter':{NAMES[n]:out.count(n) for n in range(len(COLORS))}}
    return snapped,report,change_mask


def assemble_owned(source,p1,p2,foreground,labels,p1hair,p1foreground,p2foreground):
    front=label_mask(labels,{1});back=label_mask(labels,{2});allhair=ImageChops.lighter(front,back)
    known=ImageChops.multiply(label_mask(labels,{3,4,5,6,7}),foreground)
    unknown=ImageChops.multiply(label_mask(labels,{0}),foreground)
    # Only observed occlusions consume generated paint. P2 sits beneath all
    # hair; P1 non-hair surfaces replace it directly beneath the front hair.
    base=p2.copy();base.putalpha(ImageChops.multiply(p2foreground,allhair))
    p1surface=ImageChops.multiply(front,ImageChops.subtract(p1foreground,p1hair))
    base.paste(p1,(0,0),p1surface);base.paste(source,(0,0),known)
    rear=p1.copy();rear.putalpha(ImageChops.multiply(front,p1hair));rear.paste(source,(0,0),back)
    fringe=source.copy();fringe.putalpha(front)
    unresolved=source.copy();unresolved.putalpha(unknown)
    layers={'base':base,'back hair':rear,'front hair':fringe}
    if unknown.getbbox():layers['unassigned']=unresolved
    composite=Image.new('RGBA',source.size)
    for im in layers.values():composite.alpha_composite(im)
    expected=source.copy();expected.putalpha(foreground);expected=Image.alpha_composite(Image.new('RGBA',source.size),expected)
    delta=ImageChops.difference(composite,expected)
    check={'pass':all(not c.getbbox() for c in delta.split()),'foregroundPixels':sum(a>0 for a in foreground.tobytes()),
        'changedPixels':sum(any(v) for v in delta.getdata()),'maximumChannelDifference':max(hi for lo,hi in delta.getextrema()),
        'unassignedPixels':sum(a>0 for a in unknown.tobytes()),'comparison':'RGBA on transparent black against independent source foreground; unassigned source pixels are explicitly counted'}
    return layers,composite,check,{'p1-hidden-hair':ImageChops.multiply(front,p1hair),'p1-hidden-surface':p1surface,'p2-hidden-surface':ImageChops.multiply(p2foreground,allhair)}


def constrain_completed_labels(labels,foreground,p2foreground,landmarks):
    """Non-hair above the collar must fit P2; preserve existing hair owners."""
    w,h=labels.size;data=bytearray(labels.tobytes());fg=foreground.tobytes();p2fg=p2foreground.tobytes()
    collar_y=min(p[1] for p in landmarks['collar']);rejected=[];body_reassigned=[]
    for i,n in enumerate(data):
        # The palette has no separate arm/torso class. Skin below the collar
        # belongs to the body, even if a generated map calls all skin "face".
        if n in (3,4,7) and fg[i] and i//w>=collar_y:
            data[i]=6;body_reassigned.append(i)
        if n in (3,4,5,6,7) and fg[i] and not p2fg[i] and i//w<collar_y:rejected.append(i)
    # Assign rejected head-exterior pixels to the nearest existing hair label.
    # This explicit geometry rule is separate from the <=3px edge refinement.
    nearest=bytearray(w*h);queue=deque()
    for i,n in enumerate(data):
        if n in (1,2):nearest[i]=n;queue.append(i)
    if rejected and not queue:raise ValueError('Cannot assign rejected body pixels without any hair labels.')
    while queue and rejected:
        i=queue.popleft();x,y=i%w,i//w
        for n in ((i-1 if x else -1),(i+1 if x+1<w else -1),(i-w if y else -1),(i+w if y+1<h else -1)):
            if n>=0 and not nearest[n]:nearest[n]=nearest[i];queue.append(n)
    for i in rejected:data[i]=nearest[i]
    edits=bytearray(w*h)
    for i in rejected+body_reassigned:edits[i]=255
    return Image.frombytes('L',labels.size,bytes(data)),{'headExteriorNonHairToHairPixels':len(rejected),'headLabelsBelowCollarToBodyPixels':len(body_reassigned),'rule':'Non-hair source pixels outside P2 above the collar go to the nearest existing hair label (Manhattan distance, row-major ties). Face, ear and facial-feature labels below the collar belong to topwear/body; neck and hair labels stay unchanged. Existing hair owners are preserved, including above the parting. These explicit geometry corrections are not subject to the separate 3px boundary-refinement radius.'},Image.frombytes('L',labels.size,bytes(edits))


def match_hidden_rear_hair(source,p3,foreground,labels,p3foreground):
    """Tint generated hidden hair to observed rear-hair shadows, preserving alpha."""
    if any(im.size!=source.size for im in (p3,foreground,labels,p3foreground)):
        raise ValueError('Rear-hair color matching needs one shared canvas.')
    rgb=source.convert('RGB');back=ImageChops.multiply(label_mask(labels,{2}),foreground)
    support=erode(back,2)
    if not support.getbbox():support=back
    gradient=ImageChops.difference(rgb.filter(ImageFilter.MaxFilter(3)),rgb.filter(ImageFilter.MinFilter(3))).convert('L')
    samples=[(i,g,c) for i,(g,c,v) in enumerate(zip(gradient.tobytes(),rgb.getdata(),support.tobytes())) if v]
    if not samples:raise ValueError('No visible source rear hair is available for shadow color matching.')
    gradient_limit=sorted(g for _,g,_ in samples)[len(samples)//2]
    smooth=sorted((item for item in samples if item[1]<=gradient_limit),key=lambda item:sum(item[2]))
    shadow=smooth[:max(1,len(smooth)//3)]
    target=[sorted(c[k] for _,_,c in shadow)[len(shadow)//2] for k in range(3)]
    shadow_mask=bytearray(source.width*source.height)
    for i,_,_ in shadow:shadow_mask[i]=255
    hidden=ImageChops.multiply(ImageChops.multiply(foreground,p3foreground),ImageChops.invert(back))
    opaque=ImageChops.multiply(hidden,p3.getchannel('A').point(lambda a:255 if a==255 else 0))
    interior=erode(opaque,2)
    if not interior.getbbox():interior=opaque
    generated=[c for c,v in zip(p3.convert('RGB').getdata(),interior.tobytes()) if v]
    if not generated:raise ValueError('Generated rear hair has no opaque hidden paint to color-match.')
    median=[sorted(c[k] for c in generated)[len(generated)//2] for k in range(3)]
    if any(a==0 and b>0 for a,b in zip(median,target)):
        raise ValueError('Generated rear-hair shadow has an empty color channel.')
    gains=[b/a if a else 1 for a,b in zip(median,target)]
    result=p3.copy();pixels=result.load();changed=0
    for i,(v,pixel) in enumerate(zip(hidden.tobytes(),p3.getdata())):
        if not v or not pixel[3]:continue
        corrected=tuple(round(min(255,max(0,pixel[k]*gains[k]))) for k in range(3))+(pixel[3],)
        pixels[i%source.width,i//source.width]=corrected;changed+=corrected!=pixel
    report={'method':'Per-channel median gain from generated opaque hidden hair to the darkest third of low-gradient, eroded visible source rear hair. Only non-visible P3 paint changes; source rear hair and alpha stay unchanged.',
            'sourceSamplePixels':len(shadow),'sourceShadowRgb':target,'generatedSamplePixels':len(generated),'generatedMedianRgb':median,
            'gains':gains,'changedPixels':changed,'alphaUnchanged':result.getchannel('A').tobytes()==p3.getchannel('A').tobytes()}
    return result,hidden,Image.frombytes('L',source.size,bytes(shadow_mask)),report


def assemble_completed(source,p1,p2,p3,foreground,labels,p1hair,p1foreground,p2foreground,p3foreground):
    front=label_mask(labels,{1});back=label_mask(labels,{2});hair=ImageChops.lighter(front,back)
    known=ImageChops.multiply(label_mask(labels,{3,4,5,6,7}),foreground);unknown=ImageChops.multiply(label_mask(labels,{0}),foreground)
    # Complete rear hair lies behind the body. Its hidden interior comes from
    # actual P3 paint, including under the original face and ears.
    rear=p3.copy();rear.putalpha(ImageChops.multiply(ImageChops.multiply(p3foreground,foreground),p3.getchannel('A')));rear.paste(source,(0,0),back)
    # P1 hair identifies an occluding rear surface. Putting P2 skin above it
    # would hide the completed P3 and reveal a scalp strip when bangs move.
    occluders=ImageChops.lighter(front,label_mask(labels,{8,9}))
    hiddenbody=ImageChops.multiply(ImageChops.multiply(occluders,p2foreground),ImageChops.invert(p1hair));base=p2.copy();base.putalpha(hiddenbody)
    p1surface=ImageChops.multiply(hiddenbody,ImageChops.subtract(p1foreground,p1hair));base.paste(p1,(0,0),p1surface);base.paste(source,(0,0),known)
    fringe=source.copy();fringe.putalpha(front);unresolved=source.copy();unresolved.putalpha(unknown)
    layers={'back hair':rear,'base':base,'front hair':fringe}
    from split_accessories import accessory_layers
    accessory_layers(source,p1,foreground,labels,p1hair,p1foreground,layers)
    if unknown.getbbox():layers['unassigned']=unresolved
    composite=Image.new('RGBA',source.size)
    for im in layers.values():composite.alpha_composite(im)
    expected=source.copy();expected.putalpha(foreground);expected=Image.alpha_composite(Image.new('RGBA',source.size),expected);delta=ImageChops.difference(composite,expected)
    check={'pass':all(not c.getbbox() for c in delta.split()),'foregroundPixels':sum(a>0 for a in foreground.tobytes()),'changedPixels':sum(any(v) for v in delta.getdata()),'maximumChannelDifference':max(hi for lo,hi in delta.getextrema()),'unassignedPixels':sum(a>0 for a in unknown.tobytes()),'comparison':'RGBA on transparent black against independent source foreground; includes explicitly unassigned pixels'}
    return layers,composite,check,{'p1-hidden-surface':p1surface,'p2-hidden-surface':hiddenbody,'p3-hidden-hair':ImageChops.multiply(ImageChops.multiply(ImageChops.subtract(foreground,back),p3foreground),p3.getchannel('A'))}


def ownership_candidate(source,p1,p2,fg,fg1,fg2,lm,palettes,root,result_file,request_file,provenance,completion=None,refine=False,source_hair=None,p1_fringe_face=False,face_parts_files=None,face_source='original'):
    request=json.loads(request_file.read_text());input_file=request_file.parent/'input.png';expected,padding=square_pad(source,(255,255,255,255))
    if request['sourceSha256']!=provenance['sourceSha256'] or request['padding']!=padding or file_hash(input_file)!=request['inputSha256'] or Image.open(input_file).convert('RGBA').tobytes()!=expected.tobytes():raise ValueError('Ownership request does not match original source.')
    if file_hash(result_file)!=request['resultSha256']:raise ValueError('Ownership result hash changed.')
    raw=Image.open(result_file).convert('RGBA')
    if abs(raw.width/raw.height-1)>.01:raise ValueError('Ownership map must keep the square request framing.')
    reference,_=square_pad(fg,0);reference=reference.convert('RGBA')
    maximum=Image.new('L',raw.size)
    for c in raw.convert('RGB').split():maximum=ImageChops.lighter(maximum,c)
    silhouette=maximum.point(lambda v:255 if v>40 else 0).convert('RGBA')
    edge=ImageChops.subtract(dilate(reference.getchannel('R'),5),erode(reference.getchannel('R'),5));band=Image.new('RGBA',reference.size);band.putalpha(edge)
    alignment=alignment_check(reference,silhouette,band,24,1,12,.03)
    dump(root/'ownership-alignment.json',alignment)
    if not alignment['pass']:raise ValueError('Ownership alignment exceeds existing shift/scale limits.')
    aligned=compensate_result(expected,raw,alignment,1);aligned.save(root/'ownership-aligned-square.png')
    # Quantization follows registration, so interpolation colors never become labels.
    rounded=nearest_labels(aligned,len(request.get("palette",{})) or 8);labels=square_unpad(rounded,padding)
    from split_accessories import constrain_accessory_labels,constrain_garment_labels,retain_accessory_ink
    labels,accessory_support=constrain_accessory_labels(labels,square_unpad(aligned,padding),lm)
    # Preserve previously accepted legacy eight-color maps byte for byte.
    garment_support={'detachedHeadClothingPixelsReassigned':0,'legacyPaletteUnchanged':True}
    if len(request.get('palette',{}))>8:labels,garment_support=constrain_garment_labels(labels,lm)
    labels,ink_support,ink_changes=retain_accessory_ink(source,labels,fg,palettes)
    accessory_support['sourceInkRetention']=ink_support
    ink_changes.save(root/'accessory-ink-changes.png');dump(root/'accessory-ink-retention.json',ink_support)
    colorize(labels).save(root/'ownership-rounded.png')
    snapped,snap,changed=snap_boundaries(source,labels,fg,3);colorize(snapped).save(root/'ownership-snapped.png');snapped.save(root/'ownership-labels.png');changed.save(root/'ownership-changes.png')
    dump(root/'ownership-boundaries.json',snap)
    geometry=None
    if completion:
        snapped,geometry,edits=constrain_completed_labels(snapped,fg,fg2,lm);colorize(snapped).save(root/'ownership-constrained.png');snapped.save(root/'ownership-labels.png');edits.save(root/'ownership-geometry-changes.png');dump(root/'ownership-geometry.json',geometry)
    refinement=None;visible_source=source;face_parts=None;face_parts_report=None
    if refine:
        from split_refinement import resolve_missing,refine_layers,prioritize_removed_hair,source_skin_mask,extend_crown_to_outline
        from split_image import generated_face_surface
        if source_hair is None:raise ValueError('Ownership refinement requires original hair support.')
        skin=generated_face_surface(p1,palettes,lm,{'padding':[0,0,0,0],'cropBox':[0,0,*source.size]})
        if face_parts_files:
            from split_features import import_face_parts
            face_parts,face_parts_report=import_face_parts(p1,skin,lm,*face_parts_files,provenance['sourceSha256'],root)
        map_ears=label_mask(labels,{4});source_skin=source_skin_mask(source,palettes)
        snapped,priority_support,priority=prioritize_removed_hair(snapped,source_hair,skin,fg,map_ears,source_skin)
        colorize(snapped).save(root/'ownership-priority.png');dump(root/'ownership-priority.json',priority)
        snapped,crown_changes,crown=extend_crown_to_outline(snapped,fg,map_ears,source_skin,lm,source)
        colorize(snapped).save(root/'ownership-crown.png');dump(root/'ownership-crown.json',crown)
        snapped,resolved=resolve_missing(snapped,fg);snapped.save(root/'ownership-labels.png');colorize(snapped).save(root/'ownership-resolved.png')
        snapped,face_protection,face_guard=protect_face_owners(snapped,labels,fg,lm)
        snapped.save(root/'ownership-labels.png');colorize(snapped).save(root/'ownership-face-protected.png');face_protection.save(root/'ownership-face-protection.png');dump(root/'ownership-face-protection.json',face_guard)
    overlay=Image.blend(source.convert('RGB'),colorize(snapped),.38);overlay.save(root/'ownership-overlay.png')
    # This classifies only already-generated P1 hidden artwork. Visible source
    # ownership uses the map, bounded snapping and explicit support rules above.
    groups=[palettes['hair'],palettes['skin']+palettes.get('neck',[]),[(255,255,255)],palettes['topwear']]
    classes=classify(p1.convert('RGB'),groups);p1hair=Image.frombytes('L',source.size,bytes(255 if v==0 else 0 for v in classes));p1hair=ImageChops.multiply(p1hair,fg1)
    facial=mask(source.size,[*lm['eyes'],*lm['brows'],lm['nose'],lm['mouth']]);p1hair=ImageChops.subtract(p1hair,dilate(facial,2))
    if completion:
        rear_paint,rear_color_mask,rear_color_samples,rear_color_report=match_hidden_rear_hair(source,completion['image'],fg,snapped,completion['foreground'])
        rear_paint.save(root/'p3-color-matched.png')
        if refine:
            rear_paint=unmatte_white(rear_paint.convert('RGB'),completion['foreground'],edge_width=6,fallback_colours=palettes['hair'],enclosed_gaps=True)
            rear_paint.putalpha(ImageChops.multiply(rear_paint.getchannel('A'),completion['image'].getchannel('A')))
            rear_paint.save(root/'p3-unmatted.png')
        layers,composite,check,hidden=assemble_completed(source,p1,p2,rear_paint,fg,snapped,p1hair,fg1,fg2,completion['foreground'])
        hidden.update({'p3-color-match-region':rear_color_mask,'p3-shadow-color-samples':rear_color_samples})
    else:layers,composite,check,hidden=assemble_owned(source,p1,p2,fg,snapped,p1hair,fg1,fg2)
    if refine:
        layers,composite,check,extra,refinement,visible_source=refine_layers(source,p1,fg,snapped,layers,palettes,lm,skin=skin,p1_fringe_face=p1_fringe_face,source_hair=source_hair,face_parts=face_parts,face_source=face_source);hidden.update(extra);hidden.update({'original-hair-p1-skin-priority':priority_support,'priority-excluded-map-ears':map_ears,'priority-excluded-source-skin':source_skin,'crown-extended':crown_changes});refinement['missingAssignment']=resolved;refinement['frontHairPriority']=priority;refinement['crownExtension']=crown;refinement['generatedRearWhiteMatte']='P3 background edges, including enclosed strand gaps, are unmatted before source-visible back hair is restored, using the same 6px edge and sampled-hair fallback.'
        if face_parts_report:refinement['facePartsImport']=face_parts_report
        dump(root/'ownership-refinement.json',refinement)
    folder=root/'layers';folder.mkdir(exist_ok=True)
    for n,im in layers.items():im.save(folder/(n+'.png'))
    composite.save(root/'composite.png');make_contact_sheet([folder/(n+'.png') for n in layers],root/'layers-overview.png')
    visible=root/'visible-parts';visible.mkdir(exist_ok=True)
    for n,name in enumerate(NAMES[1:],1):
        im=visible_source.copy();im.putalpha(ImageChops.multiply(label_mask(snapped,{n}),visible_source.getchannel('A') if refine else fg));im.save(visible/(name+'.png'))
    make_contact_sheet([visible/(n+'.png') for n in NAMES[1:]],root/'visible-parts-overview.png')
    (root/'masks').mkdir(exist_ok=True)
    for n,im in hidden.items():im.save(root/'masks'/(n+'.png'))
    report={'schemaVersion':1,'purpose':'generated ownership candidate before PSD assembly','productionReady':False,'psdBuilt':False,
        **provenance,'ownershipResultSha256':file_hash(result_file),'ownershipAlignment':alignment,'accessorySupport':accessory_support,'garmentSupport':garment_support,'boundaryRefinement':snap,'staticConservation':check,
        'method':{'visible':'Original pixels, owned by nearest palette class from generated map, then source-guided boundary changes <=3px. No P0/P1 color difference ownership.',
        'hidden':'P1 hair and non-hair paint only under original front hair; P2 only under original hair. No invented color-field artwork.',
        'order':list(layers),'base':'Non-hair parts held together for the same affine hair comparison; individual visible cutouts are also exported.'},
        'artifacts':{n:{'sha256':file_hash(folder/(n+'.png')),'pixels':sum(v>0 for v in im.getchannel('A').tobytes())} for n,im in layers.items()},
        'limitations':['Review candidate only; no PSD, expressions or renderer physics validation.','Foreground conservation includes an explicit unassigned layer if the map misses visible source pixels.','Fine edges and semantic front/back boundary may remain wrong within or beyond the permitted correction range.']}
    if completion:
        report.update({'p3Sha256':completion['sha256'],'p3Alignment':completion['alignment'],'p3HiddenColorMatch':rear_color_report,'geometryConstraints':geometry})
        report['method']['hidden']='P3 completes rear hair behind the body, clipped to original foreground; P2 supplies hidden body only within its silhouette and behind front hair, with P1 non-hair paint there. Visible original source pixels retain final ownership.'
        report['method']['hidden']+=' Hidden P3 colors match the dark side of observed source rear hair; raw generated art and alpha are preserved separately.'
        report['limitations'].append('P2 outer-silhouette clipping does not guarantee removal of residual contours inside the head; source edges and rear/front joins still need visual review.')
    if refinement:
        report['refinement']=refinement
        report['method']['visible']='Original hair intersected with connected P1 skin takes priority as front hair, excluding generated-map ears and original skin colors. Above both ear centers, existing upper hair extends together to the silhouette. Original opaque interior pixels are conserved; external white-matte colors are represented by foreground RGB plus alpha with exact source RGB conservation over white, including thin strands without an eroded interior. Missing labels join the nearest existing part; source background stays background.'
        report['method']['hidden']='P1 visible skin support limits hidden body. P3 completes rear hair. No upper-edge fade or observed-source root overlap is added. Source white-matte edge colors are recovered as alpha with exact white-composite conservation.'
        report['limitations'].append('In refined mode, final-hidden-body is authoritative; p1-hidden-surface/p2-hidden-surface record the earlier assembly before the P1 skin constraint.')
    if face_source=='generated':
        report['method']['visible']+=' The complete registered P1 face and ears are adopted; generated-face-scope.png declares the only source-difference domain. Hair, clothing and neck remain source-owned. Facial drawings are never mixed between source and P1.'
        report['limitations'].append('Generated face appearance is intentionally different from the source. Static in-scope differences, layer separation and expression/motion quality require review.')
    elif p1_fringe_face:
        report['method']['visible']+=' Explicit P1 fringe-face mode permits static changes only inside masks/p1-fringe-face-scope.png; the exact-source result and in-scope differences are reported separately.'
        report['limitations'].append('The source is no longer pixel-identical inside the declared generated-face scope. Static close-ups and expression review are required; outside-scope conservation is still exact.')
    dump(root/'review.json',report)
    if not check['pass']:raise ValueError('Visible source pixels were not conserved.')
    return {'candidate':str(root/'composite.png'),'layers':str(root/'layers-overview.png'),'report':str(root/'review.json'),'productionReady':False,'psdBuilt':False,'ownershipComplete':check['unassignedPixels']==0 if refine else snap['completeWithinRadius']}
