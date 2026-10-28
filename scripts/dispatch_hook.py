#!/usr/bin/env python3
"""Claude Code PreToolUse hook: a review or an Astra job runs through the Bash tool's background option, not detached.

A review (`scripts/review-dispatch.py ... --prompt ...`) takes minutes, and an Astra collection or judging run
(`scripts/astra-collect.py`, `scripts/astra-judge.py`, D03 T04 §4 and §9) takes hours. Started with the tool's
`run_in_background`, the session is told the moment it finishes and acts on it; started detached (`&`, `nohup`,
`disown`, `setsid`), nothing tells the session, and the finished job waits for the next heartbeat (operator,
2026-10-27). This hook refuses the detached form and a foreground form alike, naming the fix. Calls that run no review
(`--check-pin`, `--help`) and Astra calls that run nothing (`--dry-run`, `--help`) pass, and so does anything it cannot
read: a broken hook must never block the session's other work.

Wired in .claude/settings.json as a PreToolUse hook on Bash; exit 2 refuses the call and shows the message to Claude.
"""
import json
import re
import sys

# The dispatcher run as a command: after `python`/`python3`, or in command position (the start, after `;`, `&`, `|`,
# `(`, a newline, `nohup`, `setsid` or `exec`). Text that only mentions it (a heredoc, a commit message) is not a run.
REVIEW = re.compile(
    r"(?:\bpython3?\s+|(?:^|[\n;&|(]|\bnohup\b|\bsetsid\b|\bexec\b)\s*)(?:[\w.~/-]*/)?review-dispatch\.py\b"
)
# The Astra launchers, matched the same way.
ASTRA = re.compile(
    r"(?:\bpython3?\s+|(?:^|[\n;&|(]|\bnohup\b|\bsetsid\b|\bexec\b)\s*)(?:[\w.~/-]*/)?(astra-(?:collect|judge))\.py\b"
)
# A single `&` that backgrounds a command, not `&&`, `&>`, `>&` or `2>&1`.
DETACH = re.compile(r"(?<![&>])&(?![&>])|\bnohup\b|\bdisown\b|\bsetsid\b")


def verdict(payload: dict) -> str | None:
    """Why this tool call is refused, or None to let it run."""
    if payload.get("tool_name") != "Bash":
        return None
    tool_input = payload.get("tool_input") or {}
    command = tool_input.get("command")
    if not isinstance(command, str):
        return None
    if REVIEW.search(command) and "--prompt" in command:
        name, job, length = "review-dispatch", "the review", "a review takes minutes"
    else:
        astra = ASTRA.search(command)
        if not astra or re.search(r"(?:^|\s)(?:--dry-run|--help|-h)(?:\s|$)", command):
            return None
        name, job, length = astra.group(1), "the Astra run", "an Astra run takes hours"
    if DETACH.search(command):
        return (f"{name}: run {job} with the Bash tool's run_in_background option, not detached "
                "(&, nohup, disown, setsid): only the tool's option tells the session when it finishes")
    if tool_input.get("run_in_background") is not True:
        return (f"{name}: {length}; run it with the Bash tool's run_in_background option, so "
                "the session is told when it finishes")
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if not isinstance(payload, dict):
        return 0
    why = verdict(payload)
    if why:
        print(why, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
