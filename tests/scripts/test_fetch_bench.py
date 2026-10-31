"""scripts/glimmer/fetch_bench.py (D03 T04 §20, §23): the harness measures each tool on the same seeded payload, dropped at
half its length on its first transfer, and records medians, recovery and integrity with each tool's exact command; the
acceptance judges every gate and the paired statistics (a ratio and its 95 percent interval over alternating pairs)."""
import hashlib
import importlib.util
import json
import os
import shutil
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

def scratch(case, prefix="tmp"):
    """A temporary folder removed when the test ends, passed or not: the bench writes 40 to 100 MB a run, and folders
    left behind piled up gigabytes in /tmp, which on this host is memory."""
    folder = Path(tempfile.mkdtemp(prefix=prefix))
    case.addCleanup(shutil.rmtree, folder, True)
    return folder


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "fetch_bench.py"
spec = importlib.util.spec_from_file_location("fetch_bench", SCRIPT)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


# The connections a host sees at once are a recorded figure, not a gate: the bench counts sockets the server still
# sees as established at each accept, and on a loaded runner a client's close can reach the server after its next
# connection's handshake, so a tool holding four reads as five (CI run 41214259231). The tests assert the budget
# each tool is given, which is deterministic (`test_the_four_connection_budget_each_tool_is_given`).

