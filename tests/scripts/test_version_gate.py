"""scripts/glimmer/version-gate.py (D03 T04 §13; operator, 2026-11-02): the broken-model guard only. A version is
kept only when its record cannot be trusted or it is broken (false alarms over 10 percent, lure recall under 40
percent, or an incomplete evaluation); being worse than the previous version never blocks on its own."""
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
                           "unanswered": unanswered},
               "south_africa": {"lure_recall": sa_recall if sa_recall is not None else recall,
                                "false_alarm_rate": sa_alarms if sa_alarms is not None else alarms,
                                "complete": complete, "unanswered": unanswered}}
    if withheld:
        metrics["bar_withheld"] = withheld
    return ({"lines_trained": lines}, metrics)


class Gate(unittest.TestCase):
    def test_a_better_version_with_more_lines_is_promoted(self):
        self.assertEqual(gate.decide(version(80_000, 0.95, 0.02), version(60_000, 0.93, 0.03)), "promote")

    # The case that matters (operator, 2026-11-02): worse than 1.0 on both relative figures and fewer lines,
    # but inside the broken lines, promotes. The old gate kept this version; the new one must not.
    def test_a_worse_version_inside_the_broken_lines_is_promoted(self):
        old = version(60_000, 0.93, 0.03)
        self.assertEqual(gate.decide(version(50_000, 0.80, 0.05), old), "promote")

    def test_false_alarms_over_the_broken_line_keeps_the_previous_version(self):
        old = version(60_000, 0.93, 0.03)
        self.assertIn("10 percent broken line", gate.decide(version(80_000, 0.95, 0.11), old))
        self.assertIn("south_africa", gate.decide(version(80_000, 0.95, 0.02, sa_alarms=0.20), old))

    def test_lure_recall_under_the_broken_line_keeps_the_previous_version(self):
        old = version(60_000, 0.93, 0.03)
        self.assertIn("40 percent broken line", gate.decide(version(80_000, 0.39, 0.02), old))
        self.assertIn("south_africa", gate.decide(version(80_000, 0.95, 0.02, sa_recall=0.10), old))

    def test_a_different_held_out_file_keeps_the_previous_version(self):
        old = version(60_000, 0.93, 0.03)
        self.assertIn("same held-out file", gate.decide(version(80_000, 0.95, 0.02, sha="e2"), old))

    # §13 completion review gap 1: unanswered benign pages lower the false alarms, so an incomplete run never promotes.
    def test_an_incomplete_or_withheld_evaluation_is_never_promoted(self):
        old = version(60_000, 0.93, 0.03)
        self.assertIn("incomplete (34 pages unanswered)", gate.decide(version(80_000, 0.95, 0.01, unanswered=34), old))
        self.assertIn("withheld", gate.decide(version(80_000, 0.95, 0.01, withheld="spark run incomplete"), old))
        self.assertIn("previous version's overall evaluation is incomplete",
                      gate.decide(version(80_000, 0.95, 0.01), version(60_000, 0.93, 0.03, unanswered=2)))

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
            # Worse beside 1.1 but inside the broken lines: still promotes (the relative figures never block).
            self.assertEqual(gate.main(["1.0", "1.1"]), 0)
            self.assertEqual(gate.main(["1.2", "1.0"]), 2)


if __name__ == "__main__":
    unittest.main()
