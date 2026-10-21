#!/usr/bin/env python3
"""Render close/open expression previews from the same layer order used by the PSD builder."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

from expression_definitions import load_expressions


def checkerboard(size: tuple[int, int], cell: int = 32) -> Image.Image:
    image = Image.new("RGBA", size, (42, 47, 59, 255))
    draw = ImageDraw.Draw(image)
    colors = ((42, 47, 59, 255), (58, 65, 80, 255))
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill=colors[(x // cell + y // cell) % 2])
    return image


def selected_layers(layer_dir: Path, layer_map: dict) -> list[tuple[str, Path]]:
    order = []
    selected = {}
    for entry in layer_map["layers"]:
        target = entry["target"]
        if target not in order:
            order.append(target)
        source = layer_dir / entry["source"]
        if not source.is_file():
            continue
        if target not in selected or entry.get("override"):
            selected[target] = source
    return [(target, selected[target]) for target in order if target in selected]


def render(layers: list[tuple[str, Path]], state: str) -> Image.Image:
    first = Image.open(layers[0][1]).convert("RGBA")
    composite = Image.new("RGBA", first.size)
    definitions = load_expressions()
    hidden = {item["name"] for item in definitions if item["prompt"] is not None}
    if state == "open":
        hidden = {item["name"] for item in definitions if item["prompt"] is not None and item["registration"] != "mouth"}
        hidden.update(item["placeholderFrom"] for item in definitions if item["registration"] == "mouth" and item["placeholderFrom"])
    for name, source in layers:
        if name in hidden:
            continue
        composite.alpha_composite(Image.open(source).convert("RGBA"))
    background = checkerboard(composite.size)
    background.alpha_composite(composite)
    return background.convert("RGB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layer-dir", type=Path, required=True)
    parser.add_argument("--layer-map", type=Path, default=Path("configs/layer-map.json"))
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    layer_map = json.loads(args.layer_map.read_text(encoding="utf-8"))
    layers = selected_layers(args.layer_dir, layer_map)
    if not layers:
        raise RuntimeError("no PSD layers were found")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {}
    for state in ("close", "open"):
        destination = args.output_dir / f"preview-mouth-{state}.png"
        render(layers, state).save(destination, optimize=True)
        outputs[state] = destination.as_posix()
    print(json.dumps({"layerOrder": [name for name, _ in layers], "outputs": outputs}))


if __name__ == "__main__":
    main()
