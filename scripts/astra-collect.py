#!/usr/bin/env python3
"""Run GPT-6 Astra as the Loupe dataset collector (D03 T04 §4).

    python3 scripts/astra-collect.py             # collect: Codex with network access, rooted at <store>/raw
    python3 scripts/astra-collect.py --dry-run   # print the command and the store, change nothing

Astra follows docs/glimmer/astra-collection-brief.md, given on standard input, in `codex exec --sandbox
workspace-write` with network access, rooted at the Glimmer data store's `raw/` folder: `GLIMMER_DATA_DIR`, default
`~/isitlegit-data/glimmer`, the store scripts/glimmer/store.ts uses. A store inside this repository or any other git
work tree (the main checkout of a worktree included) is refused, so nothing Astra downloads can be one `git add` from a
public leak.

The run creates `<store>/raw` first and moves an earlier `ASTRA-REPORT.md` aside under its UTC stamp, so a stale report
never stands as this run's. It holds the brief's 4-hour limit itself: at the deadline, or when the launcher is
interrupted, Codex's whole process group gets SIGTERM and, 5 seconds later, SIGKILL. `RUN-STATUS.json` (written
temp-then-rename) says whether the run is `running`, `completed`, `failed`, `timed-out` or `interrupted`, and a progress
line every 60 seconds counts accepted, rejected and incomplete sources and the bytes collected. The exit code is
Codex's own, 124 at the deadline, or 130 when interrupted. Claude verifies everything Astra collects (D03 T04 §5);
Astra never reviews it.

Run it with the Bash tool's run_in_background option (scripts/dispatch_hook.py refuses anything else): a collection
takes hours.
"""
import argparse
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIEF = ROOT / "docs" / "glimmer" / "astra-collection-brief.md"
MODEL = "gpt-6-astra"
# The operator's Codex config defaults to `max`; research at `high` is this section's choice, changed here alone.
EFFORT = "high"
REPORT = "ASTRA-REPORT.md"
STATUS = "RUN-STATUS.json"
DEADLINE_SECONDS = 4 * 60 * 60  # the brief's stop condition, held here so it does not rest on the model
PROGRESS_SECONDS = 60
KILL_GRACE_SECONDS = 5


def store_dir(env=None) -> Path:
    """The Glimmer data store, resolved as scripts/glimmer/store.ts resolves it."""
    env = os.environ if env is None else env
    configured = env.get("GLIMMER_DATA_DIR")
    path = Path(configured) if configured else Path(env.get("HOME") or Path.home()) / "isitlegit-data" / "glimmer"
    return path.expanduser().resolve()


def inside_repository(path: Path) -> bool:
    """Whether `path` is this repository or lies in any git work tree, judged from its nearest existing folder."""
    if path == ROOT or ROOT in path.parents:
        return True
    existing = next((p for p in (path, *path.parents) if p.is_dir()), None)
    if existing is None:
        return False
    git = shutil.which("git")
    if not git:
        return True  # unprovable without git, so treated as inside: the store must be shown to be outside
    probe = subprocess.run([git, "-C", str(existing), "rev-parse", "--is-inside-work-tree"], capture_output=True,
                           text=True, check=False)
    return probe.returncode == 0 and probe.stdout.strip() == "true"


def command(codex: str, raw: Path) -> list[str]:
    return [codex, "exec", "-m", MODEL, "-c", f"model_reasoning_effort={EFFORT}", "--sandbox", "workspace-write",
            "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check", "--ephemeral",
            "--cd", str(raw), "-o", str(raw / REPORT), "-"]


def utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_status(raw: Path, status: dict) -> None:
    temporary = raw / f".{STATUS}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, raw / STATUS)