class Harness(unittest.TestCase):
    def test_the_payload_is_the_same_every_run(self):
        self.assertEqual(bench.payload(100_000), bench.payload(100_000))
        self.assertEqual(len(bench.payload(100_000)), 100_000)

    def test_a_small_run_records_fetch_py_recovering_intact(self):
        out = scratch(self, prefix="bench-") / "bench.json"
        # Without aria2c the harness measures fetch.py alone and says so; with it, every tool.
        with mock.patch.object(bench, "aria2c", return_value=None), mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            # The figures are written, and the exit says the bar was not met (aria2c not measured, one run).
            self.assertEqual(bench.main(["--size-mib", "2", "--cap-mib", "8", "--pairs", "1", "--gigabyte-mib", "40",
                                         "--latency-ms", "5", "--batch-files", "3", "--batch-mib", "1.5",
                                         "--out", str(out)]), 1)
        figures = json.loads(out.read_text())
        for scenario, tools in (("drop", ("fetch.py (one stream)", "fetch.py (four segments)")),
                                ("mirror", ("fetch.py (one stream)", "fetch.py (four segments)")),
                                ("gigabyte", ("fetch.py (four segments)",))):
            for tool in tools:
                row = figures["scenarios"][scenario][tool]
                self.assertEqual((row["recovered"], row["intact"], row["cut"], row["latency"], row["runs"]), (1, 1, 1, 1, 1),
                                 (scenario, tool))
            self.assertFalse(figures["acceptance"][scenario]["met"])  # aria2c not measured: not met
        # The two-sources scenario ran on two hosts, uninterrupted, and was judged on both hosts busy at once.
        two = figures["scenarios"]["two-sources"]["fetch.py (four segments)"]
        self.assertEqual((two["recovered"], two["intact"], two["latency"], two["overlap"]), (1, 1, 1, 1))
        self.assertIn("connections", two)  # recorded, not gated: see the note above Bench tests
        self.assertNotIn("cut", two)  # nothing interrupts it
        self.assertFalse(figures["acceptance"]["two-sources"]["met"])  # aria2c not measured: not met
        # The batch scenario fetched every file of its source with fetch.py's manifest, in one process, within four
        # connections, and was judged (not met: aria2c not measured).
        batch = figures["scenarios"]["batch"]
        row = batch[bench.BATCH_OURS]
        self.assertEqual((row["recovered"], row["intact"], row["latency"], row["runs"]), (1, 1, 1, 1))
        self.assertIn("peak_connections", row)  # recorded, not gated
        self.assertEqual((batch["files"], batch["payload_bytes"]), ([int(1.5 * 2**20)] * 3, 3 * int(1.5 * 2**20)))
        self.assertFalse(figures["acceptance"]["batch"]["met"])
        self.assertIn("--manifest", json.dumps(figures["commands"]["batch"]))
        # The gigabyte scenario's first process was killed at the server's byte (one 64 KiB piece per connection of
        # slack) and a second one finished from what the first had saved: none of its requests started at byte 0.
        giga = figures["scenarios"]["gigabyte"]
        self.assertEqual(giga["fetch.py (four segments)"]["resumed"], 1)
        kill = giga["fetch.py (four segments)"]["kills"][0]
        kill_at = giga["payload_bytes"] // 8
        # The server held every connection at exactly the kill byte.
        self.assertEqual(kill["at_kill"], kill_at)
        # The second process went on from the ranges the first had saved: each request that carried data starts at or
        # past its range's saved byte, never before it (the ranges as saved at the kill, plan review of D00 T01 §14).
        self.assertIsNone(kill["failed"])
        carried = [start for start, sent in kill["second_requests"] if sent >= 65536]
        self.assertTrue(carried)
        for start in carried:
            first, end, saved_to = next(r for r in kill["kept"] if r[0] <= start < r[1])
            self.assertGreaterEqual(start, saved_to, (start, kill["kept"]))
        self.assertLess(kill["second_bytes"], giga["payload_bytes"])
        self.assertLessEqual(kill["second_bytes"], giga["payload_bytes"] - kill["at_kill"] + bench.RESUME_SLACK)
        # Every kind of request paid the measured latency: the ranges and the failing URL's refusals (fetch.py sends no
        # HEAD when its first range answers for it, D03 T04 §23).
        self.assertIn("GET range", figures["scenarios"]["drop"]["fetch.py (four segments)"]["waits"])
        self.assertIn("HEAD refused", figures["scenarios"]["mirror"]["fetch.py (four segments)"]["waits"])
        self.assertNotIn("fetch.py (one stream)", figures["scenarios"]["gigabyte"])
        self.assertEqual(figures["scenarios"]["drop"]["fetch.py (one stream)"]["median_refetched_bytes"], 0)
        self.assertIn("aria2c", figures)
        self.assertIn("not installed", figures["aria2c"])
        self.assertGreater(figures["estimate_seconds"], 0)
        self.assertIn("wall_seconds", figures)
        recorded = json.dumps(figures["commands"])
        self.assertIn("<url>", recorded)
        self.assertIn("<mirror 1>", recorded)
        self.assertIn("<certificate>", recorded)
        self.assertNotIn(str(Path.home()), recorded)
        self.assertIn("<repo>/scripts/glimmer/fetch.py", recorded)

    def test_an_interrupted_harness_leaves_no_tool_running(self):
        real_wait = subprocess.Popen.wait
        calls = {"n": 0}

        def interrupted(process, *args, **kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                calls["group"] = process.pid  # a session leader: its pid is its group's id
                raise KeyboardInterrupt
            return real_wait(process, *args, **kwargs)

        folder = scratch(self)
        with mock.patch.object(subprocess.Popen, "wait", interrupted), self.assertRaises(KeyboardInterrupt):
            bench.run_bounded(["sh", "-c", "sleep 30 & sleep 30"], folder, deadline=60)
        # The tool's own process group is gone: nothing of it is left running.
        group = calls["group"]
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        with self.assertRaises(ProcessLookupError):
            os.killpg(group, 0)

    def test_aria2c_too_is_killed_at_the_byte_and_resumes(self):
        if not bench.aria2c():
            self.skipTest("aria2c is not installed here")
        body = bench.payload(40 * 1024 * 1024)
        sha = hashlib.sha256(body).hexdigest()
        folder = scratch(self, prefix="bench-tls-")
        tls = bench.make_certificate(folder)
        # Slow enough that the kill (a quarter in, about 1.3 seconds) comes after aria2c's first save (each second).
        server = bench.Bench(body, 2 * 1024 * 1024, tls=tls)
        server.dropped = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        work = scratch(self, prefix="bench-work-")
        (work / "src").mkdir()
        command = bench.tools([f"https://127.0.0.1:{server.server_address[1]}/x"], sha, work, ca=tls[0])["aria2c (four connections)"]
        run = bench.killed_and_resumed(command, work, server, len(body) // 4, 120)
        self.assertTrue(run["killed"])
        self.assertEqual(run["at_kill"], len(body) // 4)
        self.assertEqual(run["code"], 0)
        self.assertTrue(run["resumed"])
        # aria2c's second process too asked for little more than what the first had not received.
        self.assertLessEqual(run["fetched_twice"], bench.RESUME_SLACK)
        self.assertLessEqual(run["second_bytes"], len(body) - run["at_kill"] + bench.RESUME_SLACK)

    # D00 T01 §14's plan review: each wait the kill depends on is an event, and one that never comes is a failed
    # measurement, with the first process gone and no second run.

    def held_server(self, open_connections=0):
        server = bench.Bench(b"x" * 1024, 1024)
        self.addCleanup(server.server_close)
        server.reached.set()
        server.sent = server.kill_at = 512
        server.open = open_connections
        return server

    def test_a_tool_that_never_saves_is_a_failed_measurement_with_no_second_run(self):
        work = scratch(self, prefix="bench-unsaved-")
        server = self.held_server()
        started = []
        with mock.patch.object(bench, "tool_saved", return_value=False), \
                mock.patch.object(bench, "run_bounded", side_effect=lambda *a, **k: started.append(a)):
            run = bench.killed_and_resumed(["sleep", "30"], work, server, 512, 1.0)
        self.assertEqual((run["failed"], run["saved"], run["resumed"], run["code"]),
                         ("the tool never saved its progress", False, False, None))
        self.assertEqual(started, [], "no second run")

    def test_connections_that_never_close_are_a_failed_measurement_with_no_second_run(self):
        work = scratch(self, prefix="bench-open-")
        server = self.held_server(open_connections=1)
        started = []
        with mock.patch.object(bench, "tool_saved", return_value=True), \
                mock.patch.object(bench, "run_bounded", side_effect=lambda *a, **k: started.append(a)):
            run = bench.killed_and_resumed(["sleep", "30"], work, server, 512, 1.0)
        self.assertEqual((run["failed"], run["closed"], run["resumed"]),
                         ("the first run's connections never closed", False, False))
        self.assertEqual(started, [], "no second run")

    def test_the_kill_waits_for_the_save_and_the_second_run_for_the_close(self):
        work = scratch(self, prefix="bench-late-")
        server = self.held_server(open_connections=1)
        answers = iter([False, False, True])
        order = []
        # The connections close only once the save has been seen: an event, never a pause a slow start could outrun.
        seen_save = threading.Event()

        def saved(*args):
            ready = next(answers, True)
            order.append(f"saved:{ready}")
            if ready:
                seen_save.set()
            return ready

        def close_later():
            seen_save.wait(30)
            with server.lock:
                order.append("closed")
                server.open = 0
                server.closed.notify_all()

        def second(*args, **kwargs):
            order.append("second run")
            return 0

        threading.Thread(target=close_later, daemon=True).start()
        with mock.patch.object(bench, "tool_saved", side_effect=saved), \
                mock.patch.object(bench, "run_bounded", side_effect=second):
            run = bench.killed_and_resumed(["sleep", "30"], work, server, 512, 10.0)
        self.assertEqual(order, ["saved:False", "saved:False", "saved:True", "closed", "second run"])
        self.assertIsNone(run["failed"])

    def test_a_range_saved_short_of_what_it_was_sent_is_not_saved(self):
        work = scratch(self, prefix="bench-ranges-")
        state = work / "src" / ".partial" / "data.bin.state.json"
        state.parent.mkdir(parents=True)
        mib = 1 << 20

        def saved_as(first_saved, second_saved):
            state.write_text(json.dumps({"segments": [[0, 5 * mib - 1, first_saved], [5 * mib, 10 * mib - 1, second_saved]]}))
            return bench.tool_saved(work, 0, {0: 2 * mib + 4096, 5 * mib: 3 * mib})

        # Each range must be saved to the furthest byte it was sent, as aria2c's control file holds all it had: the second
        # range far ahead does not cover the first, and a range short by any amount is not saved.
        self.assertFalse(saved_as(0, 3 * mib))
        self.assertFalse(saved_as(mib + 8192, 3 * mib))
        self.assertTrue(saved_as(2 * mib + 4096, 3 * mib))
        self.assertFalse(saved_as(2 * mib + 4096, 3 * mib - 1))
        state.write_text("{")  # caught mid-replace
        self.assertFalse(bench.tool_saved(work, 0, {}))

    def test_fetch_py_counts_as_saved_only_on_a_state_file_written_since_the_hold(self):
        work = scratch(self, prefix="bench-fetch-saved-")
        state = work / "src" / ".partial" / "data.bin.state.json"
        state.parent.mkdir(parents=True)
        state.write_text(json.dumps({"segments": [[0, 99, 50]]}))
        os.utime(state, (1000, 1000))
        self.assertFalse(bench.tool_saved(work, 2000, {0: 50}))
        os.utime(state, (3000, 3000))
        self.assertTrue(bench.tool_saved(work, 2000, {0: 50}))

    def test_aria2c_counts_as_saved_only_on_a_control_file_written_since_the_hold(self):
        work = scratch(self, prefix="bench-aria2c-")
        (work / "src").mkdir()
        control = work / "src" / "data.bin.aria2"
        control.write_bytes(b"\0")
        os.utime(control, (1000, 1000))
        self.assertFalse(bench.tool_saved(work, 2000, {}))
        os.utime(control, (3000, 3000))
        self.assertTrue(bench.tool_saved(work, 2000, {}))

    def test_a_tool_past_its_deadline_is_ended_with_its_process_group(self):
        # None is the deadline's own answer: a tool left alone exits 0 after its 30 seconds (no wall-clock bound).
        code = bench.run_bounded(["sh", "-c", "sleep 30 & sleep 30"], scratch(self), deadline=0.5)
        self.assertIsNone(code)

    def test_https_is_verified_and_every_request_waits(self):
        # The run's certificate is trusted only through each tool's own option: without it, the fetch is refused.
        folder = scratch(self, prefix="bench-tls-")
        tls = bench.make_certificate(folder)
        body = bench.payload(2 * 1024 * 1024)
        sha = hashlib.sha256(body).hexdigest()
        for trusted in (False, True):
            with self.subTest(trusted=trusted):
                server = bench.Bench(body, 10**9, tls=tls, latency=0.05)
                server.dropped = True  # no cut here: this test is about trust and latency
                threading.Thread(target=server.serve_forever, daemon=True).start()
                self.addCleanup(lambda s=server: (s.shutdown(), s.server_close()))
                work = scratch(self, prefix="bench-work-")
                (work / "src").mkdir()
                url = f"https://127.0.0.1:{server.server_address[1]}/x"
                with mock.patch.object(bench, "aria2c", return_value=None):
                    command = bench.tools([url], sha, work, ca=tls[0] if trusted else None)["fetch.py (four segments)"]
                done = subprocess.run(command, cwd=work, capture_output=True, text=True, check=False)
                if trusted:
                    self.assertEqual(done.returncode, 0, done.stderr[-300:])
                    self.assertEqual(server.delayed, server.requests)
                    self.assertGreaterEqual(server.requests, 2)  # the first range and at least one more
                    # Each paid the latency, measured: a sleep removed from the server would show here.
                    self.assertGreaterEqual(min(paid for _, paid in server.waits), 0.05 * 0.95)
                    self.assertIn("GET range", {kind for kind, _ in server.waits})
                else:
                    self.assertNotEqual(done.returncode, 0)
                    self.assertIn("certificate did not verify", json.loads(done.stdout)["reason"])
        binary = bench.aria2c()
        if binary:  # where aria2c is installed, it refuses the untrusted certificate too
            server = bench.Bench(body, 10**9, tls=tls)
            server.dropped = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(lambda: (server.shutdown(), server.server_close()))
            work = scratch(self, prefix="bench-work-")
            (work / "src").mkdir()
            command = bench.tools([f"https://127.0.0.1:{server.server_address[1]}/x"], sha, work)["aria2c (four connections)"]
            self.assertNotEqual(subprocess.run(command, cwd=work, capture_output=True, check=False).returncode, 0)

    def test_the_kill_signal_waits_for_the_bytes_to_be_written(self):
        # A write that blocks at the kill byte: the signal must not ring until it has gone out (it rang on the promise).
        body = bench.payload(8 * 65536)
        server = bench.Bench(body, 10**9)
        server.dropped = True
        server.kill_at = 65536
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.release.set(), server.shutdown(), server.server_close()))
        gate = threading.Event()
        real_write = socketserver._SocketWriter.write

        def blocked(writer, data):
            if len(data) >= 4096:  # the body's piece, not the status line and headers
                gate.wait(5)
            return real_write(writer, data)

        with mock.patch.object(socketserver._SocketWriter, "write", blocked):
            reader = threading.Thread(target=lambda: urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_address[1]}/x", timeout=10).read(65536), daemon=True)
            reader.start()
            time.sleep(0.5)
            self.assertFalse(server.reached.is_set())  # the boundary piece is promised, not written
            gate.set()
            self.assertTrue(server.reached.wait(5))
        self.assertEqual(server.sent, 65536)

    def test_the_cut_happens_on_a_piece_boundary(self):
        # A cut point exactly where a 64 KiB piece ends was never cut before (completion review G9): an eighth of
        # this file is one piece.
        body = bench.payload(8 * 65536)
        server = bench.Bench(body, 10**9)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        with self.assertRaises(Exception):
            urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}/x", timeout=5).read()
        self.assertEqual(server.drops, 1)
        self.assertEqual(server.sent, 65536)

    # The two-sources scenario (D03 T04 §22).
    def served(self, body, cap, aggregate, connections=4):
        """The seconds `connections` concurrent range requests, together asking for the whole body, take from one host."""
        server = bench.Bench(body, cap, aggregate=aggregate)
        server.dropped = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        piece = len(body) // connections

        def get(number):
            request = urllib.request.Request(f"http://127.0.0.1:{server.server_address[1]}/x",
                                             headers={"Range": f"bytes={number * piece}-{(number + 1) * piece - 1}"})
            urllib.request.urlopen(request, timeout=30).read()

        threads = [threading.Thread(target=get, args=(number,)) for number in range(connections)]
        began = time.monotonic()
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return time.monotonic() - began

    def test_a_hosts_cap_is_shared_by_all_its_connections_not_held_on_each(self):
        body = bench.payload(4 * 1024 * 1024)
        cap = 8 * 1024 * 1024
        shared = self.served(body, cap, aggregate=True)
        each = self.served(body, cap, aggregate=False)
        # Four connections to a host capped as a whole take as long as one would (0.5 seconds for these bytes);
        # capped on each connection they take a quarter of it. A cap that became per connection fails the first bound.
        self.assertGreaterEqual(shared, 0.85 * len(body) / cap)
        self.assertLess(each, 0.6 * shared)

    def test_two_hosts_are_judged_busy_together_only_when_their_transfers_overlap(self):
        launched = 100.0
        together = [[(101.0, 105.0, 0, 1000), (106.0, 108.0, 0, 1000)], [(102.0, 107.0, 0, 1000)]]
        ok, seconds = bench.both_hosts_busy(together, launched)
        self.assertTrue(ok)
        self.assertAlmostEqual(seconds, 3.0 + 1.0)  # 102 to 105, and 106 to 107
        # One host after the other, as a tool that only fails over would use them: no overlap at all.
        sequential = [[(101.0, 105.0, 0, 1000)], [(105.0, 109.0, 0, 1000)]]
        self.assertEqual(bench.both_hosts_busy(sequential, launched), (False, 0.0))
        # A touch of overlap does not make two hosts a pair in use together.
        brief = [[(101.0, 105.0, 0, 1000)], [(104.9, 109.0, 0, 1000)]]
        self.assertFalse(bench.both_hosts_busy(brief, launched)[0])
        self.assertFalse(bench.both_hosts_busy([[], [(101.0, 105.0, 0, 1000)]], launched)[0])  # one host served nothing

    def run_two_sources(self, name):
        folder = scratch(self, prefix="bench-tls-")
        tls = bench.make_certificate(folder)
        body = bench.payload(8 * 1024 * 1024)
        spec = {"size": len(body), "servers": (False, False), "interrupt": None, "tools": bench.FOUR, "hosts": True}
        return bench.one_run(spec, "two-sources", name, body, hashlib.sha256(body).hexdigest(), 8 * 1024 * 1024, 0.005, 120,
                             tls, {})

    def test_fetch_py_uses_both_hosts_at_once_and_within_four_connections(self):
        row = self.run_two_sources("fetch.py (four segments)")
        self.assertTrue(row["recovered"] and row["intact"], row)
        self.assertEqual(len(row["hosts"]), 2)
        for host in row["hosts"]:
            self.assertGreater(sum(count for _, count, _, _ in host), 0)  # each host served bytes
        # Both were sending at the same time: a tool that fell back to one host after the other fails here.
        self.assertTrue(row["overlap"], row)
        self.assertGreater(row["overlap_seconds"], 0)
        self.assertIn("peak_connections", row)  # recorded, not gated
        self.assertEqual(len(row["load"]), 2)

    def paced_request(self, server):
        """A connection with a GET under way whose answer, paced at the host's cap, runs for seconds after its first
        bytes have arrived."""
        sock = socket.create_connection(server.server_address, timeout=10)
        sock.sendall(b"GET /payload.bin HTTP/1.1\r\nHost: bench\r\n\r\n")
        self.assertTrue(sock.recv(1))
        return sock

    def test_a_connection_closed_mid_answer_is_not_counted_beside_the_next_one(self):
        # CI run 41199420247: aria2c, holding four connections, was counted at five. Its handler at the host goes on
        # pacing (and writing into) a connection the client has closed, and the peak counted the requests handlers
        # were still answering. A connection closed before the next one opens is never counted beside it.
        server = bench.Bench(bench.payload(1 << 20), 64 * 1024)  # 1 MiB at 64 KiB a second: each answer runs 16 seconds
        server.dropped = True  # no cut: every answer is paced to its end
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        held = [self.paced_request(server) for _ in range(4)]
        for sock in held:
            self.addCleanup(sock.close)
        held[0].close()  # mid-answer: its handler is still pacing it
        held[0] = self.paced_request(server)
        self.addCleanup(held[0].close)
        self.assertEqual(server.meter["peak"], 4)
        # A fifth held beside the four is counted: the meter is not blind to a real one.
        fifth = self.paced_request(server)
        self.addCleanup(fifth.close)
        self.assertEqual(server.meter["peak"], 5)

    def test_aria2c_uses_both_hosts_at_once_too(self):
        if not bench.aria2c():
            self.skipTest("aria2c is not installed here")
        row = self.run_two_sources("aria2c (four connections)")
        self.assertTrue(row["recovered"] and row["intact"], row)
        self.assertTrue(row["overlap"], row)
        self.assertIn("peak_connections", row)  # recorded, not gated

    def test_the_four_connection_budget_each_tool_is_given(self):
        # What each two-sources and single-file tool is told to hold: fetch.py four segments, aria2c four connections
        # (`-x4 -s4`); the batch budget is checked in its own test.
        with mock.patch.object(bench, "aria2c", return_value=["aria2c"]):
            commands = bench.tools(["https://a/x", "https://b/x"], "0" * 64, Path("/tmp/x"), ca=Path("/tmp/ca.pem"))
        four = commands["aria2c (four connections)"]
        self.assertIn("-x4", four)
        self.assertIn("-s4", four)
        ours = commands["fetch.py (four segments)"]
        self.assertEqual(ours[ours.index("--segments") + 1], str(bench.MAX_CONNECTIONS))

    def test_refuses_nonsense_settings(self):
        with mock.patch("sys.stderr"):
            self.assertEqual(bench.main(["--runs", "0"]), 2)
            self.assertEqual(bench.main(["--batch-files", "0"]), 2)
            self.assertEqual(bench.main(["--batch-mib", "0"]), 2)

    # The batch scenario (D03 T04 §23): a source's files, each tool fetching them all in one process.
    def test_the_batch_commands_give_both_tools_the_same_files_and_the_same_connection_budget(self):
        work = scratch(self, prefix="bench-batch-")
        entries = [(f"https://127.0.0.1:9/f{n:02d}.bin", f"f{n:02d}.bin", f"{n:064x}") for n in range(1, 6)]
        with mock.patch.object(bench, "aria2c", return_value=["aria2c"]):
            commands = bench.batch_tools(entries, work, ca=work / "ca.pem")
        ours, theirs = commands[bench.BATCH_OURS], commands[bench.BATCH_THEIRS]
        # fetch.py's manifest lists the files in order, each its URL, destination in the source and digest.
        manifest = Path(ours[ours.index("--manifest") + 1])
        listed = [json.loads(line) for line in manifest.read_text().splitlines()]
        self.assertEqual([(e["url"], e["dest"], e["sha256"]) for e in listed], [(u, f"src/{n}", d) for u, n, d in entries])
        # aria2c's input file lists the same files in the same order, each with its own name and digest.
        listing = Path(next(part for part in theirs if part.startswith("--input-file=")).split("=", 1)[1])
        lines = listing.read_text().splitlines()
        self.assertEqual(len(lines), 3 * len(entries))
        got = [(lines[i], lines[i + 1].strip(), lines[i + 2].strip()) for i in range(0, len(lines), 3)]
        self.assertEqual(got, [(u, f"out={n}", f"checksum=sha-256={d}") for u, n, d in entries])
        self.assertEqual(theirs[theirs.index("-d") + 1], str(work / "src"))
        # Both files sit beside the source folder, never in it (its byte limit counts only the downloads).
        self.assertEqual({manifest.parent, listing.parent}, {work})
        # No single file's options leak into the batch: aria2c takes each digest and name from its listing.
        self.assertFalse([part for part in theirs if part.startswith("--checksum") or part == "-o"])
        self.assertNotIn("--url", ours)
        # The same connection budget: fetch.py one file at a time on four segments (its cap, CONNECTIONS), aria2c
        # `-j` files at once on `-x` connections each, four in all.
        self.assertEqual(ours[ours.index("--segments") + 1], "4")
        for flag in bench.ARIA2_BATCH:
            self.assertIn(flag, theirs)
        self.assertEqual(bench.batch_budget(), bench.MAX_CONNECTIONS)
        self.assertEqual(bench.batch_budget(("-j1", "-x4", "-s4", "-k1M")), 4)
        self.assertEqual(bench.batch_budget(("-j4", "-x4", "-s4")), 16)  # what a fair budget must not be
        # The same tries, timeouts, rate floor and trust for both.
        self.assertEqual(ours[ours.index("--attempts") + 1], "3")
        self.assertIn("--max-tries=3", theirs)
        self.assertIn("--timeout=30", theirs)
        self.assertEqual(ours[ours.index("--timeout") + 1], "30")
        self.assertIn("--lowest-speed-limit=16K", theirs)
        self.assertEqual(ours[ours.index("--min-rate") + 1], str(16 * 1024))
        self.assertIn(f"--ca-certificate={work / 'ca.pem'}", theirs)
        self.assertEqual(ours[ours.index("--ca-file") + 1], str(work / "ca.pem"))

    def run_batch(self, name, files):
        folder = scratch(self, prefix="bench-tls-")
        tls = bench.make_certificate(folder)
        spec = {"size": sum(len(data) for _, data, _ in files), "files": [len(data) for _, data, _ in files],
                "servers": (False,), "interrupt": None, "tools": bench.BATCH}
        return bench.one_run(spec, "batch", name, files, "0" * 64, 8 * 1024 * 1024, 0.005, 120, tls, {})

    def test_a_batch_run_fetches_every_file_in_one_process_within_the_budget(self):
        files = bench.batch_payloads([1 << 20, 3 << 19, 1 << 20])
        self.assertEqual(len({digest for _, _, digest in files}), 3)  # each file its own payload
        names = [bench.BATCH_OURS] + ([bench.BATCH_THEIRS] if bench.aria2c() else [])
        for name in names:
            row = self.run_batch(name, files)
            self.assertTrue(row["recovered"] and row["intact"] and row["latency"], (name, row))
            self.assertIn("peak_connections", row)  # recorded, not gated
            self.assertEqual(row["refetched"], 0, name)
        # One file whose published digest is wrong: the run is neither recovered nor intact, for either tool.
        path, data, _ = files[-1]
        broken = files[:-1] + [(path, data, "0" * 64)]
        for name in names:
            row = self.run_batch(name, broken)
            self.assertFalse(row["recovered"] or row["intact"], (name, row))


