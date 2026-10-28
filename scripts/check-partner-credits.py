#!/usr/bin/env python3
"""Check D99 T01 §7's partner-credit records (todo/99-manual/TODO-01-day0-accounts.md) as records, not as a pattern.

Each provider (Fireworks, Baseten, Modal) has exactly one line

    Partner credit <name>: <outcome>, <YYYY-MM-DD> (<coverage>; <used|not used>: <decision>)

with an outcome from the record's list, a real calendar date, coverage and a decision of real words, and exactly one
usage decision however it is spelled: Fireworks used (Loupe, D03 T04), Baseten and Modal not used (operator,
2026-10-28). Prints the number of valid records (3 when all hold) and each refusal on stderr; exits 1 on any.
Stdlib only.
"""
from datetime import date
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECORDS = ROOT / "todo/99-manual/TODO-01-day0-accounts.md"
PROVIDERS = {"Fireworks": "used", "Baseten": "not used", "Modal": "not used"}
OUTCOMES = ("not applied", "not offered", "applied", "granted")
LINE = re.compile(r"^Partner credit (?P<name>[A-Za-z]+): (?P<rest>.*)$")
# Any line that looks like a record, however it is spaced or cased, is one: a malformed one is refused, never skipped.
CANDIDATE = re.compile(r"^\s*partner\s*credit\b", re.IGNORECASE)
# Any spelling of a usage decision: "used:", "not used :", "Not Used:".
USAGE = re.compile(r"\b(not\s+)?used\s*:", re.IGNORECASE)
# Real words: at least three letters, so "-" or "x" is not coverage or a decision.
WORDS = re.compile(r"[A-Za-z]{3,}")


def check(text):
    """The valid records and the refusals, from the file's text."""
    found, refusals = {}, []
    for number, line in enumerate(text.splitlines(), 1):
        if not CANDIDATE.match(line):
            continue
        m = LINE.match(line)
        if not m:
            refusals.append(f"line {number}: a record must read 'Partner credit <name>: <outcome>, <date> (...)'")
            continue
        name, rest = m["name"], m["rest"]
        where = f"line {number} ({name})"
        if name not in PROVIDERS:
            refusals.append(f"{where}: not a partner provider ({', '.join(PROVIDERS)})")
            continue
        if name in found:
            refusals.append(f"{where}: a second record for {name}")
            continue
        outcome = next((o for o in OUTCOMES if rest.startswith(o + ", ")), None)
        if outcome is None:
            refusals.append(f"{where}: the outcome must be one of {', '.join(OUTCOMES)}")
            continue
        rest = rest[len(outcome) + 2:]
        try:
            date.fromisoformat(rest[:10])
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", rest[:10])
        except (ValueError, AssertionError):
            refusals.append(f"{where}: {rest[:10]!r} is not a calendar date")
            continue
        body = rest[10:]
        if not (body.startswith(" (") and body.endswith(")")):
            refusals.append(f"{where}: the details must follow the date in parentheses")
            continue
        body = body[2:-1]
        usages = list(USAGE.finditer(body))
        if len(usages) != 1:
            refusals.append(f"{where}: {len(usages)} usage decisions; a record holds exactly one")
            continue
        usage = "not used" if usages[0].group(1) else "used"
        coverage, decision = body[: usages[0].start()].rstrip().rstrip(";"), body[usages[0].end():]
        if not WORDS.search(coverage) or not WORDS.search(decision):
            refusals.append(f"{where}: the coverage and the decision must say something")
            continue
        if usage != PROVIDERS[name]:
            refusals.append(f"{where}: {name} must be {PROVIDERS[name]}, not {usage}")
            continue
        found[name] = line
    for name in PROVIDERS:
        if name not in found and not any(r.endswith(f"({name})") or f"({name})" in r for r in refusals):
            refusals.append(f"no record for {name}")
    return found, refusals


def main(argv):
    path = Path(argv[1]) if len(argv) > 1 else RECORDS
    found, refusals = check(path.read_text(encoding="utf-8"))
    for refusal in refusals:
        print(f"check-partner-credits: {refusal}", file=sys.stderr)
    print(len(found))
    return 1 if refusals else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
