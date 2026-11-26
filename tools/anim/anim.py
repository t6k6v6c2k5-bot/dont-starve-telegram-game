#!/usr/bin/env python3
"""Cut-out (puppet) animation renderer for Kapi — no AI video.

usage: anim.py <dir>
<dir> must contain: bg.png, closed.png, open.png, blink.png (RGBA, same canvas),
voice.mp3, words.json (ElevenLabs scribe format). Writes <dir>/anim.mp4.

What it animates:
  * background: slow Ken-Burns zoom (parallax feel)
  * Kapi: idle bob + sway, squash/stretch with voice loudness
  * mouth: open/closed driven by audio loudness, only inside spoken words
  * blinks: in pauses between words
  * finale: water splash particles + Kapi jumps
"""
import json, math, os, random, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

D = sys.argv[1]
W, H, FPS = 1080, 1920, 30
p = lambda n: os.path.join(D, n)

# ---------- audio envelope ----------
raw = subprocess.run(["ffmpeg", "-v", "error", "-i", p("voice.mp3"), "-ac", "1", "-ar", "16000",
                      "-f", "s16le", "-"], capture_output=True, check=True).stdout
pcm = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
voice_dur = len(pcm) / 16000
TAIL = 1.6                      # seconds after speech for the splash finale
dur = voice_dur + TAIL
N = int(dur * FPS)
spf = 16000 // FPS
env = np.array([np.sqrt(np.mean(pcm[i * spf:(i + 1) * spf] ** 2)) if i * spf < len(pcm) else 0
                for i in range(N)])
env = env / (np.percentile(env[env > 0], 95) + 1e-9)
env = np.clip(env, 0, 1)

words = [w for w in json.load(open(p("words.json")))["words"] if w.get("type") == "word"]
def in_word(t):
    return any(w["start"] - 0.03 <= t <= w["end"] + 0.03 for w in words)

# mouth level 0 closed / 1 half / 2 open, from loudness inside words
mouth = []
for i in range(N):
    t = i / FPS
    e = env[i]
    if not in_word(t) or e < 0.22:
        mouth.append(0)
    elif e < 0.55:
        mouth.append(1)
    else:
        mouth.append(2)
# avoid 1-frame flicker
for i in range(1, N - 1):
    if mouth[i] != mouth[i - 1] and mouth[i] != mouth[i + 1]:
        mouth[i] = mouth[i - 1]

# blinks: pick moments in pauses (>0.25s gaps) plus a fallback every ~2.5s
gaps = [(a["end"], b["start"]) for a, b in zip(words, words[1:]) if b["start"] - a["end"] > 0.25]
blink_times = [(g0 + g1) / 2 for g0, g1 in gaps]
blink_times += [voice_dur + 0.3]
bl = set()
last = -9
for bt in sorted(blink_times):
    if bt - last < 1.2:
        continue
    last = bt
    f0 = int(bt * FPS) - 2
    bl.update(range(f0, f0 + 4))

# ---------- assets ----------
def load_char(n):
    im = Image.open(p(n)).convert("RGBA")
    return im
ch = {k: load_char(f"{k}.png") for k in ("closed", "half", "open", "blink")}
# common bbox over all three so they stay aligned
bbox = None
for im in ch.values():
    b = im.getchannel("A").point(lambda a: 255 if a > 20 else 0).getbbox()
    bbox = b if bbox is None else (min(bbox[0], b[0]), min(bbox[1], b[1]), max(bbox[2], b[2]), max(bbox[3], b[3]))
CH_H = 1100
for k in ch:
    im = ch[k].crop(bbox)
    s = CH_H / im.height
    ch[k] = im.resize((int(im.width * s), CH_H), Image.LANCZOS)
cw = ch["closed"].width
FEET_Y = 1790

bg0 = Image.open(p("bg.png")).convert("RGB")
s = max(W / bg0.width, H / bg0.height) * 1.12
bg0 = bg0.resize((int(bg0.width * s), int(bg0.height * s)), Image.LANCZOS)

