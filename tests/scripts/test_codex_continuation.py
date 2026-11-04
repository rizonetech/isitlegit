"""Continuation state transitions and native transport, with no model calls."""
import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import uuid

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import codex_continuation as cc
from codex_rpc import Client, RpcError
sys.path.remove(str(SCRIPTS))


class Native:
    def __init__(self, root):
        self.root = root
        self.calls = []
        self.queue = []
        self.status = "idle"
        self.trust = "trusted"
        self.on_add = lambda: None
        self.on_start = lambda: None
        self.fail_add = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def call(self, method, params):
        self.calls.append((method, params))
        if method == "thread/read":
            return {"thread": {"cwd": str(self.root), "status": {"type": self.status}}}
        if method == "hooks/list":
            return {"data": [{"hooks": [{"sourcePath": str(self.root / ".codex/hooks.json"),
                      "enabled": True, "trustStatus": self.trust, "eventName": e}
                     for e in ["sessionStart", "userPromptSubmit", "preToolUse", "stop", "interrupt"]]}]}
        if method == "thread/queue/add":
            item = {"id": "submission", "clientUserMessageId": params["clientUserMessageId"], "input": params["input"]}
            self.queue.append(item)
            self.on_add()
            if self.fail_add:
                raise RpcError("transport broke after acceptance")
            return {"queuedSubmission": item}
        if method == "thread/queue/list":
            return {"data": list(self.queue), "nextCursor": None}
        if method == "thread/queue/delete":
            self.queue = [x for x in self.queue if x["id"] != params["queuedSubmissionId"]]
            return {}
        if method == "thread/queue/start":
            self.on_start()
            self.status = "active"
            return {"turn": {"id": "wake-turn"}}
        if method == "turn/interrupt":
            return {}
        raise AssertionError(method)


