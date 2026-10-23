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


def whole_eye_mask(layers, size):
    """Surround replacement eyes and brows with a forehead/cheek skin margin."""
    support = alpha_union(layers, ["eyewhite", "irides", "eyelash", "eyebrow"], size)
    face = alpha_union(layers, ["face"], size)
    box = face.getbbox()
    if not box:
        raise ValueError("A visible face is required for eye artwork.")
    eye_box = support.getbbox()
    if not eye_box:
        raise ValueError("Visible eyes and brows are required for replacement artwork.")
    mask = Image.new("L", size)
    draw = ImageDraw.Draw(mask)
    width, height = eye_box[2]-eye_box[0], eye_box[3]-eye_box[1]
    # Include the bridge between the eyes and a skin margin around every ink
    # stroke; otherwise the extraction boundary cuts through changed lashes.
    draw.rectangle((eye_box[0]-width*.08, eye_box[1]-height*.35,
                    eye_box[2]+width*.08, eye_box[3]+height*.4), fill=255)
    # The complete drawing continues underneath front hair. The permanent
    # hair layer stays above it in PSD order, preserving its visible contour.
    return ImageChops.multiply(mask, face.filter(ImageFilter.MinFilter(9)))


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


def overlay_mask(layers, size, region):
    """Bound additive water/ink while keeping existing facial features intact."""
    face = alpha_union(layers, ["face"], size)
    box = face.getbbox()
    if not box:
        raise ValueError("A visible face is required for overlay artwork.")
    x0, y0, x1, y1 = box
    width, height = x1-x0, y1-y0
    eye_box = alpha_union(layers,["eyewhite","irides","eyelash"],size).getbbox()
    if not eye_box:
        raise ValueError("Visible eyes are required to place overlay artwork.")
    eye_top, eye_height = eye_box[1], eye_box[3]-eye_box[1]
    mask = Image.new("L", size)
    draw = ImageDraw.Draw(mask)
    if region == "tears":
        eyes = alpha_union(layers, ["eyewhite", "irides", "eyelash"], size)
        for left, right in [(0, round((x0+x1)/2)), (round((x0+x1)/2), size[0])]:
            side = eyes.crop((left, 0, right, size[1])).getbbox()
            if not side:
                raise ValueError("Both visible eyes are required for tears.")
            ex0, ey0, ex1, ey1 = side
            ex0 += left; ex1 += left
            draw.rounded_rectangle((ex0+(ex1-ex0)*.08, ey1-2, ex1-(ex1-ex0)*.08,
                                    min(y1-height*.18,ey1+height*.22)), radius=max(2,round(width*.025)), fill=255)
        protected = alpha_union(layers, ["eyewhite", "irides", "eyelash", "eyebrow", "front hair"], size, threshold=0).filter(ImageFilter.MaxFilter(3))
        mask = ImageChops.multiply(ImageChops.multiply(mask,face.filter(ImageFilter.MinFilter(9))),ImageChops.invert(protected))
    elif region == "temple":
        draw.ellipse((x0+width*.86,eye_top-eye_height*.35,x1+width*.06,eye_top+eye_height*.9),fill=255)
    elif region == "forehead":
        draw.ellipse((x0+width*.63,eye_top-eye_height*1.9,x0+width*.90,eye_top-eye_height*.85),fill=255)
    else:
        raise ValueError("Unknown overlay region.")
    if not mask.getbbox():
        raise ValueError("No editable overlay region remains.")
    return mask
