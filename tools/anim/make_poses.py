#!/usr/bin/env python3
"""Draw mouth-open / mouth-half / eyes-closed variants on top of closed.png (no AI).
usage: make_poses.py <dir>   (coords tuned for the Kapi front-facing sprite)"""
import os, sys
from PIL import Image, ImageDraw
D = sys.argv[1]
base = Image.open(os.path.join(D, "closed.png")).convert("RGBA")
SS = 4  # supersample for smooth edges

def draw_on(img, fn):
    big = img.resize((img.width * SS, img.height * SS), Image.LANCZOS)
    layer = Image.new("RGBA", big.size, (0, 0, 0, 0))
    fn(ImageDraw.Draw(layer), lambda *v: tuple(int(x * SS) for x in v))
    big.alpha_composite(layer)
    return big.resize(img.size, Image.LANCZOS)

px = base.load()
fur = px[395, 330]
print("fur sample", fur)

def mouth(h):
    def f(d, s):
        cx, top = 441, 470
        w = 46 if h > 30 else 38
        d.ellipse(s(cx - w, top - 4, cx + w, top + h), fill=(70, 28, 22, 255), outline=(15, 8, 6, 255), width=5 * SS)
        tw = w * 0.55
        d.ellipse(s(cx - tw, top + h * 0.45, cx + tw, top + h - 3), fill=(235, 110, 120, 255))
        d.ellipse(s(cx - w, top - 4, cx + w, top + h), outline=(15, 8, 6, 255), width=5 * SS)
    return f

def blink(d, s):
    for (x0, y0, x1, y1) in [(303, 286, 381, 390), (498, 286, 576, 390)]:
        d.ellipse(s(x0, y0, x1, y1), fill=fur)
        cy = (y0 + y1) / 2 + 6
        d.arc(s(x0 + 6, cy - 22, x1 - 6, cy + 18), start=15, end=165, fill=(10, 6, 4, 255), width=6 * SS)

draw_on(base, mouth(52)).save(os.path.join(D, "open.png"))
draw_on(base, mouth(30)).save(os.path.join(D, "half.png"))
draw_on(base, blink).save(os.path.join(D, "blink.png"))

# preview sheet
sheet = Image.new("RGBA", (base.width * 4, base.height), (80, 200, 80, 255))
for i, n in enumerate(["closed", "half", "open", "blink"]):
    sheet.alpha_composite(Image.open(os.path.join(D, n + ".png")).convert("RGBA"), (i * base.width, 0))
sheet.crop((0, 200, sheet.width, 620)).convert("RGB").save(os.path.join(D, "poses_preview.png"))
