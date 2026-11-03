"""scripts/glimmer/version-gate.py (D03 T04 §13, §50): a version is promoted only when, on the same held-out file, it
is better: higher lure recall with no more false alarms, or fewer false alarms with no less recall."""
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


def version(lines, recall, alarms, sa_recall=None, sa_alarms=None, sha="e1", unanswered=0, withheld=None):
    """A run's record and its metrics as evaluate.ts writes them: each slice says whether every page was answered."""
    complete = unanswered == 0
    metrics = {"eval_sha256": sha,
               "overall": {"lure_recall": recall, "false_alarm_rate": alarms, "complete": complete,
                           "unanswered": unanswered, "lures": 400, "benign": 600},
               "south_africa": {"lure_recall": sa_recall if sa_recall is not None else recall,
                                "false_alarm_rate": sa_alarms if sa_alarms is not None else alarms,
                                "complete": complete, "unanswered": unanswered, "lures": 100, "benign": 150}}
    if withheld:
        metrics["bar_withheld"] = withheld
    return ({"lines_trained": lines}, metrics)


class Gate(unittest.TestCase):
    def test_a_better_version_with_more_lines_is_promoted(self):
        self.assertEqual(gate.decide(version(80_000, 0.95, 0.02), version(60_000, 0.93, 0.03)), "promote")

    def test_each_improvement_branch_promotes_and_neither_old_rule_vetoes_it(self):
        old = version(60_000, 0.93, 0.03)
        # Fewer false alarms at equal recall (the second branch).
        self.assertEqual(gate.decide(version(80_000, 0.93, 0.02), old), "promote")
        # Trained on fewer lines: no longer a gate.
        self.assertEqual(gate.decide(version(40_000, 0.95, 0.02), old), "promote")
        # A worse South African slice: printed, no longer a gate.
        self.assertEqual(gate.decide(version(80_000, 0.95, 0.02, sa_recall=0.80), old), "promote")

    def test_a_version_that_is_not_better_is_kept_out(self):
        old = version(60_000, 0.93, 0.03)
        self.assertIn("false-alarm rate", gate.decide(version(80_000, 0.95, 0.04), old))
        self.assertIn("lure recall", gate.decide(version(80_000, 0.92, 0.02), old))
        self.assertIn("equal, not better", gate.decide(version(80_000, 0.93, 0.03), old))
        self.assertIn("same held-out file", gate.decide(version(80_000, 0.95, 0.02, sha="e2"), old))

    # §13 completion review gap 1: unanswered benign pages lower the false alarms, so an incomplete run never promotes.
    def test_an_incomplete_or_withheld_evaluation_is_never_promoted(self):
        old = version(60_000, 0.93, 0.03)
        self.assertIn("incomplete (34 pages unanswered)", gate.decide(version(80_000, 0.95, 0.01, unanswered=34), old))
        self.assertIn("withheld", gate.decide(version(80_000, 0.95, 0.01, withheld="spark run incomplete"), old))
        self.assertIn("the previous version's overall evaluation is incomplete (2 pages unanswered)",
                      gate.decide(version(80_000, 0.95, 0.01), version(60_000, 0.93, 0.03, unanswered=2)))

    def test_the_command_reads_the_records_and_exits_by_verdict(self):
        store = Path(tempfile.mkdtemp(prefix="gate-"))
        self.addCleanup(shutil.rmtree, store, True)
        for name, (run, metrics) in (("1.0", version(60_000, 0.93, 0.03)), ("1.1", version(80_000, 0.95, 0.02))):
            (store / "runs" / f"loupe-{name}").mkdir(parents=True)
            (store / "runs" / f"loupe-{name}" / "run.json").write_text(json.dumps(run))
            (store / "runs" / f"eval-{name}").mkdir(parents=True)
            (store / "runs" / f"eval-{name}" / "metrics.json").write_text(json.dumps(metrics))
        import contextlib
        import io
        with mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(store)}), mock.patch("sys.stderr"):
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(gate.main(["1.1", "1.0"]), 0)
            printed = out.getvalue()
            # Both versions' figures with denominators print, on acceptance and on refusal alike.
            self.assertIn("1.1 (new) overall: lure recall 0.9500 (380/400 lures)", printed)
            self.assertIn("false alarms 0.0300 (18/600 benign)", printed)
            self.assertIn("south_africa", printed)
            self.assertIn("promote", printed)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(gate.main(["1.0", "1.1"]), 1)
            self.assertIn("keep 1.1", out.getvalue())
            self.assertEqual(gate.main(["1.2", "1.0"]), 2)


if __name__ == "__main__":
    unittest.main()
