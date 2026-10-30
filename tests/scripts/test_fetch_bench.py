"""scripts/glimmer/fetch_bench.py (D03 T04 §20): the harness measures each tool on the same seeded payload, dropped at
half its length on its first transfer, and records medians, recovery and integrity with each tool's exact command."""
import hashlib
import importlib.util
import json
import os
import shutil
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


class Harness(unittest.TestCase):
    def test_the_payload_is_the_same_every_run(self):
        self.assertEqual(bench.payload(100_000), bench.payload(100_000))
        self.assertEqual(len(bench.payload(100_000)), 100_000)

    def test_a_small_run_records_fetch_py_recovering_intact(self):
        out = scratch(self, prefix="bench-") / "bench.json"
        # Without aria2c the harness measures fetch.py alone and says so; with it, every tool.
        with mock.patch.object(bench, "aria2c", return_value=None), mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            # The figures are written, and the exit says the bar was not met (aria2c not measured, one run).
            self.assertEqual(bench.main(["--size-mib", "2", "--cap-mib", "8", "--runs", "1", "--gigabyte-mib", "40",
                                         "--latency-ms", "5", "--out", str(out)]), 1)
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
        self.assertEqual((two["recovered"], two["intact"], two["latency"], two["overlap"], two["connections"]), (1, 1, 1, 1, 1))
        self.assertNotIn("cut", two)  # nothing interrupts it
        self.assertFalse(figures["acceptance"]["two-sources"]["met"])  # aria2c not measured: not met
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
        # Every kind of request paid the measured latency: the HEAD, the ranges, and the failing URL's refusals.
        self.assertIn("HEAD", figures["scenarios"]["drop"]["fetch.py (four segments)"]["waits"])
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

        def saved(*args):
            ready = next(answers, True)
            order.append(f"saved:{ready}")
            return ready

        def close_later():
            time.sleep(0.3)
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

        # The second range far ahead does not cover the first, still more than a MiB short of what it was sent.
        self.assertFalse(saved_as(0, 3 * mib))
        self.assertTrue(saved_as(mib + 8192, 3 * mib))
        self.assertTrue(saved_as(2 * mib, 2 * mib))
        self.assertFalse(saved_as(2 * mib, mib))
        state.write_text("{")  # caught mid-replace
        self.assertFalse(bench.tool_saved(work, 0, {}))

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
        started = time.monotonic()
        code = bench.run_bounded(["sh", "-c", "sleep 30 & sleep 30"], scratch(self), deadline=0.5)
        self.assertIsNone(code)
        self.assertLess(time.monotonic() - started, 5)

    def test_the_acceptance_line_judges_time_refetch_and_integrity(self):
        def row(seconds, refetched=0, runs=5, **counts):
            return {"median_seconds": seconds, "median_refetched_bytes": refetched, "runs": runs,
                    **{"recovered": runs, "cut": runs, "intact": runs, "latency": runs, "resumed": runs, **counts}}

        def judged(ours, theirs=None, scenarios=("gigabyte",)):
            theirs = theirs or row(3.31)
            return bench.acceptance({name: {bench.OURS: ours, bench.THEIRS: theirs} for name in scenarios},
                                    required=scenarios)

        self.assertTrue(judged(row(3.0))["gigabyte"]["met"])
        self.assertTrue(judged(row(3.0))["all"]["met"])
        self.assertFalse(judged(row(3.31))["gigabyte"]["met"])  # a ratio of exactly 1.00 does not beat aria2c
        self.assertFalse(judged(row(3.3101))["gigabyte"]["met"])  # unrounded: just above 1.00 fails
        self.assertFalse(judged(row(3.0, refetched=1))["gigabyte"]["met"])  # more refetched than aria2c
        for check in ("recovered", "cut", "intact"):
            self.assertFalse(judged(row(3.0, **{check: 4}))["gigabyte"]["met"], check)  # ours, one run short
            self.assertFalse(judged(row(3.0), row(3.31, **{check: 4}))["gigabyte"]["met"], check)  # aria2c's
        resumed = judged(row(3.0, resumed=5), row(3.31, resumed=4), scenarios=("gigabyte",))
        self.assertFalse(resumed["gigabyte"]["met"])  # aria2c's second process did not resume one run
        # Start-up is taken off each tool's time before the ratio: 3.30 against 3.25 raw, with 0.12 and 0.01 of
        # start-up, is 3.18 against 3.24 of downloading, and beats it; the raw ratio is kept beside it.
        started = judged(row(3.30, startup_seconds=0.12), row(3.25, startup_seconds=0.01))
        self.assertTrue(started["gigabyte"]["met"])
        self.assertGreater(started["gigabyte"]["time_ratio"], 1.0)
        self.assertLess(started["gigabyte"]["net_ratio"], 1.0)
        self.assertFalse(judged(row(3.40, startup_seconds=0.12), row(3.25, startup_seconds=0.01))["gigabyte"]["met"])
        # Five runs at least, and each scenario's own evidence: a run of one, or a row without its latency or (the
        # gigabyte scenario) its resume evidence, is no bar met.
        self.assertFalse(judged(row(3.0, runs=1), row(3.31, runs=1))["gigabyte"]["met"])
        no_latency = row(3.0)
        del no_latency["latency"]
        self.assertFalse(judged(no_latency)["gigabyte"]["met"])
        no_resume = bench.acceptance({"gigabyte": {bench.OURS: {k: v for k, v in row(3.0).items() if k != "resumed"},
                                                    bench.THEIRS: row(3.31)}}, required=("gigabyte",))
        self.assertFalse(no_resume["gigabyte"]["met"])  # no `resumed`
        # §20's 96 MiB cut scenario is held to §20's bar, 10 percent: a regression guard, not the win.
        def drop(ours):
            return bench.acceptance({"drop": {bench.OURS: ours, bench.THEIRS: row(3.25)}}, required=("drop",))["drop"]["met"]

        self.assertTrue(drop(row(3.30)))
        self.assertFalse(drop(row(3.60)))
        # Unrounded: 3.3349 and 3.2251 less 0.117 and 0.009 is 1.00056, not a win (rounded first, it read 0.9975).
        close = judged(row(3.3349, startup_seconds=0.117), row(3.2251, startup_seconds=0.009))
        self.assertFalse(close["gigabyte"]["met"])
        self.assertGreater(close["gigabyte"]["net_ratio"], 1.0)
        missing = bench.acceptance({"drop": {bench.OURS: row(3.0), bench.THEIRS: row(3.31)}}, required=("drop", "gigabyte"))
        self.assertFalse(missing["gigabyte"]["met"])
        self.assertFalse(missing["all"]["met"])

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
                    self.assertGreaterEqual(server.requests, 2)  # the HEAD and at least one range
                    # Each paid the latency, measured: a sleep removed from the server would show here.
                    self.assertGreaterEqual(min(paid for _, paid in server.waits), 0.05 * 0.95)
                    self.assertEqual({kind for kind, _ in server.waits} >= {"HEAD", "GET range"}, True)
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
        self.assertTrue(row["connections"])
        self.assertLessEqual(row["peak_connections"], bench.MAX_CONNECTIONS)
        self.assertEqual(len(row["load"]), 2)

    def test_aria2c_uses_both_hosts_at_once_too(self):
        if not bench.aria2c():
            self.skipTest("aria2c is not installed here")
        row = self.run_two_sources("aria2c (four connections)")
        self.assertTrue(row["recovered"] and row["intact"], row)
        self.assertTrue(row["overlap"], row)
        self.assertLessEqual(row["peak_connections"], bench.MAX_CONNECTIONS)

    def test_the_two_tools_run_turn_about_and_each_run_keeps_its_raw_time_and_load(self):
        order = []

        def fake_run(spec, scenario, name, *rest):
            order.append(name)
            return {"seconds": 1.0, "refetched": 0, "recovered": True, "intact": True, "latency": True, "waits": [],
                    "overlap": True, "connections": True, "overlap_seconds": 1.0, "peak_connections": 4, "load": [1.0, 2.0],
                    "hosts": []}

        spec = {"size": 1, "servers": (False, False), "interrupt": None, "tools": bench.FOUR, "hosts": True, "interleave": True}
        names = {bench.OURS: [], bench.THEIRS: []}
        with mock.patch.object(bench, "one_run", fake_run), mock.patch.object(bench, "tools", return_value=names), \
                mock.patch.object(bench, "startup_seconds", return_value=0.0), mock.patch.object(bench, "aria2c", return_value=None), \
                mock.patch("sys.stderr"):
            figures = bench._measure({"two-sources": spec}, 3, 8, 0.0, 10, (Path("c"), Path("k")))
        self.assertEqual(order, [bench.OURS, bench.THEIRS] * 3)
        ours = figures["scenarios"]["two-sources"][bench.OURS]
        self.assertEqual((ours["seconds"], ours["load"], ours["overlap"], ours["connections"]), ([1.0] * 3, [[1.0, 2.0]] * 3, 3, 3))

    def test_the_acceptance_requires_the_two_sources_scenario_and_judges_it_on_the_raw_time(self):
        def row(seconds, runs=5, startup=0.0, **counts):
            return {"median_seconds": seconds, "median_refetched_bytes": 0, "runs": runs, "startup_seconds": startup,
                    **{"recovered": runs, "cut": runs, "intact": runs, "latency": runs, "resumed": runs, "overlap": runs,
                       "connections": runs, **counts}}

        def judged(ours, theirs=None, extra=()):
            scenarios = {name: {bench.OURS: row(3.0), bench.THEIRS: row(3.31)} for name in extra}
            scenarios["two-sources"] = {bench.OURS: ours, bench.THEIRS: theirs or row(3.31)}
            return bench.acceptance(scenarios, required=("two-sources",))

        self.assertTrue(judged(row(3.0))["two-sources"]["met"])
        self.assertFalse(judged(row(3.31))["two-sources"]["met"])  # a ratio of exactly 1.00 is not under it
        self.assertFalse(judged(row(3.4))["two-sources"]["met"])  # a slower raw time
        # Judged raw: its start-up is not taken off (taken off, 3.30 against 3.25 would read 0.98 and pass).
        started = judged(row(3.30, startup=0.12), row(3.25, startup=0.01))
        self.assertFalse(started["two-sources"]["met"])
        self.assertLess(started["two-sources"]["net_ratio"], 1.0)
        self.assertGreater(started["two-sources"]["time_ratio"], 1.0)
        self.assertEqual(started["two-sources"]["judged_on"], "raw")
        for check in ("recovered", "intact", "latency", "overlap", "connections"):
            self.assertFalse(judged(row(3.0, **{check: 4}))["two-sources"]["met"], check)  # a run short, ours
            self.assertFalse(judged(row(3.0), row(3.31, **{check: 4}))["two-sources"]["met"], check)  # and theirs
        self.assertFalse(judged(row(3.0, runs=1), row(3.31, runs=1))["two-sources"]["met"])
        # The scenario is required: the other three met and it missing is a bar not met.
        done = bench.acceptance({name: {bench.OURS: row(3.0), bench.THEIRS: row(3.31)} for name in ("drop", "mirror", "gigabyte")})
        self.assertFalse(done["two-sources"]["met"])
        self.assertFalse(done["all"]["met"])
        self.assertIn("two-sources", done["all"]["required"])
        everything = bench.acceptance({name: {bench.OURS: row(3.0), bench.THEIRS: row(3.31)}
                                       for name in ("drop", "mirror", "gigabyte", "two-sources")})
        self.assertTrue(everything["all"]["met"])

    def test_refuses_nonsense_settings(self):
        with mock.patch("sys.stderr"):
            self.assertEqual(bench.main(["--runs", "0"]), 2)


if __name__ == "__main__":
    unittest.main()
