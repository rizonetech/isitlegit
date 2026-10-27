#!/usr/bin/env python3
"""Compile the Worker's MP3 decoder, native/minimp3/decoder.c with minimp3.h, to src/voice/minimp3.wasm (D01 T03 §7).

Zig is the compiler (it ships its own clang and WebAssembly linker, installable with pip and no system packages), pinned
in native/minimp3/requirements.txt so the output is the same byte for byte; CI rebuilds it and fails when the committed
file differs. The module links no C library: no imports, its memory exported and grown by the binding itself.

    python3 -m venv build/zig-venv && build/zig-venv/bin/pip install -r native/minimp3/requirements.txt
    build/zig-venv/bin/python scripts/build-minimp3-wasm.py [--out src/voice/minimp3.wasm] [--check]
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "native" / "minimp3" / "decoder.c"
OUT = ROOT / "src" / "voice" / "minimp3.wasm"
FLAGS = [
    "--target=wasm32-freestanding",
    "-O2",
    "-nostdlib",
    "-fno-builtin",
    "-ffunction-sections",
    "-Wl,--no-entry",
    "-Wl,--export-memory",
    "-Wl,--strip-all",
]


def build(out: Path) -> None:
    """Compiles to a temporary file beside `out`, then replaces `out` with it."""
    with tempfile.NamedTemporaryFile(dir=out.parent, suffix=".wasm.tmp", delete=False) as handle:
        tmp = Path(handle.name)
    try:
        subprocess.run(
            [
                sys.executable, "-m", "ziglang", "cc", *FLAGS,
                # Our own <stdlib.h> and <string.h> (native/minimp3/include), for the freestanding target has none.
                "-I", str(SOURCE.parent / "include"), "-I", str(SOURCE.parent), str(SOURCE), "-o", str(tmp),
            ],
            check=True,
            cwd=ROOT,
        )
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--check", action="store_true", help="build to a temporary file and compare with --out")
    args = parser.parse_args()
    if not args.check:
        build(args.out)
        print(f"build-minimp3-wasm: wrote {args.out} ({args.out.stat().st_size} bytes)")
        return 0
    with tempfile.TemporaryDirectory() as scratch:
        fresh = Path(scratch) / "minimp3.wasm"
        build(fresh)
        if fresh.read_bytes() != args.out.read_bytes():
            print(f"build-minimp3-wasm: {args.out} differs from a fresh build; rebuild and commit it", file=sys.stderr)
            return 1
    print(f"build-minimp3-wasm: {args.out} matches a fresh build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
