"""Review-only P1 skin support, guarded hair ownership and white-matte recovery."""
from collections import deque,Counter
from PIL import Image,ImageChops,ImageFilter
from split_common import unmatte_white,classify,mask,dilate,erode,row_fill,fill_enclosed
from split_image import generated_face_surface


def source_skin_mask(source,palettes):
    # This mask protects head skin from hair ownership. Bare-arm colours in
    # topwear samples must not compete with the same colours on the face.
    classes=classify(source.convert('RGB'),[palettes['skin']+palettes.get('neck',[]),palettes['hair'],[(255,255,255)]])
    return Image.frombytes('L',source.size,bytes(255 if n==0 else 0 for n in classes))


def prioritize_removed_hair(labels,source_hair,p1_skin,foreground,map_ears,source_skin):
    """Revealed P1 skin identifies fringe, except source skin and mapped ears."""
    if any(im.size!=labels.size for im in (source_hair,p1_skin,foreground,map_ears,source_skin)):
        raise ValueError('Ownership support masks must match the source canvas.')
    data=bytearray(labels.tobytes());support=bytearray(len(data));before=Counter();requested=ears=skin_pixels=excluded=0
    for i,(hair,skin,fg,ear,original_skin) in enumerate(zip(source_hair.tobytes(),p1_skin.tobytes(),foreground.tobytes(),map_ears.tobytes(),source_skin.tobytes())):
        if hair and skin and fg and data[i] not in (8,9):
            requested+=1;ears+=bool(ear);skin_pixels+=bool(original_skin)
            if ear or original_skin:excluded+=1;continue
            support[i]=255;before[data[i]]+=1;data[i]=1
    report={'requestedIntersectionPixels':requested,'excludedMapEarPixels':ears,'excludedSourceSkinPixels':skin_pixels,'excludedUnionPixels':excluded,'supportPixels':sum(before.values()),'changedPixels':sum(n for label,n in before.items() if label!=1),'previousLabels':dict(before),'remainingNonFrontPixels':sum(s>0 and n!=1 for s,n in zip(support,data)),'rule':'Original hair intersected with connected P1 skin and independent source foreground is front hair, except ears in the registered generated map and source pixels classified as skin. Excluded pixels retain their preceding owner. This semantic rule is separate from the 3px boundary refinement.'}
    return Image.frombytes('L',labels.size,bytes(data)),Image.frombytes('L',labels.size,bytes(support)),report


def resolve_missing(labels,foreground):
    w,h=labels.size;raw=labels.tobytes();data=bytearray(raw);nearest=bytearray(raw);queue=deque(i for i,n in enumerate(raw) if n)
    missing=[i for i,(n,f) in enumerate(zip(raw,foreground.tobytes())) if not n and f]
    if missing and not queue:raise ValueError('No existing owner to resolve missing source pixels.')
    while queue and missing:
        i=queue.popleft();x,y=i%w,i//w
        for n in ((i-1 if x else -1),(i+1 if x+1<w else -1),(i-w if y else -1),(i+w if y+1<h else -1)):
            if n>=0 and not nearest[n]:nearest[n]=nearest[i];queue.append(n)
    for i in missing:data[i]=nearest[i]
    return Image.frombytes('L',labels.size,bytes(data)),{'resolvedPixels':len(missing),'assignedLabels':dict(Counter(data[i] for i in missing)),'method':'Nearest existing non-background owner by Manhattan distance; source background remains background. This also keeps clothing-edge pixels with clothing rather than distant hair.'}


