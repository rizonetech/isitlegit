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
            self.assertIsNone(figures["acceptance"][scenario]["met"])
        self.assertIn("not installed", figures["aria2c"])
        recorded = json.dumps(figures["commands"])
        self.assertIn("<url>", recorded)
        self.assertIn("<mirror 1>", recorded)
        self.assertNotIn(str(Path.home()), recorded)
        self.assertIn("<repo>/scripts/glimmer/fetch.py", recorded)

    def test_the_acceptance_line_judges_time_refetch_and_integrity(self):
        def row(seconds, refetched, intact, cut=5, recovered=5):
            return {"median_seconds": seconds, "median_refetched_bytes": refetched, "intact": intact, "cut": cut,
                    "recovered": recovered, "runs": 5}

        judged = bench.acceptance({"drop": {"fetch.py (four segments)": row(3.5, 0, 5), "aria2c (four connections)": row(3.31, 65536, 5)},
                                   "mirror": {"fetch.py (four segments)": row(4.0, 0, 5), "aria2c (four connections)": row(3.31, 0, 5)}})
        self.assertTrue(judged["drop"]["met"])
        self.assertFalse(judged["mirror"]["met"])  # 21 percent slower
        uncut = bench.acceptance({"drop": {"fetch.py (four segments)": row(3.0, 0, 5, cut=0),
                                           "aria2c (four connections)": row(3.31, 0, 5)}})
        self.assertFalse(uncut["drop"]["met"])  # never interrupted: no recovery was measured
        for ours, theirs in ((0, 5), (5, 0)):
            failed = bench.acceptance({"drop": {"fetch.py (four segments)": row(3.0, 0, 5, recovered=ours),
                                                "aria2c (four connections)": row(3.31, 0, 5, recovered=theirs)}})
            self.assertFalse(failed["drop"]["met"])  # a run that did not exit 0 is no recovery, whoever's it was

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
