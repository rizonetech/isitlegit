#!/usr/bin/env python3
"""Read the numbers the videos show from the repository and write media/src/data/stats.json.

Every number on screen comes from here, so a render always matches the checkout it was made from:
sections and stamps from the Implementation Order tables under todo/, review rounds and final reviews
from the receipts under docs/reviews/, and the date and commit from HEAD.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent
REPO = MEDIA.parent
OUT = MEDIA / "src" / "data" / "stats.json"

ROW = re.compile(r"^\| *\d+ *\| *§")
ROUND = re.compile(r"^## Round \d+", re.M)
FINAL = re.compile(r"^## Final review: (?!none)[a-z0-9-]+", re.M)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def collect(repo: Path) -> dict:
    """The on-screen numbers for the checkout at `repo`."""
    rows = [line for f in (repo / "todo").rglob("TODO-*.md") for line in f.read_text().splitlines() if ROW.match(line)]
    receipts = [f.read_text() for f in (repo / "docs" / "reviews").rglob("*.md")]
    return {
        "sections": len(rows),
        "stamped": sum("[x]" in line for line in rows),
        "rounds": sum(len(ROUND.findall(t)) for t in receipts),
        "finals": sum(len(FINAL.findall(t)) for t in receipts),
        "date": git(repo, "log", "-1", "--format=%ad", "--date=format:%-d %b %Y"),
        "commit": git(repo, "rev-parse", "--short", "HEAD"),
    }


def write(stats: dict, out: Path) -> None:
    """Replace `out` atomically, so a render never reads a half-written file."""
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out.parent, prefix=".stats-", suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump(stats, fh, indent=2)
        fh.write("\n")
    os.replace(tmp, out)


def main() -> None:
    repo = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else REPO
    stats = collect(repo)
    write(stats, OUT)
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
