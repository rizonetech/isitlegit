#!/usr/bin/env python3
"""The campaign run guard for process-plan: the Claude Code Stop hook and its lifecycle commands.

    python scripts/campaign_guard.py stop-hook                      (the Stop hook; reads the payload on stdin)
    python scripts/campaign_guard.py acquire --session S --phase N --run-file F --cron-id J [--scope plan|phase] [--generation G] [--handover REASON]
    python scripts/campaign_guard.py end --session S --reason closeout|park|plan-done|operator-stop|escalation|stall
    python scripts/campaign_guard.py hook-error [--session S] [--ack LINE]
    python scripts/campaign_guard.py mint-generation
    python scripts/campaign_guard.py whoami --session S --generation G
    python scripts/campaign_guard.py reset-state --session S | --expect-no-guard yes
    python scripts/campaign_guard.py pending-cancel | cancel-confirmed --cron-id J
    python scripts/campaign_guard.py reconcile --session S --jobs J1,J2
    python scripts/campaign_guard.py health --session S --jobs J1,J2
    python scripts/campaign_guard.py expiry --session S [--now ISO]
    python scripts/campaign_guard.py rows --session S                (the run's lane: ready, open, next row)
    python scripts/campaign_guard.py wait --session S --on 'DNN TNN §N,...' [--unreachable 'DNN TNN §N,...']
    python scripts/campaign_guard.py wake --session S [--now ISO]    (the heartbeat's waiting step: fetch, merge, rows)

A campaign run has three parts. The guard file (`build/claude-campaign-guard.json`) names the session that owns the
run, its phase, run file, heartbeat job and run id; it is written and deleted only through this module, under an
interprocess lock. The Stop hook (`stop-hook`, wired in `.claude/settings.json`) blocks that session's end of turn
while the run is open and lets go when the run file carries this run's `## Closeout run=<id>` heading or column-0
`PARKED <UTC> run=<id>` line, when `query ready` has nothing runnable, or when the stall breaker trips after 3 blocks
with no change to the tree. The heartbeat is a `CronCreate` job inside the session (process-plan holds its prompt)
that resumes an idle run. There is no keep-alive outside the session: a session that died is resumed by the operator,
and the new session takes the guard with `acquire --handover`.

A run is pinned to its lane (`todo/lanes.json`, D00 T01 §19): a new guard records the lane `todo-graph.py query lane`
names, a re-point or handover of the same run keeps it, and every query the guard runs (the hook's ready count,
`end --reason plan-done`, `rows` for the heartbeat) runs with `TODO_LANE` set to it, so a worktree that switches branch
under a run never counts another lane's rows. A graph without `query lane` (Isotone's) records no lane, and its
queries follow the checkout as before.

A run whose lane has nothing runnable but rows that wait on another lane's rows waits instead of ending (D00 T01 §20):
`wait` records the rows waited on in the guard, the heartbeat keeps running, and each heartbeat's `wake` fetches `main`,
merges it into the lane (through the plan's merge stop, D00 T01 §22), and reads `READY` once the lane has a runnable row
in the run's scope. Every git failure is backed out to a state the next heartbeat retries.

The hook fails open on a bad payload, a missing guard or any error, and records the error for the heartbeat to report
(`hook-error`). Every command takes `--root` to act on a fixture workspace instead of this repository. Ported from
Isotone's `scripts/campaign_guard.py` and `.claude/hooks/campaign-stop.ps1` (2026-10-20), with the hook in Python so
it runs the same on Windows and WSL, and without Isotone's CI repair ledger.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import queue
import re
import stat
import subprocess
import sys
import threading
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, ".."))
END_REASONS = ("closeout", "park", "plan-done", "operator-stop", "escalation", "stall")
LOCK_WAIT = 10.0
MAX_BLOCKS_WITHOUT_PROGRESS = 3
SCOPES = ("plan", "phase")
# Claude Code stops a Stop hook at the timeout .claude/settings.json gives it (60 seconds) and treats that as a
# non-blocking error, so the hook keeps its own deadline well inside it and still has time to record a failure.
HOOK_BUDGET_SECONDS = 40.0
UTC_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
# The guard's record of a run waiting on another lane's rows (D00 T01 §20).
WAIT_KEYS = ("waiting_on", "waiting_since", "notified_at", "unreachable")
LONG_WAIT = datetime.timedelta(hours=24)


class GuardError(ValueError):
    """A refusal naming why the guard was not changed."""


def _paths(root: str) -> tuple[str, str]:
    return (os.path.join(root, "build", "claude-campaign-guard.json"),
            os.path.join(root, "build", "claude-campaign-state.json"))


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name, "")
    return int(value) if value.isdigit() else default


class _Lock:
    """An interprocess lock on the guard. Every change (acquire, re-point, handover, end, the hook's state write)
    holds it, so a read-then-replace never interleaves with another change. It is an operating-system lock on an open
    handle (`msvcrt.locking` on Windows, `flock` elsewhere): it never expires while its holder lives, the OS releases
    it when the holder dies, and the lock file itself is never deleted."""

    def __init__(self, root: str, wait: float = LOCK_WAIT):
        self.path = os.path.join(root, "build", "claude-campaign-guard.lock")
        self.wait = wait
        self.fd = None

    def _try(self) -> bool:
        if os.name == "nt":
            import msvcrt
            try:
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
                return True
            except OSError:
                return False
        import fcntl
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644)
        deadline = time.monotonic() + self.wait
        while not self._try():
            if time.monotonic() >= deadline:
                os.close(self.fd)
                self.fd = None
                raise GuardError(f"the guard is locked by another change ({self.path}); retry")
            time.sleep(0.05)
        return self

    def __exit__(self, *exc):
        if self.fd is not None:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(self.fd, 0, os.SEEK_SET)
                    msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
                self.fd = None
        return False


def _write_json(path: str, doc) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def read_guard(root: str) -> dict | None:
    guard, _ = _paths(root)
    try:
        with open(guard, encoding="utf-8-sig") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise GuardError(f"the guard file {guard} does not parse: {exc}")
    if not isinstance(doc, dict):
        raise GuardError(f"the guard file {guard} is not an object")
    return doc


def _read_state(root: str) -> dict:
    _, state_path = _paths(root)
    try:
        with open(state_path, encoding="utf-8-sig") as fh:
            doc = json.load(fh)
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


def mint_generation() -> str:
    """A fresh generation: the heartbeat prompt carries it, so a replaced job in the same session knows it is obsolete."""
    return uuid.uuid4().hex[:12]


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime(UTC_FORMAT)


def _graph(root: str, args: list[str], lane: str | None, timeout: float) -> subprocess.CompletedProcess:
    """Run this workspace's todo-graph with `args`, with `TODO_LANE` pinned to `lane` when the run has one."""
    env = dict(os.environ)
    if lane:
        env["TODO_LANE"] = lane
    return subprocess.run([sys.executable, os.path.join(root, "scripts", "todo-graph.py"), *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=root,
                          timeout=max(timeout, 1.0), env=env)


def graph_lane(root: str, timeout: float = 120.0, lane: str | None = None) -> str | None:
    """The lane `todo-graph.py query lane` names for this checkout, or None for a graph that has no such query (its
    argparse refuses the choice `lane`). Any other failure, or output that is not a lane, refuses: a guard is never
    written for a lane nobody could read."""
    try:
        proc = _graph(root, ["query", "lane"], lane, timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GuardError(f"query lane did not run: {exc}") from None
    if proc.returncode == 2 and "invalid choice: 'lane'" in proc.stderr:
        return None
    if proc.returncode != 0:
        raise GuardError(f"query lane failed: {proc.stderr.strip() or f'exit {proc.returncode}'}")
    try:
        doc = json.loads(proc.stdout)
    except ValueError:
        doc = None
    if not (isinstance(doc, dict) and isinstance(doc.get("lane"), str) and doc["lane"].strip()):
        raise GuardError(f"query lane printed no lane: {proc.stdout.strip()[:200]!r}")
    return doc["lane"]


def _continues(previous: dict, session: str, run_file: str, handover: str | None) -> bool:
    """Whether an acquire carries an existing run on (a re-point by its owner, or a handover of its run file), so the
    run keeps its lane, scope and run id."""
    return bool(previous) and (previous.get("session_id") == session
                               or bool(handover and previous.get("run_file") == run_file))


def acquire(root: str, session: str, phase: int | None, run_file: str, cron_id: str,
            handover: str | None = None, generation: str | None = None, scope: str | None = None) -> str:
    """Write the guard for `session`. Only one session can hold it: every guard change holds the lock, so two sessions
    racing to start a run cannot both win; the owner re-points its own guard; a live guard owned by another session is
    refused unless the operator hands it over, and the handover is recorded in the guard.

    `scope` is what the run covers: `plan` (process-plan chains every ready phase) or `phase` (process-phase was asked
    for one phase), so a heartbeat resumes only what was asked for. A re-point keeps the scope and the phase unless one
    is given; a new guard, or one taken from another run, needs its phase."""
    if not session or not run_file or not cron_id:
        raise GuardError("acquire needs --session, --run-file, and --cron-id")
    if os.path.isabs(run_file) or ".." in run_file.replace("\\", "/").split("/"):
        raise GuardError(f"run file {run_file!r} must be a repo-relative path inside the workspace")
    if scope is not None and scope not in SCOPES:
        raise GuardError(f"scope {scope!r} is not one of {', '.join(SCOPES)}")
    # A new run reads its lane before the lock, so no subprocess is ever held under it; a run carried on keeps its own.
    try:
        previous = read_guard(root) or {}
    except GuardError:
        previous = {}
    carried = _continues(previous, session, run_file, handover)
    lane = graph_lane(root) if not carried else None
    with _Lock(root):
        return _acquire_locked(root, session, phase, run_file, cron_id, handover, generation, scope, lane, carried)


def _acquire_locked(root: str, session: str, phase: int | None, run_file: str, cron_id: str,
                    handover: str | None, generation: str | None, scope: str | None, lane: str | None,
                    carried: bool = False) -> str:
    guard, state_path = _paths(root)
    os.makedirs(os.path.dirname(guard), exist_ok=True)
    exists = os.path.exists(guard)
    try:
        previous = read_guard(root) or {}
    except GuardError:
        previous = {}  # a torn or unreadable guard: only an operator handover may replace it (below)
    same_run = previous.get("run_file") == run_file and previous.get("session_id") == session
    continues = _continues(previous, session, run_file, handover)
    if carried and not continues:
        # The guard changed between the read before the lock and this one, so no lane was read for this new run.
        raise GuardError("the guard changed while acquire waited for the lock; run acquire again")
    if phase is None:
        if not (previous.get("session_id") == session and isinstance(previous.get("phase"), int)):
            raise GuardError("acquire needs --phase for a new guard (a re-point of your own guard keeps its phase)")
        phase = previous["phase"]
    doc = {"runner": "claude", "workspace": root.replace("\\", "/"), "phase": phase,
           "run_file": run_file, "session_id": session, "cron_id": cron_id,
           "scope": scope or (previous.get("scope") if previous.get("session_id") == session or
                              (handover and previous.get("run_file") == run_file) else None) or "plan",
           # The generation the heartbeat prompt carries, and when its job was created (the 7-day expiry counts
           # from it).
           "generation": generation or (previous.get("generation") if same_run and
                                        previous.get("cron_id") == cron_id else None) or mint_generation(),
           "job_created_at": (previous.get("job_created_at") if previous.get("cron_id") == cron_id
                              and previous.get("job_created_at") else _utc_now()),
           # A stable run identity every terminal marker must carry, so a reused run file's old markers never end
           # this run however the file is edited.
           "run_id": (previous.get("run_id") if (same_run or (handover and previous.get("run_file") == run_file))
                      and previous.get("run_id") else mint_generation())}
    # The run's lane: kept by a run carried on (a guard written before lanes keeps none), else the one read for it.
    pinned = previous.get("lane") if continues else lane
    if pinned:
        doc["lane"] = pinned
    # A wait belongs to the run (D00 T01 §20): a re-point, a new heartbeat job or a handover keeps it and its age; a new
    # run starts without one.
    if continues:
        doc.update({k: previous[k] for k in WAIT_KEYS if k in previous})
    what = "created"
    if exists:
        owner = str(previous.get("session_id", ""))
        if owner != session:
            if not handover:
                raise GuardError(f"the guard is live for session {owner or '<unreadable>'}; "
                                 f"refusing to take it without an operator handover (--handover REASON)")
            doc["handover_from"] = owner or "<unreadable guard>"
            doc["handover_reason"] = handover
        what = "handed over" if owner != session else "re-pointed"
    # Published whole through a temporary file and a rename, under the lock held since the read above, so neither a
    # reader nor a crash ever sees a torn guard and no other change lands in between.
    _write_json(guard, doc)
    if what != "re-pointed" or not same_run:
        try:
            os.unlink(state_path)  # a fresh or handed-over run starts a fresh breaker
        except FileNotFoundError:
            pass
    lane_note = f"lane {doc['lane']}, " if doc.get("lane") else ""
    return (f"acquire: guard {what} for session {session} ({lane_note}phase {phase}, scope {doc['scope']}, "
            f"{run_file}, job {cron_id}, generation {doc['generation']}, run {doc['run_id']})")


def ready_rows(root: str, timeout: float = 300.0, phase: int | None = None,
               lane: str | None = None, skip: tuple | list = ()) -> tuple[int | None, str]:
    """How many rows `query ready` offers, and the first one, or (None, "") when the query cannot be read.

    The SDK's todo-graph prints a JSON list of ready rows; a graph that prints a `N runnable now` summary (Isotone's)
    is read by that line instead. With `phase`, only that phase's rows count. The text summary does not say which
    phase a row is in, so for a phase it is unknown (None, ""): a phase run then ends on its own closeout or park
    marker, never on another phase's count, and is never pointed at another phase's row. With `lane`, the query counts
    that lane's rows whatever branch is checked out. `skip` leaves out ready rows the run cannot take (a waiting run's
    rows bound to a host this session cannot reach, recorded by `wait --unreachable`).
    """
    try:
        proc = _graph(root, ["query", "ready"], lane, timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None, ""
    if proc.returncode != 0:
        return None, ""
    out = proc.stdout.strip()
    try:
        rows = json.loads(out)
    except ValueError:
        rows = None
    if isinstance(rows, list):
        if phase is not None:  # a phase-scoped run: only that phase's rows (the JSON rows name their phase)
            rows = [r for r in rows if isinstance(r, dict) and r.get("phase") == phase]
        if skip:
            rows = [r for r in rows if not (isinstance(r, dict) and r.get("ref") in skip)]
        first = rows[0] if rows else {}
        label = f"{first.get('ref', '')}  {first.get('title', '')}".strip() if isinstance(first, dict) else ""
        return len(rows), label
    counts = re.findall(r"(\d+) runnable now", out)
    if not counts or phase is not None:
        return None, ""
    lines = [ln.strip() for ln in out.splitlines() if ln.strip() and "runnable now" not in ln]
    return int(counts[-1]), (lines[0] if lines else "")


def open_rows(root: str, timeout: float = 300.0, lane: str | None = None) -> int | None:
    """How many rows the plan (with `lane`, that lane's share of it) still has open (not stamped), from `query stats`,
    or None when it cannot be read. A plan with nothing ready can still hold blocked rows: that is a park, not a
    finished plan."""
    try:
        proc = _graph(root, ["query", "stats"], lane, timeout)
        stats = json.loads(proc.stdout) if proc.returncode == 0 else None
        return int(stats["total"]) - int(stats["verified"])
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, KeyError):
        return None


def marker_run(line: str) -> str | None:
    m = re.search(r"\brun=([0-9a-f]{6,})\b", line)
    return m.group(1) if m else None


def _run_markers_text(root: str, run_rel: str, guard: dict) -> str:
    """The run file's lines that count as this run's markers: every line when the guard has no run id, else only
    `## Closeout` and `PARKED` lines carrying `run=<this run's id>`, wherever they sit in the file."""
    try:
        with open(os.path.join(root, run_rel), encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return ""
    run_id = guard.get("run_id")
    if not run_id:
        return text
    keep = [ln for ln in text.splitlines()
            if not re.match(r"\A(## Closeout\b|PARKED\b)", ln) or marker_run(ln) == run_id]
    return "\n".join(keep)


def end(root: str, session: str, reason: str) -> str:
    """End the run on one of its end paths: check the path's marker, then delete the guard file and the state file.
    The heartbeat job lives in the session, not on disk, so the caller deletes it (`CronDelete`) and the returned line
    names it."""
    if reason not in END_REASONS:
        raise GuardError(f"reason {reason!r} is not one of {', '.join(END_REASONS)}")
    if not session:
        raise GuardError("end needs --session (the session that owns the guard)")
    # The plan query runs before the lock, so no subprocess is ever held under it, and counts the run's own lane.
    ready = still_open = None
    if reason == "plan-done":
        try:
            lane = (read_guard(root) or {}).get("lane")
        except GuardError:
            lane = None
        ready = ready_rows(root, lane=lane)[0]
        still_open = open_rows(root, lane=lane)
    with _Lock(root):
        return _end_locked(root, session, reason, ready, still_open)


def _end_locked(root: str, session: str, reason: str, ready: int | None, still_open: int | None = None) -> str:
    guard_path, state_path = _paths(root)
    guard = read_guard(root)
    if guard is None:
        raise GuardError("no guard file: the run is already over")
    if str(guard.get("session_id", "")) != session:
        raise GuardError(f"the guard belongs to session {guard.get('session_id')}, not {session}")
    run_rel = str(guard.get("run_file", ""))
    text = _run_markers_text(root, run_rel, guard)
    rid = guard.get("run_id")
    tag = f" run={rid}" if rid else ""
    if reason == "closeout" and not re.search(r"(?m)^## Closeout\b", text):
        raise GuardError(f"closeout needs a '## Closeout{tag}' heading in {run_rel}")
    if reason == "park" and not re.search(r"(?m)^PARKED\b", text):
        raise GuardError(f"park needs a column-0 'PARKED <UTC>{tag} <reason>' line in {run_rel}")
    if reason == "escalation" and not re.search(r"(?m)^PARKED\b.*\bescalation:", text):
        raise GuardError(f"escalation needs a column-0 'PARKED <UTC>{tag} escalation: <cause>' line in {run_rel}")
    if reason == "plan-done" and ready != 0:
        raise GuardError(f"plan-done needs nothing runnable; query ready reads {ready}")
    if reason == "plan-done" and still_open != 0:
        raise GuardError(f"plan-done needs every row stamped; {still_open} still open, so end with a park")
    if reason == "stall":
        try:
            trips = int(_read_state(root).get("trips", 0))
        except (TypeError, ValueError):
            trips = 0
        if trips < 2:
            raise GuardError(f"stall needs a state file with trips of 2 or more; it reads {trips}")
    # The guard goes first, so the run is over the moment anything is written: an end interrupted after this leaves no
    # guard (the heartbeat finds none and deletes itself, the Stop hook lets the turn end), never a live guard that a
    # heartbeat would resume beside a recorded cancellation.
    jobs = [j for j in _pending_jobs(root) if j.get("cron_id") != guard.get("cron_id")]
    try:
        os.unlink(guard_path)
    except FileNotFoundError:
        pass
    if os.path.exists(guard_path):
        raise GuardError(f"could not delete {guard_path}")
    try:
        os.unlink(state_path)
    except FileNotFoundError:
        pass
    # The job id outlives the guard until CronDelete is confirmed, so a failed delete stays recoverable, and a later
    # end never overwrites an earlier unconfirmed cancellation.
    jobs.append({"cron_id": guard.get("cron_id"), "reason": reason, "at": _utc_now()})
    _write_json(_pending_path(root), jobs)
    if os.path.exists(state_path):
        raise GuardError(f"could not delete {state_path}")
    return (f"end: {reason}: guard and state deleted; CronDelete {guard.get('cron_id')} now "
            f"(the heartbeat job), confirm it is gone with CronList, then run "
            f"cancel-confirmed --cron-id {guard.get('cron_id')}")


def _pending_path(root: str) -> str:
    return os.path.join(root, "build", "claude-campaign-pending-cancel.json")


def _pending_jobs(root: str) -> list[dict]:
    try:
        with open(_pending_path(root), encoding="utf-8") as fh:
            doc = json.load(fh)
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        raise GuardError("the pending-cancellation record is unreadable: list the jobs with CronList and delete any "
                         "run-guard heartbeat by hand")
    if isinstance(doc, dict):
        doc = [doc]
    return [j for j in doc if isinstance(j, dict)] if isinstance(doc, list) else []


def pending_cancel(root: str) -> str:
    try:
        jobs = _pending_jobs(root)
    except GuardError as exc:
        return f"pending-cancel: {exc}"
    return "\n".join(f"pending-cancel: CronDelete {j.get('cron_id')} (ended by {j.get('reason')} at {j.get('at')})"
                     for j in jobs)


def cancel_confirmed(root: str, cron_id: str) -> str:
    with _Lock(root):
        jobs = _pending_jobs(root)
        if not jobs:
            return "cancel-confirmed: nothing pending"
        if cron_id not in [str(j.get("cron_id")) for j in jobs]:
            raise GuardError(f"no pending cancellation names job {cron_id} "
                             f"(pending: {', '.join(str(j.get('cron_id')) for j in jobs)})")
        rest = [j for j in jobs if str(j.get("cron_id")) != cron_id]
        if rest:
            _write_json(_pending_path(root), rest)
            return (f"cancel-confirmed: job {cron_id} is gone; still pending: "
                    f"{', '.join(str(j.get('cron_id')) for j in rest)}")
        os.unlink(_pending_path(root))
        return f"cancel-confirmed: job {cron_id} is gone; nothing pending"


def whoami(root: str, session: str, generation: str | None = None) -> str:
    """What this heartbeat is to the run: OWNER, NOT THE OWNER, NOT THE CURRENT JOB (a replaced job in the owning
    session), NO GUARD, or MALFORMED GUARD."""
    with _Lock(root):
        try:
            guard = read_guard(root)
        except GuardError:
            return "MALFORMED GUARD"
    if guard is None:
        return "NO GUARD"
    if str(guard.get("session_id", "")) != session:
        return "NOT THE OWNER"
    if generation and str(guard.get("generation", "")) != generation:
        return "NOT THE CURRENT JOB"
    # The run id rides the answer, so the heartbeat reads which markers are this run's.
    scope = guard.get("scope") or "plan"
    lane = f" lane={guard['lane']}" if guard.get("lane") else ""
    run = f" run={guard.get('run_id')}" if guard.get("run_id") else ""
    waiting = " waiting" if guard.get("waiting_on") else ""
    return f"OWNER{run} scope={scope}{lane}{waiting}"


def rows(root: str, session: str) -> tuple[int, str]:
    """The heartbeat's view of the run: `lane=L ready=N open=M next=<row>`, every count through the guard's pinned
    lane (and, for a phase run, its phase's ready rows only), or exit 1 with `LANE MISMATCH` when this checkout now
    works another lane, or `ROWS UNKNOWN` when a query failed, so the heartbeat never selects work it could not
    count."""
    try:
        guard = read_guard(root)
    except GuardError:
        return 1, "MALFORMED GUARD"
    if guard is None:
        return 1, "NO GUARD"
    if str(guard.get("session_id", "")) != session:
        return 1, "NOT THE OWNER"
    pinned = guard.get("lane")
    if pinned:
        try:
            here = graph_lane(root)
        except GuardError as exc:  # acquire refuses on this; the heartbeat waits and asks again
            return 1, f"ROWS UNKNOWN: {exc} (lane {pinned}); the guard is unchanged"
        if here is not None and here != pinned:
            return 1, f"LANE MISMATCH guard={pinned} checkout={here}"
    phase = guard.get("phase") if guard.get("scope") == "phase" else None
    skip = guard.get("unreachable") or () if guard.get("waiting_on") else ()
    ready, next_row = ready_rows(root, phase=phase, lane=pinned, skip=skip)
    still_open = open_rows(root, lane=pinned)
    if ready is None or still_open is None:
        failed = " and ".join(q for q, n in (("query ready", ready), ("query stats", still_open)) if n is None)
        return 1, f"ROWS UNKNOWN: {failed} failed or timed out (lane {pinned or 'checkout'}); the guard is unchanged"
    if guard.get("waiting_on"):
        return _wait_state(root, guard, ready, next_row, pinned)
    where = f" phase={phase}" if phase is not None else ""
    return 0, f"lane={pinned or 'checkout'}{where} ready={ready} open={still_open} next={next_row or 'none'}"


def _classify(root: str, refs: list[str], lane: str | None, timeout: float = 120.0) -> dict | None:
    """`todo-graph.py classify` for `refs` under the run's lane: each ref's disposition (3 stamped), or None."""
    try:
        proc = _graph(root, ["classify", *refs], lane, timeout)
        out = json.loads(proc.stdout) if proc.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None
    return out if isinstance(out, dict) else None


def _wait_state(root: str, guard: dict, ready: int, next_row: str, lane: str | None) -> tuple[int, str]:
    """A waiting run's state: READY once the lane has a runnable row in the run's scope (the wait cleared under the
    lock), else WAITING on the refs still open. A stamped prerequisite is not enough: its dependent may wait on more."""
    if ready > 0:
        with _Lock(root):
            still = read_guard(root)
            if _same_run(still, guard):
                for key in WAIT_KEYS:
                    still.pop(key, None)
                _write_json(_paths(root)[0], still)
        return 0, f"READY {next_row}"
    refs = list(guard.get("waiting_on") or [])
    states = _classify(root, refs, lane)
    if states is None:
        return 1, f"ROWS UNKNOWN: classify failed for {', '.join(refs)}; the guard is unchanged"
    open_refs = [ref for ref in refs if states.get(ref) != 3]
    if not open_refs:
        return 1, (f"STUCK: every row waited on is stamped ({', '.join(refs)}), but the lane has no runnable row; "
                   f"its rows wait on something else (`todo-graph.py query blocked`): report it to the coordinator")
    return 0, f"WAITING on {', '.join(open_refs)} since {guard.get('waiting_since')}"


def wait(root: str, session: str, refs: list[str], unreachable: list[str] | tuple = ()) -> str:
    """Record that the run waits on `refs`, each another lane's open row (D00 T01 §20). Refused, with the guard
    unchanged, while the lane has a runnable row, the run has ended, or a ref is this lane's, unknown or stamped.
    `unreachable` names the lane's ready rows this session cannot take (their Needs name a host it cannot reach): they
    do not count as runnable while the run waits, and each must be one of the lane's ready rows."""
    if not refs:
        raise GuardError("wait needs --on with at least one 'DNN TNN §N'")
    guard = read_guard(root)
    if guard is None or str(guard.get("session_id", "")) != session:
        raise GuardError("wait: this session holds no live guard")
    text = _run_markers_text(root, str(guard.get("run_file", "")), guard)
    if re.search(r"(?m)^(## Closeout\b|PARKED\b)", text):
        raise GuardError("wait: the run file already ends this run (a Closeout or PARKED marker)")
    lane = guard.get("lane")
    phase = guard.get("phase") if guard.get("scope") == "phase" else None
    unreachable = list(unreachable)
    if unreachable:
        all_ready, _ = ready_rows(root, phase=phase, lane=lane)
        listed = _classify(root, unreachable, lane) or {}
        strays = [ref for ref in unreachable if listed.get(ref) != 0]
        if all_ready is None or strays:
            raise GuardError(f"wait: --unreachable names rows the lane cannot claim as ready: {', '.join(strays)}")
    ready, next_row = ready_rows(root, phase=phase, lane=lane, skip=unreachable)
    if ready is None:
        raise GuardError("wait: query ready failed, so whether the lane has work is not known")
    if ready > 0:
        raise GuardError(f"wait: the lane has a runnable row ({next_row}); build it instead of waiting")
    for ref in refs:
        try:
            proc = _graph(root, ["resolve", ref], lane, 120.0)
            doc = json.loads(proc.stdout) if proc.stdout.strip() else {}
        except (OSError, subprocess.TimeoutExpired, ValueError):
            raise GuardError(f"wait: {ref} could not be resolved") from None
        if proc.returncode in (1, 2) or not isinstance(doc, dict) or not doc.get("ref"):
            raise GuardError(f"wait: {ref} is no section ({proc.stderr.strip() or f'exit {proc.returncode}'})")
        if proc.returncode == 3:
            raise GuardError(f"wait: {ref} is already stamped here; merge main or build the row it unblocks")
        if doc.get("lane") == doc.get("this_lane"):
            raise GuardError(f"wait: {ref} is this lane's own row ({doc.get('lane')}); build it instead of waiting")
    with _Lock(root):
        still = read_guard(root)
        if not _same_run(still, guard):
            raise GuardError("wait: the guard changed while the rows were read; run wait again")
        still["waiting_on"] = refs
        still.setdefault("waiting_since", _utc_now())
        if unreachable:
            still["unreachable"] = unreachable
        _write_json(_paths(root)[0], still)
    return f"wait: run {guard.get('run_id')} waits on {', '.join(refs)} since {still['waiting_since']}"


def _run_git(root: str, *args: str, timeout: float = 120.0) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)


def _fetch_main(root: str) -> str | None:
    """`git fetch origin main`; the failure's cause, or None."""
    try:
        done = _run_git(root, "fetch", "origin", "main")
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"fetch did not finish: {exc}"
    return None if done.returncode == 0 else f"fetch failed: {done.stderr.strip()[:300]}"


def _merging(root: str) -> bool:
    return _run_git(root, "rev-parse", "-q", "--verify", "MERGE_HEAD").returncode == 0


def _abort_merge(root: str) -> str | None:
    """`git merge --abort`, verified: None once no merge is open, else why it is still open (said, never hidden)."""
    if not _merging(root):
        return None
    try:
        done = _run_git(root, "merge", "--abort")
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"git merge --abort did not finish ({exc})"
    if _merging(root):
        return f"git merge --abort failed ({(done.stderr or done.stdout).strip()[:200] or f'exit {done.returncode}'})"
    return None


def _backed_out(root: str, cause: str) -> str:
    """The cause, and whether the merge was really backed out: a failed abort is reported as still open."""
    left = _abort_merge(root)
    if left:
        return (f"{cause}; and the merge is STILL OPEN: {left}. The next wake tries the abort again; until then the "
                f"lane holds an unfinished merge (`git merge --abort` once its cause, such as an index.lock, is gone)")
    return f"{cause}: backed out"


def _merge_main(root: str) -> str | None:
    """Merge origin/main into the lane when it holds a commit the lane lacks: `git merge --no-edit`, and when the
    plan's merge stop (D00 T01 §22) halts it with nothing unmerged, `git commit --no-edit` through the hooks. Any
    conflict or failed conclusion is backed out with `git merge --abort`. Returns the failure's cause, or None."""
    if _run_git(root, "merge-base", "--is-ancestor", "origin/main", "HEAD").returncode == 0:
        return None
    try:
        merged = _run_git(root, "merge", "--no-edit", "origin/main", timeout=600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return _backed_out(root, f"the merge did not finish ({exc})")
    if merged.returncode == 0:
        return None
    if not _merging(root):
        return f"merge refused: {(merged.stderr or merged.stdout).strip()[:300]}"
    unmerged = _run_git(root, "diff", "--name-only", "--diff-filter=U").stdout.split()
    if unmerged:
        return _backed_out(root, f"merge conflict in {', '.join(unmerged[:5])}") + "; the coordinator resolves it"
    return _conclude(root)


def _conclude(root: str) -> str | None:
    """Conclude a merge the plan's merge stop halted; a failed conclusion is backed out. The cause, or None."""
    try:
        done = _run_git(root, "commit", "--no-edit", timeout=600)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return _backed_out(root, f"the merge's conclusion did not finish ({exc})")
    if done.returncode == 0:
        return None
    return _backed_out(root, f"the merge's conclusion failed ({(done.stderr or done.stdout).strip()[:300]})")


def wake(root: str, session: str, now: str | None = None) -> tuple[int, str]:
    """The heartbeat's waiting step (D00 T01 §20): for a waiting run, fetch main and merge it into the lane, then read
    the wait (`READY` or `WAITING`), add the once-a-day `long-wait` notice and the job's expiry when due. A run that
    is not waiting gets `rows`. Exit 1 with the cause when a step failed; the run then stays waiting for a retry."""
    try:
        guard = read_guard(root)
    except GuardError:
        return 1, "MALFORMED GUARD"
    if guard is None:
        return 1, "NO GUARD"
    if str(guard.get("session_id", "")) != session:
        return 1, "NOT THE OWNER"
    if not guard.get("waiting_on"):
        return rows(root, session)
    pinned = guard.get("lane")
    if pinned:
        # The lane is checked before git touches anything: a worktree now on another lane's branch is left as it is.
        try:
            here = graph_lane(root)
        except GuardError as exc:
            return 1, f"ROWS UNKNOWN: {exc} (lane {pinned}); nothing fetched or merged"
        if here is not None and here != pinned:
            return 1, f"LANE MISMATCH guard={pinned} checkout={here}; nothing fetched or merged"
    lines, failed = [], None
    if _merging(root):
        # A merge an earlier wake could not back out (an index.lock, a full disk): try again before anything else.
        left = _abort_merge(root)
        if left:
            failed = f"an earlier merge is still open and could not be backed out: {left}"
        else:
            lines.append("wake: an earlier merge left open was backed out")
    # The run file is the heartbeat's own bookkeeping, written between commits: it never blocks the merge.
    run_rel = str(guard.get("run_file", ""))
    dirty = _run_git(root, "status", "--porcelain", "--untracked-files=normal", "--", ".", f":!{run_rel}").stdout
    if failed is None and dirty.strip():
        failed = "the working tree has changes, so main was not merged: commit or stash them; the run keeps waiting"
    if failed is None:
        failed = _fetch_main(root)
    if failed is None and pinned not in (None, "main"):
        failed = _merge_main(root)
    if _merging(root):
        # A tree with a merge still open is half one side and half the other: nothing is read from it, so a stamp
        # that arrived only in the unfinished merge can never end the wait.
        lines.append(f"WAITING on {', '.join(guard.get('waiting_on') or [])} (a merge is still open)")
        lines.append(f"wake: {failed}")
        return 1, "\n".join(lines)
    code, line = rows(root, session)
    lines.append(line)
    if failed:
        lines.append(f"wake: {failed}")
    current = (datetime.datetime.strptime(now, UTC_FORMAT) if now else
               datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None))
    if line.startswith("WAITING"):
        lines.extend(_long_wait(root, guard, current))
    due, notice = expiry(root, session, now=current.strftime(UTC_FORMAT))
    if due:
        lines.append(notice)
    return (1 if failed or code else 0), "\n".join(lines)


def _long_wait(root: str, guard: dict, now: datetime.datetime) -> list[str]:
    """`long-wait` once a day while a wait lasts more than 24 hours, recorded as `notified_at` under the lock."""
    try:
        since = datetime.datetime.strptime(str(guard.get("waiting_since")), UTC_FORMAT)
    except ValueError:
        return []
    if now - since <= LONG_WAIT:
        return []
    try:
        last = datetime.datetime.strptime(str(guard.get("notified_at")), UTC_FORMAT)
    except ValueError:
        last = None
    if last is not None and now - last <= LONG_WAIT:
        return []
    with _Lock(root):
        still = read_guard(root)
        if not _same_run(still, guard):
            return []
        still["notified_at"] = now.strftime(UTC_FORMAT)
        _write_json(_paths(root)[0], still)
    hours = (now - since).total_seconds() / 3600
    return [f"long-wait: waiting {hours:.0f}h on {', '.join(guard.get('waiting_on') or [])}: tell the coordinator"]


def reset_state(root: str, session: str | None = None, expect_no_guard: bool = False) -> str:
    """Delete the breaker state under the lock, re-checking ownership or absence first: never a direct delete."""
    _, state_path = _paths(root)
    with _Lock(root):
        try:
            guard = read_guard(root)
        except GuardError:
            raise GuardError("the guard is unreadable; refusing to reset its state")
        if expect_no_guard and guard is not None:
            raise GuardError("a guard exists: a new run started; its state is not this heartbeat's to delete")
        if not expect_no_guard and (guard is None or str(guard.get("session_id", "")) != session):
            raise GuardError("reset-state needs the owning --session of a live guard")
        try:
            os.unlink(state_path)
            return "reset-state: state deleted"
        except FileNotFoundError:
            return "reset-state: no state"


def reconcile(root: str, session: str, jobs: list[str]) -> list[str]:
    """Startup reconciliation between the guard and the live heartbeat jobs: what to delete or recreate before a run
    starts."""
    with _Lock(root):
        try:
            guard = read_guard(root)
        except GuardError:
            return ["reconcile: the guard is unreadable: report it to the operator and start nothing"]
    out: list[str] = []
    try:
        out += [f"reconcile: a pending cancellation is unconfirmed: CronDelete {j.get('cron_id')}, then cancel-confirmed"
                for j in _pending_jobs(root)]
    except GuardError as exc:
        out.append(f"reconcile: {exc}")
    if guard is None:
        out += [f"reconcile: orphan job {j} has no guard: CronDelete it" for j in jobs]
        return out or ["reconcile: consistent (no guard, no job)"]
    owner, job = str(guard.get("session_id", "")), str(guard.get("cron_id", ""))
    if owner != session:
        return [f"reconcile: the guard belongs to session {owner}: start nothing and report the owner"]
    if job not in jobs:
        out.append(f"reconcile: the guard names job {job}, which is not live: CronCreate a heartbeat "
                   f"and re-point with acquire --cron-id")
    out += [f"reconcile: stale job {j} is not the guard's: CronDelete it" for j in jobs if j != job]
    return out or [f"reconcile: consistent (guard and job {job})"]


def health(root: str, session: str, jobs: list[str]) -> tuple[int, str]:
    with _Lock(root):
        try:
            guard = read_guard(root)
        except GuardError:
            return 1, "health: the guard is unreadable"
    if guard is None or str(guard.get("session_id", "")) != session:
        return 1, "health: this session holds no live guard"
    job = str(guard.get("cron_id", ""))
    if job not in jobs:
        return 1, f"health: job {job} is missing: CronCreate a heartbeat and re-point with acquire --cron-id"
    return 0, f"health: ok, job {job} is live"


def expiry(root: str, session: str, now: str | None = None, days: float = 7.0,
           margin_hours: float = 12.0) -> tuple[int, str]:
    """Whether the heartbeat job nears its 7-day expiry: exit 1 `replace due` inside the margin, else how long is left."""
    with _Lock(root):
        try:
            guard = read_guard(root)
        except GuardError:
            return 1, "expiry: the guard is unreadable"
    if guard is None or str(guard.get("session_id", "")) != session:
        return 1, "expiry: this session holds no live guard"
    try:
        created = datetime.datetime.strptime(str(guard.get("job_created_at")), UTC_FORMAT)
    except ValueError:
        return 1, "expiry: the job's creation time is unknown: replace the job"
    current = (datetime.datetime.strptime(now, UTC_FORMAT) if now else
               datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0, tzinfo=None))
    left = datetime.timedelta(days=days) - (current - created)
    if left <= datetime.timedelta(hours=margin_hours):
        return 1, (f"expiry: replace due, job {guard.get('cron_id')} created {guard.get('job_created_at')} "
                   f"expires in {max(left.total_seconds(), 0) / 3600:.1f}h: CronCreate a replacement and re-point")
    return 0, f"expiry: ok, job {guard.get('cron_id')} expires in {left.total_seconds() / 3600:.1f}h"


def _hook_errors_dir(root: str) -> str:
    return os.path.join(root, "build", "claude-campaign-hook-errors")


def hook_error(root: str, session: str | None = None, ack: str | None = None) -> str:
    """Print the error the hook recorded, if any, and clear it on its exact `--ack`. With a session, a guard owned by
    another session is refused before anything is read or cleared, so a former owner's heartbeat never consumes the
    current owner's failure record."""
    with _Lock(root):
        unreadable = False
        if session:
            try:
                guard = read_guard(root)
            except GuardError:
                guard, unreadable = None, True
            if guard is not None and str(guard.get("session_id", "")) != session:
                raise GuardError(f"the guard belongs to session {guard.get('session_id')}, not {session}")
        _, state_path = _paths(root)
        state = _read_state(root)
        err, at = state.get("hook_error"), state.get("hook_error_at")
        if not err:
            return _hook_error_log(root, ack)
        note = " (the guard file is unreadable: repair it before resuming)" if unreadable else ""
        line = f"campaign-stop hook failed at {at}: {err}{note}"
        if ack is None:
            return line
        if ack != line:
            raise GuardError("the acknowledgement does not match the recorded error; nothing cleared")
        state.pop("hook_error", None)
        state.pop("hook_error_at", None)
        _write_json(state_path, state)
        return f"hook-error: acknowledged and cleared: {line}"


def _hook_error_log(root: str, ack: str | None) -> str:
    """The oldest error the hook recorded without the lock: one file per error, so a writer never races this drain."""
    try:
        names = sorted(n for n in os.listdir(_hook_errors_dir(root)) if n.endswith(".txt"))
    except OSError:
        return ""
    if not names:
        return ""
    oldest = os.path.join(_hook_errors_dir(root), names[0])
    try:
        with open(oldest, encoding="utf-8", errors="replace") as fh:
            at, _, reason = fh.read().strip().partition(" ")
    except OSError:
        return ""
    line = f"campaign-stop hook failed at {at}: {reason} (recorded without the lock)"
    if ack is None:
        return line
    if ack != line:
        raise GuardError("the acknowledgement does not match the recorded error; nothing cleared")
    os.unlink(oldest)
    return f"hook-error: acknowledged and cleared: {line}"


# The Stop hook.

def _git(root: str, deadline: float, *args: str) -> bytes:
    proc = subprocess.run(["git", *args], cwd=root, capture_output=True, timeout=max(deadline - time.monotonic(), 1.0))
    return proc.stdout


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise GuardError("the hook ran out of its time budget before deciding")
    return left


# The guard's own files: a repository that does not ignore build/ would otherwise see every state write as progress.
OWN_FILES = re.compile(r"^build/claude-campaign-(guard|state|pending-cancel)\.json(\.[0-9]+\.tmp)?$|"
                       r"^build/claude-campaign-guard\.lock$|^build/claude-campaign-hook-errors/")


def _open_no_follow(path: str) -> int:
    """A read descriptor for path that never follows a link and never blocks on a special file. POSIX has O_NOFOLLOW
    and O_NONBLOCK; Windows has neither, so there the file is opened with CreateFileW's FILE_FLAG_OPEN_REPARSE_POINT,
    which opens a link as itself instead of following it (to a stalled network share, say)."""
    if os.name != "nt":
        return os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    import ctypes
    from ctypes import wintypes
    import msvcrt
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel32.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
                       wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    generic_read, share_all, open_existing, open_reparse_point = 0x80000000, 0x7, 3, 0x00200000
    handle = create(path, generic_read, share_all, None, open_existing, open_reparse_point, None)
    if handle in (None, ctypes.c_void_p(-1).value):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except OSError:
        kernel32.CloseHandle(wintypes.HANDLE(handle))
        raise


FILE_SECONDS = 5.0  # the longest the fingerprint waits on one untracked path before counting the rest by name


def _untracked_line(full: str, path: str, hash_it: bool, stat_it: bool, max_bytes: int) -> bytes:
    """The fingerprint line for one untracked path: its content hash, size and time, link target, kind, or name."""
    try:
        info = os.lstat(full)  # the path itself: a link is never followed
    except OSError:
        return f"{path} missing\n".encode("utf-8")
    if stat.S_ISLNK(info.st_mode):
        try:
            target = os.readlink(full)
        except OSError:
            target = "?"
        return f"{path} link {target}\n".encode("utf-8", "replace")
    if not stat.S_ISREG(info.st_mode):
        # A directory, FIFO, socket or device: its name and kind count, its content never (reading one could block or
        # never end).
        return f"{path} special {stat.S_IFMT(info.st_mode)}\n".encode("utf-8")
    if hash_it and info.st_size <= max_bytes:
        content = _read_regular(full, max_bytes, info)
        if content is not None:
            return f"{path} ".encode("utf-8") + hashlib.sha256(content).hexdigest().encode() + b"\n"
        return f"{path} {info.st_size} {info.st_mtime_ns}\n".encode("utf-8")
    if stat_it:
        return f"{path} {info.st_size} {info.st_mtime_ns}\n".encode("utf-8")
    return f"{path}\n".encode("utf-8")


def _read_regular(path: str, max_bytes: int, seen: os.stat_result | None = None) -> bytes | None:
    """At most max_bytes of path, or None when what opened is not the regular file the lstat saw (seen): swapped for a
    FIFO, a device, or a link to elsewhere. Opened without following a link and without blocking where the OS allows;
    where it does not (Windows has neither flag), the device and inode comparison catches a link followed to another
    file."""
    try:
        fd = _open_no_follow(path)
    except OSError:
        return None
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            return None
        if seen is not None and (opened.st_dev, opened.st_ino) != (seen.st_dev, seen.st_ino):
            return None
        if getattr(opened, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            return None  # a link opened as itself, never followed
        chunks, left = [], max_bytes + 1
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        return b"".join(chunks)
    except OSError:
        return None
    finally:
        os.close(fd)


def fingerprint(root: str, run_rel: str, run_text: str, deadline: float | None = None) -> str:
    """HEAD, the working-tree diff, the untracked files, and the run file without its `- bookkeeping:` lines.

    The run file leaves the diff and the untracked set and is hashed on its own, so a heartbeat or retry note in its
    Critical events never passes for progress, while any other line still counts. Untracked content is hashed for the
    first 500 files up to 4 MB each, the next 5000 count by size and write time, and any past that by name alone, so a
    huge scratch tree cannot stall the hook and no untracked path drops out.
    """
    deadline = deadline if deadline is not None else time.monotonic() + HOOK_BUDGET_SECONDS
    max_hashed = _env_int("CAMPAIGN_HASH_FILES", 500)
    max_bytes = _env_int("CAMPAIGN_HASH_BYTES", 4 * 1024 * 1024)
    max_stat = _env_int("CAMPAIGN_STAT_FILES", 5000)
    run_path = run_rel.replace("\\", "/")
    digest = hashlib.sha256()
    digest.update(_git(root, deadline, "rev-parse", "HEAD").strip() + b"\n")
    digest.update(_git(root, deadline, "diff", "HEAD", "--", ".", f":(exclude){run_path}",
                       ":(exclude)build/claude-campaign-*") + b"\n")
    listed = _git(root, deadline, "ls-files", "-z", "--others", "--exclude-standard").decode("utf-8", "replace")
    # Every file-system call on an untracked path runs on a daemon worker, waited on for at most FILE_SECONDS: no call
    # can be interrupted once it blocks (a path whose parent became a link to a stalled share, say), so a stall is
    # outwaited instead. After one, this and every later path count by name alone, with no further I/O, and the
    # blocked worker is abandoned (a daemon thread never holds the process open).
    jobs: queue.Queue = queue.Queue()
    results: queue.Queue = queue.Queue()

    def work():
        while True:
            item = jobs.get()
            if item is None:
                return
            try:
                results.put(_untracked_line(*item))
            except Exception:  # an unreadable path still counts, by name
                results.put(f"{item[1]} unreadable\n".encode("utf-8"))

    threading.Thread(target=work, name="campaign-fingerprint", daemon=True).start()
    stalled = False
    for index, path in enumerate((p for p in listed.split("\0") if p and p != run_path and not OWN_FILES.match(p)),
                                 1):
        if stalled:
            digest.update(f"{path}\n".encode("utf-8"))
            continue
        jobs.put((os.path.join(root, path), path, index <= max_hashed, index <= max_hashed + max_stat, max_bytes))
        try:
            digest.update(results.get(timeout=min(_remaining(deadline), FILE_SECONDS)))
        except queue.Empty:
            stalled = True
            digest.update(f"{path} stalled\n".encode("utf-8"))
    if stalled:
        # An incomplete observation is neither progress nor its absence: it is an error, which the Stop hook handles
        # the way it handles every error (it fails open and records the error for the heartbeat), so the breaker's
        # counters are never moved by something nobody could see.
        raise GuardError("the fingerprint could not read every untracked path in time (a path stalled)")
    jobs.put(None)
    digest.update(re.sub(r"(?m)^- bookkeeping:.*(\r?\n)?", "", run_text).encode("utf-8"))
    return digest.hexdigest()


def _same_run(still: dict | None, guard: dict) -> bool:
    return (still is not None and str(still.get("session_id", "")) == str(guard.get("session_id", ""))
            and str(still.get("run_file", "")) == str(guard.get("run_file", ""))
            and str(still.get("run_id", "")) == str(guard.get("run_id", "")))


def _alive(pid: int) -> bool:
    if os.name == "nt":
        return True  # no safe liveness probe without extra modules; the deadline bounds it instead
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def review_in_flight(root: str) -> str | None:
    """The reviewer scripts/review-dispatch.py is running now, from build/review-in-flight.json, or None: the file
    must name a live process and a deadline not yet passed (a crashed dispatcher's leftover file never holds a run)."""
    try:
        with open(os.path.join(root, "build", "review-in-flight.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
        pid, deadline = int(doc["pid"]), float(doc["deadline"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if pid <= 0 or time.time() > deadline or not _alive(pid):
        return None
    return f"{doc.get('reviewer', 'reviewer')}, dispatcher pid {pid}"


def stop_decision(root: str, session: str) -> dict | None:
    """The hook's decision for one Stop event: None allows the stop, a dict is the `block` payload to print."""
    guard = read_guard(root)
    if guard is None or not session or str(guard.get("session_id", "")) != session:
        return None  # only the campaign session; a second session or a subagent ends its turns normally
    run_rel = str(guard.get("run_file", ""))
    if not run_rel or os.path.isabs(run_rel) or ".." in run_rel.replace("\\", "/").split("/"):
        return None
    try:
        with open(os.path.join(root, run_rel), encoding="utf-8", errors="replace") as fh:
            run_text = fh.read()
    except FileNotFoundError:
        return None
    run_id = str(guard.get("run_id") or "")
    for line in run_text.splitlines():
        if re.match(r"(## Closeout\b|PARKED\b)", line) and (not run_id or marker_run(line) == run_id):
            return None
    reviewing = review_in_flight(root)
    if reviewing:
        # Waiting for a review is the work: the tree must not change under the reviewer, so the turn may end and the
        # review's notification (or the heartbeat) resumes the row. Not a block, so it never counts toward the breaker.
        print(f"campaign-stop: a review is running ({reviewing}); waiting for it, not stalled", file=sys.stderr)
        return None
    deadline = time.monotonic() + _env_int("CAMPAIGN_HOOK_BUDGET_SECONDS", int(HOOK_BUDGET_SECONDS))
    phase_only = guard.get("scope") == "phase"
    ready, next_row = ready_rows(root, timeout=_remaining(deadline) / 2,
                                 phase=guard.get("phase") if phase_only else None, lane=guard.get("lane"),
                                 skip=(guard.get("unreachable") or ()) if guard.get("waiting_on") else ())
    if ready == 0:
        return None  # nothing runnable here: blocking cannot produce work that does not exist
    print_ = fingerprint(root, run_rel, run_text, deadline)
    _, state_path = _paths(root)
    with _Lock(root, wait=_env_int("CAMPAIGN_LOCK_WAIT_MS", 5000) / 1000):
        # A handover or an end that landed while this hook worked means the state is no longer this run's.
        try:
            still = read_guard(root)
        except GuardError:
            still = None
        if not _same_run(still, guard):
            print("campaign-stop: the guard changed while this hook waited; nothing written", file=sys.stderr)
            return None
        old = _read_state(root)
        state = {"fingerprint": str(old.get("fingerprint", "")), "blocks": int(old.get("blocks", 0) or 0),
                 "trips": int(old.get("trips", 0) or 0), "stalled": False}
        # An error the heartbeat has not acknowledged yet stays until it is (`hook-error --ack`).
        state.update({k: old[k] for k in ("hook_error", "hook_error_at") if old.get(k)})
        if state["fingerprint"] != print_:
            state.update(fingerprint=print_, blocks=0, trips=0)  # the tree moved: real progress resets the breaker
        if state["blocks"] >= MAX_BLOCKS_WITHOUT_PROGRESS:
            # Repeated pushes with no change to the tree mean the session is stuck, not idle: let it stop.
            state.update(blocks=0, trips=state["trips"] + 1, stalled=True, stalled_at=_utc_now())
            _write_json(state_path, state)
            print(f"campaign-stop: stall breaker tripped ({state['trips']}) after {MAX_BLOCKS_WITHOUT_PROGRESS} "
                  f"blocks with no tree change", file=sys.stderr)
            return None
        state["blocks"] += 1
        _write_json(state_path, state)
    tag = f" run={run_id}" if run_id else ""
    onward = (f" of Phase {guard.get('phase')} only (this run covers that phase)" if phase_only
              else ", then the next phase")
    lane_note = f"lane {guard['lane']}, " if guard.get("lane") else ""
    reason = (f"Campaign run is still open ({lane_note}{run_rel}). Do not end the turn. Finish the open section's checklist, "
              f"run its review and stamp it, then the next section{onward}. A commit, a green suite, a "
              f"red CI (repair it) or a status report is not a stop.")
    if next_row:
        reason += f" Next ready row: {next_row}."
    reason += (f" Finished means a '## Closeout{tag}' heading or a column-0 'PARKED <UTC>{tag} <reason>' line in the "
               f"run file. Escalating to the operator ends the run first: write a column-0 'PARKED <UTC>{tag} "
               f"escalation: <cause>' line, run 'python scripts/campaign_guard.py end --session {session} --reason "
               f"escalation', CronDelete the heartbeat it names, then report. The breaker allows the stop after "
               f"{MAX_BLOCKS_WITHOUT_PROGRESS} pushes with no tree change (this is push {state['blocks']}).")
    return {"decision": "block", "reason": reason}


def _record_hook_error(root: str, guard: dict | None, reason: str) -> None:
    """Record a failure for the heartbeat: in the state file under the lock when this run still owns it, else in a
    file of its own that needs no lock. Best effort: the hook has already failed open."""
    at = _utc_now()
    try:
        with _Lock(root, wait=1.0):
            try:
                still = read_guard(root)
            except GuardError:
                still = None
            if guard is not None and _same_run(still, guard):
                state = _read_state(root)
                state.update(hook_error=reason, hook_error_at=at)
                _write_json(_paths(root)[1], state)
                return
    except (GuardError, OSError):
        pass
    folder = _hook_errors_dir(root)
    os.makedirs(folder, exist_ok=True)
    name = os.path.join(folder, f"{time.time_ns():020d}-{os.getpid()}.txt")
    with open(name + ".tmp", "w", encoding="utf-8") as fh:  # the drain lists only .txt, so it never reads a torn file
        fh.write(f"{at} {reason}")
    os.replace(name + ".tmp", name)


def stop_hook(stdin: str, project_dir: str | None) -> tuple[int, str]:
    """Run the hook on one Stop payload; returns (exit, stdout). Always exits 0: a failure allows the stop."""
    root, guard = None, None
    try:
        if not stdin.strip():
            return 0, ""
        event = json.loads(stdin)
        root = project_dir or str(event.get("cwd") or "")
        if not root:
            return 0, ""
        guard = read_guard(root)
        decision = stop_decision(root, str(event.get("session_id") or ""))
        return 0, json.dumps(decision) if decision else ""
    except Exception as error:  # fail open, but never silently: the heartbeat reports what is recorded here
        reason = f"{type(error).__name__}: {error}"
        print(f"campaign-stop: {reason}", file=sys.stderr)
        if root:
            try:
                _record_hook_error(root, guard, reason)
            except OSError:
                pass
        return 0, ""


def _opts(argv: list[str]) -> dict:
    out: dict = {}
    i = 0
    while i < len(argv):
        if not argv[i].startswith("--") or i + 1 >= len(argv):
            raise GuardError(f"bad argument {argv[i]!r}")
        out[argv[i][2:].replace("-", "_")] = argv[i + 1]
        i += 2
    return out


def main(argv: list[str]) -> int:
    if argv == ["stop-hook"]:
        code, out = stop_hook(sys.stdin.read(), os.environ.get("CLAUDE_PROJECT_DIR"))
        if out:
            print(out)
        return code
    if not argv:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    try:
        opts = _opts(argv[1:])
        root = opts.pop("root", REPO)
        if argv[0] == "acquire":
            phase = opts.get("phase")
            if phase is not None and not phase.isdigit():
                raise GuardError(f"--phase {phase!r} is not a phase number")
            print(acquire(root, opts.get("session", ""), int(phase) if phase is not None else None, opts.get("run_file", ""),
                          opts.get("cron_id", ""), opts.get("handover"), opts.get("generation"), opts.get("scope")))
            return 0
        if argv[0] == "end":
            print(end(root, opts.get("session", ""), opts.get("reason", "")))
            return 0
        if argv[0] == "hook-error" and set(opts) <= {"session", "ack"}:
            line = hook_error(root, opts.get("session"), opts.get("ack"))
            if line:
                print(line)
            return 0
        if argv[0] == "mint-generation" and not opts:
            print(mint_generation())
            return 0
        if argv[0] == "whoami":
            print(whoami(root, opts.get("session", ""), opts.get("generation")))
            return 0
        if argv[0] == "reset-state":
            print(reset_state(root, opts.get("session"), opts.get("expect_no_guard") == "yes"))
            return 0
        if argv[0] == "pending-cancel" and not opts:
            line = pending_cancel(root)
            if line:
                print(line)
            return 0
        if argv[0] == "cancel-confirmed":
            print(cancel_confirmed(root, opts.get("cron_id", "")))
            return 0
        if argv[0] in ("reconcile", "health"):
            jobs = [j for j in opts.get("jobs", "").split(",") if j]
            if argv[0] == "reconcile":
                print("\n".join(reconcile(root, opts.get("session", ""), jobs)))
                return 0
            code, line = health(root, opts.get("session", ""), jobs)
            print(line, file=sys.stdout if code == 0 else sys.stderr)
            return code
        if argv[0] == "wait" and {"session", "on"} <= set(opts) <= {"session", "on", "unreachable"}:
            split = lambda v: [r.strip() for r in v.split(",") if r.strip()]  # noqa: E731
            print(wait(root, opts["session"], split(opts["on"]), split(opts.get("unreachable", ""))))
            return 0
        if argv[0] == "wake" and set(opts) <= {"session", "now"} and "session" in opts:
            code, line = wake(root, opts["session"], opts.get("now"))
            print(line)
            return code
        if argv[0] == "rows" and set(opts) == {"session"}:
            code, line = rows(root, opts["session"])
            print(line)
            return code
        if argv[0] == "expiry":
            code, line = expiry(root, opts.get("session", ""), opts.get("now"))
            print(line, file=sys.stdout if code == 0 else sys.stderr)
            return code
    except (GuardError, ValueError) as exc:
        print(f"campaign_guard: {exc}", file=sys.stderr)
        return 1
    print(f"campaign_guard: unknown command {' '.join(argv)!r}; see the module docstring", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