def downward_bundle_gap(source,hair,start_x,start_y,side,mid):
    """Trace a smooth dark gap through source hair until its actual tip."""
    w,h=source.size;rgb=source.convert('RGB').load();hp=hair.load();costs={};parents=[]
    for y in range(start_y,h):
        current={};parent={}
        for x in range(0,mid) if side=='left' else range(mid,w):
            if not hp[x,y]:continue
            lum=sum(rgb[x,y])/765
            if not costs:
                if abs(x-start_x)>4:continue
                current[x]=lum*lum+.02*(x-start_x)**2;parent[x]=x
            else:
                choices=[(costs[p]+.015*(x-p)**2,p) for p in range(x-3,x+4) if p in costs]
                if not choices:continue
                cost,previous=min(choices);current[x]=cost+lum*lum;parent[x]=previous
        if not current:break
        costs=current;parents.append((y,parent))
    if not parents:return []
    x=min(costs,key=costs.get);path=[]
    for y,parent in reversed(parents):path.append([x,y]);x=parent[x]
    return list(reversed(path))


def extend_crown_to_outline(labels,foreground,map_ears,source_skin,landmarks,source):
    """Extend crown ownership to the outline and carry cut side bundles to tips."""
    w,h=labels.size;data=bytearray(labels.tobytes());fg=foreground.tobytes();ears=map_ears.tobytes();skin=source_skin.tobytes();changed=bytearray(w*h)
    limit=min(h,max(0,int(min(e['center'][1] for e in landmarks['ears']))))
    active_rows={y for y in range(limit) if 1 in data[y*w:(y+1)*w]}
    for y in active_rows:
        for x in range(w):
            i=y*w+x
            if data[i]==2 and fg[i] and not ears[i] and not skin[i]:data[i]=1;changed[i]=255
    # An ear-height stop cuts a long side lock across its shaft. Only bundles
    # actually cut by this extension continue downward, following a source-ink
    # gap; unrelated hair keeps the map's ownership.
    eligible=Image.frombytes('L',labels.size,bytes(255 if n in (1,2) and f and not e and not s else 0 for n,f,e,s in zip(data,fg,ears,skin)))
    mid=min(w-1,max(1,round(landmarks['hairPart'][0])));paths={};continued=0
    if 0<limit<h:
        for side,xs in [('left',range(mid)),('right',range(mid,w))]:
            cut=[x for x in xs if changed[(limit-1)*w+x] and data[limit*w+x]==2 and eligible.getpixel((x,limit))]
            if not cut:continue
            start=max(cut) if side=='left' else min(cut)
            path=downward_bundle_gap(source,eligible,start,limit,side,mid)
            if not path:raise ValueError('Cannot trace the extended side bundle to its tip.')
            paths[side]=path;boundary={y:x for x,y in path};last=path[-1][0]
            for y in range(limit,h):
                edge=boundary.get(y,last)
                for x in (range(edge+1) if side=='left' else range(edge,w)):
                    i=y*w+x
                    if data[i]==2 and eligible.getpixel((x,y)):
                        data[i]=1;changed[i]=255;continued+=1
    report={'changedPixels':sum(v>0 for v in changed),'aboveEarY':limit,'continuedSideBundlePixels':continued,'bundleGapPaths':paths,'maximumPathStepPx':3,'rule':'Extend crown front hair to the source silhouette above both ears. If that extension cuts a side bundle at ear height, follow its dark source-hair gap downward and keep the outer bundle in front through its tips. Preserve all non-hair, generated-map ears and source skin; do not add a horizontal end or change unrelated hair.'}
    return Image.frombytes('L',labels.size,bytes(data)),Image.frombytes('L',labels.size,bytes(changed)),report


