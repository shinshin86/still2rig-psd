#!/usr/bin/env python3
"""Prepare local, masked face crops for an image generation service."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from expression_definitions import load_expressions
from expression_masks import alpha_union, cheek_mask, overlay_mask, whole_eye_mask, expand_up, exclude_eye_obstacles, expand_eye_sides
from expression_requests_common import composite_layers, file_hash, layer_hash, mouth_limits, neutral_layers
from closed_mouth import closed_mouth_quality, mouth_support


def build_requests(job_id: str, layer_dir: Path, layer_map: Path, output_dir: Path, definitions=None, only=None):
    mapping = json.loads(layer_map.read_text(encoding="utf-8"))
    definitions = load_expressions(mapping) if definitions is None else definitions
    available = [item for item in definitions if item["prompt"] is not None]
    if only is not None:
        names = [item["name"] for item in available] if only == "all" else only.split(",")
        if not names or len(set(names)) != len(names) or any(name not in {item["name"] for item in available} for name in names):
            raise ValueError("Choose known expressions with --only name,name or --only all.")
        requested = [item for item in available if item["name"] in names]
    else:
        requested = [item for item in available if item["requiredForProduction"]]
    if only == "all":
        requested = [item for item in requested if item["name"] != "mouth_close"]
    original_names = [item["name"] for item in requested]
    # Inspect the mapped override, never a hard-coded source filename.
    _, base_layers = neutral_layers(layer_dir, mapping, definitions)
    quality = json.loads((Path(__file__).resolve().parent.parent / "configs" / "default.json").read_text(encoding="utf-8"))["quality"]
    closed = closed_mouth_quality(base_layers.get("mouth_close"), base_layers["face"], quality)
    needs_closed = not closed["usable"] and any(item["registration"] == "mouth" for item in requested)
    if needs_closed:
        requested = [next(item for item in available if item["name"] == "mouth_close")]
    overlays = any(item["extraction"] == "overlay" for item in requested)
    composite, layers = neutral_layers(layer_dir, mapping, definitions, include_front=overlays)
    limits = mouth_limits(layers["face"], quality)
    face = alpha_union(layers, ["face", *[name for item in requested for name in item["editableLayers"]]], composite.size)
    box = face.getbbox()
    if not box:
        raise ValueError("The face layers are empty.")
    margin = max(4, round(max(box[2] - box[0], box[3] - box[1]) * 0.12))
    crop_box = [max(0, box[0] - margin), max(0, box[1] - margin),
                min(composite.width, box[2] + margin), min(composite.height, box[3] + margin)]
    if overlays:
        side = min(max(crop_box[2]-crop_box[0],crop_box[3]-crop_box[1]),composite.width,composite.height)
        cx, cy = (box[0]+box[2])/2, (box[1]+box[3])/2
        left = max(0,min(composite.width-side,round(cx-side/2)))
        top = max(0,min(composite.height-side,round(cy-side/2)))
        crop_box = [left,top,left+side,top+side]
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "results").mkdir(exist_ok=True)
    variants = {}
    crop_size = (crop_box[2] - crop_box[0], crop_box[3] - crop_box[1])
    scale = min(4, max(1, math.ceil(1024 / max(crop_size))))
    request_size = (crop_size[0] * scale, crop_size[1] * scale)
    for definition in requested:
        name, targets, mask_options = definition["name"], definition["editableLayers"], definition["mask"]
        variant_layers = layers if definition["extraction"] == "overlay" else {key:value for key,value in layers.items() if key not in ("front hair","headwear")}
        variant_composite = composite_layers(variant_layers,definitions=definitions)
        region = mask_options.get("region")
        mask_layers = layers
        if region == "cheeks" and not closed["usable"]:
            support, _ = mouth_support(layers, quality)
            reserved = Image.new("RGBA", composite.size)
            reserved.putalpha(support)
            mask_layers = {**layers, "mouth_close": reserved}
        editable = overlay_mask(layers,composite.size,region) if definition["extraction"] == "overlay" and definition["registration"] == "face" else cheek_mask(mask_layers, composite.size) if region == "cheeks" else alpha_union(layers, targets, composite.size)
        placement = None
        if name == "mouth_close":
            editable, placement = mouth_support(layers, quality)
        if region == "eyes":
            editable = whole_eye_mask(layers, composite.size)
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
        upper = round((editable_box[2] - editable_box[0]) * mask_options.get("upperExpansionRatio", 0))
        editable = expand_up(editable, upper)
        protect_eye_features = definition["registration"] == "eyes" and mask_options.get("upperExpansionRatio", 0) > 0
        if protect_eye_features:
            editable = expand_eye_sides(editable, layers, max(4, dilation))
            editable = exclude_eye_obstacles(editable, layer_dir, mapping,
                                             eye_support=alpha_union(layers, targets, composite.size, threshold=0),
                                             eye_padding=max(4, dilation))
        if definition["registration"] == "mouth" and definition["extraction"] == "overlay":
            editable = ImageChops.multiply(editable, alpha_union(layers, ["face"], composite.size).filter(ImageFilter.MinFilter(9)))
        editable_box = editable.getbbox()
        editable = editable.crop(crop_box).resize(request_size, Image.Resampling.NEAREST)
        variant_dir = output_dir / name
        variant_dir.mkdir(exist_ok=True)
        variant_composite.crop(crop_box).resize(request_size, Image.Resampling.LANCZOS).save(variant_dir / "input.png")
        composite_layers(variant_layers, [] if region == "cheeks" or (definition["extraction"] == "overlay" and definition["registration"] == "face") else targets, definitions).crop(crop_box).resize(request_size, Image.Resampling.LANCZOS).save(variant_dir / "underlay.png")
        mask = Image.new("RGBA", editable.size, (255, 255, 255, 255))
        mask.putalpha(ImageChops.invert(editable))
        mask.save(variant_dir / "mask.png")
        prompt = (definition["prompt"] + " Use input.png as the reference and mask.png as the edit mask: "
                  "transparent mask pixels may change; opaque mask pixels must stay identical. "
                  f"Return a PNG of exactly {request_size[0]}x{request_size[1]} pixels, with no crop, shift or added border. "
                  "Do not change any pixels outside the editable mask. "
                  "Front hair and head accessories are intentionally hidden to keep expression layers separate. "
                  "Do not add hair or accessories.\n")
        if definition["extraction"] == "overlay":
            prompt = (definition["prompt"] + " input.png is a placement and style reference only. "
                      "mask.png is a placement guide: draw only within its transparent region. "
                      "Everything else, including the character, must be alpha=0 in the returned PNG. "
                      f"Keep the square canvas and exact reference positions; target size {request_size[0]}x{request_size[1]}. "
                      "Never draw a checkerboard or white background. Do not crop or center the small artwork.\n")
        (variant_dir / "prompt.txt").write_text(prompt, encoding="utf-8")
        variants[name] = {
            "cropBox": crop_box, "scale": scale, "size": list(editable.size),
            "input": f"{name}/input.png", "mask": f"{name}/mask.png", "prompt": f"{name}/prompt.txt",
            "underlay": f"{name}/underlay.png",
            "inputSha256": file_hash(variant_dir / "input.png"),
            "maskSha256": file_hash(variant_dir / "mask.png"),
            "underlaySha256": file_hash(variant_dir / "underlay.png"),
            **({"outputMode": "transparent-overlay"} if definition["extraction"] == "overlay" else {}),
            "result": f"results/{name}.png", "dilationPx": dilation,
            "editableBox": list(editable_box),
            **({"protectedFeatures": {"layers": ["eyebrow", "front hair"], "paddingPx": 4}} if protect_eye_features else {}),
            **({"eyeEnvelopeMarginPx": max(4, dilation)} if protect_eye_features else {}),
            **({"faceContourInsetPx": 4} if mask_options.get("region") == "cheeks" else {}),
            **({"mouthLimits": limits} if mask_options["mouthLimits"] else {}),
            **({"mouthPlacement": placement} if placement else {}),
        }
    report = {
        "schemaVersion": 2, "jobId": job_id, "canvas": list(composite.size),
        "layerDir": layer_dir.relative_to(Path.cwd()).as_posix(),
        "layerSha256": layer_hash(layer_dir, layer_map), "variants": variants,
        "closedMouth": closed, "stage": "closed-mouth" if needs_closed else "expressions",
        "requestedExpressions": original_names,
        "deferredExpressions": [name for name in original_names if name != "mouth_close"] if needs_closed else [],
        "resumeOnly": only,
    }
    (output_dir / "requests.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    request_title = " and ".join(item["requestLabel"] for item in requested)
    result_paths = ", ".join(f"results/{item['name']}.png" for item in requested)
    (output_dir / "README.md").write_text(
        f"# Generate {request_title}\n\n"
        "Ask the image owner for permission before sending these images to an image generation service. "
        "The face crops leave this machine when you send them.\n\n"
        "For each drawing, use its input.png, mask.png and prompt.txt to generate one image. "
        "Transparent mask pixels may change; opaque pixels must stay identical. "
        "The crops use the current PSD layers, with front hair and accessories hidden. "
        "Do not add hair or accessories. Keep the original dimensions and coordinates. "
        "underlay.png is local extraction data; do not modify or send it.\n\n"
        f"Save images as {result_paths}. "
        "Never overwrite the input, mask or underlay. Validate each result with "
        f"`npm run still2rig-psd -- import-expressions {job_id} --only NAME --read-only` "
        "and inspect the extracted artwork. Regenerate a failed drawing at most twice; "
        "skip it with a reason if it still fails, and continue with the others.\n\n"
        + ("The closed mouth is missing or unusable. Generate and validate only mouth_close first, "
           f"import with `npm run still2rig-psd -- import-expressions {job_id} --only mouth_close`, "
           f"then run `npm run still2rig-psd -- repair {job_id} --expressions .still2rig-psd/jobs/{job_id}/generated-expressions`. "
           + (f"Rerun `npm run still2rig-psd -- expression-requests {job_id}" + (f" --only {only}" if only else "") + "` "
              "and use the fresh inputs for the remaining expressions. Do not generate other mouths before this step. "
              if report["deferredExpressions"] else "The requested closed-mouth repair is now complete. ") +
           "Continue in the same request without asking the user to choose candidates.\n"
           if needs_closed else
           "Import accepted names together with --only, then repair once. "
           "Finish with one overview, retry counts, skipped drawings and QA results. "
           "Do not pause for per-expression selection. Import alone does not establish visual quality.\n"), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--layer-dir", type=Path, required=True)
    parser.add_argument("--layer-map", type=Path, default=Path("configs/layer-map.json"))
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--only")
    args = parser.parse_args()
    print(json.dumps(build_requests(args.job_id, args.layer_dir, args.layer_map, args.output_dir, only=args.only)))


if __name__ == "__main__":
    main()
