"""Geometric editable regions for expressions without a neutral artwork layer."""

from PIL import Image, ImageChops, ImageDraw, ImageFilter


def alpha_union(layers, names, size):
    mask = Image.new("L", size, 0)
    for name in names:
        if name in layers:
            alpha = layers[name].getchannel("A").point(lambda value: 255 if value > 16 else 0)
            mask = ImageChops.lighter(mask, alpha)
    return mask


def expand_up(mask, pixels):
    expanded = 0
    while expanded < pixels:
        step = min(expanded + 1, pixels - expanded)
        shifted = mask.transform(mask.size, Image.Transform.AFFINE, (1, 0, 0, 0, 1, step))
        mask = ImageChops.lighter(mask, shifted)
        expanded += step
    return mask


def cheek_mask(layers, size):
    face = alpha_union(layers, ["face"], size)
    eyes = alpha_union(layers, ["eyewhite", "irides", "eyelash"], size)
    mouth = alpha_union(layers, ["mouth_close"], size)
    box, eye_box, mouth_box = face.getbbox(), eyes.getbbox(), mouth.getbbox()
    if not box or not eye_box or not mouth_box:
        raise ValueError("Visible face, eyes and mouth are required to prepare cheek blush.")
    width, height = box[2] - box[0], box[3] - box[1]
    center_y = min(eye_box[3] + height * 0.14, (mouth_box[1] + mouth_box[3]) / 2)
    radius_x, radius_y = max(2, width * 0.14), max(2, height * 0.12)
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for fraction in (0.22, 0.78):
        center_x = box[0] + width * fraction
        draw.ellipse((center_x - radius_x, center_y - radius_y, center_x + radius_x, center_y + radius_y), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(max(0.75, width * 0.025)))
    padding = max(1, round(width * 0.025))
    protected = ImageChops.lighter(eyes, mouth).filter(ImageFilter.MaxFilter(2 * padding + 1))
    interior = face.filter(ImageFilter.MinFilter(3))
    return ImageChops.multiply(ImageChops.multiply(mask, interior), ImageChops.invert(protected))
