#!/usr/bin/env python3
"""Read every lane's WAITING line and say whose blocker has cleared (D00 T01 section 33).

Read-only. Each lane ends a parking report in its outbox
(~/isitlegit-data/handover/<lane>-outbox.md) with one line:

    WAITING: stamp D07 T04 section 28 on main
    WAITING: coordinator gate for D07 T03 section 25
    WAITING: operator: enable Zero Trust for /admin
    WAITING: time: 2026-11-02T00:07:00+02:00
    WAITING: none

This script prints JSON {"notify": [...], "waiting": [...], "unknown": [...], "urgent": [...]}.
A wait clears when the waited stamp is ticked in todo/implementation-plan.md,
or the waited time has passed. A lane whose inbox already holds a
"notified: <the same wait text>" record is never notified twice for it.
Waits this script cannot judge (coordinator gate, operator) stay in waiting;
the coordinator judges those itself. It changes nothing it reads.

Urgent messages ride the same files. A coordinator message that must not
wait its turn is an inbox line `URGENT <id> <ISO time>: <text>`; the lane
answers with `ACK <id>:` in its outbox before continuing queued work. Every
urgent line with no ACK is reported under "urgent" with its age in minutes,
and "escalate" once it is 10 minutes old: the heartbeat re-steers the lane
once, then raises it to the operator. Normal inbox lines stay queued.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

URGENT = re.compile(r"URGENT\s+(\S+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?):\s*(.*)")
ESCALATE_AFTER_MINUTES = 10


def last_wait(outbox: Path) -> str | None:
    if not outbox.is_file():
        return None
    found = None
    for line in outbox.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.strip().startswith("WAITING:"):
            found = line.strip()[len("WAITING:"):].strip()
    return found


def stamped(plan_text: str, ref: str) -> bool:
    for line in plan_text.splitlines():
        if ref in line and "[x]" in line:
            return True
    return False


def unacked_urgent(handover: Path, lane: str, now: datetime) -> list[dict]:
    inbox = handover / f"{lane}-inbox.md"
    if not inbox.is_file():
        return []
    outbox = handover / f"{lane}-outbox.md"
    acked = outbox.read_text(encoding="utf-8", errors="ignore") if outbox.is_file() else ""
    found = []
    for line in inbox.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = URGENT.search(line)
        if not match or f"ACK {match.group(1)}" in acked:
            continue
        sent = parse_time(match.group(2))
        age = max(0, int((now - sent).total_seconds() // 60)) if sent else 0
        found.append(
            {
                "lane": lane,
                "id": match.group(1),
                "text": match.group(3).strip(),
                "age_minutes": age,
                "escalate": age >= ESCALATE_AFTER_MINUTES,
            }
        )
    return found


def parse_time(text: str) -> datetime | None:
    try:
        when = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--handover-dir", default=str(Path.home() / "isitlegit-data" / "handover"))
    parser.add_argument("--plan", default="todo/implementation-plan.md")
    parser.add_argument("--lanes", default="todo/lanes.json")
    parser.add_argument("--now", default=None, help="ISO time to judge time waits against (tests)")
    args = parser.parse_args(argv)

    handover = Path(args.handover_dir)
    plan_path = Path(args.plan)
    if not plan_path.is_file():
        print(f"lane_waits: no plan at {plan_path}", file=sys.stderr)
        return 2
    plan_text = plan_path.read_text(encoding="utf-8", errors="ignore")
    try:
        lanes = json.loads(Path(args.lanes).read_text(encoding="utf-8"))["lanes"]
    except (OSError, ValueError, KeyError) as error:
        print(f"lane_waits: cannot read lanes: {error}", file=sys.stderr)
        return 2
    now = parse_time(args.now) if args.now else datetime.now(timezone.utc)
    if now is None:
        print(f"lane_waits: bad --now {args.now!r}", file=sys.stderr)
        return 2

    notify, waiting, unknown = [], [], []
    for lane in sorted(lanes):
        wait = last_wait(handover / f"{lane}-outbox.md")
        if wait is None:
            unknown.append({"lane": lane, "reason": "no WAITING line in outbox"})
            continue
        if wait == "none":
            continue
        inbox = handover / f"{lane}-inbox.md"
        already = inbox.is_file() and f"notified: {wait}" in inbox.read_text(encoding="utf-8", errors="ignore")
        cleared_by = None
        if wait.startswith("stamp "):
            ref = wait[len("stamp "):].removesuffix(" on main").strip()
            if stamped(plan_text, ref):
                cleared_by = f"{ref} ticked in the plan"
        elif wait.startswith("time:"):
            when = parse_time(wait[len("time:"):])
            if when is not None and now >= when:
                cleared_by = f"time reached {wait[len('time:'):].strip()}"
        if cleared_by and not already:
            notify.append({"lane": lane, "wait": wait, "cleared_by": cleared_by})
        else:
            waiting.append({"lane": lane, "wait": wait})
    urgent_lanes = set(lanes) | {
        path.name[: -len("-inbox.md")] for path in handover.glob("*-inbox.md")
    }
    urgent = [item for lane in sorted(urgent_lanes) for item in unacked_urgent(handover, lane, now)]
    heartbeat_missing = []
    for lane in sorted(urgent_lanes):
        outbox = handover / f"{lane}-outbox.md"
        recorded = outbox.is_file() and "lane heartbeat installed:" in outbox.read_text(
            encoding="utf-8", errors="ignore"
        )
        if not recorded:
            heartbeat_missing.append(lane)
    print(
        json.dumps(
            {
                "notify": notify,
                "waiting": waiting,
                "unknown": unknown,
                "urgent": urgent,
                "heartbeat_missing": heartbeat_missing,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
