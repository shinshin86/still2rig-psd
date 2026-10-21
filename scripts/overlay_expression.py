"""Validate registered additive artwork without reconstructing its background."""
from PIL import Image, ImageChops


def validate_overlay_artwork(result, editable, name):
    alpha = result.getchannel("A")
    histogram = alpha.histogram()
    total = result.width * result.height
    visible = sum(histogram[9:])
    outside = ImageChops.multiply(alpha, ImageChops.invert(editable))
    outside_pixels = sum(outside.histogram()[9:])
    allowed = sum(editable.point(lambda v:255 if v else 0).histogram()[1:])
    warm = neutral = solid = 0
    for r,g,b,a in result.getdata():
        if a <= 8:
            continue
        if a >= 128:
            solid += 1
            warm += r-g > 10 and g-b > 8 and r < max(1,g)*2
            neutral += max(r,g,b)-min(r,g,b)<12
    checks = {
        "transparentBackground": histogram[0]/total >= .90,
        "artworkPresent": visible >= 8,
        "insideAllowedRegion": outside_pixels == 0,
        "sparseArtwork": visible <= allowed*.65,
        "noNeutralBackgroundPatch": not solid or neutral/solid < .70,
        "noSkinOrHairColor": not solid or warm/solid < .03,
    }
    details = {"checks": checks,"transparentPixelRatio":round(histogram[0]/total,6),
               "visiblePixels":visible,"outsideVisiblePixels":outside_pixels,
               "warmColorRatio":round(warm/max(1,solid),6),"neutralColorRatio":round(neutral/max(1,solid),6),
               "registration":"proportional canvas coordinates; no background alignment estimate"}
    failed = [key for key,value in checks.items() if not value]
    if failed:
        raise ValueError(f"{name}: transparent overlay check failed: {', '.join(failed)}; {details}")
    return details
