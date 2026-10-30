#!/usr/bin/env python3
"""Prove every figure in media/data/loupe-facts.json against its source at the pinned commit.

Each fact names a file and either an exact quote, which must appear in `git show <commit>:<file>` and contain
the displayed value unless it is a label, or a `count` pattern, whose matching lines must number the value. Exit 0 when every fact holds, 1 with each
failure listed. Run before rendering video 03 so a number on screen always has a source.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent
REPO = MEDIA.parent
FACTS = MEDIA / "data" / "loupe-facts.json"

# Values that are labels or composites rather than a figure copied out of the quote.
LABELS = {
    "imageInput", "loraTunable", "visionFrozen", "context", "failover", "ariyadasa",
    "mallory", "teacherMix", "teacherReasoning", "sparkRecall", "evalLureCap", "chainHost",
    "build1", "build2", "build2Fix", "maxSeqLen", "gate", "gateHeldOut", "scaleToZero",
    "screenPage", "serverless", "majestic",
}


def show(commit: str, path: str, cache: dict) -> str | None:
    if path not in cache:
        r = subprocess.run(["git", "show", f"{commit}:{path}"], cwd=REPO, capture_output=True, text=True)
        cache[path] = r.stdout if r.returncode == 0 else None
    return cache[path]


def check(data: dict) -> list[str]:
    cache: dict = {}
    failures = []
    for key, fact in data["facts"].items():
        if fact.get("status") not in ("measured", "planned"):
            failures.append(f"{key}: status must be measured or planned")
        text = show(data["commit"], fact["source"], cache)
        if text is None:
            failures.append(f"{key}: {fact['source']} not found at {data['commit'][:10]}")
        elif "count" in fact:
            found = len(re.findall(fact["count"], text, re.M))
            if str(found) != fact["value"]:
                failures.append(f"{key}: {found} lines match in {fact['source']}, not {fact['value']}")
            continue
        elif fact["quote"] not in text:
            failures.append(f"{key}: quote not in {fact['source']}: {fact['quote']!r}")
        if key not in LABELS and fact["value"] not in fact["quote"]:
            failures.append(f"{key}: value {fact['value']!r} is not in its quote")
    return failures


def main() -> int:
    data = json.loads(FACTS.read_text())
    failures = check(data)
    for f in failures:
        print(f"check-facts: {f}", file=sys.stderr)
    if failures:
        return 1
    print(f"check-facts: {len(data['facts'])} facts hold at {data['commit'][:10]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