def transfer_fringe_shadows(source,p1,foreground,labels,layers,palettes,landmarks,skin,source_hair=None):
    """Move observed fringe ink/shade over actual generated skin, not a fill."""
    from split_layers import move_shadows
    size=source.size
    front=labels.point(lambda n:255 if n==1 else 0)
    face=labels.point(lambda n:255 if n in (3,7) else 0)
    distance=abs(landmarks['eyes'][1]['center'][0]-landmarks['eyes'][0]['center'][0])
    radius=max(2,round(distance*.03))
    band=ImageChops.subtract(dilate(front,radius),front)
    p1skin=source_skin_mask(p1,palettes)
    # Landmark boxes also contain fringe contours. Protect actual P1 eye/brow
    # artwork, including thin lid creases, instead of all skin in those boxes.
    p1rgb=p1.convert('RGB');local_light=p1rgb.filter(ImageFilter.MaxFilter(5))
    local_ink=Image.frombytes('L',size,bytes(255 if sum(b)-sum(a)>9 else 0 for a,b in zip(p1rgb.getdata(),local_light.getdata())))
    feature_ink=ImageChops.multiply(mask(size,[*landmarks['eyes'],*landmarks['brows']]),ImageChops.lighter(ImageChops.invert(p1skin),local_ink))
    facial=mask(size,[landmarks['nose'],landmarks['mouth'],*landmarks['ears']])
    protected=ImageChops.lighter(dilate(facial,2),dilate(feature_ink,1))
    clean=ImageChops.multiply(ImageChops.multiply(p1skin,skin),foreground)
    sample=erode(ImageChops.multiply(clean,source_skin_mask(source,palettes)),2)
    sample=ImageChops.multiply(sample,face)
    sample=ImageChops.subtract(sample,ImageChops.lighter(dilate(front,radius*2),protected))
    rgb=source.convert('RGB');paint=p1.convert('RGB')
    differences=sorted(abs(sum(b)-sum(a))/3 for a,b,m in zip(rgb.getdata(),paint.getdata(),sample.tobytes()) if m)
    tolerance=max(3,differences[round((len(differences)-1)*.9)]) if differences else 3
    eligible=ImageChops.multiply(ImageChops.multiply(band,face),clean)
    if source_hair is not None:
        # When the face below the fringe is wholly P1, an old source hair pixel
        # must not turn into a visible skin hole merely because it lies inside
        # a landmark protection envelope. P1's actual skin (not its completed
        # face mask) limits this recovery, so drawn P1 eyes/brows remain intact.
        recovered=ImageChops.multiply(eligible,source_hair)
        eligible=ImageChops.lighter(ImageChops.subtract(eligible,protected),recovered)
    else:
        eligible=ImageChops.subtract(eligible,protected)
    selected=Image.frombytes('L',size,bytes(255 if m and sum(b)-sum(a)>tolerance*3 else 0 for a,b,m in zip(rgb.getdata(),paint.getdata(),eligible.tobytes())))
    count=move_shadows(source,layers['base'],layers['front hair'],paint,selected)
    report={'transferredPixels':count,'radiusPx':radius,'skinDifferenceTolerance':tolerance,'skinComparisonSamples':len(differences),'protectedPixels':sum(v>0 for v in protected.tobytes()),'rule':'Observed face pixels within the narrow front-hair edge band, darker than registered P1 skin, become front-hair RGBA over that exact P1 skin. Actual P1 eye/brow artwork and nose/mouth/ear envelopes are protected. Colour tolerance comes from unchanged skin away from hair. No generated pixels replace the static source composite.'}
    return {'fringe-shadow-transferred':selected,'fringe-shadow-protected':protected},report


def fringe_face_scope(labels,foreground,skin,base,landmarks):
    """Fill fringe gaps above its landmark tip envelope, not between side locks."""
    w,h=labels.size;front=labels.point(lambda n:255 if n==1 else 0)
    radius=max(2,round(abs(landmarks['eyes'][1]['center'][0]-landmarks['eyes'][0]['center'][0])*.03))
    tips=landmarks['bangTips'];envelope=Image.new('L',labels.size);ep=envelope.load()
    for (x0,y0),(x1,y1) in zip(tips,tips[1:]):
        for x in range(max(0,round(x0)),min(w,round(x1)+1)):
            bottom=round(y0+(y1-y0)*(x-x0)/(x1-x0))
            for y in range(max(0,min(h,bottom+1))):ep[x,y]=255
    gaps=ImageChops.multiply(row_fill(front),envelope)
    region=dilate(ImageChops.lighter(front,gaps),radius)
    for support in [foreground,skin,labels.point(lambda n:255 if n in (1,3,7) else 0),base.getchannel('A').point(lambda a:255 if a==255 else 0)]:
        region=ImageChops.multiply(region,support)
    return region,radius


