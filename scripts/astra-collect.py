#!/usr/bin/env python3
"""Run GPT-6 Astra as the Loupe dataset collector (D03 T04 §4).

    python3 scripts/astra-collect.py             # collect: Codex with network access, rooted at <store>/raw
    python3 scripts/astra-collect.py --dry-run   # print the command and the store, change nothing

Astra follows docs/glimmer/astra-collection-brief.md, given on standard input, in `codex exec --sandbox
workspace-write` with network access, rooted at the Glimmer data store's `raw/` folder: `GLIMMER_DATA_DIR`, default
`~/isitlegit-data/glimmer`, the store scripts/glimmer/store.ts uses. A store inside this repository or any other git
work tree (the main checkout of a worktree included) is refused, so nothing Astra downloads can be one `git add` from a
public leak.

The run creates `<store>/raw` first, refuses while another collection is running, keeps a run that died without
recording its end as `abandoned`, and moves an earlier `ASTRA-REPORT.md` aside under its UTC stamp, so a stale report
never stands as this run's. It holds the brief's 4-hour limit itself: at the deadline, or when the launcher is
interrupted, Codex's whole process group gets SIGTERM and, 5 seconds later, SIGKILL for whatever is left, including a
download Codex started and left behind when it exited. A launch, pipe or disk failure ends as `failed` with its reason.
A run that ends without Astra's report gets a partial one listing each source's state, and a zero exit with no report
is a failure. `RUN-STATUS.json` (written temp-then-rename) says whether the run is `running`, `completed`, `failed`,
`timed-out` or `interrupted`, and a progress line every 60 seconds counts accepted, rejected and incomplete sources
and the bytes collected. The exit code is Codex's own, 1 for a failure of the launch or the report, 124 at the
deadline, or 130 when interrupted. Claude verifies everything Astra collects (D03 T04 §5); Astra never reviews it.

Run it with the Bash tool's run_in_background option (scripts/dispatch_hook.py refuses anything else): a collection
takes hours.
"""
import argparse
import fcntl
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
FETCH = ROOT / "scripts" / "glimmer" / "fetch.py"
MODEL = "gpt-6-astra"
# The operator's Codex config defaults to `max`; research at `high` is this section's choice, changed here alone.
EFFORT = "high"
REPORT = "ASTRA-REPORT.md"
STATUS = "RUN-STATUS.json"
LOCK = ".astra-collect.lock"
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
    """One line on what the collection holds so far, read from the folder the brief tells Astra to fill.

    A count that cannot be read says so instead of raising: progress must never stop a failure being recorded."""
    try:
        return count_progress(raw, started)
    except OSError as error:
        return f"astra-collect: progress unavailable: {error.strerror or error}"


def count_progress(raw: Path, started: float) -> str:
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


def group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def stop(child: subprocess.Popen) -> None:
    """End Codex's whole process group: SIGTERM, then SIGKILL to whatever is left after the grace period.

    The group is watched rather than the Codex parent, so a download Codex started is killed even when Codex itself
    exits on SIGTERM and leaves it behind."""
    pgid = child.pid
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if sig == signal.SIGKILL:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                return
        end = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < end:
            child.poll()  # reap the parent, or its zombie keeps the group alive
            if not group_alive(pgid):
                return
            time.sleep(0.05)


def take_lock(raw: Path):
    """An exclusive lock on the store held for the whole run, or None when another collection holds it.

    The kernel drops the lock when the last process holding it dies. Codex inherits it (`pass_fds`), so a launcher
    killed outright still leaves the store locked while Codex runs, and a crashed run blocks nothing once it is gone."""
    handle = open(raw / LOCK, "a+")  # noqa: SIM115 (held open for the life of the run)
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return None
    return handle


def write_fallback_report(raw: Path, status: dict) -> str:
    """Astra's report when it wrote one; otherwise a partial report from what the folder holds. Returns which."""
    report = raw / REPORT
    if report.is_file() and report.stat().st_size > 0:
        return "astra"
    lines = ["# Partial collection report", "",
             f"Written by `scripts/astra-collect.py` because Astra left no report: the run was {status['outcome']}"
             + (f" ({status['reason']})" if status.get("reason") else "") + ".", "", "## Sources", ""]
    sources = sorted(p for p in raw.iterdir() if p.is_dir() and not p.name.startswith("."))
    for source in sources:
        state = "accepted (COLLECTED.md present)" if (source / "COLLECTED.md").is_file() else "incomplete"
        lines.append(f"- {source.name}: {state}")
    if not sources:
        lines.append("- none")
    rejected = raw / "REJECTED.md"
    if rejected.is_file():
        lines += ["", "## Rejected", "", rejected.read_text(encoding="utf-8", errors="replace").strip()]
    temporary = raw / f".{REPORT}.{os.getpid()}.tmp"
    temporary.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(temporary, report)
    return "fallback"


