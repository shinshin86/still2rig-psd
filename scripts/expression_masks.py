"""Geometric editable regions for expressions without a neutral artwork layer."""

from PIL import Image, ImageChops, ImageDraw, ImageFilter


def alpha_union(layers, names, size, threshold=16):
    mask = Image.new("L", size, 0)
    for name in names:
        if name in layers:
            alpha = layers[name].getchannel("A").point(lambda value: 255 if value > threshold else 0)
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
    # Four native pixels keep the editable boundary inside the skin, rather
    # than on the dark face outline. Apply after the soft falloff is built.
    interior = face.filter(ImageFilter.MinFilter(9))
    return ImageChops.multiply(ImageChops.multiply(mask, interior), ImageChops.invert(protected))


def expand_eye_sides(editable, layers, padding=4):
    """Include thin eyelash tips as well as the whites of both eyes."""
    tips = alpha_union(layers, ["eyewhite", "eyelash"], editable.size, threshold=0)
    extended = tips.copy()
    for shift in range(1, padding + 1):
        for sign in (-1, 1):
            moved = tips.transform(tips.size, Image.Transform.AFFINE, (1, 0, sign * shift, 0, 1, 0))
            extended = ImageChops.lighter(extended, moved)
    return ImageChops.lighter(editable, extended)


def exclude_eye_obstacles(editable, layer_dir, layer_map, padding=4, eye_support=None, eye_padding=4):
    """Keep an expanded eye edit boundary off eyebrow and front-hair ink."""
    from render_expression_states import selected_layers

    protected = Image.new("L", editable.size)
    for name, file in selected_layers(layer_dir, layer_map):
        if name not in ("eyebrow", "front hair"):
            continue
        alpha = Image.open(file).convert("RGBA").getchannel("A")
        if alpha.size != editable.size:
            raise ValueError("Protected eye features must match the PSD canvas size.")
        obstacle = alpha.point(lambda a: 255 if a > 0 else 0).filter(ImageFilter.MaxFilter(2 * padding + 1))
        if name == "front hair" and eye_support is not None:
            # Do not cut a lash tip to protect hair that is rendered above it.
            # Retain the source-eye envelope; PSD occlusion checks handle the
            # portions genuinely hidden by the front hair.
            envelope = eye_support.filter(ImageFilter.MaxFilter(2 * eye_padding + 1))
            obstacle = ImageChops.multiply(obstacle, ImageChops.invert(envelope))
        protected = ImageChops.lighter(protected, obstacle)
    result = ImageChops.multiply(editable, ImageChops.invert(protected))
    if not result.getbbox():
        raise ValueError("No editable eye pixels remain after protecting eyebrows and front hair.")
    return result