# D03 T04 §23: the acceptance judges every gate, and the paired statistics.
ALL_CHECKS = ("recovered", "cut", "intact", "latency", "resumed", "overlap", "connections")
CHECKED = {"drop": ("recovered", "cut", "intact", "latency"), "mirror": ("recovered", "cut", "intact", "latency"),
           "gigabyte": ("recovered", "cut", "intact", "latency", "resumed"),
           "two-sources": ("recovered", "intact", "latency", "overlap", "connections"),
           "batch": ("recovered", "intact", "latency", "connections")}
WIN = [0.90 + 0.002 * number for number in range(bench.PAIRS)]  # fetch.py takes 0.90 to 0.94 of aria2c's time


def pairs_of(ratios, losses=(), first=1):
    """Pairs in the record's shape: fetch.py first in odd pairs, each pair's fetch.py time its ratio times aria2c's."""
    out = []
    for number, ratio in enumerate(ratios, start=first):
        theirs = 3.0 + 0.01 * (number % 3)
        out.append({"pair": number, "order": ["ours", "theirs"] if number % 2 else ["theirs", "ours"],
                    "ours_seconds": theirs * ratio, "theirs_seconds": theirs, "ours_whole": number not in losses,
                    "theirs_whole": True, "load": {"ours": [1.0, 1.0], "theirs": [1.0, 1.0]}})
    return out


