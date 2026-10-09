"""Shared canvas and provenance helpers for expression requests."""

from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image

from render_expression_states import selected_layers


def file_hash(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def layer_hash(layer_dir: Path, layer_map: Path) -> str:
    digest = hashlib.sha256(layer_map.read_bytes())
    for file in sorted(layer_dir.glob("*.png")):
        digest.update(file.name.encode("utf-8") + b"\0")
        digest.update(bytes.fromhex(file_hash(file)))
    return digest.hexdigest()


def neutral_layers(layer_dir: Path, layer_map: dict):
    selected = selected_layers(layer_dir, layer_map)
    if not selected:
        raise ValueError("No current PSD layers found. Finalize first.")
    order = list(dict.fromkeys(entry["target"] for entry in layer_map["layers"]))
    # Expressions must stay independent of hair/accessories animated above them.
    allowed = set(order[:order.index("eye_close") + 1])
    layers = {name: Image.open(file).convert("RGBA") for name, file in selected if name in allowed}
    size = next(iter(layers.values())).size
    if any(image.size != size for image in layers.values()):
        raise ValueError("Current PSD layers have different canvas sizes.")
    return composite_layers(layers), layers


def composite_layers(layers: dict, excluded=()) -> Image.Image:
    composite = Image.new("RGBA", next(iter(layers.values())).size)
    for name, image in layers.items():
        if name not in {"mouth_open", "eye_close", *excluded}:
            composite.alpha_composite(image)
    return composite
