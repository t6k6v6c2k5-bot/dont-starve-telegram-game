#!/usr/bin/env python3
""""Pro" shorts builder: cinematic camera on stills, beat punches, shake, flashes,
water particles, animated hook title, vignette, SFX design. No AI video.

usage: build_pro.py <dir>     (reads <dir>/shots.json, voice.mp3, words.json, music.mp3, sfx_*.mp3)
shots.json = {"title": "...", "tail": 0.6,
  "shots": [{"img": "s01.png", "start": 0, "end": 2.0, "move": "tilt_down",
             "punch": [..times..], "shake": [[t0,t1,amp]], "flash": [t], "drops": true}, ...],
  "sfx": [{"file": "sfx_whoosh.mp3", "t": 2.0, "vol": 0.4}, ...]}
"""
import json, math, os, random, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

D = sys.argv[1]
p = lambda n: os.path.join(D, n)
W, H, FPS = 1080, 1920, 30
cfg = json.load(open(p("shots.json")))
shots = cfg["shots"]
vdur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                             p("voice.mp3")], capture_output=True, text=True).stdout)
dur = vdur + cfg.get("tail", 0.6)
shots[-1]["end"] = dur
N = int(dur * FPS)
MARGIN = 1.22

def cover(img):
    s = max(W / img.width, H / img.height) * MARGIN
    return img.resize((int(img.width * s), int(img.height * s)), Image.LANCZOS)
imgs = {s["img"]: cover(Image.open(p(s["img"])).convert("RGB")) for s in shots}

def ease(x):
    x = min(1, max(0, x))
    return x * x * (3 - 2 * x)

MOVES = {  # (scale0, scale1, x0, x1, y0, y1)  offsets in fraction of free margin (-1..1)
    "push": (1.00, 1.10, 0, 0, 0, 0),
    "push_slow": (1.00, 1.06, 0, 0, 0, 0),
    "pull": (1.12, 1.00, 0, 0, 0, 0),
    "pan_r": (1.06, 1.06, -0.9, 0.9, 0, 0),
    "pan_l": (1.06, 1.06, 0.9, -0.9, 0, 0),
    "tilt_down": (1.05, 1.08, 0, 0, -0.9, 0.6),
    "tilt_up": (1.05, 1.08, 0, 0, 0.8, -0.6),
    "crash": (1.00, 1.16, 0, 0, 0, 0),
}

def camera(shot, t):
    a, b = shot["start"], shot["end"]
    u = (t - a) / max(0.01, b - a)
    s0, s1, x0, x1, y0, y1 = MOVES[shot.get("move", "push")]
    if shot.get("move") == "crash":
        k = 1 - (1 - min(1, u / 0.18)) ** 3 * 1.0 if u < 0.18 else 1
        sc = s0 + (s1 - s0) * (0.75 * k + 0.25 * ease(u))
    else:
        sc = s0 + (s1 - s0) * ease(u)
    x = x0 + (x1 - x0) * ease(u)
    y = y0 + (y1 - y0) * ease(u)
    # beat punches
    for pt in shot.get("punch", []):
        if 0 <= t - pt < 0.35:
            sc *= 1 + 0.07 * math.exp(-(t - pt) * 12)
    # cut-in punch: first frames of every shot
    if t - a < 0.12:
        sc *= 1 + 0.05 * (1 - (t - a) / 0.12)
    sx = sy = 0
    for t0, t1, amp in shot.get("shake", []):
        if t0 <= t <= t1:
            fall = 1 - (t - t0) / max(0.01, t1 - t0)
            sx += amp * fall * math.sin(t * 93.0)
            sy += amp * fall * math.cos(t * 71.0)
    return sc, x, y, sx, sy

def render_shot(shot, t):
    im = imgs[shot["img"]]
    sc, x, y, sx, sy = camera(shot, t)
    cw, ch = W / sc * (im.width / (W * MARGIN)) * MARGIN, H / sc * (im.height / (H * MARGIN)) * MARGIN
    cw, ch = im.width / MARGIN / sc, im.height / MARGIN / sc
    freex, freey = (im.width - cw) / 2, (im.height - ch) / 2
    cx = im.width / 2 + x * freex + sx
    cy = im.height / 2 + y * freey + sy
    box = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)
    return im.crop(tuple(int(v) for v in box)).resize((W, H), Image.BILINEAR)

# vignette
yy, xx = np.mgrid[0:H, 0:W]
r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
vig = Image.fromarray((np.clip((r - 0.75) / 0.7, 0, 1) ** 1.6 * 150).astype(np.uint8))
vig_rgba = Image.new("RGBA", (W, H), (0, 0, 0, 0))
vig_rgba.putalpha(vig)

# hook title
title = cfg.get("title")
font = ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"
                          if os.path.exists("/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf")
                          else "/usr/share/fonts/opentype/inter/Inter-Bold.otf", 80)
