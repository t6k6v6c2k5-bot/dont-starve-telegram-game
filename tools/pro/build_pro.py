#!/usr/bin/env python3
"""Shorts builder v2: cinematic camera on stills (sub-pixel smooth), crop-cuts inside one image,
beat punches, shake, flashes, hook title, option cards, glow spots, vignette, SFX design with
music ducking / mutes and loudness normalisation. No AI video.

usage: build_pro.py <dir>     reads <dir>/shots.json, voice.mp3, music.mp3, subs.ass, images, sfx files
                              writes <dir>/final.mp4

shots.json keys
  title, title_dur, title_y        hook title (two lines separated by \\n), seconds, top y in px (default 230)
  tail                             seconds after the voice ends
  music_vol, music_mute            drone level; [[t0, t1], ...] windows where the drone drops to silence
  voice_vol                        gain for the narration (default 1.0)
  lufs                             target integrated loudness (default -14)
  shots: [{img, start, end,
           move: push|push_slow|pull|pan_r|pan_l|tilt_down|tilt_up|crash|static      (legacy presets)
           keys: [{t|u, z, fx, fy}, ...]   explicit camera: t = absolute seconds (or u = 0..1 inside the shot),
                                           z = zoom relative to the whole image (1 = whole image visible),
                                           fx, fy = centre of the view in image fractions
           punch: [t], shake: [[t0, t1, amp]], flash: [t], topfade: true, nocutin: true}]
  cards: [{text, t, end, x, y, color}]
  spots: [{t, x, y, r, dur}]       soft glow pulse at screen position (px)
  sfx:   [{file, t, vol, dur}]     dur trims the clip
"""
import json, math, os, re, subprocess, sys
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
MARGIN = 1.22   # legacy presets assume the view never shows more than 1/MARGIN of the image

def load(img):
    """centre-crop to exact 9:16 and keep native resolution (only upscale if too small)"""
    w, h = img.size
    if w / h > W / H:
        nw = round(h * W / H); img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
    else:
        nh = round(w * H / W); img = img.crop((0, (h - nh) // 2, w, (h - nh) // 2 + nh))
    need = int(W * MARGIN)
    if img.width < need:
        img = img.resize((need, round(need * H / W)), Image.LANCZOS)
    return img
imgs = {s["img"]: load(Image.open(p(s["img"])).convert("RGB")) for s in shots}

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
    "static": (1.02, 1.02, 0, 0, 0, 0),
}

def camera(shot, t):
    """returns zoom z (1 = whole image), centre fx, fy in image fractions"""
    a, b = shot["start"], shot["end"]
    u = (t - a) / max(0.01, b - a)
    if "keys" in shot:
        ks = [dict(k, T=(k["t"] if "t" in k else a + k["u"] * (b - a))) for k in shot["keys"]]
        if t <= ks[0]["T"]:
            k0 = k1 = ks[0]; w = 0
        elif t >= ks[-1]["T"]:
            k0 = k1 = ks[-1]; w = 0
        else:
            i = max(j for j in range(len(ks) - 1) if ks[j]["T"] <= t)
            k0, k1 = ks[i], ks[i + 1]
            w = ease((t - k0["T"]) / max(1e-6, k1["T"] - k0["T"]))
        z = math.exp(math.log(k0["z"]) * (1 - w) + math.log(k1["z"]) * w)
        fx = k0.get("fx", 0.5) * (1 - w) + k1.get("fx", 0.5) * w
        fy = k0.get("fy", 0.5) * (1 - w) + k1.get("fy", 0.5) * w
    else:
        s0, s1, x0, x1, y0, y1 = MOVES[shot.get("move", "push")]
        if shot.get("move") == "crash":
            k = 1 - (1 - min(1, u / 0.18)) ** 3 if u < 0.18 else 1
            sc = s0 + (s1 - s0) * (0.75 * k + 0.25 * ease(u))
        else:
            sc = s0 + (s1 - s0) * ease(u)
        z = sc * MARGIN
        free = (1 - 1 / z) / 2
        fx = 0.5 + (x0 + (x1 - x0) * ease(u)) * free
        fy = 0.5 + (y0 + (y1 - y0) * ease(u)) * free
    for pt in shot.get("punch", []):
        if 0 <= t - pt < 0.35:
            z *= 1 + 0.07 * math.exp(-(t - pt) * 12)
    if t - a < 0.3 and not shot.get("nocutin"):
        z *= 1 + 0.06 * 2 ** (-10 * (t - a) / 0.3)
    for t0, t1, amp in shot.get("shake", []):
        if t0 <= t <= t1:
            fall = 1 - (t - t0) / max(0.01, t1 - t0)
            fx += amp * fall * math.sin(t * 93.0) / (W * MARGIN)
            fy += amp * fall * math.cos(t * 71.0) / (H * MARGIN)
    return z, fx, fy

def render_shot(shot, t):
    im = imgs[shot["img"]]
    z, fx, fy = camera(shot, t)
    z = max(1.0, z)
    vw, vh = im.width / z, im.height / z
    cx = min(max(fx * im.width, vw / 2), im.width - vw / 2)
    cy = min(max(fy * im.height, vh / 2), im.height - vh / 2)
    box = (max(0.0, cx - vw / 2), max(0.0, cy - vh / 2), min(float(im.width), cx + vw / 2), min(float(im.height), cy + vh / 2))
    return im.resize((W, H), Image.BICUBIC, box=box)

# ---- static overlays ----
yy, xx = np.mgrid[0:H, 0:W]
r = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2)
vig_rgba = Image.new("RGBA", (W, H), (0, 0, 0, 0))
vig_rgba.putalpha(Image.fromarray((np.clip((r - 0.75) / 0.7, 0, 1) ** 1.6 * 150).astype(np.uint8)))

