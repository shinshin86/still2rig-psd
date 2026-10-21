"""Recover a low-opacity color overlay from an edited face and its underlay."""

from PIL import Image


def extract_soft_artwork(result, underlay, editable, noise_threshold=0, minimum_component_pixels=0, maximum_alpha=0.6):
    artwork = Image.new("RGBA", result.size)
    output = artwork.load()
    source, background, mask = result.load(), underlay.load(), editable.load()
    visible = capped = 0
    for y in range(result.height):
        for x in range(result.width):
            if not mask[x, y] or background[x, y][3] < 240 or source[x, y][3] < 240:
                continue
            base, changed = background[x, y], source[x, y]
            delta = [changed[c] - base[c] for c in range(3)]
            # Rosy color changes must increase red relative to green and blue.
            # Gray shadows and uniform exposure shifts are not blush artwork.
            if delta[0] - delta[1] <= 0 or delta[0] - delta[2] <= 0:
                continue
            minimum = max((delta[c] / max(1, 255 - base[c]) if delta[c] > 0 else -delta[c] / max(1, base[c]))
                          for c in range(3))
            alpha = min(maximum_alpha, minimum * 1.25)
            if not alpha:
                continue
            color = tuple(max(0, min(255, round(base[c] + delta[c] / alpha))) for c in range(3))
            opacity = min(round(maximum_alpha * 255), max(1, round(alpha * 255)))
            output[x, y] = (*color, opacity)
            visible += 1
            capped += minimum > maximum_alpha
    return artwork, {"artworkPixels": visible, "removedNoisePixels": 0,
                     "extraction": "soft", "maximumAlpha": maximum_alpha, "cappedPixels": capped}
