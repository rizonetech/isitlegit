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

- Loupe 1.0: isitlegit-loupe-1-0, set 3 of 3 lines (1 tokens, seed 1), dataset abababababababababababababababababababababababababababababababab
{more}
## Deployment

- deployment isitlegit-loupe serving isitlegit-loupe-1-0 on 1 x NVIDIA_H100_80GB, scale to zero after 300s, warm-up median 140 s

## Decisions

- Model card: [docs/glimmer/model-card.md](model-card.md)
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
    return {"eval_sha256": "ab" * 32, "overall": figures, "south_africa": figures, "by_lure_type": {"credential": figures},
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
        (run / "metrics.jsonl").write_text("".join(json.dumps({"step": s, "loss": 1.0 / s, "grad_norm": 100.0 + s, "seconds": 7.0 * s}) + "\n" for s in range(1, 5)))
        (run / "run.json").write_text(json.dumps({
            "model_id": f"isitlegit-loupe-{v.replace('.', '-')}", "hyperparameters": {"lora_rank": 8, "learning_rate": 1e-4,
            "batch_size": 8, "epochs": 1}, "started": "2026-10-30T00:00:00+00:00", "ended": "2026-10-30T09:00:00+00:00",
            "sessions": ["ts-1"], "lines_trained": lines, "steps": 4, "first_loss": 1.0, "last_loss": 0.25,
            "tokens_sent": 1000, "rated_usd": 0.01, "resumes": 0, "outcome": "completed"}))
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

    # §17 plan review gaps 2 and 3: every published artifact is read back, and records that disagree make no card.
    def test_the_check_fails_an_altered_or_deleted_markdown_section_and_loss_chart(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
            self.assertEqual(mc.main(["--check"]), 0)
        page, chart = self.docs / "model-card.md", self.docs / "loupe-1.0-loss.svg"
        kept_page, kept_chart = page.read_text(), chart.read_text()
        for name, damage, restore in (
            ("an altered figure", lambda: page.write_text(kept_page.replace("98.0%", "99.0%").replace("93.0%", "99.0%")), lambda: page.write_text(kept_page)),
            ("a deleted page", lambda: page.unlink(), lambda: page.write_text(kept_page)),
            ("an altered chart", lambda: chart.write_text(kept_chart.replace("<circle", "<rect", 1)), lambda: chart.write_text(kept_chart)),
            ("a deleted chart", lambda: chart.unlink(), lambda: chart.write_text(kept_chart)),
        ):
            damage()
            with mock.patch("sys.stdout"):
                self.assertEqual(mc.main(["--check"]), 1, name)
            restore()
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["--check"]), 0)

    def test_records_that_disagree_make_no_card_and_leave_the_earlier_one(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
        earlier = (self.docs / "loupe-1.0.json").read_text()
        # An evaluation run on another held-out file than the dataset record's.
        path = self.store / "runs" / "eval-1.0" / "metrics.json"
        record = json.loads(path.read_text())
        path.write_text(json.dumps({**record, "eval_sha256": "ee" * 32}))
        with mock.patch("sys.stderr"):
            self.assertEqual(mc.main(["1.0"]), 1)
        self.assertEqual((self.docs / "loupe-1.0.json").read_text(), earlier)
        path.write_text(json.dumps(record))
        # A step recorded twice, and a step count that disagrees with the run's.
        metrics = self.store / "runs" / "loupe-1.0" / "metrics.jsonl"
        kept = metrics.read_text()
        metrics.write_text(kept + kept.splitlines()[0] + "\n")
        with mock.patch("sys.stderr"):
            self.assertEqual(mc.main(["1.0"]), 1)
        metrics.write_text("".join(kept.splitlines(True)[:3]))
        with mock.patch("sys.stderr"):
            self.assertEqual(mc.main(["1.0"]), 1)
        self.assertEqual((self.docs / "loupe-1.0.json").read_text(), earlier)

    # §17 plan review gap 4: a failed run and a completed run awaiting its evaluation each say why they have no card.
    def test_a_failed_run_and_an_unevaluated_one_say_why_they_have_no_card(self):
        self.version("1.0", 3, 0.93, 0.03)
        more = "- Loupe 1.1: isitlegit-loupe-1-1, set 5 of 5 lines (1 tokens, seed 1), dataset abababababababababababababababababababababababababababababababab\n- Loupe 1.2: isitlegit-loupe-1-2, set 5 of 5 lines (1 tokens, seed 1), dataset abababababababababababababababababababababababababababababababab\n"
        (self.docs / "training.md").write_text(TRAINING.format(more=more))
        failed = self.store / "runs" / "loupe-1.1"
        failed.mkdir(parents=True)
        (failed / "run.json").write_text(json.dumps({"outcome": "failed"}))
        waiting = self.store / "runs" / "loupe-1.2"
        waiting.mkdir(parents=True)
        (waiting / "run.json").write_text(json.dumps({"outcome": "completed"}))
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
        problems = mc.check(self.store, (self.docs / "training.md").read_text())
        self.assertIn("Loupe 1.1: no card yet: its run is failed, so it has no card (a version is never reused: train the next one)", problems)
        self.assertTrue(any(p.startswith("Loupe 1.2: no card yet: its run completed and awaits its evaluation: `node scripts/glimmer/evaluate.ts loupe 1.2`") for p in problems))
        self.assertFalse(any(p.startswith("Loupe 1.0") for p in problems))

    # §17 plan review gap 5: a later version never inherits an earlier one's deployment or warm-ups.
    def test_a_version_shows_only_its_own_deployment_and_warm_ups(self):
        self.version("1.1", 3, 0.93, 0.03)
        folder = self.store / "runs" / "warmup"
        folder.mkdir(parents=True)
        (folder / "a.json").write_text(json.dumps({"version": "1.0", "cold": True, "warmup_ms": 195_000, "zero_ms_after_last_request": 319_000}))
        (self.docs / "training.md").write_text(TRAINING.format(more="").replace("Loupe 1.0: isitlegit-loupe-1-0, set 3 of 3 lines", "Loupe 1.1: isitlegit-loupe-1-1, set 3 of 3 lines"))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.1"]), 0)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("Warm-up: not measured yet.", page)
        self.assertNotIn("NVIDIA_H100_80GB", page)
        self.assertIn("not deployed: no deployment is recorded for this version", page)

    # §17 plan review gaps 1 and 6: the readable card carries the promised parts and every recorded finding's scope.
    def test_the_card_names_its_sources_checkpoint_tokens_slices_and_recorded_findings(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.store / "runs" / "loupe-1.0" / "output-model.json").write_text(json.dumps({"model_id": "isitlegit-loupe-1-0", "checkpoint": "step-4"}))
        (self.docs / "sources.md").write_text("| Source | Dataset | Licence | Licence link | Decision |\n| --- | --- | --- | --- | --- |\n"
                                              "| `phreshphish` | https://example.test/p | CC BY 4.0 | https://example.test/licence | accepted |\n")
        ref = self.store / "runs" / "eval-1.0" / "reference"
        ref.mkdir(parents=True)
        (ref / "loupe.causes.json").write_text(json.dumps({"unconfirmed": 0, "pages": [{}, {}], "confirmed": {"brand absent: its own page": 2}}))
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("| phreshphish | https://example.test/p | CC BY 4.0 | https://example.test/licence |", page)
        self.assertIn("promoted checkpoint step-4.", page)
        self.assertIn("3312 image tokens a screenshot", page)
        self.assertIn("| South Africa | Loupe | 10 (4 lures, 6 benign) |", page)
        self.assertIn("| credential |", page)
        self.assertIn("Independent reference set, its 2 errors, each confirmed from its screenshot: 2 brand absent: its own page.", page)
        self.assertIn("the teacher-agreed set", page)

    # §17: the measured warm-up comes from the receipts and the key check's cold start, and the running-time rule is shown.
    def test_the_card_shows_the_measured_warm_up_and_the_running_time_rule(self):
        self.version("1.0", 3, 0.93, 0.03)
        folder = self.store / "runs" / "warmup"
        folder.mkdir(parents=True)
        for number, (cold, zero) in enumerate(((195_000, 319_000), (137_800, 335_000), (169_100, 336_000), (142_900, 335_000))):
            (folder / f"r{number}.json").write_text(json.dumps({"version": "1.0", "cold": True, "warmup_ms": cold, "zero_ms_after_last_request": zero}))
        (folder / "warm.json").write_text(json.dumps({"version": "1.0", "cold": False, "warmup_ms": None, "zero_ms_after_last_request": 330_000}))
        key = "- 2026-10-31 13:54 UTC, key check (`deploy.ts key-check 1.0`): one-token call answered 200 after 9 attempts and 130.7 s of cold start"
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
        (self.docs / "training.md").write_text(TRAINING.format(more="").replace("Loupe 1.0: isitlegit-loupe-1-0, set 3 of 3 lines", "Loupe 1.1: isitlegit-loupe-1-1, set 3 of 3 lines"))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.1"]), 0)
        self.assertIn("Warm-up: not measured yet.", (self.docs / "model-card.md").read_text())
        self.assertIn("promoted checkpoint not recorded.", (self.docs / "model-card.md").read_text())

    def make(self, version="1.0", more="", **kw):
        self.version(version, 3, kw.get("recall", 0.93), kw.get("alarms", 0.03))
        (self.docs / "training.md").write_text(TRAINING.format(more=more))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main([version]), 0)

    def files(self, version="1.0"):
        return {f.name: f.read_bytes() for f in self.docs.iterdir() if f.name.startswith(("model-card", f"loupe-{version}"))}

    # §17 completion review C2: dataset and licence links apart, and a private source explained without naming a client.
    def test_a_source_shows_its_dataset_and_licence_link_apart_and_a_private_one_is_explained(self):
        self.version("1.0", 3, 0.93, 0.03)
        split_by = json.loads((self.docs / "dataset-1.0.json").read_text())
        split_by["train"]["by_source"] = {"phreshphish": 2, "samples-body": 1}
        (self.docs / "dataset-1.0.json").write_text(json.dumps(split_by))
        (self.docs / "sources.md").write_text("| Source | Dataset | Licence | Licence link | Decision |\n| --- | --- | --- | --- | --- |\n"
                                              "| `phreshphish` | https://example.test/data | CC BY 4.0 | https://example.test/licence | accepted |\n")
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("| phreshphish | https://example.test/data | CC BY 4.0 | https://example.test/licence |", page)
        self.assertIn("| samples-body | private pilot-client mail, redacted before any use (D03 T04 §7) | the client's written consent for redacted training | not published: the consent is kept privately and names the client |", page)

    # C3: the training record must describe what was trained.
    def test_a_run_that_trained_another_number_of_lines_than_the_dataset_record_makes_no_card(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        path = self.store / "runs" / "loupe-1.0" / "run.json"
        record = json.loads(path.read_text())
        path.write_text(json.dumps({**record, "lines_trained": 2}))
        with mock.patch("sys.stderr") as err:
            self.assertEqual(mc.main(["1.0"]), 1)
        self.assertIn("trained 3 of 3 lines, run.json 2", "".join(c.args[0] for c in err.write.call_args_list))
        self.assertFalse((self.docs / "loupe-1.0.json").exists())
        # The trainer's selection, when kept, must name the same training file.
        path.write_text(json.dumps(record))
        (self.store / "runs" / "loupe-1.0" / "selection.json").write_text(json.dumps({"file_sha": "ff" * 32, "dataset_sha": "ee" * 32, "lines": 3}))
        with mock.patch("sys.stderr") as err:
            self.assertEqual(mc.main(["1.0"]), 1)
        self.assertIn("selection names training file", "".join(c.args[0] for c in err.write.call_args_list))

    # Round 1, finding 1: the digest binding comes from the trainer's Training record, never from matching counts alone.
    def test_a_training_record_with_no_digest_or_another_one_makes_no_card(self):
        self.version("1.0", 3, 0.93, 0.03)
        record = TRAINING.format(more="")
        for name, text, expect in (
            ("no digest", record.replace(", dataset " + "ab" * 32, ""), "names no dataset digest"),
            ("another digest", record.replace("dataset " + "ab" * 32, "dataset " + "cd" * 32), "is not the dataset record's"),
            ("another count", record.replace("set 3 of 3 lines", "set 3 of 4 lines"), "trained 3 of 4 lines"),
        ):
            (self.docs / "training.md").write_text(text)
            with mock.patch("sys.stderr") as err:
                self.assertEqual(mc.main(["1.0"]), 1, name)
            self.assertIn(expect, "".join(c.args[0] for c in err.write.call_args_list), name)
            self.assertFalse((self.docs / "loupe-1.0.json").exists(), name)

    # Finding 3: a subset's page says the figures describe the available dataset, not what was trained.
    def test_a_subset_run_says_its_figures_describe_the_available_dataset(self):
        self.version("1.0", 3, 0.93, 0.03)
        run = self.store / "runs" / "loupe-1.0" / "run.json"
        run.write_text(json.dumps({**json.loads(run.read_text()), "lines_trained": 2}))
        (self.docs / "training.md").write_text(TRAINING.format(more="").replace("set 3 of 3 lines", "set 2 of 3 lines"))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("Trained on 2 of the dataset's 3 lines (the trainer's cut to fit its limits)", page)
        self.assertIn("describe the whole available dataset, not the trained subset", page)
        self.assertTrue(json.loads((self.docs / "loupe-1.0.json").read_text())["data"]["subset"])

    # Round 2: a step with no finite loss, or a first or last loss that disagrees with the metrics, makes no card.
    def test_a_step_without_a_loss_or_a_run_with_other_end_losses_makes_no_card(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        metrics = self.store / "runs" / "loupe-1.0" / "metrics.jsonl"
        kept = metrics.read_text()
        rows = [json.loads(l) for l in kept.splitlines()]
        for name, damage, expect in (
            ("a null loss", lambda: [dict(r, loss=None) if r["step"] == 2 else r for r in rows], "no finite loss at 1 step(s), the first being step 2"),
            ("a missing loss", lambda: [{k: v for k, v in r.items() if k != "loss"} if r["step"] == 3 else r for r in rows], "the first being step 3"),
            ("a non-finite loss", lambda: [dict(r, loss=float("nan")) if r["step"] == 2 else r for r in rows], "the first being step 2"),
            ("another last loss", lambda: [dict(r, loss=0.5) if r["step"] == 4 else r for r in rows], "first or last loss is not the metrics'"),
        ):
            metrics.write_text("".join(json.dumps(r) + "\n" for r in damage()))
            with mock.patch("sys.stderr") as err:
                self.assertEqual(mc.main(["1.0"]), 1, name)
            self.assertIn(expect, "".join(c.args[0] for c in err.write.call_args_list), name)
            self.assertFalse((self.docs / "loupe-1.0.json").exists(), name)
        metrics.write_text(kept)
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)

    # Finding 2: a failed version keeps its number but is no predecessor.
    def test_a_failed_version_between_two_completed_ones_is_skipped_as_predecessor(self):
        self.version("1.0", 3, 0.93, 0.03)
        self.version("1.2", 5, 0.95, 0.02)
        failed = self.store / "runs" / "loupe-1.1"
        failed.mkdir(parents=True)
        (failed / "run.json").write_text(json.dumps({"outcome": "failed"}))
        more = ("- Loupe 1.1: isitlegit-loupe-1-1, set 5 of 5 lines (1 tokens, seed 1), dataset " + "ab" * 32 + "\n"
                "- Loupe 1.2: isitlegit-loupe-1-2, set 5 of 5 lines (1 tokens, seed 1), dataset " + "ab" * 32 + "\n")
        (self.docs / "training.md").write_text(TRAINING.format(more=more))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
            self.assertEqual(mc.main(["1.2"]), 0)
            self.assertEqual(mc.main(["--check"]), 1)
        self.assertEqual(json.loads((self.docs / "loupe-1.2.json").read_text())["results"]["previous"]["version"], "1.0")
        # The check reports the failed version's explanation, and nothing else is wrong.
        problems = mc.check(self.store, (self.docs / "training.md").read_text())
        self.assertEqual([p for p in problems if not p.startswith("Loupe 1.1: no card yet: its run is failed")], [])

    # C4: standing comes from the version's own evidence.
    def test_the_standing_follows_the_figures_and_the_deployment(self):
        self.make("1.0", alarms=0.01)
        page = (self.docs / "model-card.md").read_text()
        # 1 percent false alarms meet that part; the recall part is unmeasured, so the standard is not yet met.
        self.assertIn("- False alarms: 1.0 percent at their highest of the two sets, so the part is met.", page)
        self.assertIn("Loupe 1.0 does not yet meet the project's own standard.", page)
        self.assertNotIn("not the trained subset", page)
        # A version with no deployment is not told it ships.
        shutil.rmtree(self.root)
        self.setUp()
        self.version("1.1", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more="").replace("Loupe 1.0: isitlegit-loupe-1-0, set 3 of 3 lines", "Loupe 1.1: isitlegit-loupe-1-1, set 3 of 3 lines"))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.1"]), 0)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("It is not deployed.", page)
        self.assertNotIn("It ships", page)
        self.assertIn("- False alarms: 3.0 percent at their highest of the two sets, so the part is not met.", page)

    # C5: the predecessor's card is required, and the changes are shown.
    def test_a_later_version_needs_the_earlier_card_and_shows_the_change(self):
        self.version("1.0", 3, 0.93, 0.03)
        self.version("1.1", 5, 0.95, 0.02)
        (self.docs / "training.md").write_text(TRAINING.format(more="- Loupe 1.1: isitlegit-loupe-1-1, set 5 of 5 lines (1 tokens, seed 1), dataset abababababababababababababababababababababababababababababababab\n"))
        with mock.patch("sys.stderr") as err:
            self.assertEqual(mc.main(["1.1"]), 1)
        self.assertIn("Loupe 1.0 has no card to compare against; make it first", "".join(c.args[0] for c in err.write.call_args_list))
        self.assertFalse((self.docs / "loupe-1.1.json").exists())
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["1.0"]), 0)
            self.assertEqual(mc.main(["1.1"]), 0)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("training lines 3 to 5 (+2)", page)
        self.assertIn("(+2.0 points)", page)
        self.assertIn("(-1.0 points)", page)
        # A card that dropped its comparison is caught by the check.
        card = json.loads((self.docs / "loupe-1.1.json").read_text())
        del card["results"]["previous"]
        (self.docs / "loupe-1.1.json").write_text(json.dumps(card))
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["--check"]), 1)

    # C6 and C7: records that cannot make a card change nothing, whatever is wrong with them.
    def test_invalid_malformed_or_unready_records_change_no_artifact(self):
        self.make("1.0")
        before = self.files()
        run = self.store / "runs" / "loupe-1.0" / "run.json"
        good = run.read_text()
        for name, damage in (
            ("a missing learning rate", lambda: run.write_text(json.dumps({**json.loads(good), "hyperparameters": {"lora_rank": 8, "batch_size": 8, "epochs": 1}}))),
            ("a record that is not JSON", lambda: run.write_text("{ broken")),
            ("a record of the wrong shape", lambda: run.write_text(json.dumps([1, 2]))),
            ("a run still running", lambda: run.write_text(json.dumps({**json.loads(good), "outcome": "running"}))),
        ):
            damage()
            with mock.patch("sys.stderr") as err:
                self.assertEqual(mc.main(["1.0"]), 1, name)
            self.assertTrue("".join(c.args[0] for c in err.write.call_args_list).startswith("model-card: refused"), name)
            self.assertEqual(self.files(), before, name)
        run.write_text(good)
        # A completed run awaiting its evaluation says which command comes next.
        (self.store / "runs" / "eval-1.0" / "metrics.json").unlink()
        with mock.patch("sys.stderr") as err:
            self.assertEqual(mc.main(["1.0"]), 1)
        self.assertIn("`node scripts/glimmer/evaluate.ts loupe 1.0`", "".join(c.args[0] for c in err.write.call_args_list))
        self.assertEqual(self.files(), before)

    def test_a_write_that_fails_names_the_file_and_the_way_back(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        real = mc.write_atomic
        def failing(path, text):
            if path.name == "loupe-1.0.json":
                raise OSError("disk full")
            real(path, text)
        with mock.patch.object(mc, "write_atomic", failing), mock.patch("sys.stderr") as err:
            self.assertEqual(mc.main(["1.0"]), 1)
        message = "".join(c.args[0] for c in err.write.call_args_list)
        self.assertIn("could not write", message)
        self.assertIn("loupe-1.0.json", message)
        self.assertIn("run `python3 scripts/glimmer/model_card.py 1.0` again", message)
        # The page is written last, so a failure before it leaves no page naming a card that is not there.
        self.assertFalse((self.docs / "model-card.md").exists())

    # C8: the training record must link the card.
    def test_the_check_fails_when_the_training_record_does_not_link_the_card(self):
        self.make("1.0")
        training = self.docs / "training.md"
        kept = training.read_text()
        for damage in (kept.replace("(model-card.md)", "(missing.md)"), kept.replace("- Model card: [docs/glimmer/model-card.md](model-card.md)\n", "")):
            training.write_text(damage)
            with mock.patch("sys.stdout"):
                self.assertEqual(mc.main(["--check"]), 1)
        training.write_text(kept)
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["--check"]), 0)

    # E1 to E3: reading order, navigation, labels, deployment state and the chart's numbers.
    def test_the_card_opens_with_use_and_standing_links_its_parts_and_labels_its_figures(self):
        self.make("1.0")
        page = (self.docs / "model-card.md").read_text()
        self.assertLess(page.index("Intended use:"), page.index("## Where Loupe 1.0 stands"))
        self.assertLess(page.index("## Where Loupe 1.0 stands"), page.index("### Results of Loupe 1.0"))
        for target in ("where-loupe-10-stands", "results-of-loupe-10", "training-of-loupe-10", "deployment-of-loupe-10", "limits-of-loupe-10"):
            self.assertIn(f"](#{target})", page)
        for internal in ("median ms", "usd", "fake_shop", "lure_recall"):
            self.assertNotIn(internal, page.replace("US$", ""))
        self.assertIn("| Lure recall |", page)
        self.assertIn("Deployment: see the record below.", page)
        self.assertIn("Deployment record (dated entries, oldest first):", page)

    def test_the_loss_chart_has_labelled_axes_and_its_numbers_are_a_checked_table(self):
        self.make("1.0")
        chart = (self.docs / "loupe-1.0-loss.svg").read_text()
        for label in (">step<", ">loss<", ">1</text>", ">4</text>", "aria-labelledby", "<desc"):
            self.assertIn(label, chart)
        table = (self.docs / "loupe-1.0-loss.csv").read_text().splitlines()
        self.assertEqual(table[0], "step,loss")
        self.assertEqual(len(table), 5)
        self.assertIn("(loupe-1.0-loss.csv)", (self.docs / "model-card.md").read_text())
        (self.docs / "loupe-1.0-loss.csv").write_text("step,loss\n1,9\n")
        with mock.patch("sys.stdout"):
            self.assertEqual(mc.main(["--check"]), 1)

    def test_the_check_fails_a_typed_figure_and_a_missing_card(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more="- Loupe 1.1: isitlegit-loupe-1-1, set 5 of 5 lines (1 tokens, seed 1), dataset abababababababababababababababababababababababababababababababab\n"))
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
        card = json.loads((self.docs / "loupe-1.0.json").read_text())
        card["results"]["loupe"]["overall"]["lure_recall"] = 0.99  # typed, not read
        (self.docs / "loupe-1.0.json").write_text(json.dumps(card))
        problems = mc.check(self.store, (self.docs / "training.md").read_text())
        self.assertIn("Loupe 1.0: the card differs from its records; rebuild it", problems)
        self.assertTrue(any(p.startswith("Loupe 1.1: no card yet: its run is not recorded") for p in problems))

    def test_an_empty_figure_is_reported_and_a_later_version_shows_the_one_before(self):
        self.version("1.0", 3, 0.93, 0.03)
        self.version("1.1", 5, 0.95, 0.02)
        (self.docs / "training.md").write_text(TRAINING.format(more="- Loupe 1.1: isitlegit-loupe-1-1, set 5 of 5 lines (1 tokens, seed 1), dataset abababababababababababababababababababababababababababababababab\n"))
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
            mc.main(["1.1"])
        card = json.loads((self.docs / "loupe-1.1.json").read_text())
        self.assertEqual(card["results"]["previous"]["version"], "1.0")
        self.assertEqual(card["results"]["previous"]["lines_trained"], 3)
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("Against Loupe 1.0: training lines 3 to 5 (+2); lure recall 93.0% (4 of 4)", page)
        self.assertIn("(+2.0 points)", page)
        self.assertEqual(page.count("## Loupe 1.0"), 1)
        # A part that is empty and not a recorded state is a gap; no deployment is itself a recorded state.
        card["data"]["train"]["sha256"] = ""
        self.assertIn("card.data.train.sha256", mc.missing(card))
        card["deployment"] = []
        self.assertNotIn("card.deployment", mc.missing(card))

    # D03 T04 §13: the card reads the keys evaluate.ts writes, and shows false alarms by source, the samples' recall
    # and the reference set; an unknown cost and an empty miss list are records, not gaps.
    def test_the_card_shows_every_figure_evaluate_writes(self):
        self.version("1.0", 3, 0.93, 0.03)
        (self.docs / "training.md").write_text(TRAINING.format(more=""))
        with mock.patch("sys.stdout"):
            mc.main(["1.0"])
        page = (self.docs / "model-card.md").read_text()
        self.assertIn("| Median latency | 0.9 s | 0.9 s |", page)
        self.assertIn("| False alarm rate | 3.0% (0 of 6) | 3.0% (0 of 6) |", page)
        self.assertIn("| Cost per page | not known per page | US$0.0074 |", page)
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