def tool_row(refetched=0, runs=bench.PAIRS, **counts):
    return {"median_seconds": 3.0, "median_refetched_bytes": refetched, "runs": runs, "startup_seconds": 0.0,
            **{check: runs for check in ALL_CHECKS}, **counts}


def scenario_of(ratios=WIN, one=None, ours=None, theirs=None, pairs=None):
    """A scenario's record: the four-connection comparison, and (`one`, its ratios) the one-stream one."""
    out = {bench.OURS: ours or tool_row(), bench.THEIRS: theirs or tool_row(),
           "comparisons": {"four": {"pairs": pairs_of(ratios) if pairs is None else pairs}}}
    if one is not None:
        out.update({bench.OURS_ONE: tool_row(), bench.THEIRS_ONE: tool_row()})
        out["comparisons"]["one"] = {"pairs": pairs_of(one)}
    return out


def batch_of(ratios=WIN, ours=None, theirs=None, pairs=None):
    """The batch scenario's record: fetch.py's manifest against aria2c's input file."""
    return {bench.BATCH_OURS: ours or tool_row(), bench.BATCH_THEIRS: theirs or tool_row(),
            "comparisons": {"batch": {"pairs": pairs_of(ratios) if pairs is None else pairs}}}


def of(scenario, **kw):
    """A scenario's record in the shape its comparisons take."""
    if scenario == "batch":
        kw.pop("one", None)
        return batch_of(**kw)
    return scenario_of(**kw)


