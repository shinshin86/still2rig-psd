#!/usr/bin/env python3
"""Validate generated crops and restore masked expression layers to the PSD canvas."""

from __future__ import annotations

import argparse
import base64
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

from expression_definitions import load_expressions, CONFIG_ROOT
from overlay_expression import validate_overlay_artwork
from soft_expression import extract_soft_artwork
from expression_seam import check_seam, feather_artwork
from expression_requests_common import file_hash, layer_hash


def comparison_image(image):
    # Generators can encode nearly opaque skin with alpha around 248–249.
    # A shared white backdrop compares visible color without darkening that
    # skin by premultiplication against black. Lost transparency still changes
    # visible contrast, and invisible RGB values never affect the comparison.
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.alpha_composite(image)
    return background.convert("RGB")


def protected_diff(reference, result, mask):
    protected = mask.getchannel("A").point(lambda value: 255 if value == 255 else 0)
    count = protected.histogram()[255]
    if not count:
        raise ValueError("Request mask has no protected pixels.")
    histogram = [0] * 256
    for channel in ImageChops.difference(comparison_image(reference), comparison_image(result)).split():
        for value, frequency in enumerate(channel.histogram(mask=protected)):
            histogram[value] += frequency
    samples = count * 3
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
    opaque = reference.getchannel("A").point(lambda value: 255 if value >= 240 else 0)
    ring = ImageChops.multiply(ring, opaque)
    mask = Image.new("RGBA", reference.size)
    mask.putalpha(ring)
    return mask


