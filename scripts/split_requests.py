"""Prepare reproducible peel/ownership requests and register unmodified outputs."""
from __future__ import annotations
import argparse,json,shutil
from datetime import datetime,timezone
from pathlib import Path
from PIL import Image
from expression_requests_common import file_hash
from split_common import dump,square_pad,square_unpad,bounds
from split_ownership import NAMES,COLORS
from split_features import FACE_NAMES,FACE_COLORS

STAGES=('p1','p2','p3','ownership','face-parts','eye_close','mouth_open','mouth_close')


def prepare_request(root,stage,job,p1_file=None,renew_request=False):
    if stage not in ('p2','p3','ownership','face-parts'):
        raise ValueError('P1 uses split-auto; expressions use expression-requests.')
    source=Path(job['input']['file']);folder=root/'split/generated'/stage
    if p1_file is not None and stage not in ('p2','p3'):
        raise ValueError('An explicit P1 input is only supported for P2/P3 requests.')
    folder.mkdir(parents=True,exist_ok=True)
    if (folder/'request.json').exists():
        if not renew_request:
            raise ValueError('This request already exists; keep it unchanged for retries, or use --renew-request to archive it before preparing a new request.')
        history=root/'split/generated/request-history'/stage;history.mkdir(parents=True,exist_ok=True)
        number=1
        while (history/f'{number:03d}').exists():number+=1
        archive=history/f'{number:03d}';previous_sha=file_hash(folder/'request.json')
        folder.rename(archive)
        try:
            result=prepare_request(root,stage,job,p1_file=p1_file)
            current=json.loads((folder/'request.json').read_text())
            current['previousRequest']={'path':str(archive/'request.json'),'sha256':previous_sha}
            dump(folder/'request.json',current)
            return result
        except Exception:
            shutil.rmtree(folder,ignore_errors=True);archive.rename(folder)
            raise
    record={'schemaVersion':1,'stage':stage,'sourceSha256':job['input']['sha256'],
            'service':'Codex built-in image_gen','prompt':'prompt.txt','result':'result.png',
            'createdAt':datetime.now(timezone.utc).isoformat()}
    if stage=='face-parts':
        native_file=root/'ownership-refined-preview/p1.png'
        if native_file.exists():
            review=json.loads((root/'ownership-refined-preview/review.json').read_text())
            if review['sourceSha256']!=job['input']['sha256']:raise ValueError('Registered P1 preview belongs to another source.')
            p1_sha=review['p1Sha256']
        else:
            from import_expression_results import compensate_result
            p1=root/'split/results/without-front-hair.png';item=json.loads((root/'split/requests.json').read_text());check=json.loads((root/'split/generation-check.json').read_text())
            if not check['pass'] or check['resultSha256']!=file_hash(p1):raise ValueError('P1 must pass its current import checks before preparing facial ownership.')
            original=Image.open(source).convert('RGBA');request,pad=square_pad(original.crop(item['cropBox']),(255,255,255,255))
            if pad!=item['padding'] or Image.open(root/'split/requests/without-front-hair/input.png').convert('RGBA').tobytes()!=request.tobytes():raise ValueError('P1 request source or framing changed.')
            registered=compensate_result(request,Image.open(p1).convert('RGBA'),check['alignment'],1)
            original.paste(square_unpad(registered,pad),tuple(item['cropBox'][:2]));native_file=folder/'p1-native.png';original.save(native_file);p1_sha=file_hash(p1)
        native=Image.open(native_file).convert('RGBA');lm_file=root/'split/landmarks.json';lm=json.loads(lm_file.read_text())
        boxes=[bounds(b) for b in [*lm['brows'],*lm['eyes'],*lm['ears'],lm['nose'],lm['mouth']]]
        distance=abs(lm['eyes'][1]['center'][0]-lm['eyes'][0]['center'][0]);margin=round(distance*.15)
        crop=[max(0,min(b[0] for b in boxes)-margin),max(0,min(b[1] for b in boxes)-round(distance*.35)),min(native.width,max(b[2] for b in boxes)+margin),min(native.height,round(max(lm['chin'][1],max(b[3] for b in boxes))+margin))]
        reference,padding=square_pad(native.crop(crop),(255,255,255,255));reference.save(folder/'input.png')
        record.update({'canvas':list(native.size),'cropBox':crop,'padding':padding,'size':list(reference.size),'p1NativeSha256':file_hash(native_file),'p1Sha256':p1_sha,'landmarksSha256':file_hash(lm_file),'palette':dict(zip(FACE_NAMES,FACE_COLORS))})
        legend='; '.join(name+' = RGB '+str(color) for name,color in zip(FACE_NAMES,FACE_COLORS))
        prompt=('Use case: precise-object-edit. Input image is an edit target: the registered face with foreground bangs already removed. '
                'Return one exact flat facial-part ownership map, matching every existing facial stroke and contour pixel for pixel. '
                'Palette: '+legend+'. Eyebrow red includes each entire eyebrow and its antialiased edge. '
                'Eyelash blue includes all eye outlines, eyelashes, upper eyelid creases and double-eyelid lines, including thin pale lines. '
                'Keep the blue lines separate where the input has skin gaps. Eyewhite white includes only visible eye whites. '
                'Irises green includes pupils and highlights inside the irises. Mouth yellow and nose cyan include their complete drawn marks. '
                'Skin gray includes visible facial and ear skin, including shadows and blush. All hair, background, clothing and square margins are black. '
                'Keep exact position, scale, face shape, both eyes and brows, all line widths and gaps. Do not invent or erase facial features. '
                'Use only the eight solid palette colors; no gradients, texture, original skin colors, black facial outlines, text, legend or border. '
                'This is a segmentation map of the supplied drawing, not a new face illustration.')
    elif stage=='ownership':
        original=Image.open(source).convert('RGBA');reference,padding=square_pad(original,(255,255,255,255))
        reference.save(folder/'input.png')
        record.update({'canvas':list(original.size),'padding':padding,'size':list(reference.size),'palette':dict(zip(NAMES,COLORS))})
        lm_file=root/'split/landmarks.json'
        lm=json.loads(lm_file.read_text()) if lm_file.exists() else {}
        count=len(NAMES) if lm.get('accessories') else 8
        record['palette']=dict(zip(NAMES[:count],COLORS[:count]))
        legend='; '.join(name+' = RGB '+str(color) for name,color in zip(NAMES[:count],COLORS[:count]))
        prompt=('Create an exact visible-part segmentation map of input.png. Keep every contour, location, scale and the square framing. '
                'Use only these flat colors: '+legend+'. No shading, texture, outlines, text, labels or legend. '
                'Color only what is visible, not inferred hidden surfaces. Front hair includes the crown connected to the bangs, '
                'the braid and long front side locks, continuing each lock to its actual tip; separate locks along dark gaps. '
                'Back hair is the remaining rear hair. Face parts means visible eye whites, irises, lashes, brows, nose and mouth; '
                'do not color skin white. Ears are separate from face. All clothing, cloth draped over it, exposed arms and torso '
                'belong to topwear/body (purple). Use face green only on the head, never below the collar. '
                'The original white backdrop and square margins become pure black. Return one square map with no added elements.')
    else:
        p1=p1_file or root/'split/results/without-front-hair.png'
        check=json.loads((root/'split/generation-check.json').read_text())
        if not check['pass'] or check['resultSha256']!=file_hash(p1):
            raise ValueError('P1 must pass its current import checks before preparing later peel requests.')
        shutil.copyfile(p1,folder/'input.png')
        with Image.open(p1) as input_image:size=input_image.size
        record.update({'size':list(size),'p1Sha256':file_hash(p1),'p1CheckSha256':file_hash(root/'split/generation-check.json')})
        if stage=='p2':
            prompt=('Edit input.png. It is the same character with foreground bangs already removed. Remove ALL remaining hair, '
                    'including rear hair, braid, loose strands and hair shadows, to reveal the complete same bald head, both ears, '
                    'neck and clothing behind it. Preserve every already-visible face feature, face contour, ear contour, skin color, '
                    'clothing design and line style exactly. Reconstruct hidden skin, neck and clothing only where hair was. '
                    'Do not add a different expression or enlarge the ears. Keep the exact framing, square margins and pure white backdrop.')
        else:
            prompt=('Edit input.png into the complete inner BACK HAIR layer of this exact character. This is the dark underside of '
                    'the rear hair hidden behind the face and foreground hair, not a second front-facing hairstyle. '
                    'Keep the original outer rear-hair silhouette, placement and scale. Preserve already-visible rear hair at the sides and tips. '
                    'Remove face, ears, neck, body, clothing, head accessories and any foreground braid. Fill the former face/ear/upper-neck '
                    'interior with continuous quiet hair in the dark shadow colors found on the original rear hair. '
                    'Inside this hidden region draw no braid, parting, scalp, highlight band, foreground bang bundles or recognizable front hairstyle. '
                    'Use only subtle downward inner strands in shadow, with no duplicated front locks and no face-shaped hole. '
                    'Do not add eyes, skin, clothing or a hat. Keep the pure white backdrop and existing square margins.')
    if stage=='ownership' and count>8:
        prompt+=' Headwear orange is visible hats and headdresses, including white frills. Eyewear pink is only visible eyeglass frames and reflections, never the transparent lens interior: eyes and face seen through lenses keep their face/face-part colors. Do not confuse white frills with background.'
    if stage=='p2':
        lm_file=root/'split/landmarks.json'
        lm=json.loads(lm_file.read_text()) if lm_file.exists() else {}
        if lm.get('accessories'):prompt+=' Also remove all hats, headdresses and eyeglasses; reconstruct hidden head, ears, neck and clothing with no accessories.'
    prompt+=f" Return exactly {record['size'][0]}x{record['size'][1]} pixels.\n"
    (folder/'prompt.txt').write_text(prompt,encoding='utf-8')
    record.update({'inputSha256':file_hash(folder/'input.png'),'promptSha256':file_hash(folder/'prompt.txt')})
    dump(folder/'request.json',record)
    return {'request':str(folder/'request.json'),'input':str(folder/'input.png'),'prompt':str(folder/'prompt.txt'),'requiresApprovedGeneration':True}


