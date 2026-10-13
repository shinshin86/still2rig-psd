#!/usr/bin/env python3
"""Clean See-through PNG layers and emit deterministic geometry metadata."""

from __future__ import annotations

import argparse
import json
import math
import shutil
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


OPTIONAL_DROP = {"bottomwear.png", "handwear.png", "earwear.png", "headwear.png"}
EXPRESSION_FILES = {"mouth_open.png", "mouth_close.png", "eye_close.png"}


def locate_layer_dir(root: Path) -> Path:
    candidates = []
    for face in root.rglob("face.png"):
        parent = face.parent
        score = sum((parent / name).is_file() for name in ("face.png", "eyewhite.png", "irides.png", "mouth.png"))
        if score >= 3:
            candidates.append((score, len(parent.parts), parent))
    if not candidates:
        raise FileNotFoundError("could not locate a See-through layer directory")
    candidates.sort(key=lambda item: (-item[0], item[1], item[2].as_posix()))
    return candidates[0][2]


def clean_alpha(image: Image.Image, threshold: int, min_pixels: int) -> tuple[Image.Image, int]:
    rgba = image.convert("RGBA")
    width, height = rgba.size
    alpha = rgba.getchannel("A").tobytes()
    seen = bytearray(width * height)
    keep = bytearray(width * height)
    for start in range(width * height):
        if seen[start] or alpha[start] <= threshold:
            continue
        queue = deque([start])
        seen[start] = 1
        component = []
        while queue:
            position = queue.popleft()
            component.append(position)
            x = position % width
            for neighbor in (position - 1, position + 1, position - width, position + width):
                if neighbor < 0 or neighbor >= width * height or seen[neighbor]:
                    continue
                if abs(neighbor % width - x) > 1:
                    continue
                if alpha[neighbor] > threshold:
                    seen[neighbor] = 1
                    queue.append(neighbor)
        if len(component) >= min_pixels:
            for position in component:
                keep[position] = 255
    mask = Image.frombytes("L", (width, height), bytes(keep)).filter(ImageFilter.MaxFilter(7))
    cleaned_alpha = Image.composite(rgba.getchannel("A"), Image.new("L", rgba.size, 0), mask)
    rgba.putalpha(cleaned_alpha)
    meaningful = sum(value > threshold for value in cleaned_alpha.tobytes())
    return rgba, meaningful


def geometry(image: Image.Image, threshold: int) -> dict:
    alpha = image.convert("RGBA").getchannel("A")
    bbox = alpha.point(lambda value: 255 if value > threshold else 0).getbbox()
    if bbox is None:
        return {"bbox": None, "centroid": None, "visiblePixels": 0}
    pixels = alpha.load()
    sx = sy = weight = 0.0
    visible = 0
    for y in range(bbox[1], bbox[3]):
        for x in range(bbox[0], bbox[2]):
            value = pixels[x, y]
            if value <= threshold:
                continue
            visible += 1
            sx += x * value
            sy += y * value
            weight += value
    return {
        "bbox": list(bbox),
        "centroid": {"x": round(sx / weight, 4), "y": round(sy / weight, 4)},
        "visiblePixels": visible,
    }


def make_contact_sheet(files: list[Path], destination: Path) -> None:
    cell = 220
    label = 30
    columns = 4
    rows = max(1, math.ceil(len(files) / columns))
    sheet = Image.new("RGB", (columns * cell, rows * (cell + label)), "white")
    draw = ImageDraw.Draw(sheet)
    checker = Image.new("RGB", (cell, cell), "white")
    checker_draw = ImageDraw.Draw(checker)
    for y in range(0, cell, 16):
        for x in range(0, cell, 16):
            if (x // 16 + y // 16) % 2:
                checker_draw.rectangle((x, y, x + 15, y + 15), fill=(226, 229, 235))
    for index, path in enumerate(files):
        image = Image.open(path).convert("RGBA")
        image.thumbnail((cell, cell), Image.Resampling.LANCZOS)
        tile = checker.copy().convert("RGBA")
        tile.alpha_composite(image, ((cell - image.width) // 2, (cell - image.height) // 2))
        ox = (index % columns) * cell
        oy = (index // columns) * (cell + label)
        sheet.paste(tile.convert("RGB"), (ox, oy))
        draw.text((ox + 5, oy + cell + 8), path.name[:32], fill="black")
    destination.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(destination, quality=90, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--contact-sheet", type=Path, required=True)
    parser.add_argument("--expressions", type=Path)
    parser.add_argument("--layer-overrides", type=Path)
    parser.add_argument("--alpha-threshold", type=int, default=16)
    parser.add_argument("--minimum-component-pixels", type=int, default=40)
    parser.add_argument("--drop-optional-below", type=int, default=1000)
    args = parser.parse_args()

    layer_dir = locate_layer_dir(args.raw_root)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    sources: dict[str, Path] = {path.name: path for path in layer_dir.glob("*.png")}
    expression_names = []
    override_names = []
    if args.layer_overrides:
        if not args.layer_overrides.is_dir():
            raise FileNotFoundError(args.layer_overrides)
        for candidate in sorted(args.layer_overrides.glob("*.png")):
            if candidate.name not in sources:
                raise ValueError(f"layer override does not match an imported layer: {candidate.name}")
            if candidate.name in EXPRESSION_FILES:
                raise ValueError(f"use --expressions for expression layer: {candidate.name}")
            sources[candidate.name] = candidate
            override_names.append(candidate.name)
    if args.expressions:
        if not args.expressions.is_dir():
            raise FileNotFoundError(args.expressions)
        for name in sorted(EXPRESSION_FILES):
            candidate = args.expressions / name
            if candidate.is_file():
                sources[name] = candidate
                expression_names.append(name)

    canvas = None
    rows = []
    for name, source in sorted(sources.items()):
        image = Image.open(source).convert("RGBA")
        if canvas is None:
            canvas = image.size
        if image.size != canvas:
            raise ValueError(f"layer dimensions differ: {name}={image.size}, expected={canvas}")
        if name in override_names:
            # Supplied artwork can intentionally contain tiny highlights/ink.
            cleaned = image.copy()
            cleaned.putalpha(image.getchannel("A").point(lambda value: value if value > args.alpha_threshold else 0))
            meaningful = sum(value > args.alpha_threshold for value in cleaned.getchannel("A").tobytes())
        else:
            cleaned, meaningful = clean_alpha(image, args.alpha_threshold, args.minimum_component_pixels)
        dropped = name not in override_names and name in OPTIONAL_DROP and meaningful < args.drop_optional_below
        target = args.output_dir / name
        if not dropped:
            cleaned.save(target, optimize=True)
        row = {"name": name, **geometry(cleaned, args.alpha_threshold), "dropped": dropped}
        rows.append(row)

    written = sorted(path for path in args.output_dir.glob("*.png") if path.is_file())
    make_contact_sheet(written, args.contact_sheet)
    report = {
        "schemaVersion": 1,
        "canvas": list(canvas or (0, 0)),
        "layers": rows,
        "expressionFiles": expression_names,
        "layerOverrides": override_names,
        "counts": {"source": len(sources), "written": len(written), "dropped": sum(row["dropped"] for row in rows)},
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