def clean_fringe_fragments(source,p1,foreground,scope,layers,palettes,maximum_pixels=40):
    """Remove tiny isolated holes inside the declared face region, once."""
    from split_layers import move_shadows
    w,h=scope.size;holes=ImageChops.subtract(fill_enclosed(scope),scope)
    remaining={i for i,v in enumerate(holes.tobytes()) if v}
    rgb=p1.convert('RGB');light=rgb.filter(ImageFilter.MaxFilter(3))
    ink=Image.frombytes('L',scope.size,bytes(255 if sum(b)-sum(a)>9 else 0 for a,b in zip(rgb.getdata(),light.getdata())))
    connected=dilate(ink,1).tobytes();p1skin=source_skin_mask(p1,palettes).tobytes();fg=foreground.tobytes();pa=p1.getchannel('A').tobytes()
    chosen=bytearray(w*h);components=0
    while remaining:
        todo=[remaining.pop()];component=[]
        while todo:
            i=todo.pop();component.append(i);x,y=i%w,i//w
            for dy in (-1,0,1):
                for dx in (-1,0,1):
                    n=(y+dy)*w+x+dx
                    if 0<=x+dx<w and 0<=y+dy<h and n in remaining:remaining.remove(n);todo.append(n)
        if len(component)>maximum_pixels or any(connected[i] or not p1skin[i] or not fg[i] or pa[i]!=255 for i in component):continue
        for i in component:chosen[i]=255
        components+=1
    clean=Image.frombytes('L',scope.size,bytes(chosen));layers['base'].paste(p1,(0,0),clean)
    touching=ImageChops.multiply(clean,dilate(layers['front hair'].getchannel('A').point(lambda a:255 if a>16 else 0),1))
    retained=move_shadows(source,layers['base'],layers['front hair'],rgb,touching)
    return ImageChops.lighter(scope,clean),clean,{'maximumComponentPixels':maximum_pixels,'components':components,'replacedPixels':sum(v>0 for v in chosen),'touchingFrontTransferredPixels':retained,'rule':'Only small enclosed holes inside the face scope, disconnected from P1 ink and supported by original foreground and opaque P1 skin. Replace with P1; retain source appearance on front hair where adjacent. No repeated cleanup or expansion beyond the enclosing scope.'}


