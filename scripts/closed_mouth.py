"""Closed-mouth eligibility and face-relative placement using the QA limits."""

from PIL import Image, ImageDraw
from statistics import median


def mouth_brightness(mouth, face, box, visible_pixels):
    """Opaque paint above skin by 20% of remaining white headroom (at least 8)."""
    samples = []
    if box:
        x0, y0, x1, y1 = box
        for y in range(max(0, y0-20), min(face.height, y1+20)):
            for x in range(max(0, x0-20), min(face.width, x1+20)):
                distance = max(x0-x, x-x1+1, y0-y, y-y1+1, 0)
                pixel = face.getpixel((x, y))
                if 8 <= distance <= 20 and pixel[3] >= 200:
                    samples.append((pixel[0]*299+pixel[1]*587+pixel[2]*114)/1000)
    skin = median(samples) if samples else None
    difference = max(8, (255-skin)*0.2) if skin is not None else None
    bright = sum(p[3] >= 200 and skin is not None and
                 (p[0]*299+p[1]*587+p[2]*114)/1000 > skin+difference
                 for p in mouth.getdata()) if mouth is not None else 0
    return {"brightPixelRatio": round(bright/visible_pixels, 4) if visible_pixels and skin is not None else None,
            "skinRingLuminance": skin, "skinRingPixels": len(samples),
            "brightPixels": bright, "minimumBrightAlpha": 200, "minimumLuminanceDifference": difference}



def closed_mouth_quality(mouth, face, quality):
    from expression_requests_common import mouth_limits

    limits = mouth_limits(face, quality)["close"]
    pixels = [] if mouth is None else [(x, y, p) for y in range(mouth.height)
        for x in range(mouth.width) if (p := mouth.getpixel((x, y)))[3] > quality["alphaThreshold"]]
    box = None
    if pixels:
        box = [min(p[0] for p in pixels), min(p[1] for p in pixels),
               max(p[0] for p in pixels)+1, max(p[1] for p in pixels)+1]
    count = len(pixels)
    fill = round(count / ((box[2]-box[0])*(box[3]-box[1])), 4) if box else None
    brightness = mouth_brightness(mouth, face, box, count)
    bright = brightness["brightPixelRatio"]
    checks = {
        "artworkPresent": count >= quality["minimumComponentPixels"],
        "compactCloseMouth": bool(box and count <= limits["maximumVisiblePixels"]
            and box[2]-box[0] <= limits["maximumWidth"] and box[3]-box[1] <= limits["maximumHeight"]),
        "closedMouthIsLineArtwork": fill is not None and fill <= quality["mouthCloseMaxFillRatio"],
        "noBrightMouthFill": bright is not None and bright <= quality["mouthMaxBrightPixelRatio"],
    }
    return {"usable": all(checks.values()), "checks": checks,
            "artwork": {"bbox": box, "visiblePixels": count, "fillRatio": fill, **brightness},
            "thresholds": {**limits, "minimumVisiblePixels": quality["minimumComponentPixels"],
                "maximumFillRatio": quality["mouthCloseMaxFillRatio"], "maximumBrightPixelRatio": quality["mouthMaxBrightPixelRatio"]}}


def mouth_support(layers, quality):
    """Reserve an editing area, never synthesize mouth ink into the reference."""
    from expression_requests_common import mouth_limits
    from expression_masks import alpha_union

    face = layers["face"]
    box = alpha_union(layers, ["face"], face.size, quality["alphaThreshold"]).getbbox()
    if not box:
        raise ValueError("A visible face is required to locate the closed mouth.")
    old = alpha_union(layers, ["mouth_close"], face.size, quality["alphaThreshold"])
    old_box = old.getbbox()
    if old_box:
        return old, {"source": "existing-mouth", "center": [(old_box[0]+old_box[2])/2, (old_box[1]+old_box[3])/2]}
    nose = alpha_union(layers, ["nose"], face.size, quality["alphaThreshold"]).getbbox()
    eyes = alpha_union(layers, ["eyewhite", "irides", "eyelash"], face.size, quality["alphaThreshold"]).getbbox()
    landmark = nose or eyes
    if not landmark:
        raise ValueError("Visible nose or eyes are required to locate the missing mouth.")
    cx, cy = (box[0]+box[2])/2, (landmark[3]+box[3])/2
    limits = mouth_limits(face, quality)["close"]
    mask = Image.new("L", face.size)
    half_width, half_height = limits["maximumWidth"]/2, limits["maximumHeight"]/2
    ImageDraw.Draw(mask).rectangle((round(cx-half_width), round(cy-half_height),
                                    round(cx+half_width), round(cy+half_height)), fill=255)
    return mask, {"source": "face-and-nose" if nose else "face-and-eyes", "center": [cx, cy]}
