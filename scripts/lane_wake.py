#!/usr/bin/env python3
"""Which waiting lanes a push of main wakes, and what to send them (D00 T01 §27).

    python3 scripts/lane_wake.py waiters <old> <new> [--root <dir>]

`<old>` and `<new>` are the commits `main` moved between (the published SHA captured before the push, and after it).
Run by the coordinator after the push succeeds; prints JSON

    {"wake": [{"lane", "worktree", "session_id", "refs", "text"}], "skipped": [{"lane", "reason"}]}

one record per lane whose guard waits (`build/claude-campaign-guard.json`, `waiting_on`) on a section `<new>` stamps and
`<old>` did not (the `[x]` rows of `todo/implementation-plan.md` at each commit), each carrying every such section and the
message to send. A lane whose worktree is absent, whose guard is absent or unreadable, is listed in `skipped` with the
reason and the other lanes still get their records. It reads guards and git objects only: it never runs `rows`, `wait` or
`wake`, so no lane's guard changes. The send itself is the coordinator's `SendMessage` (this repository cannot call it);
a lane the coordinator cannot message is not notified, and its heartbeat resumes it as before (D00 T01 §20).
Exit 0 with the JSON; exit 2 with a diagnostic on stderr for an input that is not a commit or a missing plan.
"""
import argparse
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLAN = "todo/implementation-plan.md"
LANES = "todo/lanes.json"
STAMPED = re.compile(r"^\|\s*\[x\]\s*\|\s*(D\d+ T\d+ §\d+)\s*\|", re.M)


class WakeError(Exception):
    """An input the selection cannot be made from (exit 2)."""


def _guard_module():
    spec = importlib.util.spec_from_file_location("campaign_guard_for_wake", HERE / "campaign_guard.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stamped_at(root: Path, sha: str) -> set[str]:
    """The sections stamped (`[x]`) in the generated plan committed at `sha`."""
    kind = subprocess.run(["git", "-C", str(root), "cat-file", "-t", sha], capture_output=True, text=True, timeout=30)
    if kind.returncode != 0 or kind.stdout.strip() != "commit":
        raise WakeError(f"not a commit: {sha}")
    shown = subprocess.run(["git", "-C", str(root), "show", f"{sha}:{PLAN}"], capture_output=True, timeout=30)
    if shown.returncode != 0:
        raise WakeError(f"{PLAN} is not at {sha}")
    return set(STAMPED.findall(shown.stdout.decode("utf-8", "replace")))


def newly_stamped(waiting: list, old: set[str], new: set[str]) -> list[str]:
    """The sections a lane waits on that the push stamped: stamped at `new`, not at `old`."""
    return [ref for ref in waiting if ref in new and ref not in old]


def message(lane: str, refs: list[str], new: str, session: str) -> str:
    sections = ", ".join(refs)
    return (
        f"Lane {lane}: main moved to {new[:8]} and now stamps {sections}, which your run waits on. "
        f"Run `python3 scripts/campaign_guard.py wake --session {session}` now: it fetches main, merges it and reads "
        f"the wait. On READY continue under steps 7 and 8 of the heartbeat in .claude/skills/process-plan/SKILL.md "
        f"(your run's scope and a stopped run are respected there); on WAITING do nothing more; if it answers NO GUARD "
        f"or NOT THE OWNER your run has ended, so ignore this message. Your heartbeat resumes you anyway if this "
        f"message does not arrive."
    )


def waiters(root: Path, old: str, new: str) -> dict:
    root = Path(root)
    guard = _guard_module()
    stamped_old, stamped_new = stamped_at(root, old), stamped_at(root, new)
    try:
        lanes = json.loads((root / LANES).read_text(encoding="utf-8"))["lanes"]
    except (OSError, ValueError, KeyError) as exc:
        raise WakeError(f"{LANES} cannot be read: {exc}") from None
    wake, skipped = [], []
    for lane, config in sorted(lanes.items()):
        worktree = (root / config.get("worktree", "")).resolve()
        if not worktree.is_dir():
            skipped.append({"lane": lane, "reason": f"the worktree {config.get('worktree')} is absent"})
            continue
        try:
            doc = guard.read_guard(str(worktree))
        except guard.GuardError as exc:
            skipped.append({"lane": lane, "reason": f"the guard is unreadable: {exc}"})
            continue
        if doc is None:
            skipped.append({"lane": lane, "reason": "no guard: the lane has no run open, so there is nothing to wake"})
            continue
        waiting = doc.get("waiting_on")
        if not isinstance(waiting, list) or not waiting:
            continue
        refs = newly_stamped(waiting, stamped_old, stamped_new)
        if not refs:
            continue
        session = str(doc.get("session_id", ""))
        wake.append({"lane": lane, "worktree": str(config.get("worktree")), "session_id": session, "refs": refs,
                     "text": message(lane, refs, new, session)})
    return {"wake": wake, "skipped": skipped}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    w = sub.add_parser("waiters", help="the lanes a push of main from <old> to <new> wakes, with the message for each")
    w.add_argument("old")
    w.add_argument("new")
    w.add_argument("--root", default=str(HERE.parent), help="the checkout whose todo/lanes.json names the lanes")
    args = parser.parse_args(argv)
    try:
        result = waiters(Path(args.root), args.old, args.new)
    except WakeError as exc:
        print(f"lane_wake: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