class Continuation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "repo"
        (self.root / "todo").mkdir(parents=True)
        (self.root / "todo/lanes.json").write_text('{"lanes": {}}')
        self.native = Native(self.root)
        self.now = 1000
        self.registry = cc.Registry(self.root, Path(self.tmp.name) / "handover/state",
                                    rpc=lambda: self.native, now=lambda: self.now)
        self.session = str(uuid.uuid4())
        self.outbox = self.registry.handover / "coordinator-outbox.md"
        self.outbox.write_text("WAITING: none\n")
        self.claim = self.registry.reserve("main")
        self.registry.activate("main", self.session, self.claim)
        self.registry.fingerprint = lambda state: "same"

    def event(self, event, turn="turn", **kwargs):
        return self.registry.event({"hook_event_name": event, "cwd": str(self.root),
                                    "session_id": self.session, "turn_id": turn, **kwargs})

    def idle(self):
        self.event("UserPromptSubmit", prompt="continue")
        self.outbox.write_text("WAITING: time: 1970-01-01T00:20:00+00:00\n")
        self.event("Stop")
        self.now = 1300

    def test_exclusive_reservation_and_foreign_owner(self):
        with self.assertRaises(cc.Refusal):
            self.registry.reserve("main")
        with self.assertRaises(cc.Refusal):
            self.registry.activate("main", str(uuid.uuid4()), self.claim)
        before = self.registry.read("main")
        self.registry.event({"hook_event_name": "Interrupt", "cwd": str(self.root), "session_id": str(uuid.uuid4())})
        self.assertEqual(before, self.registry.read("main"))

    def test_competing_launchers_get_one_claim(self):
        registry = cc.Registry(self.root, Path(self.tmp.name) / "competing")
        barrier = threading.Barrier(2)
        outcomes = []
        def reserve():
            barrier.wait()
            try:
                registry.reserve("main")
                outcomes.append("owner")
            except cc.Refusal:
                outcomes.append("refused")
        threads = [threading.Thread(target=reserve) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(2)
        self.assertCountEqual(outcomes, ["owner", "refused"])

    def test_timer_install_remove_verifies_own_units(self):
        home = Path(self.tmp.name) / "home"
        with mock.patch.object(cc.Path, "home", return_value=home), mock.patch.object(cc.subprocess, "run") as run:
            cc.install_timer(self.root)
            directory = home / ".config/systemd/user"
            self.assertIn("OnCalendar=*:0/5", (directory / "isitlegit-codex-heartbeat.timer").read_text())
            service = (directory / "isitlegit-codex-heartbeat.service").read_text()
            executable = Path(cc.sys.executable).resolve()
            self.assertIn(f'ExecStart="{executable}" "{self.root}/scripts/codex_continuation.py" tick\n', service)
            self.assertIn(f'ExecStopPost="{executable}" "{self.root}/scripts/codex_lane_health.py"\n', service)
            self.assertNotIn("ExecStartPost=", service)
            self.assertIn("TimeoutStopSec=90\n", service)
            self.assertEqual(service.count("ExecStart="), 1)
            self.assertEqual(service.count("ExecStopPost="), 1)
            self.assertIn(mock.call(["systemctl", "--user", "is-active", "isitlegit-codex-heartbeat.timer"], check=True), run.call_args_list)
            cc.install_timer(self.root, remove=True)
            self.assertFalse((directory / "isitlegit-codex-heartbeat.timer").exists())

    def test_missing_outbox_and_stale_outbox_do_not_wake(self):
        state = self.registry.read("main")
        state["activated_at"] = self.outbox.stat().st_mtime + 1
        self.assertFalse(self.registry.wait_ready(state))
        self.outbox.unlink()
        self.assertFalse(self.registry.wait_ready(state))

    def test_untrusted_hooks_refuse_activation(self):
        self.native.trust = "modified"
        with self.assertRaisesRegex(cc.Refusal, "trust"):
            self.registry.activate("main", self.session)

    def test_linked_worktree_accepts_identical_trusted_shared_hooks(self):
        lane = self.root.parent / "lane"
        for root in [self.root, lane]:
            (root / ".codex").mkdir(parents=True)
            (root / ".codex/hooks.json").write_text('{"hooks": {}}')
        self.registry.trusted(self.native, self.session, lane)
        (lane / ".codex/hooks.json").write_text('{"hooks": {"Stop": []}}')
        with self.assertRaises(cc.Refusal):
            self.registry.trusted(self.native, self.session, lane)

    def test_interrupt_survives_late_stop_and_session_start(self):
        self.event("UserPromptSubmit", prompt="work")
        self.event("Interrupt")
        for event in ["Stop", "SessionStart", "UserPromptSubmit"]:
            self.assertFalse(self.event(event).get("continue", True))
        self.assertEqual(self.registry.tick("main"), "paused")
        self.assertEqual(self.event("PreToolUse")["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertFalse(any(m == "thread/queue/add" for m, p in self.native.calls))

    def test_active_native_thread_never_woken(self):
        self.idle()
        self.native.status = "active"
        self.assertEqual(self.registry.tick("main"), "not idle")
        self.assertEqual(self.native.queue, [])

    def test_queued_is_not_acknowledged_and_not_repeated(self):
        self.idle()
        self.assertEqual(self.registry.tick("main"), "queued; acknowledgement pending")
        self.assertNotIn("last_ack", self.registry.read("main"))
        self.assertEqual(self.registry.tick("main"), "awaiting acknowledgement")
        self.assertEqual(len(self.native.queue), 1)
        self.event("UserPromptSubmit", turn="manual", prompt="status please")
        self.assertNotIn("last_ack", self.registry.read("main"))
        prompt = self.native.queue[0]["input"][0]["text"]
        self.event("UserPromptSubmit", turn="wake", prompt=prompt)
        self.assertEqual(self.registry.read("main")["last_ack"]["turn"], "wake")

    def test_pause_during_submission_deletes_only_own_wake(self):
        self.idle()
        self.native.queue.append({"id": "user-item", "clientUserMessageId": "user", "input": []})
        def revoke():
            state = self.registry.read("main")
            cc.atomic(self.registry.path("main", "pause"), {"session": self.session, "generation": state["generation"]})
        self.native.on_add = revoke
        self.assertEqual(self.registry.tick("main"), "paused")
        self.assertEqual([x["id"] for x in self.native.queue], ["user-item"])
        self.assertFalse(any(m == "thread/queue/start" for m, p in self.native.calls))

    def test_pause_after_queue_prevents_delivery_and_old_generation(self):
        self.idle()
        self.registry.tick("main")
        prompt = self.native.queue[0]["input"][0]["text"]
        self.registry.pause("main", self.session)
        self.assertEqual(self.native.queue, [])
        self.registry.activate("main", self.session)
        self.assertEqual(self.event("UserPromptSubmit", prompt=prompt)["decision"], "block")

    def test_pause_racing_turn_start_interrupts_only_that_wake(self):
        self.idle()
        self.native.on_start = lambda: self.registry.pause("main", self.session)
        self.assertEqual(self.registry.tick("main"), "revoked wake interrupted")
        self.assertIn(("turn/interrupt", {"threadId": self.session, "turnId": "wake-turn"}), self.native.calls)

    def test_ambiguous_acceptance_recovers_same_submission_without_duplicate(self):
        self.idle()
        self.native.fail_add = True
        self.assertEqual(self.registry.tick("main"), "submission uncertain")
        self.assertEqual(self.registry.tick("main"), "queued; acknowledgement pending")
        self.assertEqual(len(self.native.queue), 1)
        self.assertEqual(sum(m == "thread/queue/start" for m, p in self.native.calls), 1)
        self.assertNotIn("last_ack", self.registry.read("main"))
        self.now += 601
        self.assertEqual(self.registry.tick("main"), "stalled")
        self.assertEqual(self.native.queue, [])

    def test_event_revalidates_owner_after_acquiring_lock(self):
        original = self.registry.locked
        replacement_session = str(uuid.uuid4())
        @contextmanager
        def replace_before_lock(lane):
            with original(lane):
                state = self.registry.read(lane)
                state.update(session=replacement_session, turn=None, phase="unverified")
                self.registry.save(state)
                yield
        with mock.patch.object(self.registry, "locked", replace_before_lock):
            result = self.event("PreToolUse", turn="obsolete-owner")
        self.assertEqual(result["hookSpecificOutput"]["permissionDecision"], "deny")
        self.assertIsNone(self.registry.read("main")["turn"])

    def test_pending_recovery_respects_changed_missing_and_stale_wait(self):
        self.idle()
        self.native.fail_add = True
        self.assertEqual(self.registry.tick("main"), "submission uncertain")
        for mode in ["blocked", "missing", "stale"]:
            with self.subTest(mode=mode):
                self.outbox.write_text("WAITING: operator: unavailable credential\n")
                if mode == "missing":
                    self.outbox.unlink()
                elif mode == "stale":
                    self.outbox.write_text("WAITING: none\n")
                    state = self.registry.read("main")
                    state["activated_at"] = self.outbox.stat().st_mtime + 1
                    self.registry.save(state)
                self.assertEqual(self.registry.tick("main"), "not eligible")
                self.assertFalse(any(m == "thread/queue/start" for m, p in self.native.calls))
        self.assertEqual(len(self.native.queue), 1)

    def test_wait_changed_after_queue_acceptance_prevents_start(self):
        self.idle()
        self.native.on_add = lambda: self.outbox.write_text("WAITING: operator: unavailable credential\n")
        self.assertEqual(self.registry.tick("main"), "not eligible")
        self.assertFalse(any(m == "thread/queue/start" for m, p in self.native.calls))

    def test_timestamp_only_outbox_updates_are_not_progress(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "todo"], check=True)
        subprocess.run(["git", "-C", str(self.root), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
                        "commit", "-qm", "fixture"], check=True)
        state = self.registry.read("main")
        before = cc.Registry.fingerprint(self.registry, state)
        self.outbox.write_text("Status at 2026-11-04T05:00:00+02:00\nWAITING: none\n")
        self.assertEqual(cc.Registry.fingerprint(self.registry, state), before)
        (self.root / "todo/lanes.json").write_text('{"lanes": {}, "changed": true}')
        self.assertNotEqual(cc.Registry.fingerprint(self.registry, state), before)

    def test_complete_and_restart_remain_stopped(self):
        self.registry.pause("main", self.session, complete=True)
        fresh = cc.Registry(self.root, self.registry.directory, rpc=lambda: self.native)
        self.assertEqual(fresh.tick("main"), "paused")
        self.assertEqual(fresh.read("main")["phase"], "complete")

    def test_missing_unknown_blocked_waits_and_exact_stamp(self):
        state = self.registry.read("main")
        for text in ["", "WAITING: operator: access", "WAITING: unknown", "WAITING: time: broken"]:
            self.outbox.write_text(text)
            try:
                result = self.registry.wait_ready(state)
            except ValueError:
                result = False
            self.assertFalse(result)
        self.outbox.write_text("WAITING: stamp D00 T01 §3 on main")
        with mock.patch.object(cc.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="| [x] | D00 T01 §34 | done |")):
            self.assertFalse(self.registry.wait_ready(state))
        with mock.patch.object(cc.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="| [x] | D00 T01 §3 | done |")):
            self.assertTrue(self.registry.wait_ready(state))

    def test_late_stop_does_not_overwrite_new_turn(self):
        self.event("UserPromptSubmit", turn="new", prompt="work")
        self.assertEqual(self.event("Stop", turn="old"), {})
        self.assertEqual(self.registry.read("main")["phase"], "active")

    def test_unchanged_continuations_park(self):
        self.event("UserPromptSubmit", prompt="work")
        for _ in range(3):
            self.assertEqual(self.event("Stop")["decision"], "block")
        self.assertEqual(self.event("Stop"), {})
        self.assertEqual(self.registry.read("main")["phase"], "stalled")

    def test_malformed_state_refuses(self):
        self.registry.path("main").write_text('{"phase":"idle"}')
        with self.assertRaises(cc.Refusal):
            self.registry.tick("main")


