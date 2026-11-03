#!/usr/bin/env python3
"""Prove every figure in media/data/*-facts.json against its source at that file's pinned commit.

Each fact names a file and either an exact quote, which must appear in `git show <commit>:<file>` and contain the
displayed value unless the fact is marked `"label": true`, or a `count` pattern, whose matching lines must number the
value. Every `{fact.key}` a storyboard in media/data/storyboards/ or a narration file in media/data/narration/ names
must be defined. Exit 0 when everything holds,
1 with each failure listed. The render scripts run it first, so a number on screen always has a source.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent
REPO = MEDIA.parent
DATA = MEDIA / "data"
FACT_REF = re.compile(r"\{fact\.([A-Za-z0-9_]+)\}")


def show(commit: str, path: str, cache: dict) -> str | None:
    if (commit, path) not in cache:
        r = subprocess.run(["git", "show", f"{commit}:{path}"], cwd=REPO, capture_output=True, text=True)
        cache[(commit, path)] = r.stdout if r.returncode == 0 else None
    return cache[(commit, path)]


def check(data: dict) -> list[str]:
    cache: dict = {}
    failures = []
    for key, fact in data["facts"].items():
        if fact.get("status") not in ("measured", "planned", "shipped"):
            failures.append(f"{key}: status must be measured, planned or shipped")
        # A fact may pin the commit that recorded it, when a later rewrite of its source dropped the line.
        commit = fact.get("commit", data["commit"])
        text = show(commit, fact["source"], cache)
        if text is None:
            failures.append(f"{key}: {fact['source']} not found at {commit[:10]}")
        elif "count" in fact:
            found = len(re.findall(fact["count"], text, re.M))
            if str(found) != fact["value"]:
                failures.append(f"{key}: {found} lines match in {fact['source']}, not {fact['value']}")
            continue
        elif fact["quote"] not in text:
            failures.append(f"{key}: quote not in {fact['source']}: {fact['quote']!r}")
        if not fact.get("label") and fact["value"] not in fact["quote"]:
            failures.append(f"{key}: value {fact['value']!r} is not in its quote")
    return failures


def unknown_refs(known: set[str], boards: list[Path]) -> list[str]:
    """Facts a storyboard names that no facts file defines."""
    return [f"{b.name}: names unknown fact {k}" for b in boards for k in FACT_REF.findall(b.read_text()) if k not in known]


def main() -> int:
    files = sorted(DATA.glob("*-facts.json"))
    failures, known, total = [], set(), 0
    for path in files:
        data = json.loads(path.read_text())
        failures += [f"{path.name}: {f}" for f in check(data)]
        known |= set(data["facts"])
        total += len(data["facts"])
    failures += unknown_refs(known, sorted((DATA / "storyboards").glob("*.json")) + sorted((DATA / "narration").glob("*.json")))
    for f in failures:
        print(f"check-facts: {f}", file=sys.stderr)
    if failures:
        return 1
    print(f"check-facts: {total} facts in {len(files)} files hold, and every storyboard and narration reference resolves")
    return 0


if __name__ == "__main__":
    sys.exit(main())
