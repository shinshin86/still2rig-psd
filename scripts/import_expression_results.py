#!/usr/bin/env python3
"""Validate generated crops and restore masked expression layers to the PSD canvas."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

from expression_requests_common import file_hash, layer_hash


def protected_diff(reference, result, mask):
    # Compare premultiplied RGBA, so invisible RGB noise is ignored but lost
    # transparency is caught. Histogram avoids storing millions of differences.
    protected = mask.getchannel("A").point(lambda value: 255 if value == 255 else 0)
    count = protected.histogram()[255]
    if not count:
        raise ValueError("Request mask has no protected pixels.")
    histogram = [0] * 256
    for channel in ImageChops.difference(reference.convert("RGBa"), result.convert("RGBa")).split():
        for value, frequency in enumerate(channel.histogram(mask=protected)):
            histogram[value] += frequency
    samples = count * 4
    mean = sum(value * frequency for value, frequency in enumerate(histogram)) / samples
    cumulative = 0
    percentile = 0
    for value, frequency in enumerate(histogram):
        cumulative += frequency
        if cumulative >= math.ceil(samples * 0.99):
            percentile = value
            break
    return {"meanAbsoluteDiff": round(mean, 4), "p99AbsoluteDiff": percentile, "protectedPixels": count}


def protected_band(reference, editable, width):
    ring = ImageChops.subtract(editable.filter(ImageFilter.MaxFilter(2 * width + 1)), editable)
    opaque = reference.getchannel("A").point(lambda value: 255 if value > 16 else 0)
    ring = ImageChops.multiply(ring, opaque)
    mask = Image.new("RGBA", reference.size)
    mask.putalpha(ring)
    return mask


def alignment_check(reference, result, band, radius):
    width, height = reference.size
    source = reference.convert("RGB").load()
    target = result.convert("RGB").load()
    positions = [(i % width, i // width) for i, value in enumerate(band.getchannel("A").tobytes()) if value]
    stride = max(1, math.ceil(len(positions) / 1200))
    points = positions[::stride]
    if not points:
        raise ValueError("No opaque protected band is available for alignment.")
    cx, cy = width / 2, height / 2

    def cost(dx, dy, scale):
        total = count = 0
        for x, y in points:
            tx, ty = round(cx + (x - cx) * scale + dx), round(cy + (y - cy) * scale + dy)
            if not (0 <= tx < width and 0 <= ty < height):
                continue
            a, b = source[x, y], target[tx, ty]
            # Bound the effect of occasional regenerated line-art pixels.
            total += sum(min(abs(a[c] - b[c]), 48) for c in range(3)) / 3
            count += 1
        return total / count if count >= len(points) * 0.9 else float("inf")

    baseline = cost(0, 0, 1)
    best = (baseline, 0, 0, 1)
    step = 3
    shifts = sorted(set([0, *range(-radius, radius + 1, step)]))
    for scale in (0.94, 0.97, 1, 1.03, 1.06):
        for dy in shifts:
            for dx in shifts:
                candidate = (cost(dx, dy, scale), dx, dy, scale)
                if candidate[0] < best[0]:
                    best = candidate
    coarse = best
    for scale in (coarse[3] - 0.01, coarse[3], coarse[3] + 0.01):
        for dy in range(max(-radius, coarse[2] - 2), min(radius, coarse[2] + 2) + 1):
            for dx in range(max(-radius, coarse[1] - 2), min(radius, coarse[1] + 2) + 1):
                candidate = (cost(dx, dy, scale), dx, dy, scale)
                if candidate[0] < best[0]:
                    best = candidate
    gain = baseline - best[0]
    # Flat or tinted skin can yield an arbitrary best shift. Reject only when
    # a nontrivial transform materially explains the band better than identity.
    meaningful = gain > 0.75 and gain > baseline * 0.2
    shifted = math.hypot(best[1], best[2]) > 2 or abs(best[3] - 1) > 0.015
    return {"dx": best[1], "dy": best[2], "scale": round(best[3], 4),
            "identityError": round(baseline, 4), "bestError": round(best[0], 4),
            "improvement": round(gain, 4), "samples": len(points), "pass": not (meaningful and shifted)}


def extract_artwork(result, underlay, editable, noise_threshold, minimum_component_pixels):
    difference = ImageChops.difference(result.convert("RGBa"), underlay.convert("RGBa"))
    maximum = Image.new("L", result.size)
    for channel in difference.split():
        maximum = ImageChops.lighter(maximum, channel)
    # Ramp from noise floor to full opacity over 16 intensity levels.
    strength = maximum.point(lambda value: round(255 * min(1, max(0, (value - noise_threshold) / 16))))
    alpha = ImageChops.multiply(ImageChops.multiply(result.getchannel("A"), editable), strength)
    width, height = alpha.size
    pixels = alpha.tobytes()
    seen = bytearray(width * height)
    keep = bytearray(pixels)
    removed = 0
    for start, value in enumerate(pixels):
        if not value or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        component = []
        while stack:
            position = stack.pop()
            component.append(position)
            x, y = position % width, position // width
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < width and 0 <= ny < height):
                        continue
                    neighbor = ny * width + nx
                    if pixels[neighbor] and not seen[neighbor]:
                        seen[neighbor] = 1
                        stack.append(neighbor)
        if len(component) < minimum_component_pixels:
            removed += len(component)
            for position in component:
                keep[position] = 0
    artwork = result.copy()
    artwork.putalpha(Image.frombytes("L", result.size, bytes(keep)))
    return artwork, {"artworkPixels": sum(value > 0 for value in keep), "removedNoisePixels": removed}


def import_results(args, report):
    request_file = args.request_dir / "requests.json"
    if not request_file.is_file():
        raise ValueError("Run expression-requests before importing expressions.")
    requests = json.loads(request_file.read_text(encoding="utf-8"))
    if requests.get("schemaVersion") != 2 or requests.get("jobId") != args.job_id:
        raise ValueError("Expression requests belong to a different job or schema. Rerun expression-requests.")
    current_hash = layer_hash(args.layer_dir, args.layer_map)
    if (requests["layerSha256"] != current_hash
            or requests["layerDir"] != args.layer_dir.relative_to(Path.cwd()).as_posix()):
        raise ValueError("Current layers changed. Rerun expression-requests and generate new results.")
    report["layerSha256"] = current_hash
    outputs = {}
    for name in ("eye_close", "mouth_open"):
        result_file = args.result_dir / f"{name}.png"
        if not result_file.is_file():
            report["variants"][name] = {"status": "missing"}
            continue
        item = requests["variants"][name]
        # Use fixed request filenames, not arbitrary paths from JSON.
        input_file = args.request_dir / name / "input.png"
        mask_file = args.request_dir / name / "mask.png"
        underlay_file = args.request_dir / name / "underlay.png"
        if (file_hash(input_file) != item["inputSha256"] or file_hash(mask_file) != item["maskSha256"]
                or file_hash(underlay_file) != item["underlaySha256"]):
            raise ValueError(f"{name}: request input, mask or underlay changed. Rerun expression-requests.")
        reference = Image.open(input_file).convert("RGBA")
        mask = Image.open(mask_file).convert("RGBA")
        underlay = Image.open(underlay_file).convert("RGBA")
        result = Image.open(result_file).convert("RGBA")
        details = {"status": "checking", "resultSize": list(result.size), "inputSize": list(reference.size)}
        report["variants"][name] = details
        aspect_error = abs((result.width / result.height) / (reference.width / reference.height) - 1)
        details["aspectRatioError"] = round(aspect_error, 6)
        if aspect_error > 0.01:
            raise ValueError(f"{name}: aspect ratio differs ({aspect_error:.4%}); keep the input proportions.")
        if result.size != reference.size:
            result = result.resize(reference.size, Image.Resampling.LANCZOS)
        editable = ImageChops.invert(mask.getchannel("A"))
        band = protected_band(reference, editable, args.protected_band)
        details["alignment"] = alignment_check(reference, result, band, args.alignment_radius)
        details.update(protected_diff(reference, result, band))
        if not details["alignment"]["pass"]:
            alignment = details["alignment"]
            raise ValueError(f"{name}: global image misalignment: shift=({alignment['dx']}, {alignment['dy']}), scale={alignment['scale']}.")
        if details["meanAbsoluteDiff"] > args.max_outside_mean or details["p99AbsoluteDiff"] > args.max_outside_p99:
            raise ValueError(f"{name}: pixels outside the mask changed: mean={details['meanAbsoluteDiff']}, "
                             f"p99={details['p99AbsoluteDiff']} (limits {args.max_outside_mean}, {args.max_outside_p99}).")
        result, extraction = extract_artwork(result, underlay, editable, args.artwork_threshold, args.minimum_component_pixels)
        details.update(extraction)
        box = item["cropBox"]
        crop_size = (box[2] - box[0], box[3] - box[1])
        if list(reference.size) != item["size"] or reference.size != (crop_size[0] * item["scale"], crop_size[1] * item["scale"]):
            raise ValueError(f"{name}: invalid crop or scale metadata. Rerun expression-requests.")
        result = result.resize(crop_size, Image.Resampling.LANCZOS)
        # Enforce the boundary after resampling too: no skin outside editable pixels.
        editable = editable.resize(crop_size, Image.Resampling.NEAREST)
        result.putalpha(ImageChops.multiply(result.getchannel("A"), editable))
        canvas = Image.new("RGBA", tuple(requests["canvas"]))
        canvas.alpha_composite(result, (box[0], box[1]))
        outputs[name] = canvas
        details["status"] = "accepted"
        details["canvas"] = requests["canvas"]
    if not outputs:
        raise ValueError("No results found. Save eye_close.png or mouth_open.png in the results directory.")
    # Validate every supplied variant before replacing any previously imported art.
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name in ("eye_close", "mouth_open"):
        destination = args.output_dir / f"{name}.png"
        if name in outputs:
            outputs[name].save(destination)
        elif destination.exists():
            destination.unlink()
    report["accepted"] = list(outputs)
    report["ok"] = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--layer-dir", type=Path, required=True)
    parser.add_argument("--layer-map", type=Path, default=Path("configs/layer-map.json"))
    parser.add_argument("--request-dir", type=Path, required=True)
    parser.add_argument("--result-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    # Opaque-band mean 6/255 tolerates small generation/recompression tint;
    # p99 still limits local damage and a separate gate detects geometry drift.
    parser.add_argument("--max-outside-mean", type=float, default=6)
    parser.add_argument("--max-outside-p99", type=float, default=20)
    parser.add_argument("--protected-band", type=int, default=8)
    parser.add_argument("--alignment-radius", type=int, default=24)
    parser.add_argument("--artwork-threshold", type=float, default=8)
    parser.add_argument("--minimum-component-pixels", type=int, default=4)
    args = parser.parse_args()
    report = {"schemaVersion": 1, "jobId": args.job_id, "ok": False, "variants": {},
              "thresholds": {"maxOutsideMean": args.max_outside_mean, "maxOutsideP99": args.max_outside_p99,
                             "artworkThreshold": args.artwork_threshold, "minimumComponentPixels": args.minimum_component_pixels},
              "note": "Import only restores masked artwork. Existing expression QA and visual review are still required."}
    try:
        if any(not math.isfinite(value) or value < 0 or value > 255
               for value in (args.max_outside_mean, args.max_outside_p99)):
            raise ValueError("Outside-mask thresholds must be finite numbers from 0 to 255.")
        if not math.isfinite(args.artwork_threshold) or not 0 <= args.artwork_threshold < 255:
            raise ValueError("Artwork threshold must be a finite number from 0 up to (but not including) 255.")
        if args.minimum_component_pixels < 1:
            raise ValueError("Minimum component pixels must be at least 1.")
        if not 1 <= args.protected_band <= 128 or not 1 <= args.alignment_radius <= 64:
            raise ValueError("Protected band must be 1–128 pixels and alignment radius 1–64 pixels.")
        report["thresholds"].update({"protectedBand": args.protected_band, "alignmentRadius": args.alignment_radius})
        import_results(args, report)
    except (ValueError, OSError, KeyError, TypeError) as error:
        report["error"] = str(error)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not report["ok"]:
        parser.exit(1, report["error"] + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
