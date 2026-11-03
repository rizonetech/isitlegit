#!/usr/bin/env python3
"""Write YouTube captions (SRT) and chapters for videos 01 to 03 into media/out/captions/.

The timeline is computed the way the compositions lay it out (src/kit/Storyboard.tsx, src/videos/LoupeV1.tsx,
src/kit/voice.tsx, src/kit/coldopen.tsx, src/kit/reveal.tsx): the cold open, the reveal with the title line, every
sequence stretched to its narration clip, the credits. Because that layout lives in TypeScript, the computed length is checked against `remotion compositions`
and nothing is written when they differ by a frame. Captions carry the written narration (facts filled, names in
their written form, not the spoken ones in data/pronunciation.json), split into cues of at most two 42-character
lines, timed in proportion to their length within the clip. Chapters start at each chapter card (each scene in
video 03), at least 10 seconds apart, as YouTube requires.

Exit 0 when every file is written, 1 when a timeline does not match the render or a voice is missing.
"""

import importlib.util
import json
import math
import re
import subprocess
import sys
import os
import tempfile
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent
OUT = MEDIA / "out" / "captions"
FPS = 30
VIDEOS = {"01": ("DevProcess", "01-development-process"), "02": ("TechDeepDive", "02-technical-deep-dive"), "03": ("LoupeV1", None)}
SPEC = importlib.util.spec_from_file_location("voiceover", Path(__file__).with_name("voiceover.py"))
vo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vo)


def constant(path: str, name: str) -> int:
    """A frame constant from the TypeScript source, such as `export const DURATION = 240;` or `20 * 30`."""
    m = re.search(rf"export const {name} = ([0-9 *]+);", (MEDIA / path).read_text())
    return math.prod(int(x) for x in m.group(1).split("*"))


def stat(stats: dict, path: str) -> str:
    node = stats
    for part in path.split("."):
        node = node[part]
    return f"{node:,}" if isinstance(node, int) else str(node)


def fill(text: str, facts: dict, stats: dict) -> str:
    return re.sub(r"\{(stats|fact)\.([A-Za-z0-9_.]+)\}", lambda m: stat(stats, m[2]) if m[1] == "stats" else facts[m[2]], text)


def scene_seconds(s: dict, facts: dict, stats: dict) -> int:
    """sceneSeconds in src/kit/Storyboard.tsx: reading time at 3.6 words a second plus time for the visual."""
    if s.get("seconds"):
        return s["seconds"]
    if s["type"] == "chapter":
        return 5
    parts = [s["title"]] + ([s["sub"]] if s.get("sub") else [])
    t = s["type"]
    if t == "bullets":
        parts += s["items"]
    if t == "table":
        parts += [c for row in s["rows"] for c in row]
    if t == "flow":
        parts += [x for st in s["steps"] for x in (st["title"], st.get("sub", ""))] + [s.get("note", "")]
    if t == "code":
        parts += s["lines"] + [s.get("caption", "")]
    if t == "stats":
        parts += [x for it in s["items"] for x in (it["value"], it["label"])] + [s.get("note", "")]
    if t == "chart":
        parts += [s.get("note", "")]
    if t == "lanes":
        parts += [x for ln in s["lanes"] for x in (ln["name"], ln["role"], ln["owns"])]
    if t == "callout":
        parts += [s["text"]]
    words = len(fill(" ".join(parts), facts, stats).split())
    visual = 5 if t in ("chart", "flow") else 2
    return max(7, math.ceil(words / 3.6 + visual))


def clips(video: str) -> list[dict]:
    path = vo.OUT / video / "manifest.json"
    if not path.exists():
        raise ValueError(f"video {video} has no voice; run python3 media/tools/voiceover.py {video}")
    return sorted(json.loads(path.read_text())["clips"], key=lambda c: c["index"])


