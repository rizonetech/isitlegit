"""scripts/glimmer/model_card.py (D03 T04 §17): a version's card made only from its records, with a loss chart of one
point a step, the previous version beside it, and a check that fails a missing, typed or stale figure."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "model_card.py"
spec = importlib.util.spec_from_file_location("model_card", SCRIPT)
mc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mc)

TRAINING = """# Training

## Training

- Loupe 1.0: isitlegit-loupe-1-0, set 3 of 3 lines
{more}
## Deployment

- deployment isitlegit-loupe on 1 x NVIDIA_H100_80GB, scale to zero after 300s, warm-up median 140 s

## Decisions
"""


def split(lines):
    return {"lines": lines, "sha256": "ab" * 32, "by_origin": {"public": lines}, "by_source": {"phreshphish": lines},
            "by_lure_type": {"credential": lines}, "south_africa": 1, "brands": 2, "screenshots": lines,
            "tokens": {"total": 4100 * lines, "text": 788 * lines, "image": 3312 * lines, "trained": 38 * lines,
                       "prompt": 4062 * lines, "per_line": {"min": 4000, "median": 4100, "max": 4200}}}


def evaluation(recall, alarms):
    figures = {"lure_recall": recall, "false_alarm_rate": alarms, "accuracy": 0.95, "latency_ms_median": 900,
               "usd_per_page": 0.0004}
    return {"eval_sha256": "cd" * 32, "overall": figures, "south_africa": figures, "by_lure_type": {"credential": figures},
            "spark": {"overall": {**figures, "lure_recall": 0.9}}, "bar": "passed", "misses_by_cause": {"brand absent": 3}}


class Card(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="card-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.docs = self.root / "docs"
        self.store = self.root / "store"
        self.docs.mkdir()
        for p in (mock.patch.object(mc, "DOCS", self.docs), mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(self.store)})):
            p.start()
            self.addCleanup(p.stop)

    def version(self, v, lines, recall, alarms):
        (self.docs / f"dataset-{v}.json").write_text(json.dumps({"version": v, "train": split(lines), "eval": split(1)}))
        run = self.store / "runs" / f"loupe-{v}"
        run.mkdir(parents=True)
        (run / "metrics.jsonl").write_text("".join(json.dumps({"step": s, "loss": 1.0 / s, "seconds": 7.0 * s}) + "\n" for s in range(1, 5)))
        (run / "run.json").write_text(json.dumps({
            "model_id": f"isitlegit-loupe-{v.replace('.', '-')}", "hyperparameters": {"lora_rank": 8, "learning_rate": 1e-4,
            "batch_size": 8, "epochs": 1}, "started": "2026-10-30T00:00:00+00:00", "ended": "2026-10-30T09:00:00+00:00",
            "sessions": ["ts-1"], "lines_trained": lines, "steps": 4, "first_loss": 1.0, "last_loss": 0.25,
            "tokens_sent": 1000, "rated_usd": 0.01, "resumes": 0}))
        ev = self.store / "runs" / f"eval-{v}"
        ev.mkdir(parents=True)
        (ev / "metrics.json").write_text(json.dumps(evaluation(recall, alarms)))

    def test_a_card_is_made_from_its_records_with_a_point_a_step(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
        card = json.loads((self.docs / "loupe-1.0.json").read_text())
        self.assertEqual(card["data"]["lines_trained"], 3)
        self.assertEqual(card["tokens"]["image"], 9936)
        self.assertEqual(card["results"]["loupe"]["overall"]["lure_recall"], 0.93)
        self.assertEqual(card["results"]["spark"]["overall"]["lure_recall"], 0.9)
        self.assertEqual((self.docs / "loupe-1.0-loss.svg").read_text().count("<circle"), 4)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("## Loupe 1.0", page)
        self.assertIn("NVIDIA_H100_80GB", page)
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["--check"]), 0)

    def test_the_check_fails_a_typed_figure_and_a_missing_card(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more="- Loupe 1.1: isitlegit-loupe-1-1, set 5 of 5 lines\n"))
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
        card = json.loads((self.docs / "loupe-1.0.json").read_text())
        card["results"]["loupe"]["overall"]["lure_recall"] = 0.99  # typed, not read
        (self.docs / "loupe-1.0.json").write_text(json.dumps(card))
        problems = mc.check(self.store, (self.docs / "training.md").read_text())
        self.assertIn("Loupe 1.0: the card differs from its records; rebuild it", problems)
        self.assertIn("Loupe 1.1: no card", problems)

    def test_an_empty_figure_is_reported_and_a_later_version_shows_the_one_before(self):
        self.version("1.0", 3, 0.93, 0.03)
        self.version("1.1", 5, 0.95, 0.02)
        (self.docs / "training.md").write_text(TRAINING.format(more="- Loupe 1.1: isitlegit-loupe-1-1, set 5 of 5 lines\n"))
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
            mc.main(["1.1"])
        card = json.loads((self.docs / "loupe-1.1.json").read_text())
        self.assertEqual(card["results"]["previous"]["version"], "1.0")
        self.assertEqual(card["results"]["previous"]["lines_trained"], 3)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("Against Loupe 1.0 (3 lines)", page)
        self.assertEqual(page.count("## Loupe 1.0"), 1)
        card["deployment"] = []
        self.assertIn("card.deployment", mc.missing(card))


if __name__ == "__main__":
    unittest.main()
