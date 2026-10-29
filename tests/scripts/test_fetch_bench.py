"""scripts/glimmer/fetch_bench.py (D03 T04 §20): the harness measures each tool on the same seeded payload, dropped at
half its length on its first transfer, and records medians, recovery and integrity with each tool's exact command."""
import importlib.util
import json
import tempfile
import threading
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
        # Without aria2c the harness measures fetch.py alone and says so; with it, all four tools.
        with mock.patch.object(bench, "aria2c", return_value=None), mock.patch("sys.stdout"):
            self.assertEqual(bench.main(["--size-mib", "2", "--cap-mib", "8", "--runs", "1", "--out", str(out)]), 0)
        figures = json.loads(out.read_text())
        for scenario in ("drop", "mirror"):
            for tool in ("fetch.py (one stream)", "fetch.py (four segments)"):
                row = figures["scenarios"][scenario][tool]
                self.assertEqual((row["recovered"], row["intact"], row["cut"], row["runs"]), (1, 1, 1, 1), (scenario, tool))
            # A resume refetches nothing: the server sent one copy of the file in all.
            self.assertEqual(figures["scenarios"][scenario]["fetch.py (one stream)"]["median_refetched_bytes"], 0)
            self.assertFalse(figures["acceptance"][scenario]["met"])  # aria2c not measured: not met
        self.assertIn("not installed", figures["aria2c"])
        recorded = json.dumps(figures["commands"])
        self.assertIn("<url>", recorded)
        self.assertIn("<mirror 1>", recorded)
        self.assertNotIn(str(Path.home()), recorded)
        self.assertIn("<repo>/scripts/glimmer/fetch.py", recorded)

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
