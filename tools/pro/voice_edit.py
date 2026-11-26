#!/usr/bin/env python3
"""Prepare narration: drop TTS tag words, optional tempo change, insert pauses of silence.

usage: voice_edit.py <dir> [tempo]
reads  <dir>/voice_raw.mp3, <dir>/words_raw.json, <dir>/pauses.json (optional)
writes <dir>/voice.mp3, <dir>/words.json
pauses.json = [{"after_index": 54, "dur": 0.4}, ...]   index = position in the CLEANED word list (see printed list)
"""
import json, subprocess, sys, os
import numpy as np

D = sys.argv[1]
tempo = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
p = lambda n: os.path.join(D, n)
SR = 48000

raw = json.load(open(p("words_raw.json")))
words = raw["words"] if isinstance(raw, dict) else raw
TAGS = {"low", "voice]", "excited]"}
clean = [w for w in words if w.get("type") == "word" and "[" not in w["text"] and "]" not in w["text"] and w["text"] not in TAGS]
for w in clean:
    w["start"] /= tempo
    w["end"] /= tempo

af = f"atempo={tempo}" if abs(tempo - 1) > 1e-6 else "anull"
pcm = np.frombuffer(subprocess.run(["ffmpeg", "-v", "error", "-i", p("voice_raw.mp3"), "-af", af, "-ac", "1", "-ar", str(SR),
                                    "-f", "f32le", "-"], capture_output=True, check=True).stdout, np.float32).copy()

pauses = json.load(open(p("pauses.json"))) if os.path.exists(p("pauses.json")) else []
pauses = sorted(pauses, key=lambda x: x["after_index"], reverse=True)   # splice from the end so earlier times stay valid
FADE = int(0.012 * SR)
for ps in pauses:
    i = ps["after_index"]
    a, b = clean[i]["end"], clean[i + 1]["start"]
    cut = int((a + b) / 2 * SR)
    n = int(ps["dur"] * SR)
    left, right = pcm[:cut].copy(), pcm[cut:].copy()
    left[-FADE:] *= np.linspace(1, 0, FADE)
    right[:FADE] *= np.linspace(0, 1, FADE)
    pcm = np.concatenate([left, np.zeros(n, np.float32), right])
    for w in clean[i + 1:]:
        w["start"] += ps["dur"]
        w["end"] += ps["dur"]
    print(f"pause {ps['dur']}s after #{i} '{clean[i]['text']}' at {a:.2f}s (gap was {b - a:.2f}s)")

subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-", "-b:a", "192k", p("voice.mp3")],
               input=pcm.tobytes(), check=True)
json.dump({"words": clean}, open(p("words.json"), "w"), ensure_ascii=False)
for i, w in enumerate(clean):
    print(i, f"{w['start']:.2f}", f"{w['end']:.2f}", w["text"])
print(f"duration {len(pcm) / SR:.2f}s")
