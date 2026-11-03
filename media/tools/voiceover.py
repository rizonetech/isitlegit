#!/usr/bin/env python3
"""Turn a video's narration into per-scene audio in the operator's ElevenLabs voice.

Run on the operator's machine (media/voiceover/README.md). Reads media/data/narration/<video>.json, fills each
`{fact.key}` from media/data/*-facts.json (a `{stats.x}` is refused: it changes with every commit and would re-bill the
clip), says each name in media/data/pronunciation.json its spoken way, and sends only that text to ElevenLabs' text-to-speech with timestamps
(POST /v1/text-to-speech/{voice_id}/with-timestamps, from the official `elevenlabs` SDK 2.75.0), and writes media/out/voice/<video>/NN.mp3 plus manifest.json with each clip's
length and text, every file replaced atomically. A clip whose text, voice and model have not changed since it was made
for the same scene is reused, so a re-run only pays for edited lines.

The key comes from ELEVENLABS_API_KEY and is never printed or written; the voice from ELEVENLABS_VOICE_ID. Without
them it prints the setup steps and exits 2. It shows what it will send and asks once before sending (--yes skips the
question; --dry-run sends nothing).

Exit 0 when every clip exists, 1 when a request failed, 2 when setup is missing or the input is invalid.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent
NARRATION = MEDIA / "data" / "narration"
OUT = MEDIA / "out" / "voice"
API = "https://api.elevenlabs.io"
OUTPUT_FORMAT = "mp3_44100_128"
SETUP = "media/voiceover/README.md, steps 1 to 3"
REF = re.compile(r"\{(stats|fact)\.([A-Za-z0-9_.]+)\}")


def facts() -> dict[str, str]:
    """Every pinned fact's value, from the files tools/check-facts.py proves."""
    values: dict[str, str] = {}
    for path in sorted((MEDIA / "data").glob("*-facts.json")):
        values.update({k: f["value"] for k, f in json.loads(path.read_text())["facts"].items()})
    return values


def resolve(text: str, known: dict[str, str]) -> str:
    def value(m: re.Match) -> str:
        kind, key = m.groups()
        if kind == "stats":
            raise ValueError(f"names {{stats.{key}}}; narration may name only pinned facts")
        if key not in known:
            raise ValueError(f"names unknown fact {key}")
        return known[key]

    return REF.sub(value, text)


def pronounce(text: str) -> str:
    """Each written form in media/data/pronunciation.json replaced by how the narration says it, longest first."""
    path = MEDIA / "data" / "pronunciation.json"
    say = json.loads(path.read_text())["say"] if path.exists() else {}
    for written in sorted(say, key=len, reverse=True):
        text = text.replace(written, say[written])
    return text


def load(video: str) -> tuple[dict, list[str]]:
    """The narration file and each segment's text, facts filled in."""
    path = NARRATION / f"{video}.json"
    data = json.loads(path.read_text())
    texts = [s.get("text", "").strip() for s in data.get("segments", [])]
    if not texts or not all(texts):
        raise ValueError(f"{path.name}: every segment needs non-empty text")
    known = facts()
    try:
        # *Starred* words are emphasis for the on-screen hook (src/kit/coldopen.tsx); the voice reads them plainly.
        return data, [pronounce(resolve(t, known)).replace("*", "") for t in texts]
    except ValueError as exc:
        raise ValueError(f"{path.name}: {exc}") from None


def digest(text: str, voice: str, model: str, settings: dict | None = None) -> str:
    # Settings join the digest only when a file sets them, so clips made without them keep their digests.
    parts = [text, voice, model, OUTPUT_FORMAT] + ([settings] if settings else [])
    return hashlib.sha256(json.dumps(parts, sort_keys=True).encode()).hexdigest()[:16]


