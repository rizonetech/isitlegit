#!/usr/bin/env python3
"""Compile the Worker's native WebAssembly modules from their C sources (D01 T03 §7, §9).

  native/minimp3/decoder.c with minimp3.h  -> src/voice/minimp3.wasm  (the MP3 decoder)
  native/resample/resample.c                -> src/voice/resample.wasm (the resampler's SIMD kernel)

Zig is the compiler (it ships its own clang and WebAssembly linker, installable with pip and no system packages), pinned
in native/requirements.txt so the output is the same byte for byte; CI rebuilds both and fails when a committed file
differs. Each module links no C library: no imports, its memory exported and grown by the module itself.

    python3 -m venv build/zig-venv && build/zig-venv/bin/pip install -r native/requirements.txt
    build/zig-venv/bin/python scripts/build-wasm.py [--check]
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMMON = [
    "--target=wasm32-freestanding",
    "-nostdlib",
    "-fno-builtin",
    "-ffunction-sections",
    "-Wl,--no-entry",
    "-Wl,--export-memory",
    "-Wl,--strip-all",
    # Our own <stdlib.h> and <string.h>, for the freestanding target has none.
    "-I",
    str(ROOT / "native" / "minimp3" / "include"),
]
MODULES = {
    "minimp3": (ROOT / "native" / "minimp3" / "decoder.c", ROOT / "src" / "voice" / "minimp3.wasm", ["-O3", "-msimd128"]),
    "resample": (ROOT / "native" / "resample" / "resample.c", ROOT / "src" / "voice" / "resample.wasm", ["-O3", "-msimd128"]),
}


def build(source: Path, out: Path, flags: list[str]) -> None:
    """Compiles to a temporary file beside `out`, then replaces `out` with it."""
    with tempfile.NamedTemporaryFile(dir=out.parent, suffix=".wasm.tmp", delete=False) as handle:
        tmp = Path(handle.name)
    try:
        subprocess.run(
            [sys.executable, "-m", "ziglang", "cc", *COMMON, *flags, "-I", str(source.parent), str(source), "-o", str(tmp)],
            check=True,
            cwd=ROOT,
        )
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="build to temporary files and compare with the committed")
    args = parser.parse_args()
    failed = False
    for name, (source, out, flags) in MODULES.items():
        if not args.check:
            build(source, out, flags)
            print(f"build-wasm: wrote {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
            continue
        with tempfile.TemporaryDirectory() as scratch:
            fresh = Path(scratch) / out.name
            build(source, fresh, flags)
            if fresh.read_bytes() != out.read_bytes():
                print(f"build-wasm: {out.relative_to(ROOT)} differs from a fresh build; rebuild and commit it", file=sys.stderr)
                failed = True
            else:
                print(f"build-wasm: {out.relative_to(ROOT)} matches a fresh build")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
