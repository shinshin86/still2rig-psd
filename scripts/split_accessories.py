"""Shared ownership of observed accessories and their generated underlays."""
from PIL import Image, ImageChops
from split_common import mask, dilate, classify

ACCESSORIES={8:'headwear',9:'eyewear'}

def declared_accessories(size,landmarks):
    return mask(size,[a['box'] for a in landmarks.get('accessories',[]) if a['layer'] in ACCESSORIES.values()])

def accessory_layers(source,p1,foreground,labels,p1hair,p1foreground,layers):
    """Keep original frames/reflections and headwear above real generated paint."""
    for label,name in ACCESSORIES.items():
        support=ImageChops.multiply(labels.point(lambda n:255 if n==label else 0),foreground)
        if not support.getbbox():continue
        if name=='headwear':
            hidden=ImageChops.multiply(support,ImageChops.multiply(p1hair,p1foreground))
            layers['front hair'].paste(p1,(0,0),hidden)
        art=source.copy();art.putalpha(support);layers[name]=art
    return layers

def reassign_detached(labels, removed, excluded):
    """Return detached observations to the nearest adjacent non-background owner."""
    from collections import deque
    w,h=labels.size;data=bytearray(labels.tobytes());nearest=bytearray(len(data))
    queue=deque()
    for i,n in enumerate(data):
        if n and n not in excluded:nearest[i]=n;queue.append(i)
    if removed and not queue:raise ValueError('Detached ownership has no neighboring layer.')
    pending=set(removed)
    while queue and pending:
        i=queue.popleft();x,y=i%w,i//w
        if i in pending:data[i]=nearest[i];pending.remove(i)
        for yy in range(max(0,y-1),min(h,y+2)):
            for xx in range(max(0,x-1),min(w,x+2)):
                n=yy*w+xx
                if not nearest[n]:nearest[n]=nearest[i];queue.append(n)
    return Image.frombytes('L',labels.size,bytes(data))


def constrain_accessory_labels(labels,artwork,landmarks):
    """Keep the largest eight-connected accessory body, including touching paint."""
    from split_features import components
    data=labels.tobytes();removed=[];details={}
    declared={a['layer'] for a in landmarks.get('accessories',[])}
    for label,name in ACCESSORIES.items():
        parts=components(labels.point(lambda n:255 if n==label else 0))
        body=max(parts,key=len,default=[]) if name in declared else []
        retained=set(body)
        discarded=[i for part in parts for i in part if i not in retained]
        removed.extend(discarded);details[name]={'retainedPixels':len(body),'detachedPixels':len(discarded),'components':len(parts)}
    result=reassign_detached(labels,removed,set(ACCESSORIES)) if removed else labels.copy()
    return result,{'detachedAccessoryPixelsReassigned':len(removed),'components':details,'connectivity':8,'rule':'Largest declared accessory component; touching paint belongs to the same component. No spatial box is used.'}


def constrain_garment_labels(labels,landmarks):
    """An isolated head-height patch cannot be clothing without a body connection."""
    from split_features import components
    w,h=labels.size;collar=min(p[1] for p in landmarks['collar'])
    parts=components(labels.point(lambda n:255 if n==6 else 0))
    removed=[i for part in parts if not any(i//w>=collar for i in part) for i in part]
    result=reassign_detached(labels,removed,{6}) if removed else labels.copy()
    return result,{'detachedHeadClothingPixelsReassigned':len(removed),'anchor':'A garment component must reach the collar or below. Only disconnected components entirely above the collar are returned to adjacent owners.'}


def retain_accessory_ink(source,labels,foreground,palettes,radius=3):
    """Recover observed accessory ink near its map, excluding skin/background."""
    raw=labels.tobytes()
    if not any(n in ACCESSORIES for n in raw):
        return labels.copy(),{'radiusPx':radius,'changedPixels':0,'accessories':{}},Image.new('L',labels.size)
    classes=classify(source.convert('RGB'),[palettes['skin']+palettes.get('neck',[]),palettes['hair'],[(255,255,255)]])
    skin=bytes(n==0 for n in classes);fg=foreground.tobytes()
    removed=[i for i,n in enumerate(raw) if n in ACCESSORIES and (skin[i] or not fg[i])]
    base=reassign_detached(labels,removed,set(ACCESSORIES)) if removed else labels.copy()
    data=bytearray(base.tobytes());details={}
    for label,name in ACCESSORIES.items():
        support=dilate(labels.point(lambda n:255 if n==label else 0),radius).tobytes()
        kept=added=0
        for i,(near,inside,is_skin) in enumerate(zip(support,fg,skin)):
            if near and inside and not is_skin and raw[i] not in set(ACCESSORIES)-{label}:
                data[i]=label;kept+=1;added+=raw[i]!=label
        details[name]={'retainedSourcePixels':kept,'addedSourcePixels':added}
    changes=Image.frombytes('L',labels.size,bytes(255 if a!=b else 0 for a,b in zip(raw,data)))
    return Image.frombytes('L',labels.size,bytes(data)),{'radiusPx':radius,'distanceMetric':'Chebyshev at native source scale',
        'changedPixels':sum(a!=b for a,b in zip(raw,data)),'excludedSkinOrBackgroundPixels':len(removed),'accessories':details,
        'rule':'Keep original non-skin foreground ink/paint within the dilated accessory map. Later colour-boundary snapping excludes accessories.'},changes
