"""scripts/glimmer/fetch_bench.py (D03 T04 §20): the harness measures each tool on the same seeded payload, dropped at
half its length on its first transfer, and records medians, recovery and integrity with each tool's exact command."""
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "fetch_bench.py"
spec = importlib.util.spec_from_file_location("fetch_bench", SCRIPT)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class Harness(unittest.TestCase):
    def test_the_payload_is_the_same_every_run(self):
        self.assertEqual(bench.payload(100_000), bench.payload(100_000))
        self.assertEqual(len(bench.payload(100_000)), 100_000)

    def test_a_small_run_records_fetch_py_recovering_intact(self):
        out = Path(tempfile.mkdtemp(prefix="bench-")) / "bench.json"
        # Without aria2c the harness measures fetch.py alone and says so; with it, every tool.
        with mock.patch.object(bench, "aria2c", return_value=None), mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            self.assertEqual(bench.main(["--size-mib", "2", "--cap-mib", "8", "--runs", "1", "--gigabyte-mib", "40",
                                         "--latency-ms", "5", "--out", str(out)]), 0)
        figures = json.loads(out.read_text())
        for scenario, tools in (("drop", ("fetch.py (one stream)", "fetch.py (four segments)")),
                                ("mirror", ("fetch.py (one stream)", "fetch.py (four segments)")),
                                ("gigabyte", ("fetch.py (four segments)",))):
            for tool in tools:
                row = figures["scenarios"][scenario][tool]
                self.assertEqual((row["recovered"], row["intact"], row["cut"], row["latency"], row["runs"]), (1, 1, 1, 1, 1),
                                 (scenario, tool))
            self.assertFalse(figures["acceptance"][scenario]["met"])  # aria2c not measured: not met
        # The gigabyte scenario's first process was killed and a second one finished from what the first had saved.
        self.assertEqual(figures["scenarios"]["gigabyte"]["fetch.py (four segments)"]["resumed"], 1)
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

    def test_a_tool_past_its_deadline_is_ended_with_its_process_group(self):
        started = time.monotonic()
        code = bench.run_bounded(["sh", "-c", "sleep 30 & sleep 30"], Path(tempfile.mkdtemp()), deadline=0.5)
        self.assertIsNone(code)
        self.assertLess(time.monotonic() - started, 5)

    def test_the_acceptance_line_judges_time_refetch_and_integrity(self):
        def row(seconds, refetched=0, **counts):
            return {"median_seconds": seconds, "median_refetched_bytes": refetched, "runs": 5,
                    **{"recovered": 5, "cut": 5, "intact": 5, **counts}}

        def judged(ours, theirs=None, scenarios=("drop",)):
            theirs = theirs or row(3.31)
            return bench.acceptance({name: {bench.OURS: ours, bench.THEIRS: theirs} for name in scenarios},
                                    required=scenarios)

        self.assertTrue(judged(row(3.0))["drop"]["met"])
        self.assertTrue(judged(row(3.0))["all"]["met"])
        self.assertFalse(judged(row(3.31))["drop"]["met"])  # a ratio of exactly 1.00 does not beat aria2c
        self.assertFalse(judged(row(3.3101))["drop"]["met"])  # unrounded: just above 1.00 fails
        self.assertFalse(judged(row(3.0, refetched=1))["drop"]["met"])  # more refetched than aria2c
        for check in ("recovered", "cut", "intact"):
            self.assertFalse(judged(row(3.0, **{check: 4}))["drop"]["met"], check)  # ours, one run short
            self.assertFalse(judged(row(3.0), row(3.31, **{check: 4}))["drop"]["met"], check)  # aria2c's
        resumed = judged(row(3.0, resumed=5), row(3.31, resumed=4))
        self.assertFalse(resumed["drop"]["met"])  # aria2c's second process did not resume one run
        missing = bench.acceptance({"drop": {bench.OURS: row(3.0), bench.THEIRS: row(3.31)}}, required=("drop", "gigabyte"))
        self.assertFalse(missing["gigabyte"]["met"])
        self.assertFalse(missing["all"]["met"])

    def test_https_is_verified_and_every_request_waits(self):
        # The run's certificate is trusted only through each tool's own option: without it, the fetch is refused.
        folder = Path(tempfile.mkdtemp(prefix="bench-tls-"))
        tls = bench.make_certificate(folder)
        body = bench.payload(2 * 1024 * 1024)
        sha = hashlib.sha256(body).hexdigest()
        for trusted in (False, True):
            with self.subTest(trusted=trusted):
                server = bench.Bench(body, 10**9, tls=tls, latency=0.05)
                server.dropped = True  # no cut here: this test is about trust and latency
                threading.Thread(target=server.serve_forever, daemon=True).start()
                self.addCleanup(lambda s=server: (s.shutdown(), s.server_close()))
                work = Path(tempfile.mkdtemp(prefix="bench-work-"))
                (work / "src").mkdir()
                url = f"https://127.0.0.1:{server.server_address[1]}/x"
                with mock.patch.object(bench, "aria2c", return_value=None):
                    command = bench.tools([url], sha, work, ca=tls[0] if trusted else None)["fetch.py (four segments)"]
                done = subprocess.run(command, cwd=work, capture_output=True, text=True, check=False)
                if trusted:
                    self.assertEqual(done.returncode, 0, done.stderr[-300:])
                    self.assertEqual(server.delayed, server.requests)
                    self.assertGreaterEqual(server.requests, 2)  # the HEAD and at least one range, each delayed
                else:
                    self.assertNotEqual(done.returncode, 0)
                    self.assertIn("certificate did not verify", json.loads(done.stdout)["reason"])
        binary = bench.aria2c()
        if binary:  # where aria2c is installed, it refuses the untrusted certificate too
            server = bench.Bench(body, 10**9, tls=tls)
            server.dropped = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(lambda: (server.shutdown(), server.server_close()))
            work = Path(tempfile.mkdtemp(prefix="bench-work-"))
            (work / "src").mkdir()
            command = bench.tools([f"https://127.0.0.1:{server.server_address[1]}/x"], sha, work)["aria2c (four connections)"]
            self.assertNotEqual(subprocess.run(command, cwd=work, capture_output=True, check=False).returncode, 0)

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

    def test_refuses_nonsense_settings(self):
        with mock.patch("sys.stderr"):
            self.assertEqual(bench.main(["--runs", "0"]), 2)


if __name__ == "__main__":
    unittest.main()
