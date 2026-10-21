#!/usr/bin/env python3
"""Synthetic generator output for exercising the expression import boundary."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("request_dir", type=Path)
parser.add_argument("result_dir", type=Path)
parser.add_argument("mode", choices=["inside", "outside", "aspect", "resize", "noise", "artwork", "speckle", "soft", "shifted", "small-drift", "scaled", "context", "removed-brow", "moved-brow", "skin-patch", "alpha-jitter", "lost-alpha", "additional", "additional-faint", "additional-strong", "additional-outside"])
args = parser.parse_args()
args.result_dir.mkdir(parents=True, exist_ok=True)
requests = json.loads((args.request_dir / "requests.json").read_text())
for name in requests["variants"]:
    item = requests["variants"][name]
    scale = item["scale"]
    left, top, _, _ = item["cropBox"]
    image = Image.open(args.request_dir / name / "input.png").convert("RGBA")
    mask = Image.open(args.request_dir / name / "mask.png").convert("RGBA")
    underlay = Image.open(args.request_dir / name / "underlay.png").convert("RGBA")
    editable = ImageChops.invert(mask.getchannel("A"))
    if name in {"eye_smile", "blush"}:
        if name == "eye_smile":
            image = Image.composite(underlay, image, editable)
            draw = ImageDraw.Draw(image)
            for center in (37, 59):
                points = [((x-left)*scale, (y-top)*scale) for x, y in ((center-6,36),(center,30),(center+6,36))]
                draw.line(points, fill=(80,30,25,255), width=max(1,2*scale))
        else:
            opacity = 0.025 if args.mode == "additional-faint" else 1 if args.mode == "additional-strong" else 0.1
            overlay = Image.new("RGBA", image.size, (255,64,96,0))
            overlay.putalpha(editable.point(lambda value: round(value*opacity)))
            image = Image.alpha_composite(image, overlay)
        if args.mode == "additional-outside":
            ImageDraw.Draw(image).rectangle(((31-left)*scale,(31-top)*scale,(43-left+1)*scale-1,(38-top+1)*scale-1), fill=(0,255,0,255))
        image.save(args.result_dir / f"{name}.png")
        continue
    artwork_mode = args.mode not in {"inside", "outside", "aspect", "resize", "noise"}
    image = Image.composite(underlay if artwork_mode else Image.new("RGBA", image.size, (80, 30, 25, 255)), image, editable)
    draw = ImageDraw.Draw(image)

    def box(coords):
        x1, y1, x2, y2 = coords
        return ((x1 - left) * scale, (y1 - top) * scale,
                (x2 - left + 1) * scale - 1, (y2 - top + 1) * scale - 1)

    if args.mode == "outside":
        image = Image.composite(image, Image.new("RGBA", image.size, (0, 255, 0, 255)), editable)
    elif args.mode == "noise":
        r, g, b, a = image.split()
        tinted = Image.merge("RGBA", (r.point(lambda v: max(0, v - 1)), g.point(lambda v: max(0, v - 1)), b.point(lambda v: max(0, v - 1)), a))
        image = Image.composite(image, tinted, editable)
    elif args.mode == "context":
        for y in range(image.height):
            for x in range(image.width):
                if mask.getpixel((x, y))[3] and (image.getpixel((x, y))[3] == 0 or y < 4 * scale):
                    image.putpixel((x, y), (0, 255, 0, 255))
        draw = ImageDraw.Draw(image)
    if artwork_mode:
        boxes = [(31, 33, 43, 36), (53, 33, 65, 36)] if name == "eye_close" else [(42, 49, 54, 54)]
        for coords in boxes:
            draw.rectangle(box(coords), fill=(80, 30, 25, 255))
        if args.mode == "speckle":
            x, y = (29, 34) if name == "eye_close" else (40, 49)
            draw.rectangle(box((x, y, x, y)), fill=(0, 0, 0, 255))
        if args.mode == "soft" and name == "mouth_open":
            pixel = underlay.getpixel(((48-left)*scale, (48-top)*scale))
            draw.rectangle(box((42, 48, 54, 48)), fill=(pixel[0]-12, *pixel[1:]))
        if name == "eye_close" and args.mode in {"removed-brow", "moved-brow"}:
            # Entirely in the 8-pixel protected band above the editable eyes.
            draw.rectangle(box((31, 20, 45, 22)), fill=(250, 205, 175, 255))
            if args.mode == "moved-brow":
                draw.rectangle(box((49, 20, 63, 22)), fill=(70, 30, 20, 255))
        if name == "eye_close" and args.mode == "skin-patch":
            draw.rectangle(box((56, 18, 63, 23)), fill=(255, 150, 125, 255))
        if name == "eye_close" and args.mode == "lost-alpha":
            draw.rectangle(box((31, 20, 45, 22)), fill=(0, 0, 0, 0))
    if args.mode == "alpha-jitter":
        image.putalpha(image.getchannel("A").point(lambda value: max(0, value - 7)))
    if args.mode == "aspect":
        image = image.resize((image.width + 20, image.height))
    elif args.mode == "resize":
        image = image.resize((image.width * 2, image.height * 2), Image.Resampling.NEAREST)
    elif args.mode == "shifted":
        shifted = Image.new("RGBA", image.size)
        shifted.paste(image, (18 * scale, 0))
        image = shifted
    elif args.mode == "small-drift":
        # Known subpixel displacement plus a uniform 1% enlargement.
        factor = 1.01
        image = image.transform(image.size, Image.Transform.AFFINE,
             (1/factor, 0, image.width/2*(1-1/factor)-0.75*scale/factor,
             0, 1/factor, image.height/2*(1-1/factor)+0.5*scale/factor), Image.Resampling.BICUBIC)
    elif args.mode == "scaled":
        enlarged = image.resize((round(image.width * 1.12), round(image.height * 1.12)), Image.Resampling.LANCZOS)
        x, y = (enlarged.width-image.width)//2, (enlarged.height-image.height)//2
        image = enlarged.crop((x, y, x+image.width, y+image.height))
    image.save(args.result_dir / f"{name}.png")