def title_layer(text):
    lines = text.split("\n")
    lay = Image.new("RGBA", (W, 420), (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    yy0 = 30
    for ln in lines:
        w = d.textlength(ln, font=font)
        d.text(((W - w) / 2, yy0), ln, font=font, fill=(255, 221, 51), stroke_width=10, stroke_fill=(0, 0, 0))
        yy0 += 100
    return lay
TL = title_layer(title) if title else None

# pop-up option cards: {"text": "1 — ПОДВАЛ", "t": 26, "end": 31, "x": 540, "y": 700, "color": [r,g,b]}
cfont = ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-Bold.otf", 64)
CARDS = []
for c in cfg.get("cards", []):
    tw = int(ImageDraw.Draw(Image.new("RGBA", (1, 1))).textlength(c["text"], font=cfont))
    img = Image.new("RGBA", (tw + 90, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4, 4, img.width - 4, img.height - 4), radius=40, fill=tuple(c.get("color", [255, 221, 51])) + (240,),
                        outline=(0, 0, 0, 255), width=6)
    d.text((45, 22), c["text"], font=cfont, fill=(20, 20, 20))
    CARDS.append(dict(c, img=img))
TITLE_T = cfg.get("title_dur", 2.2)

# water drops
random.seed(3)
def make_drops(n):
    return [dict(x=random.uniform(0, W), y0=random.uniform(-H, 0), v=random.uniform(1800, 3200),
                 r=random.uniform(8, 30)) for _ in range(n)]
drops_cache = {}

ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                       "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                       "-pix_fmt", "yuv420p", p("silent.mp4")], stdin=subprocess.PIPE)
for i in range(N):
    t = i / FPS
    shot = next(s for s in shots if s["start"] <= t < s["end"] or s is shots[-1])
    fr = render_shot(shot, t).convert("RGBA")
    if shot.get("drops"):
        key = shot["img"]
        drops_cache.setdefault(key, make_drops(70))
        u = t - shot["start"]
        dr = ImageDraw.Draw(fr)
        for d in drops_cache[key]:
            y = (d["y0"] + d["v"] * u) % (H + 200) - 100
            rr = d["r"]
            dr.ellipse((d["x"] - rr * 0.6, y - rr, d["x"] + rr * 0.6, y + rr), fill=(200, 235, 255, 150))
            dr.ellipse((d["x"] - rr * 0.25, y - rr * 0.6, d["x"], y - rr * 0.2), fill=(255, 255, 255, 200))
    fr.alpha_composite(vig_rgba)
    for fl in shot.get("flash", []):
        if 0 <= t - fl < 0.18:
            a = int(220 * (1 - (t - fl) / 0.18))
            fr.alpha_composite(Image.new("RGBA", (W, H), (255, 255, 255, a)))
    if TL is not None and t < TITLE_T:
        # pop-in with overshoot, then gentle wobble, fade at end
        k = min(1, t / 0.35)
        s = 0.4 + 0.6 * (1 + 0.25 * math.sin(k * math.pi)) * k if k < 1 else 1 + 0.02 * math.sin(t * 9)
        lay = TL.resize((max(1, int(TL.width * s)), max(1, int(TL.height * s))), Image.BICUBIC)
        lay = lay.rotate(2.5 * math.sin(t * 5), resample=Image.BICUBIC)
        if t > TITLE_T - 0.25:
            alpha = lay.getchannel("A").point(lambda v: int(v * (TITLE_T - t) / 0.25))
            lay.putalpha(alpha)
        fr.alpha_composite(lay, ((W - lay.width) // 2, 230 - (lay.height - TL.height) // 2))
    for card in CARDS:
        if card["t"] <= t < card["end"]:
            k = min(1, (t - card["t"]) / 0.3)
            s = (0.3 + 0.7 * k) * (1 + 0.18 * math.sin(k * math.pi)) if k < 1 else 1 + 0.03 * math.sin((t - card["t"]) * 7)
            im = card["img"]
            lay = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BICUBIC)
            fr.alpha_composite(lay, (int(card["x"] - lay.width / 2), int(card["y"] - lay.height / 2)))
    ff.stdin.write(fr.convert("RGB").tobytes())
ff.stdin.close(); ff.wait()

# ---- audio ----
inputs = ["-i", p("silent.mp4"), "-i", p("voice.mp3"), "-i", p("music.mp3")]
filt = ["[1:a]apad[v]", f"[2:a]volume={cfg.get('music_vol', 0.13)},afade=t=out:st={dur-1.2:.2f}:d=1.2[m]"]
mix = ["[v]", "[m]"]
for k, s in enumerate(cfg.get("sfx", [])):
    inputs += ["-i", p(s["file"])]
    ms = int(s["t"] * 1000)
    filt.append(f"[{k+3}:a]adelay={ms}|{ms},volume={s.get('vol', 0.5)}[s{k}]")
    mix.append(f"[s{k}]")
filt.append("".join(mix) + f"amix=inputs={len(mix)}:duration=first:dropout_transition=0:normalize=0[a]")
subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filt),
                "-map", "0:v", "-map", "[a]", "-vf", "ass=" + p("subs.ass"), "-c:v", "libx264", "-crf", "18",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", f"{dur:.3f}", p("final.mp4")], check=True)
print(f"built final.mp4 {dur:.2f}s, {N} frames")
