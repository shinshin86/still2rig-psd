"""Validate registered additive artwork without reconstructing its background."""
from PIL import Image, ImageChops
import math


def alpha_centroid(image):
    pixels = image.getchannel("A")
    sx = sy = weight = 0
    for y in range(image.height):
        for x in range(image.width):
            a = pixels.getpixel((x, y))
            if a > 16:
                sx += x*a
                sy += y*a
                weight += a
    if not weight:
        raise ValueError("A visible mouth is required for registration.")
    return sx/weight, sy/weight


def register_mouth_overlay(source, reference_mouth, crop_box, request_size, maximum_shift=12):
    """Place mouth-only ink using a known lip anchor, never a background fit."""
    rx, ry = alpha_centroid(reference_mouth)
    x, y = alpha_centroid(source)
    width, height = crop_box[2]-crop_box[0], crop_box[3]-crop_box[1]
    dx = rx-(crop_box[0]+(x+.5)*width/source.width-.5)
    dy = ry-(crop_box[1]+(y+.5)*height/source.height-.5)
    if math.hypot(dx, dy) > maximum_shift:
        raise ValueError(f"Mouth registration shift exceeds {maximum_shift} native pixels.")
    result = source.transform(request_size, Image.Transform.AFFINE,
                              (source.width/request_size[0],0,-dx*source.width/width,
                               0,source.height/request_size[1],-dy*source.height/height),
                              Image.Resampling.BICUBIC)
    return result, {"reference":"closed-mouth alpha centroid", "dxNative":round(dx,4),
                    "dyNative":round(dy,4), "maximumShiftNative":maximum_shift}


def register_closed_eyes(artwork, outline, editable, tolerance=8, maximum_shift=12):
    """Translate each closed drawing horizontally; keep its ink and height.

    Use the same alpha-weighted eye-outline reference as PSD QA. Already
    registered drawings stay byte-identical. Large drift needs new artwork,
    and moving outside the original editable region is never silently clipped.
    """
    if artwork.size != outline.size or artwork.size != editable.size:
        raise ValueError('Eye registration requires one shared canvas.')
    result = Image.new('RGBA', artwork.size)
    width, height = artwork.size
    report = {'reference':'eyelash union eyewhite alpha centroid, iris fallback',
              'horizontalToleranceNative':tolerance, 'maximumShiftNative':maximum_shift, 'sides':{}}
    for name,box in [('left',(0,0,width//2,height)),('right',(width//2,0,width,height))]:
        part = artwork.crop(box)
        try:
            target_x,_ = alpha_centroid(outline.crop(box))
            source_x,_ = alpha_centroid(part)
        except ValueError as exc:
            raise ValueError(f'{name}: visible open and closed eyes are required for registration.') from exc
        offset = target_x-source_x
        if abs(offset) > maximum_shift:
            raise ValueError(f'{name}: closed-eye registration shift {offset:.3f} exceeds {maximum_shift} native pixels.')
        dx = round(offset) if abs(offset) > tolerance else 0
        moved = Image.new('RGBA',part.size)
        moved.paste(part,(dx,0))
        if moved.getchannel('A').histogram() != part.getchannel('A').histogram():
            raise ValueError(f'{name}: closed-eye registration would clip artwork.')
        outside = ImageChops.multiply(moved.getchannel('A'),ImageChops.invert(editable.crop(box)))
        if outside.point(lambda a:255 if a>16 else 0).getbbox():
            raise ValueError(f'{name}: registered closed eye leaves the original editable region.')
        removed_noise = sum(a>0 for a in outside.tobytes())
        moved.putalpha(ImageChops.multiply(moved.getchannel('A'),editable.crop(box)))
        result.paste(moved,box[:2])
        report['sides'][name] = {'dxNative':dx,'beforeXErrorNative':round(abs(offset),4),
                                'afterXErrorNative':round(abs(offset-dx),4),'applied':dx!=0,
                                'removedOutsideNoisePixels':removed_noise}
    return result,report


def register_adopted_closed_eyes(artwork, adopted, outline, tolerance=8, maximum_shift=12):
    """Reposition previously adopted ink; never accept different new artwork."""
    if artwork.size != adopted.size:
        raise ValueError('Adopted eye canvas changed.')
    for current, previous in zip(artwork.getdata(),adopted.getdata()):
        if current[3] != previous[3] or (current[3] and current != previous):
            raise ValueError('Eye artwork is not the previously adopted drawing.')
    result,report = register_closed_eyes(artwork,outline,Image.new('L',artwork.size,255),tolerance,maximum_shift)
    if result.getchannel('A').histogram() != artwork.getchannel('A').histogram():
        raise ValueError('Adopted eye registration must preserve all ink.')
    return result,report


def validate_overlay_artwork(result, editable, name, skin_reference=None):
    alpha = result.getchannel("A")
    histogram = alpha.histogram()
    total = result.width * result.height
    visible = sum(histogram[9:])
    outside = ImageChops.multiply(alpha, ImageChops.invert(editable))
    outside_pixels = sum(outside.histogram()[9:])
    allowed = sum(editable.point(lambda v:255 if v else 0).histogram()[1:])
    warm = neutral = solid = skin = 0
    reference = list(skin_reference.getdata()) if skin_reference is not None else None
    for index,(r,g,b,a) in enumerate(result.getdata()):
        if a <= 8:
            continue
        if a >= 128:
            solid += 1
            warm += r-g > 10 and g-b > 8 and r < max(1,g)*2
            neutral += max(r,g,b)-min(r,g,b)<12
            if reference is not None:
                rr,gg,bb,aa = reference[index]
                skin += aa >= 240 and max(abs(r-rr),abs(g-gg),abs(b-bb)) <= 24
    checks = {
        "transparentBackground": histogram[0]/total >= .90,
        "artworkPresent": visible >= 8,
        "insideAllowedRegion": outside_pixels == 0,
        "sparseArtwork": visible <= allowed*.65,
        "noNeutralBackgroundPatch": not solid or neutral/solid < .70,
        "noSkinOrHairColor": not solid or (skin/solid < .03 if reference is not None else warm/solid < .03),
    }
    details = {"checks": checks,"transparentPixelRatio":round(histogram[0]/total,6),
               "visiblePixels":visible,"outsideVisiblePixels":outside_pixels,
               "skinReferenceColorRatio":round(skin/max(1,solid),6),"warmColorRatio":round(warm/max(1,solid),6),"neutralColorRatio":round(neutral/max(1,solid),6),
               "registration":"proportional canvas coordinates; no background alignment estimate"}
    failed = [key for key,value in checks.items() if not value]
    if failed:
        raise ValueError(f"{name}: transparent overlay check failed: {', '.join(failed)}; {details}")
    return details
