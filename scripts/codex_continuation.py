#!/usr/bin/env python3
"""Explicit owners, native lifecycle hooks and a host heartbeat for Codex lanes."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

from codex_rpc import Client, RpcError

ROOT = Path(__file__).resolve().parents[1]
EVENTS = {"SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Interrupt"}
STATES = {"reserved", "unverified", "active", "idle", "paused", "complete", "stalled"}
MARKER = re.compile(r"ISITLEGIT_WAKE:([0-9a-f-]{36}):([0-9]+)")
STAMP = re.compile(r"^\|\s*\[x\]\s*\|\s*(D\d{2} T\d{2} §[1-9]\d*)\s*\|", re.M)


class Refusal(RuntimeError):
    pass


def identity(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise Refusal("session or claim must be a UUID") from None


def atomic(path, value):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def timer_units(root, executable):
    def quote(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    command = quote(executable) + " " + quote(root / "scripts/codex_continuation.py") + " tick"
    # WORKAROUND: this Codex runtime exposes no native recurring-job API; systemd owns the host cadence.
    return ("[Unit]\nDescription=IsItLegit Codex host heartbeat\n[Service]\nType=oneshot\n"
            f"ExecStart={command}\nTimeoutStartSec=90\n",
            "[Unit]\nDescription=IsItLegit Codex five-minute host heartbeat\n[Timer]\n"
            "OnCalendar=*:0/5\nPersistent=true\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n")


def install_timer(root, remove=False):
    name = "isitlegit-codex-heartbeat"
    directory = Path.home() / ".config/systemd/user"
    directory.mkdir(parents=True, exist_ok=True)
    units = timer_units(root, Path(sys.executable).resolve())
    if remove:
        subprocess.run(["systemctl", "--user", "disable", "--now", name + ".timer"], check=True)
        subprocess.run(["systemctl", "--user", "stop", name + ".service"], check=True)
        for extension, expected in zip(("service", "timer"), units):
            path = directory / f"{name}.{extension}"
            if path.exists() and path.read_text() != expected:
                raise Refusal("timer unit changed; refusing to delete another definition")
            path.unlink(missing_ok=True)
    else:
        for extension, value in zip(("service", "timer"), units):
            path = directory / f"{name}.{extension}"
            if path.exists() and path.read_text() != value:
                raise Refusal("existing project timer differs; inspect before replacing")
            path.write_text(value)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "--user", "enable", "--now", name + ".timer"], check=True)
        subprocess.run(["systemctl", "--user", "is-active", name + ".timer"], check=True)
        subprocess.run(["systemctl", "--user", "start", name + ".service"], check=True)
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)


class Registry:
    def __init__(self, root=ROOT, directory=None, rpc=Client, now=time.time):
        self.root = Path(root).resolve()
        self.directory = Path(directory or os.environ.get("ISITLEGIT_CONTINUATION_DIR")
                              or Path.home() / "isitlegit-data/handover/codex-continuation")
        self.handover = self.directory.parent
        self.rpc = rpc
        self.now = now
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def lanes(self):
        lanes = json.loads((self.root / "todo/lanes.json").read_text())["lanes"]
        return {"main": self.root, **{k: (self.root / v["worktree"]).resolve() for k, v in lanes.items()}}

    def path(self, lane, suffix="json"):
        if lane not in self.lanes():
            raise Refusal("unknown lane")
        return self.directory / f"{lane}.{suffix}"

    def read(self, lane):
        path = self.path(lane)
        if not path.exists():
            return None
        state = json.loads(path.read_text())
        if (not isinstance(state, dict) or state.get("lane") != lane or state.get("phase") not in STATES
                or type(state.get("generation")) is not int or state["generation"] < 1
                or state.get("worktree") != str(self.lanes()[lane])):
            raise Refusal("malformed or stale continuation owner")
        identity(state["claim"])
        if state.get("session") is not None:
            identity(state["session"])
        return state

    @contextmanager
    def locked(self, lane):
        with self.path(lane, "lock").open("a") as stream:
            deadline = time.monotonic() + 1
            while True:
                try:
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise Refusal("continuation owner is busy") from None
                    time.sleep(0.01)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def save(self, state):
        state["updated_at"] = self.now()
        atomic(self.path(state["lane"]), state)

    def paused(self, state):
        if state["phase"] in {"paused", "complete", "stalled"}:
            return True
        path = self.path(state["lane"], "pause")
        if not path.exists():
            return False
        marker = json.loads(path.read_text())
        return (marker.get("session") == state["session"] and marker.get("generation") == state["generation"])

    def reserve(self, lane):
        with self.locked(lane):
            if self.read(lane) is not None:
                raise Refusal("lane already reserved; use its exact session or explicitly release it")
            state = {"lane": lane, "worktree": str(self.lanes()[lane]), "session": None,
                     "claim": str(uuid.uuid4()), "generation": 1, "phase": "reserved",
                     "launcher_pid": os.getpid(), "pending": None, "turn": None,
                     "observed": {}, "unchanged": 0, "fingerprint": None}
            self.save(state)
            return state["claim"]

    def trusted(self, client, session, worktree):
        result = client.call("hooks/list", {"threadId": session})
        expected = str(Path(worktree) / ".codex/hooks.json")
        hooks = [h for entry in result.get("data", []) for h in entry.get("hooks", [])
                 if h.get("sourcePath") == expected and h.get("enabled")
                 and h.get("trustStatus") in {"trusted", "managed"}]
        required = {"sessionStart", "userPromptSubmit", "preToolUse", "stop", "interrupt"}
        if not required.issubset({h.get("eventName") for h in hooks}):
            raise Refusal("project lifecycle hooks need native trust/reload; unattended activation refused")

    def activate(self, lane, session, claim=None):
        session = identity(session)
        with self.locked(lane), self.rpc() as client:
            state = self.read(lane)
            if state is None:
                raise Refusal("reserve the lane before activation")
            if state["session"] not in {None, session} or (state["session"] is None and claim != state["claim"]):
                raise Refusal("another session owns this lane")
            thread = client.call("thread/read", {"threadId": session, "includeTurns": False})["thread"]
            if Path(thread["cwd"]).resolve() != Path(state["worktree"]):
                raise Refusal("session worktree differs")
            self.trusted(client, session, state["worktree"])
            if state.get("pending"):
                self.cancel(client, state)
            state.update(session=session, generation=state["generation"] + 1, phase="unverified", activated_at=self.now(),
                         pending=None, turn=None, observed={}, unchanged=0)
            self.path(lane, "pause").unlink(missing_ok=True)
            self.save(state)
            return state

    def cancel(self, client, state):
        pending = state.get("pending")
        if not pending:
            return
        cursor = None
        for _ in range(20):
            params = {"threadId": state["session"]}
            if cursor:
                params["cursor"] = cursor
            page = client.call("thread/queue/list", params)
            for item in page["data"]:
                if item["clientUserMessageId"] == pending["id"]:
                    client.call("thread/queue/delete", {"threadId": state["session"], "queuedSubmissionId": item["id"]})
            cursor = page.get("nextCursor")
            if not cursor:
                return
        raise Refusal("queue pagination limit exceeded; pause retained")

    def pause(self, lane, session, complete=False, native_interrupt=False):
        state = self.read(lane)
        if state is None or state["session"] != identity(session):
            raise Refusal("not this lane's owner")
        # Interrupt has a short deadline: revoke before waiting for a heartbeat's lock/network.
        atomic(self.path(lane, "pause"), {"session": session, "generation": state["generation"]})
        with self.locked(lane):
            state = self.read(lane)
            if state["session"] != session:
                raise Refusal("owner changed during pause")
            state["phase"] = "complete" if complete else "paused"
            state["generation"] += 1
            if native_interrupt:
                state["observed"]["Interrupt"] = self.now()
            self.save(state)
            atomic(self.path(lane, "pause"), {"session": session, "generation": state["generation"]})
            if state.get("pending"):
                with self.rpc() as client:
                    self.cancel(client, state)
                state["pending"] = None
                self.save(state)

    def release(self, lane):
        with self.locked(lane):
            state = self.read(lane)
            if state is None:
                return
            if state["session"]:
                if not self.paused(state):
                    raise Refusal("pause or complete the owner before releasing it")
                with self.rpc() as client:
                    thread = client.call("thread/read", {"threadId": state["session"], "includeTurns": False})["thread"]
                    if thread["status"]["type"] not in {"idle", "notLoaded"}:
                        raise Refusal("owner is still active")
                    self.cancel(client, state)
            else:
                try:
                    os.kill(state["launcher_pid"], 0)
                except ProcessLookupError:
                    pass
                else:
                    raise Refusal("launcher is still alive")
            self.path(lane).unlink()
            self.path(lane, "pause").unlink(missing_ok=True)

    def wait_ready(self, state):
        name = "coordinator" if state["lane"] == "main" else state["lane"]
        outbox = self.handover / f"{name}-outbox.md"
        if not outbox.exists() or outbox.stat().st_mtime < state.get("activated_at", 0):
            return False
        waits = [line[8:].strip() for line in outbox.read_text().splitlines() if line.startswith("WAITING:")]
        if not waits:
            return False
        wait = waits[-1]
        if wait == "none":
            return True
        if wait.startswith("time:"):
            when = datetime.fromisoformat(wait[5:].strip().replace("Z", "+00:00"))
            return when.tzinfo is not None and when.timestamp() <= self.now()
        match = re.fullmatch(r"stamp (D\d{2} T\d{2} §[1-9]\d*) on main", wait)
        if match:
            # Published tracking state, never local main's unpromoted plan or prefix matching.
            result = subprocess.run(["git", "-C", str(self.root), "show", "refs/remotes/origin/main:todo/implementation-plan.md"],
                                    capture_output=True, text=True, timeout=5)
            return result.returncode == 0 and match[1] in STAMP.findall(result.stdout)
        return wait == state.get("released_wait")

    def fingerprint(self, state):
        # Status timestamps are bookkeeping, not substantive work. Include untracked source changes too.
        result = subprocess.run(["git", "-C", state["worktree"], "diff", "HEAD", "--", ".",
                                 ":(exclude)docs/phase-runs", ":(exclude)todo/implementation-plan.md"],
                                capture_output=True, timeout=5, check=True)
        head = subprocess.check_output(["git", "-C", state["worktree"], "rev-parse", "HEAD"], timeout=5)
        digest = hashlib.sha256(head + result.stdout)
        names = subprocess.check_output(["git", "-C", state["worktree"], "ls-files", "--others", "--exclude-standard", "-z"], timeout=5)
        for name in sorted(names.split(b"\0")):
            if not name or name.startswith(b"docs/phase-runs/"):
                continue
            path = Path(state["worktree"]) / os.fsdecode(name)
            digest.update(name)
            if path.is_symlink():
                digest.update(os.fsencode(os.readlink(path)))
            elif path.is_file():
                with path.open("rb") as stream:
                    for chunk in iter(lambda: stream.read(65536), b""):
                        digest.update(chunk)
        return digest.hexdigest()

    def event(self, payload):
        event = payload.get("hook_event_name")
        if event not in EVENTS or not isinstance(payload.get("cwd"), str):
            raise Refusal("invalid lifecycle payload")
        lane = next((name for name, path in self.lanes().items() if path == Path(payload["cwd"]).resolve()), None)
        if lane is None:
            return {}
        state = self.read(lane)
        if state is None or state["session"] != payload.get("session_id"):
            return {}  # Unregistered readers/reviewers do not acquire or mutate writer ownership.
        if event == "Interrupt":
            self.pause(lane, state["session"], native_interrupt=True)
            return {}
        expected_owner = (state["session"], state["worktree"], state["generation"], state["claim"])
        with self.locked(lane):
            state = self.read(lane)
            if state is None or (state["session"], state["worktree"], state["generation"], state["claim"]) != expected_owner:
                if event == "PreToolUse":
                    return {"hookSpecificOutput": {"hookEventName": event, "permissionDecision": "deny",
                                                   "permissionDecisionReason": "Unattended ownership changed before this event."}}
                return {"continue": False, "stopReason": "Unattended ownership changed."}
            if self.paused(state):
                if event == "PreToolUse":
                    return {"hookSpecificOutput": {"hookEventName": event, "permissionDecision": "deny",
                                                   "permissionDecisionReason": "This unattended owner is paused; explicit activation is required."}}
                return {"continue": False, "stopReason": "Unattended owner is paused."}
            state["observed"][event] = self.now()
            turn = payload.get("turn_id")
            if event in {"UserPromptSubmit", "PreToolUse", "Stop"} and not isinstance(turn, str):
                raise Refusal("missing turn identity")
            if event == "UserPromptSubmit":
                wake = MARKER.search(payload.get("prompt", ""))
                if wake:
                    pending = state.get("pending")
                    if not pending or pending["id"] != wake[1] or state["generation"] != int(wake[2]):
                        return {"decision": "block", "reason": "Revoked or unknown unattended wake."}
                    state["last_ack"] = {"wake": wake[1], "turn": turn, "at": self.now()}
                    state["pending"] = None
                state.update(phase="active", turn=turn)
            elif event == "PreToolUse":
                # First tool after explicit activation supplies current turn without inventing a hook receipt.
                if state["turn"] is None:
                    state["turn"] = turn
                if state["turn"] != turn:
                    return {"hookSpecificOutput": {"hookEventName": event, "permissionDecision": "deny",
                                                   "permissionDecisionReason": "Stale unattended turn."}}
                state["phase"] = "active"
            elif event == "Stop":
                if state["turn"] != turn:
                    return {}
                state["phase"] = "idle"
                if self.wait_ready(state):
                    fingerprint = self.fingerprint(state)
                    state["unchanged"] = state["unchanged"] + 1 if fingerprint == state["fingerprint"] else 0
                    state["fingerprint"] = fingerprint
                    if state["unchanged"] >= 3:
                        state.update(phase="stalled", error="three unchanged continuations")
                    else:
                        self.save(state)
                        return {"decision": "block", "reason": self.prompt(state)}
            self.save(state)
            return {}

    def prompt(self, state, wake=None):
        marker = f"ISITLEGIT_WAKE:{wake}:{state['generation']}\n" if wake else ""
        return (marker + f"Continue the authorized unattended {state['lane']} run. Read its inbox and Resume point, "
                "acknowledge urgent messages, honor current ownership and user stops, and work the next ready section. "
                "No blocking questions. Record decisions and blockers, continue independent ready work. Before honoring "
                "a conversational stop, run codex_continuation.py pause for this owner. Use complete when the authorized "
                "run is finished. Never invent review or runtime evidence.")

    def queued_wake(self, client, state, wake):
        cursor = None
        for _ in range(20):
            params = {"threadId": state["session"]}
            if cursor:
                params["cursor"] = cursor
            page = client.call("thread/queue/list", params)
            matches = [item for item in page["data"] if item["clientUserMessageId"] == wake]
            if matches:
                if len(matches) != 1:
                    raise Refusal("ambiguous duplicate wake identity")
                return matches[0]
            cursor = page.get("nextCursor")
            if not cursor:
                return None
        raise Refusal("queue pagination limit exceeded")

    def tick(self, lane):
        with self.locked(lane):
            state = self.read(lane)
            if state is None or state["session"] is None:
                return "unregistered"
            with self.rpc() as client:
                if self.paused(state):
                    self.cancel(client, state)
                    return "paused"
                pending = state.get("pending")
                if pending and self.now() - pending["at"] >= 600:
                    state.update(phase="stalled", error="wake unacknowledged for ten minutes")
                    self.save(state)
                    self.cancel(client, state)
                    return "stalled"
                if not self.wait_ready(state):
                    return "not eligible"
                if not pending and (state["phase"] != "idle" or not state["observed"].get("Stop")):
                    return "not eligible"
                thread = client.call("thread/read", {"threadId": state["session"], "includeTurns": False})["thread"]
                if thread["status"]["type"] != "idle" or Path(thread["cwd"]).resolve() != Path(state["worktree"]):
                    return "awaiting acknowledgement" if pending else "not idle"
                self.trusted(client, state["session"], state["worktree"])
                if pending:
                    # Recover accepted-but-unanswered submissions by their persisted client identity, never by re-adding.
                    queued = self.queued_wake(client, state, pending["id"])
                    if queued is None:
                        return "awaiting acknowledgement"
                    wake = pending["id"]
                else:
                    wake = str(uuid.uuid4())
                    state["pending"] = {"id": wake, "at": self.now(), "phase": "submitting", "submission": None}
                    self.save(state)
                    try:
                        if self.paused(state):
                            return "paused"
                        queued = client.call("thread/queue/add", {"threadId": state["session"], "clientUserMessageId": wake,
                                             "input": [{"type": "text", "text": self.prompt(state, wake)}]})["queuedSubmission"]
                    except (OSError, RpcError, KeyError, ValueError):
                        state["error"] = "wake outcome unknown; reconcile before retry"
                        self.save(state)
                        return "submission uncertain"
                if queued["clientUserMessageId"] != wake:
                    raise Refusal("queue correlation differs")
                state["pending"].update(submission=queued["id"], phase="queued")
                self.save(state)
                if self.paused(state):
                    self.cancel(client, state)
                    return "paused"
                # Starting a turn invokes UserPromptSubmit, which must be able to acquire this lock.
                start = (state["session"], queued["id"], wake, state["generation"], state["claim"])
        session, submission, wake, generation, claim = start
        with self.rpc() as client:
            current = self.read(lane)
            if current is None or current["session"] != session or current["claim"] != claim:
                return "owner changed; no start"
            if current["generation"] != generation or self.paused(current):
                self.cancel(client, current)
                return "paused"
            thread = client.call("thread/read", {"threadId": session, "includeTurns": False})["thread"]
            if thread["status"]["type"] != "idle":
                return "awaiting acknowledgement"
            if not self.wait_ready(current):
                return "not eligible"
            try:
                turn = client.call("thread/queue/start", {"threadId": session, "queuedSubmissionId": submission})["turn"]
                current = self.read(lane)
                if current is None or self.paused(current) or current["generation"] != generation or current["claim"] != claim:
                    # Cancel only the wake turn we just started, never a user's unrelated turn.
                    client.call("turn/interrupt", {"threadId": session, "turnId": turn["id"]})
                    return "revoked wake interrupted"
                if current.get("last_ack", {}).get("wake") == wake:
                    return "acknowledged"
                return "queued; acknowledgement pending"
            except (OSError, RpcError, KeyError, ValueError):
                return "start outcome uncertain; pending identity retained"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--state-dir", type=Path)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("hook")
    sub.add_parser("tick")
    sub.add_parser("status")
    sub.add_parser("install-timer")
    sub.add_parser("remove-timer")
    for action in ("reserve", "release", "activate", "pause", "complete", "release-wait"):
        p = sub.add_parser(action)
        p.add_argument("--lane", required=True)
        if action in {"activate", "pause", "complete"}:
            p.add_argument("--session", required=True)
        if action == "activate":
            p.add_argument("--claim")
        if action == "release-wait":
            p.add_argument("--wait", required=True)
    args = parser.parse_args(argv)
    payload = {}
    try:
        root = args.root
        if root is None:
            listed = subprocess.check_output(["git", "-C", str(ROOT), "worktree", "list", "--porcelain"], text=True, timeout=5)
            blocks = [b.splitlines() for b in listed.split("\n\n") if "branch refs/heads/main" in b.splitlines()]
            if len(blocks) != 1:
                raise Refusal("no unique main coordinator worktree")
            root = Path(next(line[9:] for line in blocks[0] if line.startswith("worktree ")))
        registry = Registry(root, args.state_dir)
        if args.action == "hook":
            payload = json.loads(sys.stdin.read(1024 * 1024))
            if not isinstance(payload, dict):
                raise Refusal("invalid hook payload")
            print(json.dumps(registry.event(payload)))
        elif args.action == "reserve":
            print(registry.reserve(args.lane))
        elif args.action == "activate":
            print(json.dumps(registry.activate(args.lane, args.session, args.claim)))
        elif args.action in {"pause", "complete"}:
            registry.pause(args.lane, args.session, args.action == "complete")
        elif args.action == "release":
            registry.release(args.lane)
        elif args.action == "release-wait":
            with registry.locked(args.lane):
                state = registry.read(args.lane)
                if not state or not args.wait.startswith("coordinator gate for "):
                    raise Refusal("only an existing coordinator-gate wait can be released")
                state["released_wait"] = args.wait
                registry.save(state)
        elif args.action in {"install-timer", "remove-timer"}:
            install_timer(registry.root, args.action == "remove-timer")
        elif args.action == "status":
            print(json.dumps({lane: registry.read(lane) for lane in registry.lanes()}, indent=2))
        else:
            results = {}
            for lane in registry.lanes():
                try:
                    results[lane] = registry.tick(lane)
                except (OSError, ValueError, KeyError, Refusal, RpcError):
                    results[lane] = "unavailable; no wake"
            atomic(registry.directory / "heartbeat.json", {"at": time.time(), "results": results})
            print(json.dumps(results))
        return 0
    except (OSError, ValueError, KeyError, Refusal, RpcError, subprocess.SubprocessError) as error:
        if args.action == "hook":
            # Native exit 2 blocks supported tool/prompt events; Interrupt ignores the output and stays stopped.
            print("IsItLegit continuation unavailable: " + type(error).__name__, file=sys.stderr)
        else:
            print(f"continuation refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
