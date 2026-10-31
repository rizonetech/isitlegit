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


def bar(recall, alarms, judged=True):
    """A bar as evaluate.ts writes it (`timeBoxedBar`)."""
    def part(lures, benign, is_judged):
        return {"loupe_lure_recall": recall, "spark_lure_recall": 0.9, "loupe_false_alarm_rate": alarms, "lures": lures,
                "benign": benign, "judged": is_judged, "passed": True if is_judged else None}
    return {"result": "passed", "overall": part(4, 6, True), "south_africa": part(40, 50, True) if judged else part(0, 2, False)}


def evaluation(recall, alarms):
    # The keys evaluate.ts writes; Loupe's cost is not known per page (its deployment is billed by GPU time).
    figures = {"lure_recall": recall, "false_alarm_rate": alarms, "accuracy": 0.95, "latency_median_ms": 900,
               "cost_per_page_usd": None, "lures": 4, "benign": 6, "pages": 10, "missed": [], "false_alarms": ["b"]}
    benign = {"benign-sa": {**figures, "false_alarm_rate": 0.02, "benign": 50}}
    return {"eval_sha256": "cd" * 32, "overall": figures, "south_africa": figures, "by_lure_type": {"credential": figures},
            "by_benign_source": benign, "samples": {**figures, "lure_recall": 0.75},
            "spark": {"overall": {**figures, "lure_recall": 0.9, "cost_per_page_usd": 0.0074}}, "bar": bar(recall, alarms),
            "bar_withheld": None, "bar_both_sets": "passed",
            "reference": {"loupe": {"overall": {**figures, "pages": 493}}, "spark": {"overall": figures},
                          "bar": bar(recall, alarms, judged=False), "bar_withheld": None},
            "misses_by_cause": {"brand absent": 3}}


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
        (ev / "loupe.causes.json").write_text(json.dumps({"confirmed": {"brand absent from training: its own page": 3}, "unconfirmed": 0, "pages": []}))

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

    # §17: the measured warm-up comes from the receipts and the key check's cold start, and the running-time rule is shown.
    def test_the_card_shows_the_measured_warm_up_and_the_running_time_rule(self):
        self.version("1.0", 3, 0.93, 0.03)
        folder = self.store / "runs" / "warmup"
        folder.mkdir(parents=True)
        for number, (cold, zero) in enumerate(((195_000, 319_000), (137_800, 335_000), (169_100, 336_000), (142_900, 335_000))):
            (folder / f"r{number}.json").write_text(json.dumps({"cold": True, "warmup_ms": cold, "zero_ms_after_last_request": zero}))
        (folder / "warm.json").write_text(json.dumps({"cold": False, "warmup_ms": None, "zero_ms_after_last_request": 330_000}))
        key = "- 2026-10-31 13:54 UTC, key check: one-token call answered 200 after 9 attempts and 130.7 s of cold start"
        (self.docs / "training.md").write_text(TRAINING.format(more="").replace("warm-up median 140 s\n", "warm-up median 140 s\n" + key + "\n"))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
        card = json.loads((self.docs / "loupe-1.0.json").read_text())
        # Five cold starts (four receipts and the key check), the warm answer not counted: 130.7 137.8 142.9 169.1 195.0.
        self.assertEqual(card["warmup"], {"cold_starts": 5, "from_receipts": 4, "key_check_s": 130.7, "median_s": 142.9,
                                          "max_s": 195.0, "scale_to_zero_s_min": 319, "scale_to_zero_s_max": 336})
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("Warm-up: 5 cold starts measured from 0 replicas to the first answer, median 142.9 seconds, "
                      "maximum 195.0 seconds; the deployment read 0 replicas 319 to 336 seconds after the last request.", page)
        self.assertIn("Running time: 30 minutes a day on average since 2026-10-31, with one day borrowed ahead", page)

    def test_a_version_with_no_warm_up_receipts_says_it_was_not_measured(self):
        self.version("1.1", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.1"]), 0)
        self.assertIn("Warm-up: not measured yet.", (self.docs / "model-card.md").read_text())

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

    # D03 T04 §13: the card reads the keys evaluate.ts writes, and shows false alarms by source, the samples' recall
    # and the reference set; an unknown cost and an empty miss list are records, not gaps.
    def test_the_card_shows_every_figure_evaluate_writes(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("| latency median ms | 0.9 s | 0.9 s |", page)
        self.assertIn("| false alarm rate | 3.0% (0 of 6) | 3.0% (0 of 6) |", page)
        self.assertIn("| cost per page usd | not known per page | US$0.0074 |", page)
        self.assertIn("False alarms by benign source: benign-sa 2.0% (1 of 50).", page)
        self.assertIn("Redacted South African samples: lure recall 75.0% (3 of 4).", page)
        self.assertIn("Independent reference set (493 pages", page)
        self.assertNotIn("None |", page)
        # Where it stands, plainly, every figure from the records (operator, 2026-10-31 18:49 SAST).
        self.assertIn("Loupe 1.0 does not yet meet the project's own standard.", page)
        self.assertIn("not because the result is considered good enough", page)
        self.assertIn("South African slice: lure recall 93.0% (37 of 40)", page)
        self.assertIn("South African slice not judged (0 lures, 2 benign", page)
        self.assertIn("false alarms at most 2 percent, and lure recall above Muse Wonder's", page)
        self.assertIn("Muse Wonder's recall on these pages is not measured yet", page)
        # The list price is never shown as spend: billed is pending until §30's settled line, then that figure.
        self.assertIn("list price US$0.01; billed pending", page)
        training = (self.docs / "training.md").read_text().replace(
            "## Training\n", "## Training\n\n- Loupe 1.0 bill, 2026-11-01: reconciled: US$0.00\n", 1)
        (self.docs / "training.md").write_text(training)
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
        self.assertIn("list price US$0.01; billed US$0.00 under the free fine-tuning offer",
                      (self.docs / "model-card.md").read_text())
        card = json.loads((self.docs / "loupe-1.0.json").read_text())
        self.assertEqual(mc.missing(card), [])
        card["results"]["loupe"]["overall"]["accuracy"] = None
        self.assertIn("card.results.loupe.overall.accuracy", mc.missing(card))


if __name__ == "__main__":
    unittest.main()