class Transport(unittest.TestCase):
    def test_real_local_upgrade_masking_fragmentation_and_ping(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "rpc.sock")
            server = socket.socket(socket.AF_UNIX)
            self.addCleanup(server.close)
            server.bind(path)
            server.listen(1)
            failures = []

            def serve():
                try:
                    connection, _ = server.accept()
                    with connection:
                        connection.settimeout(3)
                        def read(n):
                            data = b""
                            while len(data) < n:
                                part = connection.recv(n - len(data))
                                if not part:
                                    raise AssertionError("client closed")
                                data += part
                            return data
                        header = b""
                        while not header.endswith(b"\r\n\r\n"):
                            header += read(1)
                        key = next(line.split(b": ", 1)[1] for line in header.split(b"\r\n") if line.startswith(b"Sec-WebSocket-Key:"))
                        accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
                        connection.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
                        first, size = read(2)
                        self.assertTrue(size & 128)
                        length = size & 127
                        if length == 126:
                            length = struct.unpack("!H", read(2))[0]
                        mask = read(4)
                        payload = bytes(value ^ mask[i % 4] for i, value in enumerate(read(length)))
                        request = json.loads(payload)
                        result = json.dumps({"id": request["id"], "result": {}}).encode()
                        connection.sendall(bytes([1, 5]) + result[:5] + b"\x89\x01x" + bytes([128, len(result)-5]) + result[5:])
                        # Drain pong and initialized; no request to a real model is made.
                        connection.recv(4096)
                        connection.recv(4096)
                except Exception as error:
                    failures.append(error)
            thread = threading.Thread(target=serve)
            thread.start()
            with Client(path):
                pass
            thread.join(4)
            self.assertFalse(thread.is_alive())
            self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
