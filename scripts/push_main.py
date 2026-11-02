#!/usr/bin/env python3
"""Push main and run the wake selection in one command (D00 T01 §32).

    python3 scripts/push_main.py [--root <dir>]

The coordinator pushes through this instead of a bare `git push origin main`: it fetches first, captures the
published baseline from the refreshed `origin/main`, pushes, and only on success runs
`lane_wake.py waiters <old> <new>` with `<new>` the exact pushed commit, printing its JSON for the sends.
A rejected push exits with the push's failure and runs no selection; an unchanged remote prints an empty
selection; a failing selection reports that publication succeeded but selection failed, with both SHAs for a
manual retry (the heartbeat fallback is unchanged). Exit 0 only when the push and the selection both succeed.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def _run(root: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, cwd=root, capture_output=True, text=True, check=False)


def _sha(root: Path, ref: str, git: str = "git") -> str | None:
    out = _run(root, [git, "rev-parse", ref])
    return out.stdout.strip() if out.returncode == 0 else None


def push_main(root: Path, git: str = "git", python: str = sys.executable) -> int:
    root = root.resolve()
    fetched = _run(root, [git, "fetch", "origin", "main"])
    if fetched.returncode != 0:
        print(f"push_main: fetch failed: {fetched.stderr.strip()}", file=sys.stderr)
        return 2
    old = _sha(root, "origin/main", git)
    new = _sha(root, "main", git)
    if old is None or new is None:
        print("push_main: could not read origin/main or main", file=sys.stderr)
        return 2
    pushed = _run(root, [git, "push", "origin", "main"])
    if pushed.returncode != 0:
        print(f"push_main: push refused: {pushed.stderr.strip()}", file=sys.stderr)
        return pushed.returncode if pushed.returncode > 0 else 1
    published = _sha(root, "origin/main", git)
    if published != new:
        print(f"push_main: published main is {published}, not the pushed {new}", file=sys.stderr)
        return 2
    if old == new:
        print(json.dumps({"wake": [], "skipped": []}))
        return 0
    wake = _run(root, [python, str(Path(__file__).resolve().with_name("lane_wake.py")), "waiters", old, new, "--root", str(root)])
    if wake.returncode != 0:
        print(
            f"push_main: published {old}..{new} but the wake selection failed; "
            f"retry with: python3 scripts/lane_wake.py waiters {old} {new} --root {root}\n{wake.stderr.strip()}",
            file=sys.stderr,
        )
        return 3
    print(wake.stdout.strip())
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Push main and run the wake selection (D00 T01 §32).")
    parser.add_argument("--root", default=".", help="the main checkout (default: current directory)")
    args = parser.parse_args(argv)
    return push_main(Path(args.root))


if __name__ == "__main__":
    raise SystemExit(main())
