"""Evaluate color continuity at edit boundaries in native PSD coordinates."""

import math

from PIL import Image, ImageChops, ImageFilter

BAND_WIDTH = 3
BLUR_RADIUS = 1
LIMITS = {"outsideMean": 18, "outsideP99": 80, "bandMean": 6, "bandP95": 20,
          "boundaryJumpP95": 12, "boundaryTileMean": 12}


def opaque_rgb(image):
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.alpha_composite(image)
    return background.convert("RGB")


def summary(values, percentile=0.95):
    values = sorted(values)
    return {"pixels": len(values), "quantile": percentile, "mean": round(sum(values) / len(values), 4) if values else None,
            "percentile": round(values[math.ceil(len(values) * percentile) - 1], 4) if values else None}


def check_seam(reference, result, editable, pixel_scale, underlay=None, occlusion=None):
    size = (reference.width // pixel_scale, reference.height // pixel_scale)
    original = reference.resize(size, Image.Resampling.LANCZOS)
    edited = result.resize(size, Image.Resampling.LANCZOS)
    original_rgb, target_rgb = opaque_rgb(original), opaque_rgb(edited)
    support = editable.resize(size, Image.Resampling.NEAREST).point(lambda a: 255 if a > 0 else 0)
    # Inside the mask, removing the source eye/mouth is intentional. Compare
    # against its actual PSD underlay, rather than classifying the old ink's
    # disappearance as a color seam. Outside remains the unchanged original.
    background = Image.composite(underlay.resize(size, Image.Resampling.LANCZOS), original, support) if underlay is not None else original
    source_rgb = opaque_rgb(background)
    if occlusion is not None and occlusion.size != size:
        raise ValueError("Occlusion must use native PSD crop coordinates.")
    covered = (occlusion if occlusion is not None else Image.new("L", size)).point(lambda a: 255 if a == 255 else 0)
    visible = ImageChops.invert(covered)
    hidden = covered.tobytes()
    # Hidden regenerated pixels must not bleed through the blur kernel into
    # neighboring visible samples. Their residual is zero before smoothing.
    visible_target = Image.composite(source_rgb, target_rgb, covered)
    # Average away one-pixel texture noise, retaining visible color steps.
    source = list(source_rgb.filter(ImageFilter.GaussianBlur(BLUR_RADIUS)).getdata())
    target = list(visible_target.filter(ImageFilter.GaussianBlur(BLUR_RADIUS)).getdata())
    residual = [tuple(b[c] - a[c] for c in range(3)) for a, b in zip(source, target)]
    eroded = support.filter(ImageFilter.MinFilter(2 * BAND_WIDTH + 1))
    expanded = support.filter(ImageFilter.MaxFilter(2 * BAND_WIDTH + 1))
    opaque = original.getchannel("A").point(lambda a: 255 if a >= 240 else 0)
    inner = ImageChops.multiply(ImageChops.subtract(support, eroded), opaque)
    outer = ImageChops.multiply(ImageChops.subtract(expanded, support), opaque)
    band_counts = {name: sum(bool(a) for a in band.tobytes()) for name, band in (("inner", inner), ("outer", outer))}
    inner = ImageChops.multiply(inner, visible)
    outer = ImageChops.multiply(outer, visible)
    mask, opacity = support.tobytes(), opaque.tobytes()
    raw_source, raw_target = list(original_rgb.getdata()), list(target_rgb.getdata())
    outside = summary([sum(abs(a[c] - b[c]) for c in range(3)) / 3
                       for i, (a, b) in enumerate(zip(raw_source, raw_target)) if not mask[i] and not hidden[i]], 0.99)
    bands = {}
    for name, band in (("inner", inner), ("outer", outer)):
        values = [(i, sum(abs(c) for c in residual[i]) / 3) for i, a in enumerate(band.tobytes()) if a]
        stats = summary([value for _, value in values])
        tiles = {}
        for i, value in values:
            tiles.setdefault(((i % size[0]) // 4, (i // size[0]) // 4), []).append(value)
        eligible = [(sum(v) / len(v), [x * 4, y * 4]) for (x, y), v in tiles.items() if len(v) >= 4]
        worst, location = max(eligible, default=(0, None))
        stats.update({"maximumTileMean": round(worst, 4), "worstTile": location})
        stats.update({"occludedPixels": band_counts[name] - stats["pixels"], "totalPixels": band_counts[name]})
        bands[name] = stats
    # Across-boundary residual differences remove gradients already in the art.
    # Use only adjoining opaque pixels, so transparency edges do not look like seams.
    jumps = []
    boundary_pairs = 0
    ignored_pairs = 0
    width, height = size
    for i, a in enumerate(mask):
        if not a or not opacity[i]:
            continue
        x, y = i % width, i // width
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height:
                n = ny * width + nx
                if not mask[n] and opacity[n]:
                    boundary_pairs += 1
                    if hidden[i] or hidden[n]:
                        ignored_pairs += 1
                        continue
                    jumps.append(sum(abs(residual[i][c] - residual[n][c]) for c in range(3)) / 3)
    jump = summary(jumps)
    ignored_fraction = ignored_pairs / boundary_pairs if boundary_pairs else 0
    checks = {"boundaryVisibility": boundary_pairs > 0 and ignored_fraction <= 0.5,
              "outsideMean": outside["mean"] is not None and outside["mean"] <= LIMITS["outsideMean"],
              "outsideP99": outside["percentile"] is not None and outside["percentile"] <= LIMITS["outsideP99"],
              "boundaryJump": jump["pixels"] > 0 and jump["percentile"] <= LIMITS["boundaryJumpP95"]}
    for name, stats in bands.items():
        checks[f"{name}Mean"] = stats["pixels"] > 0 and stats["mean"] <= LIMITS["bandMean"]
        checks[f"{name}P95"] = stats["pixels"] > 0 and stats["percentile"] <= LIMITS["bandP95"]
        if name == "inner":
            checks[f"{name}Tiles"] = stats["maximumTileMean"] <= LIMITS["boundaryTileMean"]
    return {"pass": all(checks.values()), "checks": checks, "failedChecks": [k for k, v in checks.items() if not v],
            "diagnostics": {"outerTiles": {"withinLimit": bands["outer"]["maximumTileMean"] <= LIMITS["boundaryTileMean"],
                                            "limit": LIMITS["boundaryTileMean"], "gatesImport": False}},
            "outside": outside, "bands": bands, "boundaryJump": jump, "limits": LIMITS,
            "occlusion": {"boundaryPairs": boundary_pairs, "ignoredPairs": ignored_pairs,
                          "ignoredFraction": round(ignored_fraction, 6), "maximumIgnoredFraction": 0.5,
                          "opaqueAlpha": 255},
            "bandWidth": BAND_WIDTH, "blurRadius": BLUR_RADIUS, "featherWidth": BAND_WIDTH,
            "units": "RGB levels on a white background; distances and tile coordinates in native PSD crop pixels"}


def feather_artwork(artwork, editable):
    """Fade only inside the edit support, after restoration to native pixels."""
    support = editable.point(lambda a: 255 if a > 0 else 0)
    feather = Image.new("L", artwork.size)
    for step in range(BAND_WIDTH):
        feather = ImageChops.add(feather, support.point(lambda a: round(a / BAND_WIDTH)))
        support = support.filter(ImageFilter.MinFilter(3))
    artwork.putalpha(ImageChops.multiply(artwork.getchannel("A"), feather))
    return artwork
