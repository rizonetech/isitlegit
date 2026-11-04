#!/usr/bin/env python3
"""Launch one Codex coordinator or lane in its existing checkout, without changing Git state."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SETUP_FILES = (
    "AGENTS.md", ".agents/skills/codex-lane-workflow/SKILL.md", ".conclave/reviewers.toml",
    "scripts/review-dispatch.py", "scripts/lib/todo_graph.py", "scripts/codex-lanes.py",
    "todo/lanes.json", "docs/codex-lanes.md",
    "scripts/codex_continuation.py", "scripts/codex_rpc.py", ".codex/hooks.json",
)


class LaneError(Exception):
    """A lane cannot safely be launched."""


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise LaneError(f"cannot inspect Git in {root}: {args[0]} failed")
    return result.stdout.strip()


def coordinator_root(root: Path) -> Path:
    """Resolve the main checkout even when this launcher is run from a lane."""
    for block in git(root, "worktree", "list", "--porcelain").split("\n\n"):
        lines = block.splitlines()
        if "branch refs/heads/main" in lines:
            return Path(next(line.removeprefix("worktree ") for line in lines if line.startswith("worktree ")))
    raise LaneError("the clone has no checked-out main coordinator")


def lanes(root: Path) -> dict:
    try:
        data = json.loads((root / "todo/lanes.json").read_text(encoding="utf-8"))["lanes"]
        if not isinstance(data, dict) or "main" in data:
            raise ValueError("expected lane map without reserved main")
        for name, value in data.items():
            if not isinstance(value, dict) or not all(isinstance(value.get(k), str) and value[k]
                                                      for k in ("branch", "worktree")):
                raise ValueError(f"invalid lane {name}")
        return {"main": {"branch": "main", "worktree": str(root)}, **data}
    except (OSError, ValueError, KeyError) as exc:
        raise LaneError(f"cannot read todo/lanes.json: {exc}") from None


def inspect_lane(root: Path, name: str, session: str | None = None, handover: bool = False) -> dict:
    configs = lanes(root)
    if name not in configs:
        raise LaneError(f"unknown lane {name!r}; choose {', '.join(configs)}")
    config = configs[name]
    worktree = (root / config["worktree"]).resolve()
    problems = []
    status = {"lane": name, "worktree": str(worktree), "branch": config["branch"], "problems": problems, "handover": handover}
    if not worktree.is_dir():
        problems.append("worktree is absent")
        return status
    try:
        branch = git(worktree, "symbolic-ref", "--short", "HEAD")
        if branch != config["branch"]:
            problems.append(f"expected branch {config['branch']}, found {branch}")
        dirty = git(worktree, "status", "--porcelain", "--untracked-files=normal")
        status["dirty"] = bool(dirty)
        if dirty and not session and not handover:
            problems.append("working tree has changes; use --handover for an idle previous writer or --resume for its Codex session")
    except LaneError as exc:
        problems.append(str(exc))
    for relative in SETUP_FILES:
        try:
            if (root / relative).read_bytes() != (worktree / relative).read_bytes():
                problems.append(f"integrate the coordinator setup first: {relative} differs")
        except OSError:
            problems.append(f"integrate the coordinator setup first: {relative} is missing or unreadable")
    guard = worktree / "build/claude-campaign-guard.json"
    if guard.exists():
        try:
            owner = json.loads(guard.read_text(encoding="utf-8"))["session_id"]
            if not isinstance(owner, str) or not owner:
                raise ValueError("missing session owner")
            if session != owner:
                problems.append("another session owns the campaign guard; use its supported handover before launching")
        except (OSError, ValueError, KeyError, TypeError):
            problems.append("unreadable campaign guard; recover it through campaign_guard.py before launching")
    return status


def command(status: dict, session: str | None = None) -> list[str]:
    if status["problems"]:
        raise LaneError("; ".join(status["problems"]))
    name = status["lane"]
    role = ("Act as the coordinator on main. Own the fixed twelve-hour delivery deadline and decision authority "
            "in AGENTS.md. You may raise project caps, approve project spend, resolve decisions and reassign "
            "work without routine operator approval. Coordinate lanes, own shared tooling and CI, and merge "
            "at verified stamp boundaries. Respect later user corrections and stop requests."
            if name == "main" else
            f"Act as the {name} lane. Work only the sections assigned to this lane in todo/lanes.json. "
            "Follow the coordinator's recorded delivery decisions and fixed deadline in AGENTS.md; "
            "escalate cap changes and cross-lane decisions to it. Respect later user corrections and stop requests.")
    handover_files = (
        "~/isitlegit-data/handover/coordinator-outbox.md, ~/isitlegit-data/handover/system-state.md "
        "and ~/isitlegit-data/handover/operator-actions.md"
        if name == "main" else
        f"~/isitlegit-data/handover/{name}-inbox.md and ~/isitlegit-data/handover/{name}-outbox.md"
    )
    takeover = ("The operator authorized migration from the previous writer. Confirm the previous writer is idle "
                "before editing, read every dirty diff, and continue its unfinished work without discarding it. "
                if status.get("handover") else "")
    prompt = (
        f"{role} Read AGENTS.md, docs/manifesto.md, docs/codex-lanes.md and "
        ".agents/skills/codex-lane-workflow/SKILL.md first. The operator selected Codex as writer: "
        "plan self-review, implementation, one implementation self-review round, final completion review, "
        "then a verified stamp and the next ready section. Use the dispatcher with --writer codex; "
        "never invent review receipts or weaken the product safety contract. "
        f"Read {handover_files}; continue from the latest dated Resume point and acknowledge urgent messages first. "
        f"{takeover}"
        "Inspect git status and existing campaign/session ownership before writing; preserve interrupted work "
        "and do not run two writers in one checkout. Record your Codex session ID and a dated Resume point "
        "in your outbox, ending with WAITING: <blocker> or WAITING: none. "
        "Continue authorized ready work until complete or genuinely blocked. Do not claim a heartbeat is "
        "installed without observed runtime evidence. This is an unattended session: no blocking questions. "
        "Record decisions and reversals, escalate cross-lane issues to the coordinator, and continue other ready work. "
        "Honor every user stop by running scripts/codex_continuation.py pause for this exact lane and session before "
        "acknowledging it; complete the owner when the authorized run finishes. Native hooks and the explicitly "
        "named host-timer workaround have separate runtime proof; neither is implied by this launcher."
    )
    if session:
        return ["codex", "resume", "-C", status["worktree"],
                "--dangerously-bypass-approvals-and-sandbox", session, prompt]
    return ["codex", "-C", status["worktree"], "--dangerously-bypass-approvals-and-sandbox", prompt]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, help="coordinator checkout (default: discover main worktree)")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("list", help="read-only readiness of every configured lane")
    launch = sub.add_parser("launch", help="replace this process with one interactive Codex session")
    launch.add_argument("lane")
    launch.add_argument("--resume", metavar="SESSION", help="exact session UUID or name that owns this lane")
    launch.add_argument("--handover", action="store_true",
                        help="take over unfinished work from an idle previous writer; never bypass a campaign guard")
    launch.add_argument("--dry-run", action="store_true", help="print the checked argv; never start Codex")
    args = parser.parse_args(argv)
    try:
        root = args.root.resolve() if args.root else coordinator_root(ROOT)
        if args.action == "list":
            print(json.dumps([inspect_lane(root, name) for name in lanes(root)], indent=2))
            return 0
        status = inspect_lane(root, args.lane, args.resume, args.handover)
        argv = command(status, args.resume)
        if args.dry_run:
            print(json.dumps(argv, indent=2))
            return 0
        if not shutil.which("codex"):
            raise LaneError("codex is not installed on PATH")
        # Lane identity comes from the checked branch, never an inherited coordinator override.
        os.environ.pop("TODO_LANE", None)
        from codex_continuation import Registry
        registry = Registry(root)
        existing = registry.read(args.lane)
        if existing:
            if not args.resume or existing.get("session") != args.resume:
                raise LaneError("lane has an exclusive launch claim; resume its exact owner or explicitly release it")
            if registry.paused(existing):
                raise LaneError("owner is paused; explicitly activate it before unattended resume")
            claim = existing["claim"]
        else:
            claim = registry.reserve(args.lane)
        argv[-1] += (f" Launch claim: {claim}. Before writing, activate ownership with "
                     f"python3 scripts/codex_continuation.py activate --lane {args.lane} "
                     f"--session YOUR_ACTUAL_CODEX_SESSION_ID --claim {claim}. If native hook trust is absent, "
                     "record the runtime blocker and preserve this claim; do not invent activation proof.")
        # Native hook discovery uses the process cwd before applying the CLI -C override.
        os.chdir(status["worktree"])
        os.execvp(argv[0], argv)
        return 0
    except (LaneError, OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(f"codex-lanes: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