class Interrupted(Exception):
    pass


class Failed(Exception):
    pass


def refuse(reason: str) -> int:
    print(f"astra-collect: refused: {reason}", file=sys.stderr)
    return 2


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run GPT-6 Astra as the Loupe dataset collector (D03 T04 §4).")
    parser.add_argument("--dry-run", action="store_true", help="print the command and the store; change nothing")
    parser.add_argument("--brief", help="another brief in docs/glimmer/ named astra-collection-brief*.md (D03 T04 §18)")
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
    # A later sweep gives its own brief, kept beside the first so every brief Astra was given is in the repository.
    brief = (ROOT / args.brief).resolve() if args.brief else BRIEF
    if brief.parent != BRIEF.parent or not brief.name.startswith("astra-collection-brief") or brief.suffix != ".md":
        return refuse(f"the brief must be docs/glimmer/astra-collection-brief*.md, not {args.brief}")
    if not brief.is_file():
        return refuse(f"the brief {brief.relative_to(ROOT)} is missing")
    run = command(codex, raw)
    if args.dry_run:
        print(f"store: {store}")
        print(f"brief: {brief.relative_to(ROOT)} (standard input)")
        print(shlex.join(run))
        return 0

    # `raw/` is where Codex works, so it is judged itself: a symlink or a checkout there must not pass on the store's
    # word. It is judged before it is created (when it already exists) and again after.
    if raw.exists() and inside_repository(raw.resolve()):
        return refuse(f"{raw} resolves into a git work tree ({raw.resolve()}); it must lie outside every repository")
    try:
        raw.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return refuse(f"cannot create {raw}: {error.strerror or error}")
    raw = raw.resolve()
    if inside_repository(raw):
        return refuse(f"{raw} lies in a git work tree; it must lie outside every repository")
    if not raw.is_dir() or not os.access(raw, os.W_OK | os.X_OK):
        return refuse(f"{raw} is not a writable folder")
    run = command(codex, raw)

    lock = take_lock(raw)
    if lock is None:
        return refuse(f"another collection is running in {raw}")
    try:
        return collect(args, raw, run, lock, brief)
    finally:
        lock.close()


