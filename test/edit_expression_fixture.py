#!/usr/bin/env python3
"""Synthetic generator output for exercising the expression import boundary."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("request_dir", type=Path)
parser.add_argument("result_dir", type=Path)
parser.add_argument("mode", choices=["inside", "outside", "aspect", "resize", "noise", "artwork", "speckle", "soft", "shifted", "scaled", "context"])
args = parser.parse_args()
args.result_dir.mkdir(parents=True, exist_ok=True)
requests = json.loads((args.request_dir / "requests.json").read_text())
for name in ("eye_close", "mouth_open"):
    image = Image.open(args.request_dir / name / "input.png").convert("RGBA")
    mask = Image.open(args.request_dir / name / "mask.png").convert("RGBA")
    underlay = Image.open(args.request_dir / name / "underlay.png").convert("RGBA")
    artwork_mode = args.mode in {"artwork", "speckle", "soft", "shifted", "scaled", "context"}
    for y in range(image.height):
        for x in range(image.width):
            if mask.getpixel((x, y))[3] == 0:
                image.putpixel((x, y), underlay.getpixel((x, y)) if artwork_mode else (80, 30, 25, 255))
            elif args.mode == "outside":
                image.putpixel((x, y), (0, 255, 0, 255))
            elif args.mode == "noise":
                pixel = image.getpixel((x, y))
                image.putpixel((x, y), tuple(max(0, value - 1) for value in pixel[:3]) + (pixel[3],))
            elif args.mode == "context" and (image.getpixel((x, y))[3] == 0 or y < 4):
                image.putpixel((x, y), (0, 255, 0, 255))
    if artwork_mode:
        left, top, _, _ = requests["variants"][name]["cropBox"]
        draw = ImageDraw.Draw(image)
        boxes = [(31, 33, 43, 36), (53, 33, 65, 36)] if name == "eye_close" else [(42, 49, 54, 54)]
        for x1, y1, x2, y2 in boxes:
            draw.rectangle((x1 - left, y1 - top, x2 - left, y2 - top), fill=(80, 30, 25, 255))
        if args.mode == "speckle":
            x, y = (29, 34) if name == "eye_close" else (40, 49)
            image.putpixel((x - left, y - top), (0, 0, 0, 255))
        if args.mode == "soft" and name == "mouth_open":
            for x in range(42, 55):
                pixel = underlay.getpixel((x - left, 48 - top))
                image.putpixel((x - left, 48 - top), (pixel[0] - 12, *pixel[1:]))
    if args.mode == "aspect":
        image = image.resize((image.width + 20, image.height))
    elif args.mode == "resize":
        image = image.resize((image.width * 2, image.height * 2), Image.Resampling.NEAREST)
    elif args.mode == "shifted":
        shifted = Image.new("RGBA", image.size)
        shifted.paste(image, (8, 0))
        image = shifted
    elif args.mode == "scaled":
        enlarged = image.resize((round(image.width * 1.12), round(image.height * 1.12)), Image.Resampling.LANCZOS)
        left, top = (enlarged.width - image.width) // 2, (enlarged.height - image.height) // 2
        image = enlarged.crop((left, top, left + image.width, top + image.height))
    image.save(args.result_dir / f"{name}.png")
