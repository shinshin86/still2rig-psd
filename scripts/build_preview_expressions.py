#!/usr/bin/env python3
"""Derive preview-only open-mouth and closed-eye layers from a finalized layer set.

The output is registered, full-canvas artwork that lets the preview show a
blink and mouth movement. It is derived from the neutral image, so it is never
production artwork: pass the directory to ``--preview-expressions`` so the PSD
stays ``productionReady=false``.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SUPERSAMPLE = 4


def alpha_bbox(image: Image.Image, threshold: int = 16):
    return image.getchannel("A").point(lambda value: 255 if value > threshold else 0).getbbox()


def column_ink(image: Image.Image, box: tuple[int, int, int, int], threshold: int = 16) -> dict[int, float]:
    """Alpha-weighted vertical center of ink for each column inside ``box``."""
    pixels = image.load()
    left, top, right, bottom = box
    centers = {}
    for x in range(left, right):
        weight = 0.0
        total = 0.0
        for y in range(top, bottom):
            alpha = pixels[x, y][3]
            if alpha > threshold:
                weight += alpha
                total += alpha * y
        if weight:
            centers[x] = total / weight
    return centers


def darkest_color(image: Image.Image, box: tuple[int, int, int, int]) -> tuple[int, int, int]:
    pixels = image.load()
    best = None
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            red, green, blue, alpha = pixels[x, y]
            if alpha > 200 and (best is None or red + green + blue < sum(best)):
                best = (red, green, blue)
    return best or (90, 50, 50)


def build_mouth_open(mouth: Image.Image) -> tuple[Image.Image, dict]:
    box = alpha_bbox(mouth)
    if not box:
        raise RuntimeError("mouth layer is empty")
    width, height = mouth.size
    centers = column_ink(mouth, box)
    xs = sorted(centers)
    left, right = xs[0], xs[-1]
    span = right - left
    ink = darkest_color(mouth, box)
    # A small D-shaped opening under the closed-mouth line: 30% of the line
    # width deep at most, narrower than the line so the corners stay closed.
    depth = max(6.0, min(span * 0.24, 14.0))
    inset = span * 0.16
    scale = SUPERSAMPLE
    layer = Image.new("RGBA", (width * scale, height * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    top_edge = []
    bottom_edge = []
    steps = 48
    for index in range(steps + 1):
        x = left + inset + (span - 2 * inset) * index / steps
        nearest = min(xs, key=lambda candidate: abs(candidate - x))
        y = centers[nearest]
        t = index / steps
        top_edge.append((x * scale, y * scale))
        bottom_edge.append((x * scale, (y + depth * math.sin(math.pi * t) ** 0.8) * scale))
    interior = top_edge + bottom_edge[::-1]
    draw.polygon(interior, fill=(118, 38, 44, 255))
    tongue_cx = (left + right) / 2
    tongue_top = max(point[1] for point in bottom_edge) / scale - depth * 0.45
    draw.ellipse(
        [
            (tongue_cx - span * 0.2) * scale,
            tongue_top * scale,
            (tongue_cx + span * 0.2) * scale,
            (tongue_top + depth * 0.7) * scale,
        ],
        fill=(196, 92, 92, 255),
    )
    # Clip the tongue to the opening, then draw the lip line over it.
    mask = Image.new("L", layer.size, 0)
    ImageDraw.Draw(mask).polygon(interior, fill=255)
    layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", layer.size, 0), mask))
    draw = ImageDraw.Draw(layer)
    draw.line(bottom_edge, fill=ink + (255,), width=int(1.6 * scale), joint="curve")
    result = layer.resize((width, height), Image.LANCZOS)
    result.alpha_composite(mouth)
    return result, {"bbox": list(alpha_bbox(result) or ()), "depthPx": round(depth, 2), "ink": list(ink)}


def eye_groups(eyelash: Image.Image, center_x: float) -> list[tuple[int, int, int, int]]:
    boxes = []
    for side in ("L", "R"):
        crop_box = (0, 0, int(center_x), eyelash.height) if side == "L" else (int(center_x), 0, eyelash.width, eyelash.height)
        box = alpha_bbox(eyelash.crop(crop_box))
        if not box:
            raise RuntimeError(f"eyelash layer has no {side} eye")
        boxes.append((box[0] + crop_box[0], box[1], box[2] + crop_box[0], box[3]))
    return boxes


def largest_component(image: Image.Image, threshold: int = 16) -> Image.Image:
    """Keep only the largest 8-connected ink component (the main lash line)."""
    width, height = image.size
    alpha = image.getchannel("A").load()
    seen = [[False] * width for _ in range(height)]
    best: list[tuple[int, int]] = []
    for start_y in range(height):
        for start_x in range(width):
            if seen[start_y][start_x] or alpha[start_x, start_y] <= threshold:
                continue
            component = []
            stack = [(start_x, start_y)]
            seen[start_y][start_x] = True
            while stack:
                x, y = stack.pop()
                component.append((x, y))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < width and 0 <= ny < height and not seen[ny][nx] and alpha[nx, ny] > threshold:
                            seen[ny][nx] = True
                            stack.append((nx, ny))
            if len(component) > len(best):
                best = component
    mask = Image.new("L", image.size, 0)
    mask_pixels = mask.load()
    for x, y in best:
        mask_pixels[x, y] = 255
    # Keep the soft antialiased edge around the kept component.
    mask = mask.filter(ImageFilter.MaxFilter(3))
    result = image.copy()
    result.putalpha(Image.composite(image.getchannel("A"), Image.new("L", image.size, 0), mask))
    return result


def build_eye_close(eyelash: Image.Image, eyewhite: Image.Image, irides: Image.Image, center_x: float) -> tuple[Image.Image, dict]:
    """Closed lids: each upper lash line mirrored, flattened, and lowered."""
    out = Image.new("RGBA", eyelash.size, (0, 0, 0, 0))
    details = []
    for box in eye_groups(eyelash, center_x):
        opening = [alpha_bbox(layer.crop(box)) for layer in (eyewhite, irides)]
        opening = [b for b in opening if b]
        eye_bottom = box[3] if not opening else box[1] + max(b[3] for b in opening)
        lash = largest_component(eyelash.crop(box))
        height = box[3] - box[1]
        flat_height = max(4, round(height * 0.38))
        closed = lash.transpose(Image.FLIP_TOP_BOTTOM).resize((lash.width, flat_height), Image.LANCZOS)
        # Place the lid line at about 70% down the visible eye opening.
        close_y = box[1] + (eye_bottom - box[1]) * 0.7
        top = round(close_y - flat_height / 2)
        out.alpha_composite(closed, (box[0], top))
        details.append({"box": list(box), "closeY": round(close_y, 2), "lineHeight": flat_height})
    return out, {"eyes": details}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    def load(name: str) -> Image.Image:
        path = args.layer_dir / name
        if not path.is_file():
            raise FileNotFoundError(path)
        return Image.open(path).convert("RGBA")

    mouth = load("mouth_close.png") if (args.layer_dir / "mouth_close.png").is_file() else load("mouth.png")
    eyelash = load("eyelash.png")
    eyewhite = load("eyewhite.png")
    irides = load("irides.png")
    center_x = eyelash.width / 2

    args.output_dir.mkdir(parents=True, exist_ok=True)
    mouth_open, mouth_report = build_mouth_open(mouth)
    mouth_open.save(args.output_dir / "mouth_open.png")
    eye_close, eye_report = build_eye_close(eyelash, eyewhite, irides, center_x)
    eye_close.save(args.output_dir / "eye_close.png")
    report = {
        "schemaVersion": 1,
        "provenance": "derived-preview",
        "note": "Derived from the neutral image for preview only; not production expression artwork.",
        "files": ["mouth_open.png", "eye_close.png"],
        "mouthOpen": mouth_report,
        "eyeClose": eye_report,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