def refine_layers(source,p1,foreground,labels,layers,palettes,landmarks,skin=None,p1_fringe_face=False,source_hair=None,face_parts=None,face_source='original'):
    size=source.size;w,h=size
    rear_before_matte=layers['back hair'].copy()
    if skin is None:skin=generated_face_surface(p1,palettes,landmarks,{'padding':[0,0,0,0],'cropBox':[0,0,w,h]})
    base=layers['base'].load();lp=labels.load();kp=skin.load();removed=0
    for i,n in enumerate(labels.tobytes()):
        if n==1:
            x,y=i%w,i//w
            if base[x,y][3] and not kp[x,y]:base[x,y]=(0,0,0,0);removed+=1
    # Crown-connected front hair keeps the observed silhouette. Do not fade
    # its upper edge or copy a fixed strip of it into the rear layer.
    fade=Image.new('L',size)
    target=unmatte_white(source.convert('RGB'),foreground)
    hair_target=unmatte_white(source.convert('RGB'),foreground,edge_width=6,fallback_colours=palettes['hair'],enclosed_gaps=True)
    target.paste(hair_target,(0,0),labels.point(lambda n:255 if n in (1,2) else 0))
    # Garment outlines also have a wider white-matte fringe than the default
    # two-pixel band. Enclosed whites remain opaque for this material.
    clothing_target=unmatte_white(source.convert('RGB'),foreground,edge_width=6,fallback_colours=palettes.get('topwear'))
    target.paste(clothing_target,(0,0),labels.point(lambda n:255 if n==6 else 0))
    edge_count=0;alpha=target.getchannel('A');names={1:'front hair',2:'back hair',3:'base',4:'base',5:'base',6:'base',7:'base',8:'headwear',9:'eyewear'}
    layer_pixels={n:im.load() for n,im in layers.items()}
    for i,(a,f) in enumerate(zip(alpha.tobytes(),foreground.tobytes())):
        if not f or a==255:continue
        x,y=i%w,i//w;owner=names[lp[x,y]]
        for name,pixels in layer_pixels.items():pixels[x,y]=target.getpixel((x,y)) if name==owner else (0,0,0,0)
        edge_count+=1
    use_generated_face=face_source=='generated'
    if use_generated_face and face_parts is None:raise ValueError('Generated face requires a registered face-parts map.')
    shadow_masks,shadow_report=transfer_fringe_shadows(source,p1,foreground,labels,layers,palettes,landmarks,skin,source_hair=source_hair if p1_fringe_face or use_generated_face else None)
    scope=Image.new('L',size)
    if use_generated_face:
        from split_features import generated_face
        scope,feature_masks,feature_report=generated_face(source,p1,labels,foreground,skin,layers,face_parts,landmarks)
        shadow_masks.update(feature_masks)
        scope_radius=0
        # White-matte recovery may clear a lower layer at an old source edge.
        # P1 can now cover that pixel completely, so keep the existing P3 paint
        # behind it. Partial/exposed edge pixels retain the original treatment.
        covered=ImageChops.multiply(scope.point(lambda n:255 if n else 0),layers['base'].getchannel('A').point(lambda n:255 if n==255 else 0))
        lost=ImageChops.subtract(rear_before_matte.getchannel('A'),layers['back hair'].getchannel('A'))
        restore=ImageChops.multiply(covered,lost.point(lambda n:255 if n else 0))
        layers['back hair'].paste(rear_before_matte,(0,0),restore)
        shadow_masks['rear-restored-under-face']=restore
        feature_report['rearRestoredUnderOpaqueFacePixels']=sum(v>0 for v in restore.tobytes())
    elif p1_fringe_face:
        scope,scope_radius=fringe_face_scope(labels,foreground,skin,layers['base'],landmarks)
        layers['base'].paste(p1,(0,0),scope)
        scope,fragment_mask,fragment_report=clean_fringe_fragments(source,p1,foreground,scope,layers,palettes)
        shadow_masks['fringe-isolated-fragments']=fragment_mask
        if face_parts is not None:
            from split_features import select_face_parts
            scope,feature_masks,feature_report=select_face_parts(source,p1,labels,foreground,skin,scope,layers,face_parts,landmarks)
            shadow_masks.update(feature_masks)
    composite=Image.new('RGBA',size)
    for im in layers.values():composite.alpha_composite(im)
    old=source.copy();old.putalpha(foreground);old=Image.alpha_composite(Image.new('RGBA',size),old)
    expected=Image.new('RGBA',size,'white');expected.alpha_composite(old)
    actual=Image.new('RGBA',size,'white');actual.alpha_composite(composite)
    delta=ImageChops.difference(actual.convert('RGB'),expected.convert('RGB'));rgba=ImageChops.difference(composite,old)
    interior=[i for i,(a,f) in enumerate(zip(alpha.tobytes(),foreground.tobytes())) if f and a==255];rd=list(rgba.getdata());interior_changed=sum(any(rd[i]) for i in interior)
    check={'pass':not any(c.getbbox() for c in delta.split()) and interior_changed==0,'foregroundPixels':sum(f>0 for f in foreground.tobytes()),'changedPixels':sum(any(v) for v in delta.getdata()),'maximumChannelDifference':max(hi for lo,hi in delta.getextrema()),'opaqueInteriorChangedPixels':interior_changed,'unassignedPixels':0,'transparentRgbaChangedPixels':sum(any(v) for v in rd),'comparison':'Exact RGB composited over the original white matte, plus exact RGBA on untouched opaque foreground. Exterior white-matte RGB is represented by alpha; transparent-canvas RGBA changes are reported separately.'}
    hidden=ImageChops.multiply(layers['base'].getchannel('A'),labels.point(lambda n:255 if n==1 else 0));outside=ImageChops.subtract(hidden,skin)
    report={'hiddenBaseOutsideP1SkinRemoved':removed,'hiddenBaseOutsideP1SkinFinal':sum(v>0 for v in outside.tobytes()),'rootFadePixels':0,'rootFadeWidthPx':0,'rootOverlap':'Disabled: crown-connected front hair keeps its original upper contour without an added fade or observed-source rear overlap. Exterior white-matte recovery remains separate.','whiteMattePixelsRecovered':edge_count,'whiteMatteBoundary':'Hair uses every source background boundary, including enclosed strand gaps; other materials use only border-connected background. Foreground support is unchanged.','hairMatteEdgeWidth':6,'clothingMatteEdgeWidth':6,'thinHairMatteFallback':'Nearest sampled source hair colour estimates coverage when no eroded interior exists; RGB is solved against white to retain the observed pixel.','unassignedPixels':0}
    check['pass']=check['pass'] and report['hiddenBaseOutsideP1SkinFinal']==0
    if p1_fringe_face or use_generated_face:
        inside=[];inside_changed=outside_changed=outside_interior=0
        for rgb_delta,rgba_delta,a,f,allowed in zip(delta.getdata(),rd,alpha.tobytes(),foreground.tobytes(),scope.tobytes()):
            if allowed:
                inside.extend(rgb_delta);inside_changed+=any(rgb_delta)
            else:
                outside_changed+=any(rgb_delta)
                outside_interior+=bool(a==255 and f and any(rgba_delta))
        inside.sort();scoped={'scopePixels':sum(v>0 for v in scope.tobytes()),'changedPixels':inside_changed,'meanAbsoluteChannelDifference':sum(inside)/len(inside) if inside else 0,'p99AbsoluteChannelDifference':inside[round((len(inside)-1)*.99)] if inside else 0,'maximumChannelDifference':max(inside,default=0),'outsideChangedPixels':outside_changed,'outsideOpaqueInteriorChangedPixels':outside_interior,'units':'8-bit RGB channels, all pixels inside the declared scope, including unchanged pixels','scope':'Near front hair plus row-filled bundle gaps clipped by the interpolated landmark tip envelope; restricted to existing opaque P1-supported head face. No side-lock gap fill below that envelope.','edgeRadiusPx':scope_radius}
        check['exactSourcePass']=check['pass'];check['generatedFringeFace']=scoped
        check['pass']=outside_changed==0 and outside_interior==0 and report['hiddenBaseOutsideP1SkinFinal']==0
        check['comparison']='Exact source white-background RGB and opaque RGBA outside the explicit P1 fringe-face scope; source differences inside that scope are reported, not suppressed.'
        report['generatedFringeFace']=scoped
        if use_generated_face:
            scoped['scope']='All original face/ear owners plus connected generated face behind front hair, intersected with original foreground. Original neck, clothing and hair owners remain outside this scope.'
            report['generatedFace']=feature_report
            check['comparison']='Exact source white-background RGB and opaque RGBA outside the declared complete generated-face scope; all in-scope changes are reported.'
        else:report['isolatedFringeCleanup']=fragment_report
        if face_parts is not None:
            report['faceParts']=feature_report
            if not use_generated_face:scoped['scope']+=' Whole generated semantic components intersecting this scope extend it only to the recorded component and its 3px boundary.'
    report['fringeShadowTransfer']=shadow_report
    return layers,composite,check,{'p1-skin-support':skin,'final-hidden-body':hidden,'root-fade-alpha':fade,'white-matte-alpha':alpha,'p1-fringe-face-scope':scope,**shadow_masks},report,target