def register_result(root,stage,image,job):
    if stage not in STAGES:raise ValueError('Unsupported generation stage.')
    if stage=='p1':
        metadata=root/'split/requests.json';record=json.loads(metadata.read_text())
        reference=root/'split/requests/without-front-hair/input.png';destination=root/'split/results/without-front-hair.png'
    elif stage in ('eye_close','mouth_open','mouth_close'):
        metadata=root/'expression-requests/requests.json';requests=json.loads(metadata.read_text())
        if stage not in requests['variants']:raise ValueError('Prepare a current expression request first.')
        record=requests['variants'][stage];reference=root/'expression-requests'/stage/'input.png'
        destination=root/'expression-requests/results'/f'{stage}.png'
    else:
        metadata=root/'split/generated'/stage/'request.json';record=json.loads(metadata.read_text())
        reference=metadata.parent/'input.png';destination=metadata.parent/'result.png'
        if record['sourceSha256']!=job['input']['sha256']:raise ValueError('Request source changed.')
    if not reference.exists() or file_hash(reference)!=record['inputSha256']:
        raise ValueError('Request input changed; do not register this result.')
    with Image.open(image) as raw:
        size=raw.size;raw.verify()
    if stage in ('p1','p2','p3','ownership','face-parts') and abs(size[0]/size[1]-1)>.01:
        raise ValueError('Generated peel and ownership images must keep the square framing.')
    ledger_file=root/'split/generations.json';ledger=json.loads(ledger_file.read_text()) if ledger_file.exists() else {'limit':12,'entries':[]}
    sha=file_hash(image)
    duplicates=[e for e in ledger['entries'] if e['stage']==stage and e['resultSha256']==sha and e['inputSha256']==file_hash(reference)]
    if duplicates:return {'alreadyRegistered':True,**duplicates[-1]}
    if len(ledger['entries'])>=ledger['limit']:raise ValueError('The 12-generation budget has been reached.')
    count=len(ledger['entries'])+1;archive=root/'split/generated/attempts'/f'{count:02d}-{stage}.png';archive.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(image,archive);destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(archive,destination)
    entry={'call':count,'stage':stage,'inputSha256':file_hash(reference),'requestSha256':file_hash(metadata),'resultSha256':sha,'returnedSize':list(size),'archive':str(archive),'result':str(destination),'registeredAt':datetime.now(timezone.utc).isoformat()}
    ledger['entries'].append(entry);dump(ledger_file,ledger)
    if stage in ('p2','p3','ownership','face-parts'):
        record.update({'resultSha256':sha,'returnedSize':list(size),'generationCallForOriginal':count});dump(metadata,record)
    return {**entry,'callsUsed':count,'limit':ledger['limit'],'qualityChecked':False}


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['requests','result']);p.add_argument('--job-root',type=Path,required=True)
    p.add_argument('--stage',choices=STAGES,required=True);p.add_argument('--image',type=Path)
    p.add_argument('--p1',type=Path);p.add_argument('--renew-request',action='store_true');args=p.parse_args()
    job=json.loads((args.job_root/'job.json').read_text())
    if file_hash(Path(job['input']['file']))!=job['input']['sha256']:raise ValueError('Source hash changed.')
    if args.action=='requests':result=prepare_request(args.job_root,args.stage,job,p1_file=args.p1,renew_request=args.renew_request)
    else:
        if args.p1 or args.renew_request:raise ValueError('--p1 and --renew-request are only for preparing requests.')
        if not args.image:raise ValueError('--image is required.')
        result=register_result(args.job_root,args.stage,args.image,job)
    print(json.dumps(result))


if __name__=='__main__':main()
