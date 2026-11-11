"""Match generated mouth skin to its recorded backing before extracting ink."""
from statistics import median
from PIL import Image, ImageChops, ImageFilter


def mouth_skin_ring(layers, support):
    """Sample skin 8–20 native pixels from the neutral mouth, excluding features."""
    outer = support.filter(ImageFilter.MaxFilter(41))
    inner = support.filter(ImageFilter.MaxFilter(17))
    ring = ImageChops.subtract(outer, inner)
    face = layers['face'].getchannel('A').point(lambda a: 255 if a >= 240 else 0)
    ring = ImageChops.multiply(ring, face)
    for name in ('nose', 'eyebrow', 'eyelash', 'eyewhite', 'irides', 'front hair', 'headwear'):
        if name in layers:
            obstacle = layers[name].getchannel('A').filter(ImageFilter.MaxFilter(9))
            ring = ImageChops.subtract(ring, obstacle)
    return ring


def match_mouth_skin(result, underlay, ring, editable):
    """Robust channel gains; retain alpha and every protected pixel unchanged."""
    if any(image.size != result.size for image in (underlay, ring, editable)):
        raise ValueError('Mouth skin reference sizes differ.')
    source = list(result.getdata()); target = list(underlay.getdata())
    samples = [i for i,a in enumerate(ring.tobytes()) if a and source[i][3] >= 240 and target[i][3] >= 240
               and all(source[i][c] > 0 and target[i][c] > 0 for c in range(3))]
    if not samples:
        raise ValueError('No opaque skin samples in the mouth reference ring.')
    # A median of paired ratios resists an opening or sparse line crossing the
    # ring. It does not learn a spatial patch or alter the protected-area tests.
    gains = [median(target[i][c] / source[i][c] for i in samples) for c in range(3)]
    channels = []
    for c, channel in enumerate(result.split()[:3]):
        adjusted = channel.point([min(255, max(0, round(value*gains[c]))) for value in range(256)])
        channels.append(Image.composite(adjusted, channel, editable))
    corrected = Image.merge('RGBA', (*channels, result.getchannel('A')))
    return corrected, {'method':'median paired channel ratios from recorded mouth skin ring',
                       'ringInnerPx':8,'ringOuterPx':20,'samplePixels':len(samples),
                       'gains':gains,'appliedOnlyInsideEditableMask':True,
                       'protectedChecksUseUncorrectedResult':True}
