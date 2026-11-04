#!/usr/bin/env python3
"""Validate the recorded Remotion licence evidence, not provider entitlement."""

from datetime import date
from pathlib import Path
import re
import sys


DEFAULT_RECORD = Path(__file__).resolve().parents[2] / "todo/10-media/TODO-01-channel-videos.md"
RECORD = re.compile(
    r"Remotion licence: (?:free \(up to 3 people\)|company licence, (?P<reference>[A-Z0-9][A-Z0-9-]{5,})), "
    r"(?:[^,\n]+, )?confirmed (?P<date>[0-9]{4}-[0-9]{2}-[0-9]{2})"
)


def validate(text: str) -> None:
    records = [line for line in text.splitlines() if line.lstrip().startswith("Remotion licence:")]
    if len(records) != 1:
        raise ValueError("expected exactly one Remotion licence record")
    match = RECORD.fullmatch(records[0])
    if not match:
        raise ValueError("expected a free-tier or company reference record with a confirmation date")
    reference = match["reference"]
    if reference and reference.replace("-", "") in {"PENDING", "TBD", "TODO"}:
        raise ValueError("a placeholder is not a company licence reference")
    try:
        date.fromisoformat(match["date"])
    except ValueError:
        raise ValueError("confirmation date is not a real calendar date") from None


def main(argv: list[str]) -> int:
    if len(argv) > 1:
        print("usage: check-license.py [record.md]", file=sys.stderr)
        return 2
    path = Path(argv[0]) if argv else DEFAULT_RECORD
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        print("check-license: cannot read the licence record", file=sys.stderr)
        return 1
    try:
        validate(text)
    except ValueError as error:
        print(f"check-license: {error}", file=sys.stderr)
        return 1
    print("check-license: one dated licence basis recorded (provider entitlement not verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