def local_band_diff(reference, result, band, pixel_scale, support=None, face_core=None):
    # Work in native crop pixels. Symmetric nearest-color matching tolerates
    # two-pixel contour rasterization differences without hiding removed ink
    # or a new patch. Neighbor support extends the outer ring by two pixels,
    # while still excluding editable and input-translucent pixels.
    size = (reference.width // pixel_scale, reference.height // pixel_scale)
    source = list(comparison_image(reference.resize(size, Image.Resampling.LANCZOS)).getdata())
    target = list(comparison_image(result.resize(size, Image.Resampling.LANCZOS)).getdata())
    protected = band.resize(size, Image.Resampling.NEAREST).getchannel("A").tobytes()
    support = (support or band).resize(size, Image.Resampling.NEAREST).getchannel("A").tobytes()
    face_core = face_core.tobytes() if face_core is not None else bytes([255]) * (size[0] * size[1])
    width, height = size
    tiles = {}
    matched = []
    for position, alpha in enumerate(protected):
        if not alpha:
            continue
        x, y = position % width, position // width
        neighbors = [ny * width + nx for ny in range(max(0, y - 2), min(height, y + 3))
                     for nx in range(max(0, x - 2), min(width, x + 3)) if support[ny * width + nx]]
        forward = min(sum(abs(source[position][c] - target[n][c]) for c in range(3)) / 3 for n in neighbors)
        backward = min(sum(abs(target[position][c] - source[n][c]) for c in range(3)) / 3 for n in neighbors)
        value = max(forward, backward)
        matched.append(value)
        if face_core[position]:
            tiles.setdefault((x // 4, y // 4), []).append((value, source[position]))
    local_max = flat_max = 0
    worst = worst_flat = None
    tile_count = flat_count = 0
    for (tx, ty), samples in tiles.items():
        if len(samples) < 8:
            continue
        tile_count += 1
        mean = sum(value for value, _ in samples) / len(samples)
        if mean > local_max:
            local_max, worst = mean, [tx * 4, ty * 4]
        # Uniform areas need a tighter limit than high-contrast ink/contours.
        flat = all(max(pixel[c] for _, pixel in samples) - min(pixel[c] for _, pixel in samples) <= 24
                   for c in range(3))
        if flat:
            flat_count += 1
            if mean > flat_max:
                flat_max, worst_flat = mean, [tx * 4, ty * 4]
    matched.sort()
    return {"meanMatchedDiff": round(sum(matched) / len(matched), 4),
            "p99MatchedDiff": round(matched[math.ceil(len(matched) * 0.99) - 1], 4),
            "maxLocalMeanDiff": round(local_max, 4), "maxFlatMeanDiff": round(flat_max, 4),
            "worstLocalTile": worst, "worstFlatTile": worst_flat, "localTiles": tile_count,
            "flatTiles": flat_count, "tileSize": 4, "matchingRadius": 2,
            "localRegion": "opaque face interior inset by 2 pixels",
            "units": "original PSD crop pixels"}


def alignment_check(reference, result, band, radius, pixel_scale=1, maximum_shift=12, maximum_scale=0.03):
    # Estimation runs at the original PSD crop scale, independently of the
    # integer request enlargement. Final sampling uses the original result.
    analysis_size = (round(reference.width / pixel_scale), round(reference.height / pixel_scale))
    reference = reference.resize(analysis_size, Image.Resampling.LANCZOS)
    result = result.resize(analysis_size, Image.Resampling.LANCZOS)
    band = band.resize(analysis_size, Image.Resampling.NEAREST)
    width, height = reference.size
    source = comparison_image(reference).load()
    target = comparison_image(result).load()
    positions = [(i % width, i // width) for i, value in enumerate(band.getchannel("A").tobytes()) if value]
    stride = max(1, math.ceil(len(positions) / 1200))
    points = positions[::stride]
    if not points:
        raise ValueError("No opaque protected band is available for alignment.")
    cx, cy = width / 2, height / 2

    def sample(x, y):
        ix, iy = int(x), int(y)
        fx, fy = x - ix, y - iy
        return tuple((target[ix, iy][c] * (1 - fx) + target[min(ix + 1, width - 1), iy][c] * fx) * (1 - fy)
                     + (target[ix, min(iy + 1, height - 1)][c] * (1 - fx)
                        + target[min(ix + 1, width - 1), min(iy + 1, height - 1)][c] * fx) * fy
                     for c in range(3))

    def cost(dx, dy, scale, cutoff=float("inf")):
        total = count = 0
        for x, y in points:
            tx, ty = cx + (x - cx) * scale + dx, cy + (y - cy) * scale + dy
            if not (0 <= tx < width - 1 and 0 <= ty < height - 1):
                continue
            a, b = source[x, y], sample(tx, ty)
            # Bound the effect of occasional regenerated line-art pixels.
            total += sum(min(abs(a[c] - b[c]), 48) for c in range(3)) / 3
            count += 1
            if total >= cutoff * len(points):
                return float("inf")
        return total / count if count >= len(points) * 0.9 else float("inf")

    def penalty(dx, dy, scale):
        # A narrow, smooth mouth band cannot uniquely distinguish shift from
        # scale. Prefer the smaller transform among near-equivalent matches.
        return math.hypot(dx, dy) * 0.02 + abs(scale - 1) * 2

    baseline = cost(0, 0, 1)
    best = (baseline, 0, 0, 1)
    step = 3
    shifts = sorted(set([0, *range(-radius, radius + 1, step)]))
    for scale in (() if baseline < 0.01 else (0.94, 0.97, 1, 1.03, 1.06)):
        for dy in shifts:
            for dx in shifts:
                candidate = (cost(dx, dy, scale, best[0]) + penalty(dx, dy, scale), dx, dy, scale)
                if candidate[0] < best[0]:
                    best = candidate
    coarse = best
    for scale in (() if baseline < 0.01 else (coarse[3] - 0.01, coarse[3], coarse[3] + 0.01)):
        for dy in range(max(-radius, coarse[2] - 2), min(radius, coarse[2] + 2) + 1):
            for dx in range(max(-radius, coarse[1] - 2), min(radius, coarse[1] + 2) + 1):
                candidate = (cost(dx, dy, scale, best[0]) + penalty(dx, dy, scale), dx, dy, scale)
                if candidate[0] < best[0]:
                    best = candidate
    integer_best = best
    for scale in (integer_best[3] + step * 0.0025 for step in ([] if baseline < 0.01 else range(-2, 3))):
        for dy in (integer_best[2] + step * 0.25 for step in range(-4, 5)):
            for dx in (integer_best[1] + step * 0.25 for step in range(-4, 5)):
                candidate = (cost(dx, dy, scale, best[0]) + penalty(dx, dy, scale), dx, dy, scale)
                if candidate[0] < best[0]:
                    best = candidate
    best_error = cost(best[1], best[2], best[3])
    gain = baseline - best_error
    # Flat or tinted skin can yield an arbitrary best shift. Reject only when
    # a nontrivial transform materially explains the band better than identity.
    meaningful = gain > 0.1 and gain > baseline * 0.03
    beyond_limits = math.hypot(best[1], best[2]) > maximum_shift or abs(best[3] - 1) > maximum_scale + 1e-8
    passed = not (meaningful and beyond_limits)
    apply = meaningful and passed
    return {"dx": best[1], "dy": best[2], "scale": round(best[3], 4),
            "identityError": round(baseline, 4), "bestError": round(best_error, 4),
            "selectionPenalty": round(penalty(best[1], best[2], best[3]), 4),
            "improvement": round(gain, 4), "samples": len(points), "pass": passed,
            "applied": apply, "appliedDx": best[1] if apply else 0, "appliedDy": best[2] if apply else 0,
            "appliedScale": round(best[3], 4) if apply else 1,
            "units": "original PSD crop pixels", "maximumShift": maximum_shift, "maximumScaleError": maximum_scale}


def compensate_result(reference, original, alignment, pixel_scale):
    # One affine sample from the original full-resolution generator output.
    sx, sy = original.width / reference.width, original.height / reference.height
    scale = alignment["appliedScale"]
    dx, dy = alignment["appliedDx"] * pixel_scale, alignment["appliedDy"] * pixel_scale
    coefficients = (sx * scale, 0, sx * ((1 - scale) * reference.width / 2 + dx),
                    0, sy * scale, sy * ((1 - scale) * reference.height / 2 + dy))
    return original.transform(reference.size, Image.Transform.AFFINE, coefficients, Image.Resampling.BICUBIC)


def extract_artwork(result, underlay, editable, noise_threshold, minimum_component_pixels):
    difference = ImageChops.difference(result.convert("RGBa"), underlay.convert("RGBa"))
    maximum = Image.new("L", result.size)
    for channel in difference.split():
        maximum = ImageChops.lighter(maximum, channel)
    # Nearly opaque skin must not become artwork because generator alpha is
    # a few levels lower. Keep premultiplied RGBA for transparent underlays,
    # where newly painted white artwork and opacity changes are meaningful.
    near_opaque = ImageChops.multiply(result.getchannel("A").point(lambda value: 255 if value >= 240 else 0),
                                      underlay.getchannel("A").point(lambda value: 255 if value >= 240 else 0))
    color_max = Image.new("L", result.size)
    for channel in ImageChops.difference(comparison_image(result), comparison_image(underlay)).split():
        color_max = ImageChops.lighter(color_max, channel)
    maximum = Image.composite(color_max, maximum, near_opaque)
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
    occlusion = json.load(sys.stdin) if args.psd_occlusion_stdin else None
    request_file = args.request_dir / "requests.json"
    if not request_file.is_file():
        raise ValueError("Run expression-requests before importing expressions.")
    requests = json.loads(request_file.read_text(encoding="utf-8"))
    if requests.get("schemaVersion") != 2 or requests.get("jobId") != args.job_id:
        raise ValueError("Expression requests belong to a different job or schema. Rerun expression-requests.")
    current_hash = layer_hash(args.layer_dir, args.layer_map)
    if (requests["layerSha256"] != current_hash
            or requests["layerDir"] != args.layer_dir.relative_to(Path.cwd()).as_posix()):
        raise ValueError("Current layers changed. Rerun expression-requests and generate new results. 依頼ファイルを作り直してください（expression-requests）。")
    report["layerSha256"] = current_hash
    available = {item["name"]: item for item in load_expressions(json.loads(args.layer_map.read_text(encoding="utf-8"))) if item["prompt"] is not None}
    if not isinstance(requests.get("variants"), dict) or not requests["variants"] or any(name not in available for name in requests["variants"]):
        raise ValueError("Unknown expression requests. Rerun expression-requests.")
    definitions = [item for name, item in available.items() if name in requests["variants"]]
    soft_maximum = json.loads((CONFIG_ROOT / "default.json").read_text(encoding="utf-8"))["quality"]["softExpressionMaximumAlpha"]
    outputs = {}
    previews = {}
    extractors = {"diff": extract_artwork, "soft": lambda *values: extract_soft_artwork(*values, maximum_alpha=soft_maximum)}
    for definition in definitions:
        name = definition["name"]
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
        editable = ImageChops.invert(mask.getchannel("A"))
        pixel_scale = item["scale"]
        box = item["cropBox"]
        crop_size = (box[2] - box[0], box[3] - box[1])
        if (not isinstance(pixel_scale, int) or pixel_scale < 1
                or list(reference.size) != item["size"]
                or reference.size != (crop_size[0] * pixel_scale, crop_size[1] * pixel_scale)):
            raise ValueError(f"{name}: invalid crop or scale metadata. Rerun expression-requests.")
        if definition["extraction"] == "overlay":
            if item.get("outputMode") != "transparent-overlay":
                raise ValueError(f"{name}: regenerate transparent overlay requests.")
            if args.protected_check is not None:
                raise ValueError("Transparent overlays use alpha/placement checks, not a background seam override.")
            source = Image.open(result_file)
            if "A" not in source.getbands() and "transparency" not in source.info:
                raise ValueError(f"{name}: a PNG with genuine alpha transparency is required.")
            result = result.resize(reference.size,Image.Resampling.LANCZOS)
            details["protectedCheck"] = "overlay"
            details["overlay"] = validate_overlay_artwork(result,editable,name)
            details["resizedProportionally"] = source.size != reference.size
            mode = "overlay"
        else:
            protected_editable = editable.point(lambda value: 255 if value > 0 else 0) if definition["extraction"] == "soft" else editable
            band = protected_band(reference, protected_editable, args.protected_band * pixel_scale)
            details["alignment"] = alignment_check(reference, result, band, args.alignment_radius, pixel_scale,
                                                   args.max_alignment_shift, args.max_alignment_scale)
            result = compensate_result(reference, result, details["alignment"], pixel_scale)
            details.update(protected_diff(reference, result, band))
            support = protected_band(reference, protected_editable, (args.protected_band + 2) * pixel_scale)
            face_core = Image.open(args.layer_dir / "face.png").convert("RGBA").getchannel("A").crop(item["cropBox"])
            face_core = face_core.point(lambda value: 255 if value >= 240 else 0).filter(ImageFilter.MinFilter(5))
            details.update(local_band_diff(reference, result, band, pixel_scale, support, face_core))
            if not details["alignment"]["pass"]:
                alignment = details["alignment"]
                raise ValueError(f"{name}: global image misalignment: shift=({alignment['dx']}, {alignment['dy']}), scale={alignment['scale']}.")
            mode = args.protected_check or definition["protectedCheck"]
            if args.protected_check is not None or mode == "seam":
                details["protectedCheck"] = mode
            if mode == "seam":
                coverage = None
                visibility = None
                if occlusion is not None:
                    entry = occlusion["variants"][name]
                    if (entry["width"], entry["height"]) != crop_size:
                        raise ValueError("PSD visibility must match the native request crop.")
                    coverage = Image.frombytes("L", crop_size, base64.b64decode(entry["alpha"], validate=True))
                    visibility = {key: occlusion[key] for key in ("source", "psdSha256")}
                    visibility.update({"layers": entry["layers"], "targetPresent": entry["targetPresent"]})
                details["seam"] = check_seam(reference, result, editable, pixel_scale, underlay, coverage)
                details["seam"]["occlusion"].update(visibility or {"source": "unavailable; all pixels checked"})
                if not details["seam"]["pass"]:
                    raise ValueError(f"{name}: seam check failed: " + ", ".join(details["seam"]["failedChecks"]) + ".")
            else:
                if details["meanMatchedDiff"] > args.max_outside_mean or details["p99MatchedDiff"] > args.max_outside_p99:
                    raise ValueError(f"{name}: pixels outside the mask changed: mean={details['meanMatchedDiff']}, "
                                     f"p99={details['p99MatchedDiff']} (limits {args.max_outside_mean}, {args.max_outside_p99}).")
                if details["maxLocalMeanDiff"] > args.max_band_local_mean or details["maxFlatMeanDiff"] > args.max_band_flat_mean:
                    raise ValueError(f"{name}: local pixels outside the mask changed: local={details['maxLocalMeanDiff']}, "
                                     f"flat={details['maxFlatMeanDiff']} (limits {args.max_band_local_mean}, {args.max_band_flat_mean}).")
            result, extraction = extractors[definition["extraction"]](result, underlay, editable, args.artwork_threshold, args.minimum_component_pixels * pixel_scale * pixel_scale)
            details.update(extraction)
        result = result.resize(crop_size, Image.Resampling.LANCZOS)
        # Enforce the boundary after resampling too: no skin outside editable pixels.
        editable = editable.resize(crop_size, Image.Resampling.NEAREST)
        result.putalpha(ImageChops.multiply(result.getchannel("A"), editable))
        if definition["extraction"] == "soft":
            result.putalpha(result.getchannel("A").point(lambda value: min(round(soft_maximum * 255), value)))
        if mode == "seam":
            result = feather_artwork(result, editable)
        if args.preview_dir is not None:
            base = underlay.resize(crop_size, Image.Resampling.LANCZOS)
            previews[name] = {"input": reference.resize(crop_size, Image.Resampling.LANCZOS),
                              "artwork": result.copy(), "composite": Image.alpha_composite(base, result)}
        canvas = Image.new("RGBA", tuple(requests["canvas"]))
        canvas.alpha_composite(result, (box[0], box[1]))
        outputs[name] = canvas
        details["status"] = "accepted"
        details["canvas"] = requests["canvas"]
    if not outputs:
        raise ValueError("No results found. Save " + " or ".join(f"{item['name']}.png" for item in definitions) + " in the results directory.")
    # Validate every supplied variant before replacing any previously imported art.
    if not args.read_only:
        args.output_dir.mkdir(parents=True, exist_ok=True)
        for definition in definitions:
            name = definition["name"]
            destination = args.output_dir / f"{name}.png"
            if name in outputs:
                outputs[name].save(destination)
            elif destination.exists():
                destination.unlink()
    if args.preview_dir is not None:
        # Refuse output aliases before any diagnostic image is written.
        if any((args.preview_dir / f"{name}-{label}.png").is_symlink()
               for name, images in previews.items() for label in (*images, "canvas-artwork")):
            raise ValueError("Preview images must not be symlinks.")
        args.preview_dir.mkdir(parents=True, exist_ok=True)
        for name, images in previews.items():
            files = {}
            for label, image in {**images, "canvas-artwork": outputs[name]}.items():
                file = args.preview_dir / f"{name}-{label}.png"
                image.save(file)
                files[label] = file.relative_to(Path.cwd()).as_posix()
            report["variants"][name]["preview"] = files
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
    # Shared-background color and local contour matching keep the existing
    # global limits; face-interior tiles guard against localized artwork damage.
    parser.add_argument("--max-outside-mean", type=float, default=6)
    parser.add_argument("--max-outside-p99", type=float, default=20)
    parser.add_argument("--max-band-local-mean", type=float, default=24)
    parser.add_argument("--max-band-flat-mean", type=float, default=12)
    parser.add_argument("--protected-band", type=int, default=8)
    parser.add_argument("--alignment-radius", type=int, default=24)
    parser.add_argument("--max-alignment-shift", type=float, default=12)
    parser.add_argument("--max-alignment-scale", type=float, default=0.03)
    parser.add_argument("--read-only", action="store_true")
    parser.add_argument("--protected-check", choices=("strict", "seam"))
    parser.add_argument("--preview-dir", type=Path)
    parser.add_argument("--psd-occlusion-stdin", action="store_true")
    parser.add_argument("--artwork-threshold", type=float, default=8)
    parser.add_argument("--minimum-component-pixels", type=int, default=4)
    args = parser.parse_args()
    report = {"schemaVersion": 1, "jobId": args.job_id, "ok": False, "readOnly": args.read_only,
              "comparison": "RGB on a shared opaque white background", "variants": {},
              "thresholds": {"maxOutsideMean": args.max_outside_mean, "maxOutsideP99": args.max_outside_p99,
                             "maxBandLocalMean": args.max_band_local_mean, "maxBandFlatMean": args.max_band_flat_mean,
                             "artworkThreshold": args.artwork_threshold, "minimumComponentPixels": args.minimum_component_pixels},
              "note": "Import only restores masked artwork. Existing expression QA and visual review are still required."}
    try:
        if args.preview_dir is not None:
            preview = args.preview_dir.resolve()
            state = (Path.cwd() / ".still2rig-psd").resolve()
            job = args.output_dir.parent.resolve()
            if not args.read_only or not preview.is_relative_to(state) or preview.is_relative_to(job):
                raise ValueError("Preview directory needs --read-only and must stay under .still2rig-psd outside this job.")
            args.preview_dir = preview
        if any(not math.isfinite(value) or value < 0 or value > 255
               for value in (args.max_outside_mean, args.max_outside_p99, args.max_band_local_mean, args.max_band_flat_mean)):
            raise ValueError("Outside-mask thresholds must be finite numbers from 0 to 255.")
        if not math.isfinite(args.artwork_threshold) or not 0 <= args.artwork_threshold < 255:
            raise ValueError("Artwork threshold must be a finite number from 0 up to (but not including) 255.")
        if args.minimum_component_pixels < 1:
            raise ValueError("Minimum component pixels must be at least 1.")
        if not 1 <= args.protected_band <= 128 or not 1 <= args.alignment_radius <= 64:
            raise ValueError("Protected band must be 1–128 pixels and alignment radius 1–64 pixels.")
        if (not math.isfinite(args.max_alignment_shift) or not 0 <= args.max_alignment_shift <= args.alignment_radius
                or not math.isfinite(args.max_alignment_scale) or not 0 <= args.max_alignment_scale <= 0.1):
            raise ValueError("Alignment limits must be finite: shift within the search radius, scale error 0–0.1.")
        report["thresholds"].update({"protectedBand": args.protected_band, "alignmentRadius": args.alignment_radius,
                                     "maximumAlignmentShift": args.max_alignment_shift, "maximumAlignmentScaleError": args.max_alignment_scale})
        import_results(args, report)
    except (ValueError, OSError, KeyError, TypeError) as error:
        report["error"] = str(error)
    if not args.read_only:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not report["ok"]:
        if args.read_only:
            print(json.dumps(report))
        parser.exit(1, report["error"] + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
