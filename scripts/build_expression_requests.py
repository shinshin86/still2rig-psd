#!/usr/bin/env python3
"""Prepare local, masked face crops for an image generation service."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from expression_definitions import load_expressions
from expression_requests_common import composite_layers, file_hash, layer_hash, mouth_limits, neutral_layers


def alpha_union(layers, names, size):
    mask = Image.new("L", size, 0)
    for name in names:
        if name in layers:
            alpha = layers[name].getchannel("A").point(lambda value: 255 if value > 16 else 0)
            mask = ImageChops.lighter(mask, alpha)
    return mask


def build_requests(job_id: str, layer_dir: Path, layer_map: Path, output_dir: Path, definitions=None):
    mapping = json.loads(layer_map.read_text(encoding="utf-8"))
    definitions = load_expressions(mapping) if definitions is None else definitions
    requested = [item for item in definitions if item["prompt"] is not None]
    composite, layers = neutral_layers(layer_dir, mapping, definitions)
    quality = json.loads((Path(__file__).resolve().parent.parent / "configs" / "default.json").read_text(encoding="utf-8"))["quality"]
    limits = mouth_limits(layers["face"], quality)
    face = alpha_union(layers, ["face", *[name for item in requested for name in item["editableLayers"]]], composite.size)
    box = face.getbbox()
    if not box:
        raise ValueError("The face layers are empty.")
    margin = max(4, round(max(box[2] - box[0], box[3] - box[1]) * 0.12))
    crop_box = [max(0, box[0] - margin), max(0, box[1] - margin),
                min(composite.width, box[2] + margin), min(composite.height, box[3] + margin)]
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "results").mkdir(exist_ok=True)
    variants = {}
    crop_size = (crop_box[2] - crop_box[0], crop_box[3] - crop_box[1])
    scale = min(4, max(1, math.ceil(1024 / max(crop_size))))
    request_size = (crop_size[0] * scale, crop_size[1] * scale)
    for definition in requested:
        name, targets, mask_options = definition["name"], definition["editableLayers"], definition["mask"]
        editable = alpha_union(layers, targets, composite.size)
        editable_box = editable.getbbox()
        if not editable_box:
            raise ValueError(f"Cannot prepare {name}: the relevant layers are empty.")
        if mask_options["fillBounds"]:
            # A curved closed-mouth line may surround unpainted pixels. Include
            # its interior so the generator can draw a complete mouth opening.
            ImageDraw.Draw(editable).rectangle(
                (editable_box[0], editable_box[1], editable_box[2] - 1, editable_box[3] - 1), fill=255)
        dilation = max(mask_options["minimumDilation"], round((editable_box[2] - editable_box[0]) * mask_options["dilationRatio"]))
        editable = editable.filter(ImageFilter.MaxFilter(2 * dilation + 1))
        if mask_options["mouthLimits"]:
            # Keep the lip-line position, leaving the full permitted opening
            # below it plus a boundary margin for soft edges.
            center_x = (editable_box[0] + editable_box[2]) / 2
            center_y = (editable_box[1] + editable_box[3]) / 2
            half_width = limits["open"]["maximumWidth"] / 2 + dilation
            ImageDraw.Draw(editable).rectangle((
                round(center_x - half_width), round(center_y - limits["open"]["maximumHeight"] / 2 - dilation),
                round(center_x + half_width), editable_box[1] + limits["open"]["maximumHeight"] + dilation,
            ), fill=255)
        editable_box = editable.getbbox()
        editable = editable.crop(crop_box).resize(request_size, Image.Resampling.NEAREST)
        variant_dir = output_dir / name
        variant_dir.mkdir(exist_ok=True)
        composite.crop(crop_box).resize(request_size, Image.Resampling.LANCZOS).save(variant_dir / "input.png")
        composite_layers(layers, targets, definitions).crop(crop_box).resize(request_size, Image.Resampling.LANCZOS).save(variant_dir / "underlay.png")
        mask = Image.new("RGBA", editable.size, (255, 255, 255, 255))
        mask.putalpha(ImageChops.invert(editable))
        mask.save(variant_dir / "mask.png")
        prompt = (definition["prompt"] + " Use input.png as the reference and mask.png as the edit mask: "
                  "transparent mask pixels may change; opaque mask pixels must stay identical. "
                  f"Return a PNG of exactly {request_size[0]}x{request_size[1]} pixels, with no crop, shift or added border. "
                  "Do not change any pixels outside the editable mask. "
                  "Front hair and head accessories are intentionally hidden to keep expression layers separate. "
                  "Do not add hair or accessories.\n")
        (variant_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
        variants[name] = {
            "cropBox": crop_box, "scale": scale, "size": list(editable.size),
            "input": f"{name}/input.png", "mask": f"{name}/mask.png", "prompt": f"{name}/prompt.txt",
            "underlay": f"{name}/underlay.png",
            "inputSha256": file_hash(variant_dir / "input.png"),
            "maskSha256": file_hash(variant_dir / "mask.png"),
            "underlaySha256": file_hash(variant_dir / "underlay.png"),
            "result": f"results/{name}.png", "dilationPx": dilation,
            "editableBox": list(editable_box),
            **({"mouthLimits": limits} if mask_options["mouthLimits"] else {}),
        }
    report = {
        "schemaVersion": 2, "jobId": job_id, "canvas": list(composite.size),
        "layerDir": layer_dir.relative_to(Path.cwd()).as_posix(),
        "layerSha256": layer_hash(layer_dir, layer_map), "variants": variants,
    }
    (output_dir / "requests.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    request_title = " and ".join(item["requestLabel"] for item in requested)
    result_paths = " and ".join(f"results/{item['name']}.png" for item in requested)
    (output_dir / "README.md").write_text(
        f"# Generate {request_title}\n\n"
        "Ask the image owner for permission before sending these images to an image generation service. "
        "The face crops leave this machine when you send them.\n\n"
        "For each variant, give the generator input.png, mask.png and the instructions in prompt.txt. "
        "The mask is transparent where editing is allowed and opaque where pixels must stay identical. "
        "These crops use the current PSD canvas, not the original source image. "
        "Small crops are enlarged by an integer factor (at most 4) toward a long side of at least 1024 pixels. "
        "Keep the enlarged input dimensions; import restores the original canvas scale automatically. "
        "Front hair and head accessories above the expression layers are intentionally hidden; do not add them. "
        "underlay.png is a local background reference for extracting only new artwork; do not edit it or send it.\n\n"
        f"Save the returned PNGs as {result_paths} in this directory. "
        "Keep the input size and position. Do not overwrite input.png, mask.png or underlay.png. "
        "If you rerun requests, use new results made from the new inputs.\n\n"
        f"Run `npm run still2rig-psd -- import-expressions {job_id}` to validate and restore full-canvas layers. "
        "Then use the reported repair command. Import is not a quality approval: the existing expression QA "
        "and visual review are still required.\n", encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--layer-dir", type=Path, required=True)
    parser.add_argument("--layer-map", type=Path, default=Path("configs/layer-map.json"))
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build_requests(args.job_id, args.layer_dir, args.layer_map, args.output_dir)))


if __name__ == "__main__":
    main()