def everything(**overrides):
    scenarios = {"drop": scenario_of(one=WIN), "mirror": scenario_of(one=WIN), "gigabyte": scenario_of(),
                 "two-sources": scenario_of(), "batch": batch_of()}
    scenarios.update(overrides)
    return scenarios


class PairedStatistics(unittest.TestCase):
    def test_known_winning_pairs_have_a_ratio_and_an_interval_under_one(self):
        stats = bench.paired_statistics(pairs_of(WIN))
        self.assertTrue(stats["valid"], stats)
        self.assertEqual((stats["pairs"], stats["failed_pairs"]), (20, 0))
        # The median of each pair's fetch.py over aria2c time, 0.90 to 0.938 in steps of 0.002: its middle two.
        want = bench.median_of([pair["ours_seconds"] / pair["theirs_seconds"] for pair in pairs_of(WIN)])
        self.assertAlmostEqual(stats["ratio"], want)
        self.assertAlmostEqual(stats["ratio"], 0.919, places=3)
        self.assertLessEqual(stats["lower"], stats["ratio"])
        self.assertLessEqual(stats["ratio"], stats["upper"])
        self.assertLess(stats["upper"], 1.0)
        # Fixed seed and resample count: the same pairs give the same interval, a different seed a (slightly) different one.
        self.assertEqual(stats, bench.paired_statistics(pairs_of(WIN)))
        self.assertEqual((stats["resamples"], stats["seed"]), (bench.RESAMPLES, bench.SEED))
        self.assertEqual(bench.RESAMPLES, 10000)

    def test_data_whose_interval_touches_or_crosses_one_is_refused(self):
        touching = bench.paired_statistics(pairs_of([0.9] * 5 + [1.0] * 15))
        self.assertTrue(touching["valid"])
        self.assertEqual(touching["upper"], 1.0)  # touches 1.00: not strictly under it
        crossing = bench.paired_statistics(pairs_of([0.9, 1.1] * 10))
        self.assertTrue(crossing["valid"])
        self.assertGreater(crossing["upper"], 1.0)
        self.assertLess(crossing["lower"], 1.0)
        for name, ratios in (("touching", [0.9] * 5 + [1.0] * 15), ("crossing", [0.9, 1.1] * 10),
                             ("slower", [1.03 + 0.001 * n for n in range(20)])):
            verdict = bench.acceptance({"gigabyte": scenario_of(ratios)}, required=("gigabyte",))
            self.assertFalse(verdict["gigabyte"]["met"], name)
            self.assertIn("interval", verdict["gigabyte"]["failed_gates"], name)
        self.assertTrue(bench.acceptance({"gigabyte": scenario_of()}, required=("gigabyte",))["gigabyte"]["met"])

    def test_a_constant_or_degenerate_interval_is_refused(self):
        for name, pairs in (("constant", pairs_of([0.9] * 20)), ("none", []),
                            ("a zero time", [{**pairs_of(WIN)[0], "ours_seconds": 0.0}, *pairs_of(WIN[1:], first=2)]),
                            ("a negative time", [{**pairs_of(WIN)[0], "theirs_seconds": -1.0}, *pairs_of(WIN[1:], first=2)]),
                            ("a time that is not finite", [{**pairs_of(WIN)[0], "ours_seconds": float("inf")},
                                                           *pairs_of(WIN[1:], first=2)]),
                            ("no time", [{k: v for k, v in pairs_of(WIN)[0].items() if k != "ours_seconds"},
                                         *pairs_of(WIN[1:], first=2)])):
            stats = bench.paired_statistics(pairs)
            self.assertFalse(stats["valid"], name)
            verdict = bench.acceptance({"gigabyte": scenario_of(pairs=pairs)}, required=("gigabyte",))["gigabyte"]
            self.assertFalse(verdict["met"], name)
            self.assertIn("pairs", verdict["failed_gates"], name)

    def test_a_pair_where_either_run_failed_is_a_loss_for_fetch_py_and_is_never_dropped(self):
        pairs = pairs_of(WIN, losses=(3,))
        self.assertEqual(bench.pair_ratio(pairs[2]), float("inf"))
        self.assertLess(bench.pair_ratio(pairs[1]), 1.0)
        # aria2c's failed run is a loss for fetch.py too, not a free win.
        theirs_failed = {**pairs_of(WIN)[4], "theirs_whole": False}
        self.assertEqual(bench.pair_ratio(theirs_failed), float("inf"))
        stats = bench.paired_statistics(pairs)
        self.assertEqual((stats["pairs"], stats["failed_pairs"]), (20, 1))  # kept: 20 pairs, one a loss
        # Most pairs lost: the median is a loss, and no interval is under 1.00.
        lost = bench.paired_statistics(pairs_of(WIN, losses=range(1, 12)))
        self.assertEqual(lost["failed_pairs"], 11)
        self.assertGreaterEqual(lost["upper"], float("inf"))
        self.assertIsNone(bench.jsonable(lost)["upper"])  # strict JSON: null, not Infinity
        self.assertFalse(bench.acceptance({"gigabyte": scenario_of(pairs=pairs_of(WIN, losses=range(1, 12)))},
                                          required=("gigabyte",))["gigabyte"]["met"])
        # A run that failed also breaks its tool's whole-run gate: dropping the pair would not rescue the scenario.
        short = scenario_of(pairs=pairs, ours=tool_row(recovered=19))
        verdict = bench.acceptance({"gigabyte": short}, required=("gigabyte",))["gigabyte"]
        self.assertFalse(verdict["met"])
        self.assertIn("whole", verdict["failed_gates"])
        self.assertEqual(verdict["failed_pairs"], 1)

    def test_pairs_out_of_sequence_or_order_or_fewer_than_twenty_are_refused(self):
        swapped = pairs_of(WIN)
        swapped[3]["order"] = ["ours", "theirs"]  # an even pair with fetch.py first
        renumbered = pairs_of(WIN)
        renumbered[5]["pair"] = 99
        for name, pairs in (("order", swapped), ("id", renumbered), ("19 pairs", pairs_of(WIN[:19]))):
            verdict = bench.acceptance({"gigabyte": scenario_of(pairs=pairs)}, required=("gigabyte",))["gigabyte"]
            self.assertFalse(verdict["met"], name)
            self.assertIn("pairs", verdict["failed_gates"], name)
        # The pairs must be the runs the gates count: twenty pairs over rows that counted twenty-one runs.
        verdict = bench.acceptance({"gigabyte": scenario_of(ours=tool_row(runs=21))}, required=("gigabyte",))["gigabyte"]
        self.assertFalse(verdict["met"])


