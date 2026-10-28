"""scripts/glimmer/version-gate.py (D03 T04 §13): a version is promoted only when it trained on more lines and, on the
same held-out file, detects at least as much and raises no more false alarms, overall and on the South African slice."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "version-gate.py"
spec = importlib.util.spec_from_file_location("version_gate", SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def version(lines, recall, alarms, sa_recall=None, sa_alarms=None, sha="e1"):
    return ({"lines_trained": lines}, {"eval_sha256": sha,
                                       "overall": {"lure_recall": recall, "false_alarm_rate": alarms},
                                       "south_africa": {"lure_recall": sa_recall if sa_recall is not None else recall,
                                                        "false_alarm_rate": sa_alarms if sa_alarms is not None else alarms}})


class Gate(unittest.TestCase):
    def test_a_better_version_with_more_lines_is_promoted(self):
        self.assertEqual(gate.decide(version(80_000, 0.95, 0.02), version(60_000, 0.93, 0.03)), "promote")

    def test_a_version_with_more_false_alarms_fewer_detections_or_fewer_lines_is_kept_out(self):
        old = version(60_000, 0.93, 0.03)
        self.assertIn("false-alarm rate", gate.decide(version(80_000, 0.95, 0.04), old))
        self.assertIn("lure recall", gate.decide(version(80_000, 0.92, 0.02), old))
        self.assertIn("not more than", gate.decide(version(60_000, 0.95, 0.02), old))
        self.assertIn("south_africa lure recall", gate.decide(version(80_000, 0.95, 0.02, sa_recall=0.80), old))
        self.assertIn("same held-out file", gate.decide(version(80_000, 0.95, 0.02, sha="e2"), old))

    def test_the_command_reads_the_records_and_exits_by_verdict(self):
        store = Path(tempfile.mkdtemp(prefix="gate-"))
        self.addCleanup(shutil.rmtree, store, True)
        for name, (run, metrics) in (("1.0", version(60_000, 0.93, 0.03)), ("1.1", version(80_000, 0.95, 0.02))):
            (store / "runs" / f"loupe-{name}").mkdir(parents=True)
            (store / "runs" / f"loupe-{name}" / "run.json").write_text(json.dumps(run))
            (store / "runs" / f"eval-{name}").mkdir(parents=True)
            (store / "runs" / f"eval-{name}" / "metrics.json").write_text(json.dumps(metrics))
        with mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(store)}), mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            self.assertEqual(gate.main(["1.1", "1.0"]), 0)
            self.assertEqual(gate.main(["1.0", "1.1"]), 1)
            self.assertEqual(gate.main(["1.2", "1.0"]), 2)


if __name__ == "__main__":
    unittest.main()