# shadow ellipse
shadow = Image.new("RGBA", (cw, 90), (0, 0, 0, 0))
ImageDraw.Draw(shadow).ellipse((cw * 0.18, 10, cw * 0.82, 80), fill=(0, 0, 0, 90))
shadow = shadow.filter(ImageFilter.GaussianBlur(10))

# water particles for finale
random.seed(7)
SPLASH_T = voice_dur + 0.15
drops = [dict(x=random.uniform(150, 930), y0=random.uniform(-500, -40), v=random.uniform(1500, 2400),
              r=random.uniform(10, 26), wob=random.uniform(0, 6.28)) for _ in range(140)]

def ease_out(x):
    return 1 - (1 - x) ** 3

ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                       "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                       "-pix_fmt", "yuv420p", p("silent.mp4")], stdin=subprocess.PIPE)

for i in range(N):
    t = i / FPS
    # background zoom
    cx, cy = bg0.width / 2, bg0.height / 2
    cwid, chei = bg0.width / (1.0 + 0.06 * t / dur) / 1.0, bg0.height / (1.0 + 0.06 * t / dur) / 1.0
    box = (cx - cwid / 2, cy - chei / 2, cx + cwid / 2, cy + chei / 2)
    frame = bg0.crop(tuple(int(v) for v in box)).resize((W, H), Image.BILINEAR).convert("RGBA")

    # character pose
    talking = mouth[i]
    key = "blink" if i in bl and not talking else ("closed", "half", "open")[mouth[i]]
    im = ch[key]
    e = env[i] if in_word(t) else 0
    bob = 10 * math.sin(2 * math.pi * 1.1 * t)
    sway = 2.2 * math.sin(2 * math.pi * 0.45 * t)
    sy = 1 + 0.025 * e
    sx = 1 - 0.012 * e
    jump = 0
    if t > SPLASH_T:
        u = t - SPLASH_T
        if 0.3 < u < 0.85:                 # surprised jump when the water hits
            jump = -260 * math.sin(math.pi * (u - 0.3) / 0.55)
        sway += 6 * math.sin(2 * math.pi * 6 * u) * math.exp(-3 * u)   # shiver
    if t > SPLASH_T + 0.3:
        im = ch["open"]                    # surprised "O" mouth
    imw, imh = int(im.width * sx), int(im.height * sy)
    pose = im.resize((imw, imh), Image.BILINEAR).rotate(sway, resample=Image.BICUBIC, expand=True)
    x = W // 2 - pose.width // 2
    y = int(FEET_Y - pose.height + bob + jump)
    sh_scale = 1 - min(0.5, abs(jump) / 600)
    shw = max(10, int(shadow.width * sh_scale))
    frame.alpha_composite(shadow.resize((shw, shadow.height)), (W // 2 - shw // 2, FEET_Y - 50))
    frame.alpha_composite(pose, (x, y))

    # finale water
    if t > SPLASH_T:
        u = t - SPLASH_T
        dr = ImageDraw.Draw(frame)
        for d in drops:
            yy = d["y0"] + d["v"] * u
            if -60 < yy < H:
                xx = d["x"] + 12 * math.sin(d["wob"] + 8 * u)
                r = d["r"]
                dr.ellipse((xx - r * 0.7, yy - r, xx + r * 0.7, yy + r), fill=(120, 200, 255, 230),
                           outline=(30, 110, 200, 255), width=3)
                dr.ellipse((xx - r * 0.3, yy - r * 0.6, xx - r * 0.05, yy - r * 0.2), fill=(255, 255, 255, 220))
        # quick white flash at impact
        if u < 0.12:
            frame.alpha_composite(Image.new("RGBA", (W, H), (255, 255, 255, int(160 * (1 - u / 0.12)))))
    ff.stdin.write(frame.convert("RGB").tobytes())

ff.stdin.close()
ff.wait()
print(f"rendered {N} frames, {dur:.2f}s")
