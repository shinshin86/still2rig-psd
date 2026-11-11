"""Local, deterministic helpers for landmark-driven image separation (Pillow only)."""
from __future__ import annotations

import json
import math
from collections import Counter, deque
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter


def fill_enclosed(mask):
    flooded=mask.copy(); w,h=mask.size
    for x in range(w):
        for y in (0,h-1):
            if flooded.getpixel((x,y))==0: ImageDraw.floodfill(flooded,(x,y),128)
    for y in range(h):
        for x in (0,w-1):
            if flooded.getpixel((x,y))==0: ImageDraw.floodfill(flooded,(x,y),128)
    return flooded.point(lambda v:0 if v==128 else 255)


def dump(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def validate_landmarks(data, size, accessory_names=()):
    allowed = {"schemaVersion", "canvas", "eyes", "brows", "mouth", "nose", "chin", "hairPart", "bangTips", "collar", "ears", "accessories"}
    if not isinstance(data, dict) or set(data) - allowed or data.get("schemaVersion") != 1 or data.get("canvas") != list(size):
        raise ValueError("目印の形式または画像サイズが一致しません。schemaVersion=1 と canvas を確認してください。")
    w, h = size
    def point(p):
        if not isinstance(p, list) or len(p) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in p) or not (0 <= p[0] < w and 0 <= p[1] < h):
            raise ValueError("目印の点は画像内の有限な [x, y] で指定してください。")
    def box(b):
        if not isinstance(b, dict) or set(b) != {"center", "width", "height"}:
            raise ValueError("目印の箱は center, width, height で指定してください。")
        point(b["center"])
        for value, limit in ((b["width"], w), (b["height"], h)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= limit:
                raise ValueError("箱の幅と高さが不正です。")
        if any(v < 0 for v in bounds(b)[:2]) or bounds(b)[2] > w or bounds(b)[3] > h:
            raise ValueError("目印の箱が画像からはみ出しています。")
    for name in ("eyes", "brows", "ears"):
        values = data.get(name)
        if not isinstance(values, list) or len(values) != 2:
            raise ValueError(f"{name} は左右2個を、画像の左から指定してください。")
        for b in values: box(b)
        if values[0]["center"][0] >= values[1]["center"][0]:
            raise ValueError(f"{name} の左右の順序を確認してください。")
    for name in ("mouth", "nose"): box(data.get(name))
    for name in ("chin", "hairPart"): point(data.get(name))
    for name, lo, hi in (("bangTips", 2, 6), ("collar", 3, 3)):
        values = data.get(name)
        if not isinstance(values, list) or not lo <= len(values) <= hi:
            raise ValueError(f"{name} の点の数が不正です。")
        for p in values: point(p)
        if any(a[0] >= b[0] for a, b in zip(values, values[1:])):
            raise ValueError(f"{name} は画像の左から指定してください。")
    if not data["hairPart"][1] < min(b["center"][1] for b in data["eyes"]) < data["chin"][1] < data["collar"][1][1]:
        raise ValueError("分け目・目・あご・襟の上下関係を確認してください。")
    accessories = data.get("accessories", [])
    if not isinstance(accessories, list) or len(accessories) > 6:
        raise ValueError("小物の目印が不正です。")
    for item in accessories:
        if not isinstance(item, dict) or set(item) != {"layer", "box"} or item["layer"] not in accessory_names:
            raise ValueError("未対応の小物レイヤーです。レイヤー定義の追加方法を先に相談してください。")
        box(item["box"])
    return data


def bounds(box, padding=0):
    x, y = box["center"]
    return (round(x-box["width"]/2-padding), round(y-box["height"]/2-padding), round(x+box["width"]/2+padding), round(y+box["height"]/2+padding))


def mask(size, boxes=(), polygon=None):
    im = Image.new("L", size)
    d = ImageDraw.Draw(im)
    for b in boxes: d.rectangle(bounds(b), fill=255)
    if polygon: d.polygon([tuple(p) for p in polygon], fill=255)
    return im


def dilate(im, radius=1):
    return im.filter(ImageFilter.MaxFilter(2*radius+1)) if radius else im.copy()


def erode(im, radius=1):
    return im.filter(ImageFilter.MinFilter(2*radius+1)) if radius else im.copy()


def row_fill(im):
    w, h = im.size
    data = im.tobytes()
    out = bytearray(data)
    for y in range(h):
        row = data[y*w:(y+1)*w]
        first, last = row.find(b'\xff'), row.rfind(b'\xff')
        if first >= 0: out[y*w+first:y*w+last+1] = b'\xff'*(last-first+1)
    return Image.frombytes("L", im.size, bytes(out))


def largest_component(im):
    w, h = im.size
    a = im.tobytes(); seen = bytearray(w*h); best = []
    for start, v in enumerate(a):
        if not v or seen[start]: continue
        queue = deque([start]); seen[start] = 1; component = []
        while queue:
            i = queue.popleft(); component.append(i)
            for n in (i-1, i+1, i-w, i+w):
                if 0 <= n < w*h and abs(n%w-i%w) <= 1 and a[n] and not seen[n]:
                    seen[n] = 1; queue.append(n)
        if len(component) > len(best): best = component
    out = bytearray(w*h)
    for i in best: out[i] = 255
    return Image.frombytes("L", im.size, bytes(out))


def flat_palette(rgb, region, count=8, dominant=False):
    """Learn colours from eroded, low-gradient support, without sampling boxes."""
    region = erode(region, 2)
    lo = rgb.filter(ImageFilter.MinFilter(3)); hi = rgb.filter(ImageFilter.MaxFilter(3))
    gradient = ImageChops.difference(hi, lo).convert("L")
    samples = [(g, c) for g, c, a in zip(gradient.tobytes(), rgb.getdata(), region.tobytes()) if a]
    if not samples: raise ValueError("色を読み取れる面積がありません。目印を確認してください。")
    limit = sorted(g for g, _ in samples)[len(samples)//2]
    bins = Counter(tuple(c//12 for c in color) for g, color in samples if g <= limit)
    selected = set(k for k, _ in bins.most_common(count))
    groups = {key: [] for key in selected}
    for g, color in samples:
        key = tuple(c//12 for c in color)
        if g <= limit and key in groups: groups[key].append(color)
    palette = [tuple(sorted(v[c] for v in groups[key])[len(groups[key])//2] for c in range(3)) for key, _ in bins.most_common(count)]
    if dominant:
        # A broad connected skin sample may touch dark contour ink. Separate the
        # dominant colour family at the largest observed gap, not a fixed RGB value.
        distances = sorted((colour_distance(c, palette[0]), c) for c in palette)
        if len(distances) > 1:
            cut = max(range(1,len(distances)), key=lambda i: distances[i][0]-distances[i-1][0])
            lower, upper = distances[cut-1][0], distances[cut][0]
            if upper > max(1,lower)*4:
                palette = [c for d,c in distances if d <= lower]
    return palette


def colour_distance(a, b):
    return sum((a[c]-b[c])**2 for c in range(3))


def classify(rgb, palettes):
    """Quantization bounds the nearest-colour work while preserving source pixels."""
    q = rgb.quantize(colors=96)
    colors = q.getpalette()
    table = []
    for label in range(256):
        color = colors[label*3:label*3+3]
        if len(color) != 3: table.append(0); continue
        table.append(min(range(len(palettes)), key=lambda n: min(colour_distance(color, p) for p in palettes[n])))
    return bytes(table[i] for i in q.tobytes())


def darkest_path(rgb, hair, inner, side, start_y, stop_y, start_x=None):
    """Minimum-luminance smooth path in the silhouette/face corridor; no guide polygon."""
    w, h = rgb.size
    hp, ip, cp = hair.load(), inner.load(), rgb.load()
    costs = {}; parents = []; rows = []
    for y in range(max(0,start_y), min(h,stop_y)):
        xs = [x for x in range(w) if hp[x,y]]
        face = [x for x in range(w) if ip[x,y]]
        if not xs: continue
        if face:
            a, b = (xs[0], face[0]) if side == 'left' else (face[-1], xs[-1])
        else:
            mid = start_x if start_x is not None else (xs[0]+xs[-1])//2
            a, b = (xs[0], mid) if side == 'left' else (mid, xs[-1])
        span = b-a
        # Avoid outer antialiasing and the face outline itself.
        if face:
            a += max(1,round(span*.12)); b -= max(1,round(span*.12))
        elif side == 'left': a += max(1,round(span*.12))
        else: b -= max(1,round(span*.12))
        choices = range(max(0,a),min(w,b+1))
        current = {}; parent = {}
        for x in choices:
            if not hp[x,y]: continue
            lum = sum(cp[x,y])/3/255
            local = lum*lum + .025*((x-(a+b)/2)/max(1,span))**2
            if not costs:
                if start_x is not None and abs(x-start_x)>3: continue
                current[x] = local + (abs(x-start_x)*.02 if start_x is not None else 0); parent[x] = x
            else:
                prev = [(costs[p]+.035*(p-x)**2,p) for p in range(x-3,x+4) if p in costs]
                if prev:
                    c,p = min(prev); current[x] = c+local; parent[x] = p
        if not current:
            if costs: break
            continue
        costs=current; parents.append(parent); rows.append(y)
    if not costs: raise ValueError("髪の暗い境界を見つけられませんでした。目印と髪の領域を確認してください。")
    x=min(costs,key=costs.get); result=[]
    for y,p in reversed(list(zip(rows,parents))): result.append([x,y]); x=p[x]
    return list(reversed(result))


def unmatte_white(rgb, foreground, edge_width=2, fallback_colours=None, enclosed_gaps=False):
    """Recover white-matte coverage without changing foreground support."""
    # Only background connected to the canvas border defines a white matte.
    # Closed gaps inside the character must not make neighbouring face/hair
    # pixels translucent. Keep the original foreground support unchanged.
    # Hair-only callers can include background gaps enclosed by strands. Other
    # materials retain opaque internal boundaries (eyes, garment whites, etc.).
    exterior_support = foreground if enclosed_gaps else fill_enclosed(foreground)
    edge = ImageChops.multiply(foreground, ImageChops.subtract(
        exterior_support, erode(exterior_support,edge_width)))
    solid = erode(foreground,edge_width+1)
    radius=max(3,edge_width+1)
    weight = solid.filter(ImageFilter.GaussianBlur(radius))
    premul = Image.composite(rgb,Image.new('RGB',rgb.size),solid).filter(ImageFilter.GaussianBlur(radius))
    out=rgb.convert('RGBA'); pixels=out.load(); wp=weight.load(); pp=premul.load()
    for i,v in enumerate(edge.tobytes()):
        if not v: continue
        x,y=i%rgb.width,i//rgb.width
        original=pixels[x,y][:3]
        if wp[x,y]<8:
            if not fallback_colours:continue
            # Thin strands can have no eroded interior. A sampled hair colour
            # supplies coverage only; solving RGB below still preserves the
            # observed white-matte pixel instead of repainting it that colour.
            estimate=min(fallback_colours,key=lambda c:colour_distance(original,c))
        else:estimate=[min(255,c*255/wp[x,y]) for c in pp[x,y]]
        vector=[255-c for c in estimate]
        alpha=min(1,max(.01,sum((255-original[c])*vector[c] for c in range(3))/max(1,sum(v*v for v in vector))))
        # A colour estimate can imply an impossible negative channel. Increase
        # coverage to the physical minimum, then solve using the quantized alpha.
        alpha=max(alpha,max((255-c)/255 for c in original))
        coverage=math.ceil(alpha*255); alpha=coverage/255
        pixels[x,y]=tuple(round(min(255,max(0,(c-255*(1-alpha))/alpha))) for c in original)+(coverage,)
    out.putalpha(ImageChops.multiply(out.getchannel('A'),foreground))
    return out


def square_pad(image, fill=(255,255,255,0)):
    side=max(image.size); left=(side-image.width)//2; top=(side-image.height)//2
    result=Image.new(image.mode,(side,side),fill)
    result.paste(image,(left,top))
    return result,[left,top,side-image.width-left,side-image.height-top]


def square_unpad(image, padding):
    l,t,r,b=padding
    return image.crop((l,t,image.width-r,image.height-b))
