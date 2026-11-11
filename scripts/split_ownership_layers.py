"""Expand an audited ownership preview into standard PSD layer overrides."""
from __future__ import annotations
import argparse,json
from pathlib import Path
from PIL import Image,ImageChops
from split_common import dump,dilate,erode,largest_component
from split_layers import ORDER
from expression_requests_common import file_hash
from inspect_layers import make_contact_sheet

FEATURES=['eyewhite','irides','eyelash','eyebrow','nose','facedetail','mouth']
BODY=['topwear','neck','ears','face']


def expand_layers(candidate,labels,reference,generated_face=None,generated_ears=None):
    """Keep candidate paint; use existing feature masks and hidden eye/skin art."""
    base=candidate['base'];size=base.size
    if any(im.size!=size for im in [labels,*candidate.values(),*reference.values()]):
        raise ValueError('All candidate and reference layers must share the canvas.')
    for name in FEATURES:
        if any(0<a<255 for a in reference[name].getchannel('A').tobytes()):
            raise ValueError('Feature reference masks must be binary; soft artwork needs a separate compositing path.')
    ids={name:i+1 for i,name in enumerate(BODY+FEATURES)}
    bodyowners=bytearray(size[0]*size[1]);alpha=base.getchannel('A').tobytes();earalpha=reference['ears'].getchannel('A').tobytes()
    mapping={3:'face',4:'ears',5:'neck',6:'topwear',7:'face',1:'face',8:'face',9:'face'}
    if generated_face is not None and generated_face.size!=size:
        raise ValueError('Generated face scope must share the source canvas.')
    face_scope=generated_face.tobytes() if generated_face is not None else bytes(size[0]*size[1])
    ears_scope=generated_ears.tobytes() if generated_ears is not None else bytes(size[0]*size[1])
    for i,(label,a) in enumerate(zip(labels.tobytes(),alpha)):
        if not a:continue
        if face_scope[i]:name='ears' if ears_scope[i] else 'face'
        else:
            if label not in mapping:raise ValueError('Base paint has no supported non-hair owner.')
            name='ears' if label==1 and earalpha[i] else mapping[label]
        bodyowners[i]=ids[name]
    owners=bytearray(bodyowners);face_id=ids['face']
    # Reference masks only select original drawn facial features. Partially
    # transparent exterior pixels stay with their existing body owner.
    for name in FEATURES:
        for i,a in enumerate(reference[name].getchannel('A').tobytes()):
            if a and bodyowners[i]==face_id and alpha[i]==255:owners[i]=ids[name]
    owner_image=Image.frombytes('L',size,bytes(owners))
    body_image=Image.frombytes('L',size,bytes(bodyowners))
    feature_mask=owner_image.point(lambda n:255 if n>len(BODY) else 0)
    if ImageChops.subtract(feature_mask,reference['face'].getchannel('A')).getbbox():
        raise ValueError('Existing face underlay does not cover the separated facial features.')
    layers={'back hair':candidate['back hair'].copy()}
    for name in BODY:
        im=base.copy();im.putalpha(ImageChops.multiply(base.getchannel('A'),body_image.point(lambda n:255 if n==ids[name] else 0)))
        if name=='face':im.paste(reference['face'],(0,0),feature_mask)
        layers[name]=im
    for name in FEATURES:
        rank=ids[name];owned=owner_image.point(lambda n:255 if n==rank else 0)
        hidden=owner_image.point(lambda n:255 if n>rank else 0)
        im=reference[name].copy();im.putalpha(ImageChops.multiply(im.getchannel('A'),hidden))
        im.paste(base,(0,0),owned);layers[name]=im
    layers['front hair']=candidate['front hair'].copy()
    for name in ('headwear','eyewear'):
        if name in candidate:layers[name]=candidate[name].copy()
    neck_overlap={'pixels':0,'radiusPx':0}
    if generated_face is not None:
        from split_features import clean_skin_field
        neck=layers['neck'];face=layers['face']
        neck_core=largest_component(neck.getchannel('A').point(lambda a:255 if a==255 else 0))
        face_box=face.getchannel('A').getbbox()
        if neck_core.getbbox() and face_box:
            radius=max(1,round((face_box[2]-face_box[0])*.075))
            target=ImageChops.multiply(dilate(neck_core,radius),face.getchannel('A').point(lambda a:255 if a==255 else 0))
            target=ImageChops.subtract(target,neck.getchannel('A'))
            known=erode(neck_core,3)
            if target.getbbox() and known.getbbox():
                filled=clean_skin_field(neck,known,target,max(4,round(radius/3)))
                neck.paste(filled,(0,0),target)
                neck_overlap={'pixels':sum(v>0 for v in target.tobytes()),'radiusPx':radius}
    layers={name:layers[name] for name in ORDER if name in layers}
    composite=Image.new('RGBA',size)
    for im in layers.values():composite.alpha_composite(im)
    expected=Image.new('RGBA',size)
    for name in ['back hair','base','front hair','headwear','eyewear']:
        if name in candidate:expected.alpha_composite(candidate[name])
    delta=ImageChops.difference(composite,expected)
    check={'pass':not any(c.getbbox() for c in delta.split()),'changedPixels':sum(any(p) for p in delta.getdata()),'maximumChannelDifference':max(hi for lo,hi in delta.getextrema()),'comparison':'Exact RGBA against the accepted three-layer candidate on transparent black. No source-character backdrop.','featurePixels':sum(v>0 for v in feature_mask.tobytes())}
    check['hiddenNeckOverlap']=neck_overlap
    if not check['pass']:raise ValueError('Standard layer expansion changed the candidate composite.')
    return layers,composite,owner_image,check


