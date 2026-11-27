import json, sys
words = json.load(open(sys.argv[1]))
if isinstance(words, dict):
    words = words.get("words", words)
words = [w for w in words if w.get("type") == "word" and w["text"] != "—"]
# split into clauses at punctuation, then split long clauses evenly (max 4 words)
import math
clauses, cur = [], []
for w in words:
    cur.append(w)
    if w["text"][-1] in ".?!:,":
        clauses.append(cur); cur = []
if cur: clauses.append(cur)
chunks = []
for cl in clauses:
    n = math.ceil(len(cl) / 3)
    size = math.ceil(len(cl) / n)
    for i in range(0, len(cl), size):
        chunks.append(cl[i:i+size])
def ts(s):
    h=int(s//3600); m=int(s%3600//60); sec=s%60
    return f"{h}:{m:02d}:{sec:05.2f}"
hdr = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,Inter ExtraBold,74,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,7,2,2,130,200,690,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
out = [hdr]
for i, c in enumerate(chunks):
    start = 0.0 if i == 0 else c[0]["start"]   # first chunk visible from frame 0 -> readable cover
    end = chunks[i+1][0]["start"] if i+1 < len(chunks) and chunks[i+1][0]["start"] - c[-1]["end"] < 0.5 else c[-1]["end"] + 0.15
    HL = set(x.upper() for x in sys.argv[3].split(",")) if len(sys.argv) > 3 else set()
    text = " ".join(("{\\1c&H33DDFF&}" + w["text"].upper() + "{\\1c&HFFFFFF&}") if w["text"].upper().strip(".,!?…:«»") in HL else w["text"].upper() for w in c).replace("\n", " ")
    out.append(f"Dialogue: 0,{ts(start)},{ts(end)},Main,,0,0,0,,{text}\n")
open(sys.argv[2], "w", encoding="utf-8").write("".join(out))
print(len(chunks), "chunks")
