#!/usr/bin/env python3
"""Make the videos' music and sound effects with ElevenLabs from media/data/sound.json.

Run on the operator's machine, like voiceover.py (media/voiceover/README.md). Each `music` entry goes to Eleven Music
(POST /v1/music, instrumental) and each `sfx` entry to Sound Effects (POST /v1/sound-generation); only the prompt and
length are sent. Writes media/out/sound/<name>.mp3 and manifest.json with each file's measured length, every file
replaced atomically. An entry whose prompt and length have not changed is reused, so a re-run only pays for edits.

The key comes from ELEVENLABS_API_KEY and is never printed or written. It shows what it will send and asks once
(--yes skips the question; --dry-run sends nothing). Exit 0 when every file exists, 1 when a request failed, 2 when
setup is missing or the spec is invalid.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent
SPEC = MEDIA / "data" / "sound.json"
OUT = MEDIA / "out" / "sound"
API = "https://api.elevenlabs.io"
OUTPUT_FORMAT = "mp3_44100_128"
VOICEOVER = importlib.util.spec_from_file_location("voiceover", Path(__file__).with_name("voiceover.py"))
vo = importlib.util.module_from_spec(VOICEOVER)
VOICEOVER.loader.exec_module(vo)
replace = vo.replace

# MPEG-1 Layer III bitrates (kbit/s) and sample rates, indexed by the frame header's fields.
BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
RATES = [44100, 48000, 32000, 0]


def mp3_seconds(data: bytes) -> float:
    """The length of an MPEG-1 Layer III file, by walking its frames (constant or variable bitrate)."""
    i = 0
    if data[:3] == b"ID3":
        i = 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
    frames, rate = 0, 0
    while i + 4 <= len(data):
        h = int.from_bytes(data[i : i + 4], "big")
        if h >> 21 != 0x7FF or (h >> 19) & 3 != 3 or (h >> 17) & 3 != 1:
            i += 1
            continue
        kbps, rate = BITRATES[(h >> 12) & 15], RATES[(h >> 10) & 3]
        if not kbps or not rate:
            i += 1
            continue
        frames += 1
        i += 144000 * kbps // rate + ((h >> 9) & 1)
    return round(frames * 1152 / rate, 3) if rate else 0.0


def entries(spec: dict) -> list[tuple[str, str, dict]]:
    """(kind, name, entry) for every music and sfx entry, each with a non-empty prompt and a positive length."""
    found = [(kind, name, e) for kind in ("music", "sfx") for name, e in spec.get(kind, {}).items()]
    for kind, name, e in found:
        if not str(e.get("prompt", "")).strip() or not float(e.get("seconds", 0)) > 0:
            raise ValueError(f"{kind} {name}: needs a prompt and a positive length in seconds")
    return found


def digest(kind: str, e: dict) -> str:
    return hashlib.sha256(json.dumps([kind, e["prompt"], e["seconds"], OUTPUT_FORMAT]).encode()).hexdigest()[:16]


def generate(key: str, kind: str, e: dict) -> bytes:
    if kind == "music":
        path, body = "/v1/music", {"prompt": e["prompt"], "music_length_ms": int(e["seconds"] * 1000), "model_id": "music_v1", "force_instrumental": True}
    else:
        path, body = "/v1/sound-generation", {"text": e["prompt"], "duration_seconds": e["seconds"], "prompt_influence": 0.5}
    req = urllib.request.Request(
        f"{API}{path}?output_format={OUTPUT_FORMAT}",
        data=json.dumps(body).encode(),
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.read()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="list what would be sent, send nothing")
    ap.add_argument("--yes", action="store_true", help="do not ask before sending")
    args = ap.parse_args(argv)
    try:
        todo_all = entries(json.loads(SPEC.read_text()))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"sound: {exc}", file=sys.stderr)
        return 2
    manifest_path = OUT / "manifest.json"
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"files": {}}
    made = {n: f for n, f in old.get("files", {}).items() if (OUT / f["file"]).exists()}
    todo = [(k, n, e) for k, n, e in todo_all if made.get(n, {}).get("digest") != digest(k, e)]
    print(f"sound: {len(todo_all)} entries, {len(todo)} to generate, to {API}, into {OUT.relative_to(MEDIA.parent)}")
    for kind, name, e in todo:
        print(f"  {kind:5s}  {name:10s}  {e['seconds']:6.1f} s  {e['prompt'][:70]}")
    if args.dry_run:
        return 0
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        print("sound: auth-required: export ELEVENLABS_API_KEY first (media/voiceover/README.md, step 1)", file=sys.stderr)
        return 2
    if todo and not args.yes:
        if input(f"Send {len(todo)} prompts (prompt text and length only) to {API}? [y/N] ").strip().lower() not in ("y", "yes"):
            print("sound: nothing sent")
            return 0
    files, failed = {}, 0
    for kind, name, e in todo_all:
        d = digest(kind, e)
        if made.get(name, {}).get("digest") == d:
            files[name] = made[name]
            continue
        try:
            audio = generate(key, kind, e)
        except (urllib.error.URLError, TimeoutError) as exc:
            reason = exc.code if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
            print(f"sound: {kind} {name} failed ({reason}); re-run to retry", file=sys.stderr)
            failed += 1
            continue
        replace(OUT / f"{name}.mp3", audio)
        files[name] = {"kind": kind, "file": f"{name}.mp3", "seconds": mp3_seconds(audio), "digest": d}
        print(f"  {name:10s}  {files[name]['seconds']:7.2f} s")
    replace(manifest_path, (json.dumps({"files": files}, indent=2) + "\n").encode())
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
