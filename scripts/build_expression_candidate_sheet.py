"""Render read-only masked candidate comparisons with original foreground art."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps
from expression_requests_common import neutral_layers
from import_expression_results import compensate_result


def wrap_caption(text, font, width=298):
    lines, line = [], ''
    for character in text:
        if character == '\n' or (line and font.getlength(line + character) > width):
            lines.append(line)
            line = ''
        if character != '\n':
            line += character
    if line:
        lines.append(line)
    return lines[:3] + ([lines[3].rstrip() + ('...' if len(lines) > 4 else '')] if len(lines) > 3 else [])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    report = json.loads(args.report.read_text())
    request_dir = Path(report['requestDir'])
    requests = json.loads((request_dir / 'requests.json').read_text())
    layer_dir = Path(report['layerDir'])
    layer_map = json.loads(Path('configs/layer-map.json').read_text())
    original, layers = neutral_layers(layer_dir, layer_map, include_front=True)
    foreground = [Image.open(layer_dir / f'{name}.png').convert('RGBA')
                  for name in ('front hair', 'headwear') if (layer_dir / f'{name}.png').is_file()]
    font = None
    for family in ('/System/Library/Fonts/Hiragino Sans GB.ttc',
                   '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                   'Arial.ttf'):
        try:
            font = ImageFont.truetype(family, 16)
            break
        except OSError:
            continue
    font = font or ImageFont.load_default(size=16)
    sheets = {}
    names = list(dict.fromkeys(item['name'] for item in report['candidates']))
    for name in names:
        item = requests['variants'][name]
        box = tuple(item['cropBox'])
        reference = Image.open(request_dir / name / 'input.png').convert('RGBA')
        mask = ImageChops.invert(Image.open(request_dir / name / 'mask.png').getchannel('A'))
        underlay = Image.open(request_dir / name / 'underlay.png').convert('RGBA')
        entries = [entry for entry in report['candidates'] if entry['name'] == name]
        zooms = []
        for parts in [('eyelash', 'eyewhite', 'eyebrow'), ('mouth_close', 'mouth_open')]:
            alpha = Image.new('L', original.size)
            for part in parts:
                if part in layers:
                    alpha = ImageChops.lighter(alpha, layers[part].getchannel('A'))
            bounds = alpha.getbbox() or box
            margin = max(2, round((bounds[2] - bounds[0]) * .12))
            zooms.append((max(0,bounds[0]-margin),max(0,bounds[1]-margin),min(original.width,bounds[2]+margin),min(original.height,bounds[3]+margin)))
        sheet = Image.new('RGB', (320 * (len(entries)+1), 760), '#edf0f5')
        draw = ImageDraw.Draw(sheet)
        portraits = [('Original', original, '#344054', [])]
        for entry in entries:
            evaluation = entry['report']
            details = evaluation.get('variants', {}).get(name, {})
            candidate = original.copy()
            errors = wrap_caption(evaluation.get('error', 'Import checks passed. Visual selection required.'), font)
            try:
                generated = Image.open(request_dir / 'results' / 'candidates' / f"{name}-{entry['number']}.png").convert('RGBA')
                if item.get('outputMode') == 'transparent-overlay':
                    generated = generated.resize(reference.size, Image.Resampling.LANCZOS)
                    generated.putalpha(ImageChops.multiply(generated.getchannel('A'), mask))
                    crop = Image.alpha_composite(underlay, generated)
                else:
                    alignment = details.get('alignment')
                    generated = compensate_result(reference, generated, alignment, item['scale']) if alignment and alignment.get('pass') else generated.resize(reference.size, Image.Resampling.LANCZOS)
                    crop = Image.composite(generated, reference, mask)
                # Accepted previews come from the exact import extraction and
                # registration, including mouth-overlay placement compensation.
                native = Image.open(details['preview']['composite']).convert('RGBA') if evaluation.get('ok') and details.get('preview', {}).get('composite') else crop.resize((box[2]-box[0],box[3]-box[1]),Image.Resampling.LANCZOS)
                candidate.paste(native,box[:2])
                for image in foreground:
                    candidate.alpha_composite(image)
            except (OSError, ValueError, KeyError) as error:
                errors = wrap_caption(str(error), font)
            status = 'PASS' if evaluation.get('ok') else 'FAIL'
            portraits.append((f"Candidate {entry['number']} - {status}",candidate,'#137333' if evaluation.get('ok') else '#b42318',errors))
        for column, (label, image, color, errors) in enumerate(portraits):
            left=column*320
            draw.text((left+10,8),label,font=font,fill=color)
            for line,text in enumerate(errors[:4]):
                draw.text((left+10,34+line*18),text,font=font,fill=color)
            for bounds,top,height in [(box,115,390),(zooms[0],530,120),(zooms[1],675,70)]:
                crop=image.crop(bounds)
                background=Image.new('RGBA',crop.size,'white');background.alpha_composite(crop)
                fitted=ImageOps.contain(background.convert('RGB'),(300,height),Image.Resampling.LANCZOS)
                sheet.paste(fitted,(left+10+(300-fitted.width)//2,top+(height-fitted.height)//2))
            draw.text((left+10,510),'Eyes',font=font,fill='#344054')
            draw.text((left+10,655),'Mouth',font=font,fill='#344054')
        output=args.output_dir/f'{name}-comparison.png'
        if output.is_symlink():
            raise ValueError('Comparison images must not be symlinks.')
        sheet.save(output)
        sheets[name]=output.resolve().relative_to(Path.cwd()).as_posix()
    print(json.dumps(sheets))


if __name__ == '__main__':
    main()