tf = np.clip(1 - yy / (H * cfg.get("topfade_height", 0.36)), 0, 1) ** 1.3 * 235
topfade = Image.new("RGBA", (W, H), tuple(cfg.get("topfade_color", [8, 12, 34])) + (0,))
topfade.putalpha(Image.fromarray(tf.astype(np.uint8)))

FONT_XB = "/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf"
FONT_B = "/usr/share/fonts/opentype/inter/Inter-Bold.otf"
font = ImageFont.truetype(FONT_XB if os.path.exists(FONT_XB) else FONT_B, cfg.get("title_size", 80))
def title_lines(text):
    out = []
    y0 = 30
    for ln in text.split("\n"):
        lay = Image.new("RGBA", (W, 420), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        w = d.textlength(ln, font=font)
        d.text(((W - w) / 2, y0), ln, font=font, fill=(255, 221, 51), stroke_width=10, stroke_fill=(0, 0, 0))
        out.append(lay)
        y0 += int(cfg.get("title_size", 80) * 1.25)
    return out
title = cfg.get("title")
TL = title_lines(title) if title else None
TITLE_T = cfg.get("title_dur", 2.2)
TITLE_Y = cfg.get("title_y", 290)

cfont = ImageFont.truetype(FONT_B, cfg.get("card_size", 64))
CARDS = []
for c in cfg.get("cards", []):
    tw = int(ImageDraw.Draw(Image.new("RGBA", (1, 1))).textlength(c["text"], font=cfont))
    img = Image.new("RGBA", (tw + 90, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((4, 4, img.width - 4, img.height - 4), radius=40, fill=tuple(c.get("color", [255, 221, 51])) + (245,),
                        outline=(0, 0, 0, 255), width=6)
    d.text((45, 22), c["text"], font=cfont, fill=(20, 20, 20))
    CARDS.append(dict(c, img=img))

def glow(rad):
    g = np.mgrid[0:2 * rad, 0:2 * rad]
    dist = np.sqrt((g[1] - rad) ** 2 + (g[0] - rad) ** 2) / rad
    return (np.clip(1 - dist, 0, 1) ** 1.6 * 255).astype(np.uint8)
SPOTS = [dict(s, mask=glow(int(s.get("r", 260)))) for s in cfg.get("spots", [])]

# ---- frames ----
ff = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
                       "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "17",
                       "-pix_fmt", "yuv420p", p("silent.mp4")], stdin=subprocess.PIPE)
for i in range(N):
    t = i / FPS
    shot = next(s for s in shots if s["start"] <= t < s["end"] or s is shots[-1])
    fr = render_shot(shot, t).convert("RGBA")
    if shot.get("whip") and t - shot["start"] < 0.16:
        k = 1 - (t - shot["start"]) / 0.16
        fr = fr.resize((max(6, int(W / (1 + 60 * k * k))), H), Image.BILINEAR).resize((W, H), Image.BILINEAR)
    fr.alpha_composite(vig_rgba)
    if shot.get("topfade"):
        fr.alpha_composite(topfade)
    for sp in SPOTS:
        d = sp.get("dur", 0.9)
        if sp["t"] <= t < sp["t"] + d:
            k = math.sin(math.pi * (t - sp["t"]) / d) ** 0.8
            m = Image.fromarray((sp["mask"] * (k * sp.get("alpha", 0.42))).astype(np.uint8))
            lay = Image.new("RGBA", m.size, tuple(sp.get("color", [255, 236, 170])) + (0,))
            lay.putalpha(m)
            rad = m.size[0] // 2
            x0, y0 = int(sp["x"] - rad), int(sp["y"] - rad)
            # crop the glow to the frame
            cx0, cy0 = max(0, -x0), max(0, -y0)
            cx1, cy1 = min(m.size[0], W - x0), min(m.size[1], H - y0)
            if cx1 > cx0 and cy1 > cy0:
                fr.alpha_composite(lay.crop((cx0, cy0, cx1, cy1)), (x0 + cx0, y0 + cy0))
    for fl in shot.get("flash", []):
        if 0 <= t - fl < 0.18:
            fr.alpha_composite(Image.new("RGBA", (W, H), (255, 255, 255, int(220 * (1 - (t - fl) / 0.18)))))
    if TL is not None and t < TITLE_T:
        for li, lay0 in enumerate(TL):
            k = min(1, max(0, (t - li * 0.1) / 0.2))          # blur-in, lines 0.1 s apart
            blur, alpha = 14 * (1 - k), 0.55 + 0.45 * k
            if li > 0 and t < li * 0.1:
                alpha = 0
            if t > TITLE_T - 0.2:                               # exit: blur-out and fade, shorter than the entrance
                q = (TITLE_T - t) / 0.2
                blur, alpha = 10 * (1 - q), q
            if alpha <= 0:
                continue
            lay = lay0.filter(ImageFilter.GaussianBlur(blur)) if blur > 0.3 else lay0
            if alpha < 1:
                lay = lay.copy(); lay.putalpha(lay.getchannel("A").point(lambda v: int(v * alpha)))
            fr.alpha_composite(lay, (0, TITLE_Y))
    for card in CARDS:
        if card["t"] <= t < card["end"]:
            k = min(1, (t - card["t"]) / 0.3)
            s = (0.3 + 0.7 * k) * (1 + 0.18 * math.sin(k * math.pi)) if k < 1 else 1
            im = card["img"]
            lay = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BICUBIC)
            fr.alpha_composite(lay, (int(card["x"] - lay.width / 2), int(card["y"] - lay.height / 2)))
    ff.stdin.write(fr.convert("RGB").tobytes())