def replace(path: Path, data: bytes) -> None:
    """Write `data` to `path` through a temporary file, so a reader never sees half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}-")
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def synthesise(key: str, voice: str, model: str, text: str, before: str, after: str, settings: dict | None = None) -> tuple[bytes, float]:
    """One clip: the mp3 bytes and its length in seconds, from the character alignment."""
    body = {"text": text, "model_id": model}
    # Neighbouring text helps a clip's intonation join its scene's, but ElevenLabs' eleven_v3 refuses it (400, "not yet
    # supported with the 'eleven_v3' model"), so v3 clips are made on their own.
    if not model.startswith("eleven_v3"):
        body.update({"previous_text": before, "next_text": after})
    if settings:
        body["voice_settings"] = settings
    req = urllib.request.Request(
        f"{API}/v1/text-to-speech/{voice}/with-timestamps?output_format={OUTPUT_FORMAT}",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        reply = json.loads(resp.read())
    audio = base64.b64decode(reply["audio_base64"])
    ends = (reply.get("alignment") or {}).get("character_end_times_seconds") or [0.0]
    return audio, float(ends[-1])


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("video", help="narration file name without .json, for example 01")
    ap.add_argument("--dry-run", action="store_true", help="list what would be sent, send nothing")
    ap.add_argument("--yes", action="store_true", help="do not ask before sending")
    args = ap.parse_args(argv)

    try:
        data, segments = load(args.video)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"voiceover: {exc}", file=sys.stderr)
        return 2
    model = data.get("model_id", "eleven_multilingual_v2")
    # A file may ask for a more expressive read (the hooks: lower stability, some style); the narration does not.
    settings = data.get("voice_settings")
    out = OUT / args.video
    manifest_path = out / "manifest.json"
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"clips": []}
    # Reuse is per scene: a clip is kept only when its own file still holds this text, so inserting or moving a
    # segment never leaves a scene playing another scene's words.
    made = {c["file"]: c for c in old.get("clips", []) if (out / c["file"]).exists()}

    key = os.environ.get("ELEVENLABS_API_KEY", "")
    voice = os.environ.get("ELEVENLABS_VOICE_ID", "")
    # A dry run without the voice in the environment counts against the voice the clips were made with, so it shows
    # what a real run with that voice would pay for rather than every clip.
    counted = voice or (old.get("voice", "") if args.dry_run else "")

    def reusable(i: int, d: str) -> dict | None:
        clip = made.get(f"{i:02d}.mp3")
        return clip if clip and clip["digest"] == d else None

    todo = [i for i, t in enumerate(segments) if not reusable(i, digest(t, counted, model, settings))]
    chars = sum(len(segments[i]) for i in todo)
    print(f"voiceover: video {args.video}, {len(segments)} segments, {len(todo)} to generate, {chars} characters")
    print(f"voiceover: model {model}, output {OUTPUT_FORMAT}, to {API}, audio into {out.relative_to(MEDIA.parent)}")
    if args.dry_run:
        for i in todo:
            print(f"  {i:02d}  {len(segments[i]):4d} chars  {segments[i][:90]}")
        return 0
    if not key or not voice:
        missing = " and ".join(n for n, v in (("ELEVENLABS_API_KEY", key), ("ELEVENLABS_VOICE_ID", voice)) if not v)
        print(f"voiceover: auth-required: export {missing} first ({SETUP})", file=sys.stderr)
        return 2
    if todo and not args.yes:
        answer = input(f"Send {len(todo)} segments ({chars} characters of narration text only) to {API}? [y/N] ")
        if answer.strip().lower() not in ("y", "yes"):
            print("voiceover: nothing sent")
            return 0

    clips, failed = [], 0
    for i, text in enumerate(segments):
        d = digest(text, voice, model, settings)
        name = f"{i:02d}.mp3"
        clip = reusable(i, d)
        if clip:
            clips.append({**clip, "index": i, "text": text})
            continue
        try:
            audio, seconds = synthesise(key, voice, model, text, segments[i - 1] if i else "", segments[i + 1] if i + 1 < len(segments) else "", settings)
        except (urllib.error.URLError, KeyError, ValueError, TimeoutError) as exc:
            # The reason only: an HTTP error's body can be long, and headers are never printed.
            reason = exc.code if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
            print(f"voiceover: segment {i:02d} failed ({reason}); re-run to retry", file=sys.stderr)
            failed += 1
            continue
        replace(out / name, audio)
        clips.append({"index": i, "file": name, "seconds": round(seconds, 3), "digest": d, "text": text})
        print(f"  {i:02d}  {seconds:6.2f} s")
    clips.sort(key=lambda c: c["index"])
    replace(manifest_path, (json.dumps({"video": args.video, "model_id": model, "voice": voice, "clips": clips}, indent=2) + "\n").encode())
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