def collect(args, raw: Path, run: list[str], lock, brief: Path = BRIEF) -> int:
    """The run itself, holding the store's lock."""
    # Holding the lock, a status still `running` can only belong to a run that died before it recorded its end: it is
    # kept aside as `abandoned` so the relaunch starts clean.
    previous_status = raw / STATUS
    if previous_status.is_file():
        try:
            earlier = json.loads(previous_status.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            earlier = {"outcome": "unreadable"}
        if earlier.get("outcome") in ("running", "unreadable"):
            # The lock covers a Codex that kept its inherited descriptor; the recorded process group covers one that
            # closed it. Either way a survivor of a killed launcher is never raced.
            group = earlier.get("codex_pgid")
            if isinstance(group, int) and group_alive(group):
                return refuse(f"the previous collection's Codex (process group {group}) is still running; wait for "
                              f"it, or stop it with `kill -TERM -- -{group}`")
            earlier["outcome"] = "abandoned"
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            try:
                (raw / f"RUN-STATUS.{stamp}.json").write_text(json.dumps(earlier, indent=2) + "\n", encoding="utf-8")
                previous_status.unlink()
            except OSError as error:
                return refuse(f"cannot set the abandoned run's status aside: {error.strerror or error}")
            print(f"astra-collect: the run started {earlier.get('started', 'at an unknown time')} ended without "
                  f"recording its outcome; kept as RUN-STATUS.{stamp}.json (abandoned)")

    report = raw / REPORT
    try:
        # stat(), not exists(): from Python 3.14 exists() answers False for a report that cannot be read, which would
        # let this run overwrite it; stat() raises, and only a missing report means there is nothing to set aside.
        try:
            report.stat()
            present = True
        except FileNotFoundError:
            present = False
        if present:
            aside = raw / f"ASTRA-REPORT.{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.md"
            os.replace(report, aside)
            print(f"astra-collect: the earlier report is now {aside.name}")
    except OSError as error:
        return refuse(f"cannot move the earlier report aside: {error.strerror or error}")

    # The brief's downloader, placed where Astra starts (it writes nothing outside that folder), so every download
    # resumes and is verified by the same code (D03 T04 §16).
    try:
        placed = raw / f".fetch.py.{os.getpid()}.tmp"
        placed.write_bytes(FETCH.read_bytes())
        os.replace(placed, raw / ".fetch.py")
    except OSError as error:
        return refuse(f"cannot place the downloader: {error.strerror or error}")

    status = {"started": utc(), "outcome": "running", "pid": os.getpid(), "deadline_seconds": args.deadline_seconds}
    try:
        write_status(raw, status)
    except OSError as error:
        return refuse(f"cannot write {STATUS}: {error.strerror or error}")
    print(f"astra-collect: running Astra in {raw}; its report goes to {report}", flush=True)

    stopping = False

    def interrupted(signum, _frame):
        # A second signal while the run is already stopping must not cut the shutdown short.
        if not stopping:
            raise Interrupted(signal.Signals(signum).name)

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    child = None
    started = time.monotonic()
    try:
        try:
            # Its own session and process group, so the deadline or a cancel stops everything Codex started.
            child = subprocess.Popen(run, stdin=subprocess.PIPE, cwd=raw, start_new_session=True,
                                     pass_fds=(lock.fileno(),))
        except OSError as error:
            raise Failed(f"Codex could not start: {error.strerror or error}") from error
        status["codex_pgid"] = child.pid
        write_status(raw, status)
        try:
            child.stdin.write(brief.read_bytes())
            child.stdin.close()
        except BrokenPipeError as error:
            raise Failed("Codex closed its input before reading the brief") from error
        while True:
            left = args.deadline_seconds - (time.monotonic() - started)
            if left <= 0:
                outcome, code = "timed-out", 124
                status["reason"] = f"the {args.deadline_seconds / 3600:g}-hour limit was reached"
                break
            try:
                code = child.wait(timeout=min(args.progress_seconds, left))
                outcome = "completed" if code == 0 else "failed"
                if code != 0:
                    status["reason"] = f"Codex exited {code}"
                break
            except subprocess.TimeoutExpired:
                print(progress(raw, started), flush=True)
    except Interrupted as signal_name:
        outcome, code = "interrupted", 130
        status["signal"] = str(signal_name)
        status["reason"] = f"stopped by {signal_name}"
    except Failed as error:
        outcome, code = "failed", 1
        status["reason"] = str(error)
    except OSError as error:
        outcome, code = "failed", 1
        status["reason"] = f"{error.strerror or error}"
    finally:
        stopping = True
        try:
            if child is not None:
                stop(child)  # also clears anything Codex left running after a normal exit
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)

    if outcome == "completed":
        try:
            written = report.is_file() and report.stat().st_size > 0
            missing = "Astra exited without writing its report"
        except OSError as error:
            written, missing = False, f"Astra's report could not be read ({error.strerror or error})"
        if not written:
            outcome, code = "failed", 1
            status["reason"] = missing
    status.update({"ended": utc(), "outcome": outcome, "exit": code, "progress": progress(raw, started)})
    try:
        status["report"] = write_fallback_report(raw, status)
    except OSError as error:
        print(f"astra-collect: could not write the partial report: {error.strerror or error}", file=sys.stderr)
    try:
        write_status(raw, status)
    except OSError as error:
        print(f"astra-collect: could not record the outcome in {STATUS} ({error.strerror or error}); it still reads "
              "running, and the next run sets it aside as abandoned", file=sys.stderr)
        if code == 0:
            # A collection whose end is not on record has not completed: the next run would set it aside.
            outcome, code = "failed", 1
            status["reason"] = f"its outcome could not be recorded ({error.strerror or error})"
    reason = f" ({status['reason']})" if status.get("reason") else ""
    print(f"astra-collect: {outcome}{reason}, exit {code}; {status['progress'].split(': ', 1)[1]}", flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
