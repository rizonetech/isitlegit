#!/usr/bin/env python3
"""Master a rendered video's sound: python3 tools/master.py <raw.mp4> <out.mp4>.

One fixed gain brings the whole mix to TARGET_I (-14 LUFS, YouTube's level), so the music and the voice keep the
balance src/kit/ set and nothing pumps (the old single dynamic loudnorm pass rode the level every few seconds, which
lifted the music bed in every pause and distorted it). The narration's few loudest syllables would then pass full
scale, so a transparent look-ahead limiter holds the peaks under CEILING: the gain envelope is the lowest gain any
sample in a 40 ms window needs, smoothed over 20 ms, so it starts falling before a peak arrives and never clips one.
Remotion's ffmpeg has no limiter filter, so this one is numpy. The video stream is copied untouched.
"""

import json
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

MEDIA = Path(__file__).resolve().parent.parent
FFMPEG = [str(MEDIA / "node_modules" / ".bin" / "remotion"), "ffmpeg"]
TARGET_I = -14.0
CEILING_DB = -2.0
RATE = 48000
WINDOW = int(0.040 * RATE)
SMOOTH = int(0.020 * RATE)


def loudness(path: Path) -> dict:
    r = subprocess.run([*FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"], capture_output=True, text=True)
    found = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", r.stderr, re.S)
    if r.returncode or not found:
        raise SystemExit(f"master: cannot measure {path.name}")
    return json.loads(found.group(0))


def limit(x: np.ndarray, ceiling: float) -> np.ndarray:
    """Look-ahead peak limiter on (samples, channels) float audio: no sample ends above `ceiling`."""
    peak = np.abs(x).max(axis=1)
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    # The lowest gain needed anywhere in a window centred on each sample (a running minimum, by halving steps).
    g = need.copy()
    span = 1
    while span < WINDOW:
        shifted_l = np.concatenate([g[span:], np.ones(span)])
        shifted_r = np.concatenate([np.ones(span), g[:-span]])
        g = np.minimum(g, np.minimum(shifted_l, shifted_r))
        span *= 2
    # Smoothed with a centred box average; the running minimum's margin keeps every peak under the ceiling.
    c = np.cumsum(np.concatenate([np.ones(SMOOTH), g, np.ones(SMOOTH)]))
    smooth = (c[2 * SMOOTH :] - c[: -2 * SMOOTH])[: len(g)] / (2 * SMOOTH)
    out = x * smooth[:, None]
    # A last guard for any sample the smoothing let through.
    return np.clip(out, -ceiling, ceiling)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: master.py <raw.mp4> <out.mp4>", file=sys.stderr)
        return 2
    src, out = Path(argv[0]), Path(argv[1])
    out.parent.mkdir(parents=True, exist_ok=True)
    before = float(loudness(src)["input_i"])
    gain = 10 ** ((TARGET_I - before) / 20)
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "mix.wav"
        done = Path(tmp) / "mastered.wav"
        subprocess.run([*FFMPEG, "-loglevel", "error", "-y", "-i", str(src), "-vn", "-ar", str(RATE), "-ac", "2", "-c:a", "pcm_s16le", str(raw)], check=True)
        with wave.open(str(raw)) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32).reshape(-1, 2) / 32768.0
        y = limit(x * gain, 10 ** (CEILING_DB / 20))
        with wave.open(str(done), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((y * 32767).astype("<i2").tobytes())
        subprocess.run([*FFMPEG, "-loglevel", "error", "-y", "-i", str(src), "-i", str(done), "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", str(out)], check=True)
    after = loudness(out)
    print(f"master: {out.name} at {after['input_i']} LUFS, true peak {after['input_tp']} dBTP (mix measured {before} LUFS, gain {20 * np.log10(gain):.1f} dB)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