class Acceptance(unittest.TestCase):
    def test_every_scenario_and_the_one_stream_rows_are_met_on_winning_pairs(self):
        verdict = bench.acceptance(everything())
        for label in ("drop", "drop (one stream)", "mirror", "mirror (one stream)", "gigabyte", "two-sources", "batch"):
            self.assertTrue(verdict[label]["met"], (label, verdict[label]))
        self.assertTrue(verdict["all"]["met"])
        self.assertEqual(verdict["all"]["required"], list(bench.REQUIRED))

    def test_a_timing_win_whose_refetch_gate_fails_is_not_met(self):
        for label, scenario in (("gigabyte", "gigabyte"), ("two-sources", "two-sources"), ("drop", "drop")):
            data = everything(**{scenario: scenario_of(ours=tool_row(refetched=196_608), theirs=tool_row(refetched=65_536),
                                                       one=WIN if scenario == "drop" else None)})
            verdict = bench.acceptance(data)
            self.assertLess(verdict[label]["interval"][1], 1.0, label)  # the timing is a win
            self.assertFalse(verdict[label]["met"], label)
            self.assertEqual(verdict[label]["failed_gates"], ["refetch"], label)
            self.assertFalse(verdict["all"]["met"], label)
        equal = bench.acceptance(everything(gigabyte=scenario_of(ours=tool_row(65_536), theirs=tool_row(65_536))))
        self.assertTrue(equal["gigabyte"]["met"])

    def test_a_timing_win_with_any_whole_run_gate_failed_is_not_met(self):
        for scenario, checks in CHECKED.items():
            for check in checks:
                for side in ("ours", "theirs"):
                    data = everything(**{scenario: of(scenario, **{side: tool_row(**{check: bench.PAIRS - 1})},
                                                      one=WIN if scenario in ("drop", "mirror") else None)})
                    verdict = bench.acceptance(data)[scenario]
                    self.assertFalse(verdict["met"], (scenario, check, side))
                    self.assertIn("whole", verdict["failed_gates"], (scenario, check, side))
        no_latency = tool_row()
        del no_latency["latency"]
        self.assertFalse(bench.acceptance(everything(gigabyte=scenario_of(ours=no_latency)))["gigabyte"]["met"])
        self.assertFalse(bench.acceptance(everything(gigabyte=scenario_of(ours=tool_row(runs=1), theirs=tool_row(runs=1))))
                         ["gigabyte"]["met"])  # five runs, or one: fewer than twenty pairs is not a repeatable win

    def test_a_one_stream_row_is_judged_like_the_four_connection_rows(self):
        # Four-connection pairs win; the one-stream pairs cross 1.00: only the one-stream verdict, and all, fail.
        slower = bench.acceptance(everything(drop=scenario_of(one=[0.9, 1.1] * 10)))
        self.assertTrue(slower["drop"]["met"])
        self.assertFalse(slower["drop (one stream)"]["met"])
        self.assertFalse(slower["all"]["met"])
        # The one-stream tools measured but their pairs never judged (no comparison recorded): not met.
        unjudged = scenario_of(one=WIN)
        del unjudged["comparisons"]["one"]
        verdict = bench.acceptance(everything(drop=unjudged))
        self.assertFalse(verdict["drop (one stream)"]["met"])
        self.assertIn("pairs", verdict["drop (one stream)"]["failed_gates"])
        self.assertFalse(verdict["all"]["met"])
        # No one-stream rows at all: not measured, also not met.
        absent = bench.acceptance(everything(drop=scenario_of()))
        self.assertEqual(absent["drop (one stream)"]["reason"], "not measured for both tools")
        self.assertFalse(absent["all"]["met"])
        # The one-stream rows hold the same gates: a refetch gate failed, a whole-run gate failed.
        data = scenario_of(one=WIN)
        data[bench.OURS_ONE] = tool_row(refetched=1)
        self.assertEqual(bench.acceptance(everything(drop=data))["drop (one stream)"]["failed_gates"], ["refetch"])
        data = scenario_of(one=WIN)
        data[bench.THEIRS_ONE] = tool_row(cut=19)
        self.assertEqual(bench.acceptance(everything(drop=data))["drop (one stream)"]["failed_gates"], ["whole"])

    def test_a_missing_required_scenario_is_not_met(self):
        for gone in bench.REQUIRED:
            data = everything()
            del data[gone]
            verdict = bench.acceptance(data)
            self.assertFalse(verdict[gone]["met"], gone)
            self.assertFalse(verdict["all"]["met"], gone)
        self.assertEqual(bench.acceptance({}, required=("gigabyte",))["gigabyte"]["reason"], "not measured for both tools")

    def test_the_wan_scenarios_are_required_only_when_asked_for(self):
        self.assertEqual(bench.WAN_SCENARIOS, ("wan-jitter", "wan-loss"))
        self.assertFalse(set(bench.WAN_SCENARIOS) & set(bench.REQUIRED))
        self.assertTrue(bench.acceptance(everything())["all"]["met"])  # the current bench stays runnable
        wanted = bench.REQUIRED + bench.WAN_SCENARIOS
        verdict = bench.acceptance(everything(), required=wanted)
        self.assertFalse(verdict["all"]["met"])
        self.assertEqual(verdict["all"]["required"], list(wanted))
        for name in bench.WAN_SCENARIOS:
            self.assertFalse(verdict[name]["met"], name)
        both = everything(**{name: scenario_of() for name in bench.WAN_SCENARIOS})
        self.assertTrue(bench.acceptance(both, required=wanted)["all"]["met"])  # judged like the others once measured

    def test_the_exit_is_zero_only_when_every_required_comparison_is_met(self):
        out = scratch(self, prefix="bench-exit-") / "bench.json"
        for data, code in ((everything(), 0), (everything(gigabyte=scenario_of(ours=tool_row(refetched=1),
                                                                                 theirs=tool_row())), 1)):
            figures = {"scenarios": {}, "acceptance": bench.acceptance(data)}
            with mock.patch.object(bench, "measure", return_value=figures) as measured, mock.patch("sys.stdout"):
                self.assertEqual(bench.main(["--out", str(out)]), code)
            self.assertEqual(measured.call_args.args[2], 20)  # 20 pairs by default
            self.assertEqual(measured.call_args.args[-1], bench.REQUIRED)
            self.assertEqual((measured.call_args.kwargs["batch_files"], measured.call_args.kwargs["batch_size"]),
                             (8, 4 << 20))  # the batch scenario's source by default: 8 files of 4 MiB
        with mock.patch.object(bench, "measure", return_value={"scenarios": {}, "acceptance": bench.acceptance(everything())}) \
                as measured, mock.patch("sys.stdout"):
            bench.main(["--out", str(out), "--require-wan", "--pairs", "3"])
        self.assertEqual(measured.call_args.args[-1], bench.REQUIRED + bench.WAN_SCENARIOS)
        self.assertEqual(measured.call_args.args[2], 3)


