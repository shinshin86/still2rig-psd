#!/usr/bin/env python3
"""Generate small synthetic full-canvas PNG layers for tests."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


def layer(size=(96, 96)):
    return Image.new("RGBA", size, (0, 0, 0, 0))


def save_rect(root: Path, name: str, box, color):
    image = layer()
    ImageDraw.Draw(image).rectangle(box, fill=color)
    image.save(root / name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mouth-shift", type=int, default=0)
    parser.add_argument("--mouth-patch", action="store_true")
    parser.add_argument("--without-expressions", action="store_true")
    parser.add_argument("--missing-mouth", action="store_true")
    parser.add_argument("--open-mouth", action="store_true")
    parser.add_argument("--hair-over-eyes", action="store_true")
    parser.add_argument("--inward-irises", action="store_true")
    parser.add_argument("--scale", type=int, default=1)
    parser.add_argument("--without-back-hair", action="store_true")
    parser.add_argument("--band-features", action="store_true")
    parser.add_argument("--collar-source", action="store_true", help="write src_img.png showing the collar over the lower neck")
    parser.add_argument("--hair-over-collar", action="store_true", help="front hair in a clothing-like colour covers the collar area")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    if not args.without_back_hair:
        save_rect(args.output, "back hair.png", (12, 5, 84, 82), (70, 35, 20, 255))
    save_rect(args.output, "topwear.png", (18, 67, 78, 95), (40, 50, 70, 255))
    save_rect(args.output, "neck.png", (40, 55, 56, 78), (240, 185, 150, 255))
    save_rect(args.output, "face.png", (24, 15, 72, 67), (250, 205, 175, 255))
    layer().save(args.output / "nose.png")
    if args.band_features:
        image = layer()
        ImageDraw.Draw(image).rectangle((31, 20, 45, 22), fill=(70, 30, 20, 255))
        image.save(args.output / "eyebrow.png")
    image = layer()
    draw = ImageDraw.Draw(image)
    draw.rectangle((31, 31, 43, 38), fill=(255, 255, 255, 255))
    draw.rectangle((53, 31, 65, 38), fill=(255, 255, 255, 255))
    image.save(args.output / "eyewhite.png")
    image = layer()
    draw = ImageDraw.Draw(image)
    draw.rectangle((41, 30, 43, 38) if args.inward_irises else (34, 30, 40, 38), fill=(30, 120, 150, 255))
    draw.rectangle((53, 30, 55, 38) if args.inward_irises else (56, 30, 62, 38), fill=(30, 120, 150, 255))
    image.save(args.output / "irides.png")
    image = layer()
    draw = ImageDraw.Draw(image)
    if args.open_mouth:
        draw.ellipse((40, 45, 56, 59), fill=(90, 20, 25, 255))
    elif args.mouth_patch:
        draw.rounded_rectangle((34, 44, 62, 60), radius=5, fill=(250, 245, 240, 255))
    else:
        draw.arc((40, 46, 56, 55), 10, 170, fill=(150, 45, 45, 255), width=3)
    if not args.missing_mouth:
        image.save(args.output / "mouth.png")
    if not args.without_expressions:
        save_rect(args.output, "mouth_open.png", (42 + args.mouth_shift, 48, 54 + args.mouth_shift, 56), (90, 20, 25, 255))
        image = layer()
        draw = ImageDraw.Draw(image)
        draw.rectangle((33, 32, 41, 37), fill=(70, 30, 20, 255))
        draw.rectangle((55, 32, 63, 37), fill=(70, 30, 20, 255))
        image.save(args.output / "eye_close.png")
    image = layer()
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 5, 76, 38 if args.hair_over_eyes else 28), fill=(85, 45, 25, 255))
    if args.hair_over_collar:
        draw.rectangle((40, 72, 47, 78), fill=(45, 52, 68, 255))
    image.save(args.output / "front hair.png")
    if args.hair_over_eyes:
        save_rect(args.output, "headwear.png", (20, 5, 76, 38), (10, 240, 10, 255))
    if args.collar_source:
        # The neck layer reaches y=78, but the source shows the collar from y=72 down.
        source = layer()
        for name in ("back hair.png", "topwear.png", "neck.png"):
            if (args.output / name).is_file():
                source.alpha_composite(Image.open(args.output / name).convert("RGBA"))
        ImageDraw.Draw(source).rectangle((40, 72, 56, 78), fill=(40, 50, 70, 255))
        for name in ("face.png", "eyewhite.png", "irides.png", "mouth.png", "front hair.png"):
            if (args.output / name).is_file():
                source.alpha_composite(Image.open(args.output / name).convert("RGBA"))
        source.save(args.output / "src_img.png")
    if args.scale != 1:
        for file in args.output.glob("*.png"):
            image = Image.open(file).convert("RGBA")
            image.resize((96 * args.scale, 96 * args.scale), Image.Resampling.NEAREST).save(file)


if __name__ == "__main__":
    main()