def progress(raw: Path, started: float) -> str:
    """One line on what the collection holds so far, read from the folder the brief tells Astra to fill."""
    accepted = incomplete = 0
    for source in (p for p in raw.iterdir() if p.is_dir() and not p.name.startswith(".")):
        if (source / "COLLECTED.md").is_file():
            accepted += 1
        else:
            incomplete += 1
    rejected_file = raw / "REJECTED.md"
    rejected = 0
    if rejected_file.is_file():
        rejected = sum(1 for line in rejected_file.read_text(encoding="utf-8", errors="replace").splitlines()
                       if line.strip())
    size = 0
    for folder, _, files in os.walk(raw):
        for name in files:
            try:
                size += (Path(folder) / name).stat().st_size
            except OSError:
                pass  # moved out of `.partial/` between the listing and the stat: a progress count, not a record
    minutes = int((time.monotonic() - started) // 60)
    return (f"astra-collect: {minutes} min: {accepted} accepted, {rejected} rejected, {incomplete} in progress or "
            f"incomplete, {size / 1e9:.2f} GB collected")


def stop(child: subprocess.Popen) -> None:
    """SIGTERM to Codex's whole process group, then SIGKILL after the grace period."""
    for sig, wait in ((signal.SIGTERM, KILL_GRACE_SECONDS), (signal.SIGKILL, KILL_GRACE_SECONDS)):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


class Interrupted(Exception):
    pass


def refuse(reason: str) -> int:
    print(f"astra-collect: refused: {reason}", file=sys.stderr)
    return 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run GPT-6 Astra as the Loupe dataset collector (D03 T04 §4).")
    parser.add_argument("--dry-run", action="store_true", help="print the command and the store; change nothing")
    parser.add_argument("--deadline-seconds", type=float, default=DEADLINE_SECONDS, help=argparse.SUPPRESS)
    parser.add_argument("--progress-seconds", type=float, default=PROGRESS_SECONDS, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    store = store_dir()
    raw = store / "raw"
    if inside_repository(store):
        return refuse(f"the data store {store} is inside the repository or another git work tree; "
                      "set GLIMMER_DATA_DIR outside every repository")
    codex = shutil.which("codex")
    if not codex:
        return refuse("the Codex CLI (`codex`) is not on PATH")
    if not BRIEF.is_file():
        return refuse(f"the brief {BRIEF.relative_to(ROOT)} is missing")
    run = command(codex, raw)
    if args.dry_run:
        print(f"store: {store}")
        print(f"brief: {BRIEF.relative_to(ROOT)} (standard input)")
        print(shlex.join(run))
        return 0

    try:
        raw.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return refuse(f"cannot create {raw}: {error.strerror or error}")
    if not raw.is_dir() or not os.access(raw, os.W_OK | os.X_OK):
        return refuse(f"{raw} is not a writable folder")
    report = raw / REPORT
    if report.exists():
        aside = raw / f"ASTRA-REPORT.{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.md"
        try:
            os.replace(report, aside)
        except OSError as error:
            return refuse(f"cannot move the earlier report aside: {error.strerror or error}")
        print(f"astra-collect: the earlier report is now {aside.name}")

    status = {"started": utc(), "outcome": "running", "pid": os.getpid(), "deadline_seconds": args.deadline_seconds}
    write_status(raw, status)
    print(f"astra-collect: running Astra in {raw}; its report goes to {report}", flush=True)

    def interrupted(signum, _frame):
        raise Interrupted(signal.Signals(signum).name)

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    child = None
    started = time.monotonic()
    try:
        # Its own session and process group, so the deadline or a cancel stops everything Codex started.
        child = subprocess.Popen(run, stdin=subprocess.PIPE, cwd=raw, start_new_session=True)
        child.stdin.write(BRIEF.read_bytes())
        child.stdin.close()
        while True:
            left = args.deadline_seconds - (time.monotonic() - started)
            if left <= 0:
                stop(child)
                outcome, code = "timed-out", 124
                break
            try:
                code = child.wait(timeout=min(args.progress_seconds, left))
                outcome = "completed" if code == 0 else "failed"
                break
            except subprocess.TimeoutExpired:
                print(progress(raw, started), flush=True)
    except Interrupted as signal_name:
        if child is not None:
            stop(child)
        outcome, code = "interrupted", 130
        status["signal"] = str(signal_name)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    status.update({"ended": utc(), "outcome": outcome, "exit": code, "progress": progress(raw, started)})
    write_status(raw, status)
    print(f"astra-collect: {outcome} (exit {code}); {status['progress'].split(': ', 1)[1]}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