class BatchAcceptance(unittest.TestCase):
    def test_the_batch_scenario_is_required_and_judged_like_the_others(self):
        self.assertIn("batch", bench.REQUIRED)
        self.assertEqual(bench.COMPARISONS["batch"], (bench.BATCH_OURS, bench.BATCH_THEIRS))
        self.assertTrue(bench.acceptance(everything())["batch"]["met"])
        for name, data, gate in (("crossing", batch_of([0.9, 1.1] * 10), "interval"),
                                 ("slower", batch_of([1.2 + 0.001 * n for n in range(20)]), "interval"),
                                 ("refetched more", batch_of(ours=tool_row(refetched=1)), "refetch"),
                                 ("a file missing", batch_of(ours=tool_row(intact=19)), "whole"),
                                 ("over the budget", batch_of(theirs=tool_row(connections=19)), "whole"),
                                 ("19 pairs", batch_of(WIN[:19]), "pairs")):
            verdict = bench.acceptance(everything(batch=data))
            self.assertFalse(verdict["batch"]["met"], name)
            self.assertIn(gate, verdict["batch"]["failed_gates"], name)
            self.assertFalse(verdict["all"]["met"], name)
        # The single-file rows stay judged beside it: a batch win does not carry a single-file loss.
        verdict = bench.acceptance(everything(drop=scenario_of([1.05 + 0.001 * n for n in range(20)], one=WIN)))
        self.assertTrue(verdict["batch"]["met"])
        self.assertFalse(verdict["drop"]["met"])
        self.assertFalse(verdict["all"]["met"])
        # Missing, it is not met.
        data = everything()
        del data["batch"]
        self.assertEqual(bench.acceptance(data)["batch"]["reason"], "not measured for both tools")


