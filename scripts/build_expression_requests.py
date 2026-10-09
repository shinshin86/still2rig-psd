#!/usr/bin/env python3
"""Prepare local, masked face crops for an image generation service."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from expression_requests_common import composite_layers, file_hash, layer_hash, neutral_layers


PROMPTS = {
    "eye_close": "Close both eyes with natural anime eyelid lines matching the existing line art and skin. Remove the open eyes inside the editable areas. Keep the same face, pose, hair, lighting and colors.",
    "mouth_open": 'Replace the closed mouth with a small natural open mouth saying Japanese "あ", matching the existing anime line art, position and colors. Keep the same face, eyes, pose, hair and lighting.',
}


def alpha_union(layers, names, size):
    mask = Image.new("L", size, 0)
    for name in names:
        if name in layers:
            alpha = layers[name].getchannel("A").point(lambda value: 255 if value > 16 else 0)
            mask = ImageChops.lighter(mask, alpha)
    return mask


def build_requests(job_id: str, layer_dir: Path, layer_map: Path, output_dir: Path):
    composite, layers = neutral_layers(layer_dir, json.loads(layer_map.read_text(encoding="utf-8")))
    face = alpha_union(layers, ["face", "eyewhite", "irides", "eyelash", "mouth_close"], composite.size)
    box = face.getbbox()
    if not box:
        raise ValueError("The face layers are empty.")
    margin = max(4, round(max(box[2] - box[0], box[3] - box[1]) * 0.12))
    crop_box = [max(0, box[0] - margin), max(0, box[1] - margin),
                min(composite.width, box[2] + margin), min(composite.height, box[3] + margin)]
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "results").mkdir(exist_ok=True)
    variants = {}
    for name, targets in [("eye_close", ["eyewhite", "irides", "eyelash"]),
                          ("mouth_open", ["mouth_close"])]:
        editable = alpha_union(layers, targets, composite.size)
        editable_box = editable.getbbox()
        if not editable_box:
            raise ValueError(f"Cannot prepare {name}: the relevant layers are empty.")
        if name == "mouth_open":
            # A curved closed-mouth line may surround unpainted pixels. Include
            # its interior so the generator can draw a complete mouth opening.
            ImageDraw.Draw(editable).rectangle(
                (editable_box[0], editable_box[1], editable_box[2] - 1, editable_box[3] - 1), fill=255)
        dilation = max(3, round((editable_box[2] - editable_box[0]) * (0.04 if name == "eye_close" else 0.2)))
        editable = editable.filter(ImageFilter.MaxFilter(2 * dilation + 1)).crop(crop_box)
        variant_dir = output_dir / name
        variant_dir.mkdir(exist_ok=True)
        composite.crop(crop_box).save(variant_dir / "input.png")
        composite_layers(layers, targets).crop(crop_box).save(variant_dir / "underlay.png")
        mask = Image.new("RGBA", editable.size, (255, 255, 255, 255))
        mask.putalpha(ImageChops.invert(editable))
        mask.save(variant_dir / "mask.png")
        prompt = (PROMPTS[name] + " Use input.png as the reference and mask.png as the edit mask: "
                  "transparent mask pixels may change; opaque mask pixels must stay identical. "
                  "Return a PNG of exactly the input dimensions, with no crop, shift or added border. "
                  "Do not change any pixels outside the editable mask. "
                  "Front hair and head accessories are intentionally hidden to keep expression layers separate. "
                  "Do not add hair or accessories.\n")
        (variant_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
        variants[name] = {
            "cropBox": crop_box, "scale": 1, "size": list(editable.size),
            "input": f"{name}/input.png", "mask": f"{name}/mask.png", "prompt": f"{name}/prompt.txt",
            "underlay": f"{name}/underlay.png",
            "inputSha256": file_hash(variant_dir / "input.png"),
            "maskSha256": file_hash(variant_dir / "mask.png"),
            "underlaySha256": file_hash(variant_dir / "underlay.png"),
            "result": f"results/{name}.png", "dilationPx": dilation,
        }
    report = {
        "schemaVersion": 2, "jobId": job_id, "canvas": list(composite.size),
        "layerDir": layer_dir.relative_to(Path.cwd()).as_posix(),
        "layerSha256": layer_hash(layer_dir, layer_map), "variants": variants,
    }
    (output_dir / "requests.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (output_dir / "README.md").write_text(
        "# Generate closed eyes and an open mouth\n\n"
        "Ask the image owner for permission before sending these images to an image generation service. "
        "The face crops leave this machine when you send them.\n\n"
        "For each variant, give the generator input.png, mask.png and the instructions in prompt.txt. "
        "The mask is transparent where editing is allowed and opaque where pixels must stay identical. "
        "These crops use the current PSD canvas, not the original source image. "
        "Front hair and head accessories above the expression layers are intentionally hidden; do not add them. "
        "underlay.png is a local background reference for extracting only new artwork; do not edit it or send it.\n\n"
        "Save the returned PNGs as results/eye_close.png and results/mouth_open.png in this directory. "
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
