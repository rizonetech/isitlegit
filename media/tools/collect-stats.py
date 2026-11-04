#!/usr/bin/env python3
"""Read the numbers the videos show from the repository and write media/src/data/stats.json.

Every number on screen comes from here, so a render always matches the checkout it was made from:
sections and stamps from the Implementation Order tables under todo/ (in total and per domain), review rounds
and final reviews from the receipts under docs/reviews/, the date and commit from HEAD, and the build's pace from
git: commits and stamp commits per day and commits per hour of day (SAST) across main and every lane branch in
todo/lanes.json, merges into main, and the lines of TypeScript under src/ and test/.
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
HEADING = re.compile(r"^## ")
ROUND = re.compile(r"^## Round \d+", re.M)
FINAL = re.compile(r"^## Final review: (?!none)[a-z0-9-]+", re.M)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def refs(repo: Path) -> list[str]:
    """main and every lane branch, preferring the remote copy, so the pace counts every lane's work once."""
    names = ["main"]
    lanes = repo / "todo" / "lanes.json"
    if lanes.exists():
        names += [lane["branch"] for lane in json.loads(lanes.read_text())["lanes"].values()]
    found = []
    for name in dict.fromkeys(names):
        for ref in (f"origin/{name}", name):
            if subprocess.run(["git", "rev-parse", "-q", "--verify", ref], cwd=repo, capture_output=True).returncode == 0:
                found.append(ref)
                break
    return found or ["HEAD"]


def pace(repo: Path) -> dict:
    """Commits and stamp commits per day, and commits per hour of day in SAST, each commit counted once."""
    log = subprocess.run(
        ["git", "log", *refs(repo), "--format=%ad%x09%s", "--date=format-local:%Y-%m-%d %H"],
        cwd=repo, check=True, capture_output=True, text=True, env={**os.environ, "TZ": "Africa/Johannesburg"},
    ).stdout.splitlines()
    days: dict = {}
    hours = [0] * 24
    for line in log:
        stamp, _, subject = line.partition("\t")
        day, hour = stamp.split()
        d = days.setdefault(day, {"date": day, "commits": 0, "stamps": 0})
        d["commits"] += 1
        d["stamps"] += subject.startswith("todo: stamp")
        hours[int(hour)] += 1
    first = subprocess.run(
        ["git", "log", *refs(repo), "--reverse", "--format=%ad", "--date=format-local:%-d %b %Y, %H:%M SAST"],
        cwd=repo, check=True, capture_output=True, text=True, env={**os.environ, "TZ": "Africa/Johannesburg"},
    ).stdout.splitlines()[0]
    stamps = sum(d["stamps"] for d in days.values())
    return {"days": sorted(days.values(), key=lambda d: d["date"]), "hours": hours, "commits": len(log), "stamps": stamps, "first": first}


def order_rows(text: str) -> list[str]:
    """The rows of the file's Implementation Order table only: a `| N | §N |` row in any other table (a cross-reference
    list, a section's own table) is not a section."""
    rows, inside = [], False
    for line in text.splitlines():
        if HEADING.match(line):
            inside = line.strip() == "## Implementation Order"
        elif inside and ROW.match(line):
            rows.append(line)
    return rows


def domains(repo: Path) -> list[dict]:
    """Sections and stamped sections per domain folder, in folder order."""
    out = []
    for folder in sorted(p for p in (repo / "todo").iterdir() if p.is_dir() and p.name != "templates"):
        rows = [line for f in folder.glob("TODO-*.md") for line in order_rows(f.read_text())]
        if rows:
            out.append({"domain": folder.name, "sections": len(rows), "stamped": sum("[x]" in line for line in rows)})
    return out


def lines_of_code(repo: Path) -> int:
    files = git(repo, "ls-files", "src", "test").splitlines()
    return sum(len((repo / f).read_text(errors="ignore").splitlines()) for f in files if f.endswith((".ts", ".tsx")))


def collect(repo: Path) -> dict:
    """The on-screen numbers for the checkout at `repo`."""
    rows = [line for f in (repo / "todo").rglob("TODO-*.md") if "templates" not in f.parts for line in order_rows(f.read_text())]
    receipts = [f.read_text() for f in (repo / "docs" / "reviews").rglob("*.md")]
    main = next((r for r in refs(repo) if r.endswith("main")), "HEAD")
    return {
        "sections": len(rows),
        "stamped": sum("[x]" in line for line in rows),
        "rounds": sum(len(ROUND.findall(t)) for t in receipts),
        "finals": sum(len(FINAL.findall(t)) for t in receipts),
        "date": git(repo, "log", "-1", "--format=%ad", "--date=format:%-d %b %Y"),
        "commit": git(repo, "rev-parse", "--short", "HEAD"),
        "receipts": len(receipts),
        "merges": int(git(repo, "rev-list", "--merges", "--count", main)),
        "lines": lines_of_code(repo),
        "domains": domains(repo),
        "pace": pace(repo),
    }


def write(stats: dict, out: Path) -> None:
    """Replace `out` atomically, so a render never reads a half-written file; on any failure the previous file stays
    as it was and the temporary file is removed."""
    out.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out.parent, prefix=".stats-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(stats, fh, indent=2)
            fh.write("\n")
        os.replace(tmp, out)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def main(argv: list[str]) -> None:
    """`collect-stats.py [repo] [out]`: the repository root (default: this checkout) and the JSON file to replace
    (default: media/src/data/stats.json, which the compositions import)."""
    repo = Path(argv[0]).resolve() if len(argv) > 0 else REPO
    out = Path(argv[1]).resolve() if len(argv) > 1 else OUT
    stats = collect(repo)
    write(stats, out)
    print(json.dumps(stats))


if __name__ == "__main__":
    main(sys.argv[1:])