ff.stdin.close(); ff.wait()

# ---- audio: mix -> measure loudness -> static gain + limiter ----
inputs = ["-i", p("voice.mp3"), "-i", p("music.mp3")]
mexpr = f"{cfg.get('music_vol', 0.13)}"
for a, b in cfg.get("music_mute", []):
    mexpr += f"*clip((abs(t-{(a + b) / 2:.3f})-{(b - a) / 2:.3f})/0.12,0,1)"
filt = [f"[0:a]volume={cfg.get('voice_vol', 1.0)},apad[v]",
        f"[1:a]volume='{mexpr}':eval=frame,afade=t=out:st={dur - 1.2:.2f}:d=1.2[m]"]
mix = ["[v]", "[m]"]
for k, s in enumerate(cfg.get("sfx", [])):
    inputs += ["-i", p(s["file"])]
    ms = int(s["t"] * 1000)
    trim = f"atrim=0:{s['dur']},afade=t=out:st={max(0, s['dur'] - 0.06):.3f}:d=0.06," if s.get("dur") else ""
    filt.append(f"[{k + 2}:a]{trim}aformat=channel_layouts=stereo,adelay={ms}|{ms},volume={s.get('vol', 0.5)}[s{k}]")
    mix.append(f"[s{k}]")
filt.append("".join(mix) + f"amix=inputs={len(mix)}:duration=first:dropout_transition=0:normalize=0[a]")
subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filt), "-map", "[a]",
                "-t", f"{dur:.3f}", "-ar", "48000", "-ac", "2", p("mix.wav")], check=True)
meas = subprocess.run(["ffmpeg", "-hide_banner", "-i", p("mix.wav"), "-af", "loudnorm=print_format=json", "-f", "null", "-"],
                      capture_output=True, text=True).stderr
lufs_in = float(re.search(r'"input_i"\s*:\s*"(-?[\d.]+)"', meas).group(1))
gain = min(14.0, cfg.get("lufs", -14) - lufs_in)
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", p("silent.mp4"), "-i", p("mix.wav"),
                "-filter_complex", f"[1:a]volume={gain:.2f}dB,alimiter=limit=0.8:level=disabled[a]",
                "-map", "0:v", "-map", "[a]", "-vf", "ass=" + p("subs.ass"), "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", f"{dur:.3f}", "-movflags", "+faststart", p("final.mp4")], check=True)
print(f"built final.mp4 {dur:.2f}s, {N} frames, mix {lufs_in:.1f} LUFS -> gain {gain:+.1f} dB")