def timeline(video: str) -> dict:
    """Frames of every part, in order, and where each voiced clip starts."""
    facts, stats = vo.facts(), json.loads((MEDIA / "src" / "data" / "stats.json").read_text())
    credits = constant("src/kit/credits.tsx", "CREDITS")
    tail = constant("src/kit/reveal.tsx", "REVEAL_TAIL")
    voice_at, minimum = (
        (constant("src/kit/reveal.tsx", "REVEAL_VOICE_AT"), constant("src/kit/reveal.tsx", "REVEAL_MIN"))
        if VIDEOS[video][1]
        else (constant("src/videos/LoupeMark.tsx", "LOUPE_VOICE_AT"), constant("src/videos/LoupeMark.tsx", "LOUPE_REVEAL_MIN"))
    )
    _, board = VIDEOS[video]
    if board:
        b = json.loads((MEDIA / "data" / "storyboards" / f"{board}.json").read_text())
        seconds = [6] + [scene_seconds(s, facts, stats) for s in b["scenes"]] + [6]
        names = ["Title"] + [fill(s["title"], facts, stats) if s["type"] == "chapter" else None for s in b["scenes"]] + [None]
    else:
        seconds = [int(x) for x in re.search(r"export const SCENES = \[([^\]]*)\]", (MEDIA / "src/videos/LoupeV1.tsx").read_text()).group(1).split(",")]
        labels = [s["scene"] for s in json.loads((vo.NARRATION / "03.json").read_text())["segments"]]
        names = [label[:1].upper() + label[1:] for label in labels[:-1]] + [None]
    cs = clips(video)
    frames = [max(s * FPS, math.ceil((0.5 + c["seconds"] + 0.8) * FPS)) for s, c in zip(seconds, cs, strict=True)]
    frames[0] = max(minimum, voice_at + math.ceil(cs[0]["seconds"] * FPS) + tail)
    hook = clips(f"{video}-hook")[0] if (vo.OUT / f"{video}-hook" / "manifest.json").exists() else None
    lead_ms, tail_ms = constant("src/kit/coldopen.tsx", "HOOK_LEAD_MS"), constant("src/kit/coldopen.tsx", "HOOK_TAIL_MS")
    cold = math.ceil((lead_ms / 1000 + hook["seconds"] + tail_ms / 1000) * FPS) if hook else 0
    voice, t = [], cold
    if hook:
        voice.append((round(lead_ms / 1000 * FPS), hook, f"{video}-hook"))
    starts = []
    for i, (f, c) in enumerate(zip(frames, cs, strict=True)):
        starts.append(t)
        voice.append((t + (voice_at if i == 0 else round(0.5 * FPS)), c, video))
        t += f
    return {"total": t + credits, "voice": voice, "chapters": [(s, n) for s, n in zip(starts, names, strict=True) if n]}


def rendered_frames(composition: str) -> int:
    out = subprocess.run([str(MEDIA / "node_modules/.bin/remotion"), "compositions", "src/index.ts"], cwd=MEDIA, capture_output=True, text=True).stdout
    m = re.search(rf"^{composition}\s+\d+\s+\d+x\d+\s+(\d+)", out, re.M)
    if not m:
        raise ValueError(f"remotion compositions did not list {composition}")
    return int(m.group(1))


def written(video: str) -> list[str]:
    """Each segment's narration as written: facts filled, before the pronunciation table."""
    known = vo.facts()
    texts = [vo.resolve(s["text"].strip(), known) for s in json.loads((vo.NARRATION / f"{video}.json").read_text())["segments"]]
    # Pause tags (<break time="0.5s" />) shape the delivery and *stars* the on-screen hook; a caption shows only the words.
    return [" ".join(re.sub(r"<break[^>]*/>", " ", t).replace("*", "").split()) for t in texts]


def cues(text: str, start: float, seconds: float, width: int = 42) -> list[tuple[float, float, str]]:
    """The text in cues of at most two lines of `width`, each timed by its share of the characters."""
    lines, line = [], ""
    for word in text.split():
        if line and len(line) + 1 + len(word) > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    lines.append(line)
    blocks = ["\n".join(lines[i : i + 2]) for i in range(0, len(lines), 2)]
    total, out, t = sum(len(b) for b in blocks), [], start
    for b in blocks:
        d = seconds * len(b) / total
        out.append((t, t + d, b))
        t += d
    return out


def stamp(t: float) -> str:
    ms = round(t * 1000)
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def srt(entries: list[tuple[float, float, str]]) -> str:
    return "".join(f"{i}\n{stamp(a)} --> {stamp(b)}\n{text}\n\n" for i, (a, b, text) in enumerate(entries, 1))


def chapters(points: list[tuple[int, str]], total: int) -> str:
    """YouTube chapters: the first at 0:00, each at least 10 seconds long."""
    kept: list[tuple[int, str]] = [(0, points[0][1])]
    for f, name in points[1:]:
        if f - kept[-1][0] >= 10 * FPS and total - f >= 10 * FPS:
            kept.append((f, name))
    return "".join(f"{f // FPS // 60}:{f // FPS % 60:02d} {name}\n" for f, name in kept)


def replace(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}-")
    with os.fdopen(fd, "w") as fh:
        fh.write(text)
    os.replace(tmp, path)


def main() -> int:
    failures = 0
    for video, (composition, _) in VIDEOS.items():
        try:
            tl = timeline(video)
            rendered = rendered_frames(composition)
        except (OSError, ValueError, KeyError) as exc:
            print(f"captions: {exc}", file=sys.stderr)
            failures += 1
            continue
        if tl["total"] != rendered:
            print(f"captions: video {video} computes {tl['total']} frames but renders {rendered}; the timeline here no longer matches the compositions", file=sys.stderr)
            failures += 1
            continue
        texts = {v: written(v) for v in {name for _, _, name in tl["voice"]}}
        entries = [cue for start, c, name in tl["voice"] for cue in cues(texts[name][c["index"]], start / FPS, c["seconds"])]
        replace(OUT / f"{video}.srt", srt(entries))
        replace(OUT / f"{video}-chapters.txt", chapters([(0, "Intro")] + tl["chapters"][1:], tl["total"]))
        print(f"captions: video {video}, {len(entries)} cues, {tl['total']} frames match the render")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
