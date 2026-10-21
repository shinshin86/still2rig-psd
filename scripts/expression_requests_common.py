"""Shared canvas and provenance helpers for expression requests."""

from __future__ import annotations

import hashlib
from pathlib import Path

from PIL import Image

from render_expression_states import selected_layers
from expression_definitions import load_expressions


def mouth_limits(face: Image.Image, quality: dict) -> dict:
    box = face.getchannel("A").point(lambda value: 255 if value > quality["alphaThreshold"] else 0).getbbox()
    if not box:
        raise ValueError("A visible face layer is required for mouth size limits.")
    width, height = box[2] - box[0], box[3] - box[1]
    limits = {"faceBox": list(box)}
    for state in ("Close", "Open"):
        prefix = f"mouth{state}MaxFace"
        # These match src/qa.mjs: an opening may be taller and denser than a lip line.
        limits[state.lower()] = {
            "maximumWidth": max(quality["mouthMaxWidthFloor"], int(width * quality[prefix + "WidthRatio"] + 0.5)),
            "maximumHeight": max(quality["mouthMaxHeightFloor"], int(height * quality[prefix + "HeightRatio"] + 0.5)),
            "maximumVisiblePixels": max(quality["mouthMaxVisiblePixelsFloor"], int(width * height * quality[prefix + "PixelRatio"] + 0.5)),
        }
    return limits


def file_hash(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def layer_hash(layer_dir: Path, layer_map: Path) -> str:
    digest = hashlib.sha256(layer_map.read_bytes())
    for file in sorted(layer_dir.glob("*.png")):
        digest.update(file.name.encode("utf-8") + b"\0")
        digest.update(bytes.fromhex(file_hash(file)))
    return digest.hexdigest()


def neutral_layers(layer_dir: Path, layer_map: dict, definitions=None, include_front=False):
    definitions = load_expressions(layer_map) if definitions is None else definitions
    selected = selected_layers(layer_dir, layer_map)
    if not selected:
        raise ValueError("No current PSD layers found. Finalize first.")
    order = list(dict.fromkeys(entry["target"] for entry in layer_map["layers"]))
    # Expressions must stay independent of hair/accessories animated above them.
    allowed = set(order[:max(order.index(item["name"]) for item in definitions) + 1])
    layers = {name: Image.open(file).convert("RGBA") for name, file in selected
              if name in allowed and (include_front or name not in ("front hair", "headwear"))}
    size = next(iter(layers.values())).size
    if any(image.size != size for image in layers.values()):
        raise ValueError("Current PSD layers have different canvas sizes.")
    return composite_layers(layers, definitions=definitions), layers


def composite_layers(layers: dict, excluded=(), definitions=None) -> Image.Image:
    definitions = load_expressions() if definitions is None else definitions
    hidden = {item["name"] for item in definitions if item["prompt"] is not None}
    composite = Image.new("RGBA", next(iter(layers.values())).size)
    for name, image in layers.items():
        if name not in {*hidden, *excluded}:
            composite.alpha_composite(image)
    return composite