def main():
    p=argparse.ArgumentParser();p.add_argument('--job-root',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True);args=p.parse_args()
    job=json.loads((args.job_root/'job.json').read_text());source=Path(job['input']['file']);candidate=args.candidate
    report=json.loads((candidate/'review.json').read_text());split=args.job_root/'split';segmentation=json.loads((split/'segmentation.json').read_text())
    if file_hash(source)!=job['input']['sha256'] or report['sourceSha256']!=job['input']['sha256'] or segmentation['inputSha256']!=job['input']['sha256']:
        raise ValueError('Candidate or reference source hash changed.')
    if segmentation['landmarksSha256']!=file_hash(split/'landmarks.json'):
        raise ValueError('Reference landmarks changed.')
    if not report['staticConservation']['pass'] or report['staticConservation'].get('unassignedPixels')!=0:
        raise ValueError('Candidate must pass conservation and have no unassigned pixels.')
    if report['method']['order'][:3]!=['back hair','base','front hair'] or any(n not in ('headwear','eyewear') for n in report['method']['order'][3:]):
        raise ValueError('Expected the reviewed P3/body/front layer order.')
    current={}
    for name in report['method']['order']:
        file=candidate/'layers'/f'{name}.png'
        if file_hash(file)!=report['artifacts'][name]['sha256']:raise ValueError('Candidate layer hash changed: '+name)
        current[name]=Image.open(file).convert('RGBA')
    reference={name:Image.open(split/'layers'/f'{name}.png').convert('RGBA') for name in BODY+FEATURES}
    labels=Image.open(candidate/'ownership-labels.png').convert('L')
    generated_face=Image.open(candidate/'masks/p1-fringe-face-scope.png').convert('L') if report.get('refinement',{}).get('generatedFringeFace') else None
    generated_ears=None
    feature_masks={}
    if report.get('refinement',{}).get('faceParts'):
        from split_features import face_part_references,generated_face_references
        feature_masks={name:Image.open(candidate/'masks'/f'{name}.png').convert('RGBA' if name=='face-parts-clean-skin' else 'L') for name in ('face-parts-selected','face-parts-patches','face-parts-clean-skin')}
        update=face_part_references
        if report['refinement'].get('generatedFace'):
            update=generated_face_references
            generated_ears=Image.open(candidate/'masks/generated-ears.png').convert('L')
        reference=update(current['base'],reference,feature_masks['face-parts-selected'],feature_masks['face-parts-patches'],feature_masks['face-parts-clean-skin'])
    layers,composite,owners,check=expand_layers(current,labels,reference,generated_face=generated_face,generated_ears=generated_ears)
    root=args.job_root/'ownership-rig';folder=root/'layers';folder.mkdir(parents=True,exist_ok=True)
    for name,im in layers.items():im.save(folder/f'{name}.png')
    composite.save(root/'composite.png');owners.save(root/'body-owners.png');make_contact_sheet([folder/f'{name}.png' for name in layers],root/'layers-overview.png')
    result={'schemaVersion':1,'productionReady':False,'sourceSha256':job['input']['sha256'],'candidateReviewSha256':file_hash(candidate/'review.json'),'candidateLabelsSha256':file_hash(candidate/'ownership-labels.png'),'candidateLayers':{n:report['artifacts'][n]['sha256'] for n in current},'referenceLayerSha256':{n:file_hash(split/'layers'/f'{n}.png') for n in reference},'referenceSegmentationSha256':file_hash(split/'segmentation.json'),'staticConservation':check,'order':list(layers),'outputLayers':{n:file_hash(folder/f'{n}.png') for n in layers},'method':'Candidate hair layers unchanged. Candidate body paint is partitioned into clothing, neck, ears and face. Existing opaque feature masks select facial artwork from that same body; existing face skin and eye-white backing remain only beneath higher features. No new expression artwork.','limitations':['Layer expansion alone establishes neither PSD QA nor natural motion.','Existing expression review exceptions must be retained by repair.']}
    if feature_masks:
        result['faceParts']=report['refinement']['faceParts']
        result['featureMaskSha256']={name:file_hash(candidate/'masks'/f'{name}.png') for name in feature_masks}
        result['method']+=' Within generated semantic part patches, the same selected labels extract source/P1 artwork and replace stale feature masks. Only generated P1 skin supplies face backing.'
    dump(root/'report.json',result)
    print(json.dumps({'layers':str(folder),'preview':str(root/'composite.png'),'report':str(root/'report.json'),'productionReady':False}))


if __name__=='__main__':main()