class PairedHarness(unittest.TestCase):
    def run_measure(self, spec, scenario, pairs, fail=None):
        """`_measure` over `spec` with a fake runner, returning the calls (tool, kind) in order and the figures."""
        calls = []

        def fake_run(run_spec, run_scenario, name, *rest):
            calls.append(name)
            number = len(calls)
            ours = name.startswith("fetch.py")
            ok = fail is None or not fail(number, name)
            return {"seconds": (2.7 if ours else 3.0) + 0.001 * number, "refetched": 0, "recovered": ok, "intact": True,
                    "latency": True, "waits": [], "cut": True, "overlap": True, "connections": True,
                    "overlap_seconds": 1.0, "peak_connections": 4, "load": [number * 1.0, number + 0.5], "hosts": []}

        names = {bench.OURS: [], bench.THEIRS: [], bench.OURS_ONE: [], bench.THEIRS_ONE: []}
        with mock.patch.object(bench, "one_run", fake_run), mock.patch.object(bench, "tools", return_value=names), \
                mock.patch.object(bench, "startup_seconds", return_value=0.0), mock.patch.object(bench, "aria2c", return_value=None), \
                mock.patch("sys.stderr"):
            figures = bench._measure({scenario: spec}, pairs, 8, 0.0, 10, (Path("c"), Path("k")))
        return calls, figures

    def test_the_harness_runs_exactly_n_complete_pairs_in_alternating_order(self):
        spec = {"size": 1, "servers": (False, False), "interrupt": None, "tools": bench.FOUR, "hosts": True}
        calls, figures = self.run_measure(spec, "two-sources", 6)
        # Fetch.py first in odd pairs, aria2c first in even ones; every pair has both tools.
        self.assertEqual(calls, [bench.OURS, bench.THEIRS, bench.THEIRS, bench.OURS] * 3)
        comparison = figures["scenarios"]["two-sources"]["comparisons"]["four"]
        records = comparison["pairs"]
        self.assertEqual([r["pair"] for r in records], [1, 2, 3, 4, 5, 6])
        self.assertEqual([r["order"] for r in records], [["ours", "theirs"], ["theirs", "ours"]] * 3)
        for record in records:
            self.assertTrue(record["ours_whole"] and record["theirs_whole"])
            self.assertEqual(set(record["load"]), {"ours", "theirs"})
            self.assertEqual(len(record["load"]["ours"]), 2)  # the host's load at the run's start and end
        # Each pair keeps the timing of its own two runs: call n took 2.7 or 3.0 plus 0.001 n, in the order they ran.
        self.assertAlmostEqual(records[0]["ours_seconds"], 2.701)
        self.assertAlmostEqual(records[0]["theirs_seconds"], 3.002)
        self.assertAlmostEqual(records[1]["theirs_seconds"], 3.003)
        self.assertAlmostEqual(records[1]["ours_seconds"], 2.704)
        for tool in (bench.OURS, bench.THEIRS):
            self.assertEqual(figures["scenarios"]["two-sources"][tool]["runs"], 6)
            self.assertEqual(len(figures["scenarios"]["two-sources"][tool]["load"]), 6)
        self.assertEqual(comparison["statistics"]["pairs"], 6)
        json.dumps(figures, allow_nan=False)  # the record is strict JSON, losses as null

    def test_cut_scenarios_pair_the_one_stream_tools_too(self):
        spec = {"size": 1, "servers": (False,), "interrupt": "cut", "tools": None}
        calls, figures = self.run_measure(spec, "drop", 4)
        self.assertEqual(calls, [bench.OURS, bench.THEIRS, bench.THEIRS, bench.OURS] * 2
                         + [bench.OURS_ONE, bench.THEIRS_ONE, bench.THEIRS_ONE, bench.OURS_ONE] * 2)
        comparisons = figures["scenarios"]["drop"]["comparisons"]
        self.assertEqual(set(comparisons), {"four", "one"})
        self.assertEqual((comparisons["one"]["ours"], comparisons["one"]["theirs"]), (bench.OURS_ONE, bench.THEIRS_ONE))
        for comparison in comparisons.values():
            self.assertEqual([r["pair"] for r in comparison["pairs"]], [1, 2, 3, 4])

    def test_a_failed_run_is_kept_as_a_loss_and_the_scenario_is_not_met(self):
        spec = {"size": 1, "servers": (False, False), "interrupt": None, "tools": bench.FOUR, "hosts": True}
        # Call 5 is pair 3's fetch.py run (pair 3 runs fetch.py first).
        calls, figures = self.run_measure(spec, "two-sources", 20, fail=lambda number, name: number == 5)
        records = figures["scenarios"]["two-sources"]["comparisons"]["four"]["pairs"]
        self.assertEqual(len(records), 20)
        self.assertFalse(records[2]["ours_whole"])
        self.assertEqual(figures["scenarios"]["two-sources"]["comparisons"]["four"]["statistics"]["failed_pairs"], 1)
        self.assertFalse(figures["acceptance"]["two-sources"]["met"])
        self.assertIn("whole", figures["acceptance"]["two-sources"]["failed_gates"])

    def test_the_batch_pairs_alternate_the_manifest_and_the_input_file(self):
        spec = {"size": 2, "files": [1, 1], "servers": (False,), "interrupt": None, "tools": bench.BATCH}
        calls = []

        def fake_run(run_spec, run_scenario, name, body, *rest):
            calls.append((name, [path for path, _, _ in body]))
            ours = name.startswith("fetch.py")
            return {"seconds": (2.7 if ours else 3.0) + 0.001 * len(calls), "refetched": 0, "recovered": True,
                    "intact": True, "latency": True, "waits": [], "connections": True, "peak_connections": 4,
                    "load": [1.0, 1.0]}

        with mock.patch.object(bench, "one_run", fake_run), mock.patch.object(bench, "startup_seconds", return_value=0.0), \
                mock.patch.object(bench, "aria2c", return_value=["aria2c", "--version"]), \
                mock.patch.object(bench.subprocess, "run", return_value=mock.Mock(stdout="aria2 version 1.37.0\n")), \
                mock.patch.object(bench, "openssl_version", return_value="OpenSSL"), mock.patch("sys.stderr"):
            figures = bench._measure({"batch": spec}, 20, 8, 0.0, 10, (Path("c"), Path("k")), ("batch",))
        self.assertEqual([name for name, _ in calls[:4]],
                         [bench.BATCH_OURS, bench.BATCH_THEIRS, bench.BATCH_THEIRS, bench.BATCH_OURS])
        self.assertEqual(len(calls), 40)
        self.assertEqual({tuple(paths) for _, paths in calls}, {("/f01.bin", "/f02.bin")})  # the same files for both
        batch = figures["scenarios"]["batch"]
        self.assertEqual((batch["aria2c_flags"], batch["connection_budget"]), (list(bench.ARIA2_BATCH), 4))
        self.assertEqual(len(batch["comparisons"]["batch"]["pairs"]), 20)
        self.assertTrue(figures["acceptance"]["batch"]["met"], figures["acceptance"]["batch"])

    def test_the_recorded_pairs_are_what_the_acceptance_judges(self):
        # Twenty pairs from the harness, winning, whole: the recorded figures are met with no help from the test.
        spec = {"size": 1, "servers": (False, False), "interrupt": None, "tools": bench.FOUR, "hosts": True}
        _, figures = self.run_measure(spec, "two-sources", 20)
        verdict = figures["acceptance"]["two-sources"]
        self.assertTrue(verdict["met"], verdict)
        self.assertEqual(verdict["pairs"], 20)
        self.assertLess(verdict["interval"][1], 1.0)
        self.assertEqual(verdict, bench.acceptance(figures["scenarios"], required=("two-sources",))["two-sources"])
        self.assertEqual(bench.PAIRS, 20)


if __name__ == "__main__":
    unittest.main()
