"""scripts/glimmer/train_serverless.py (D03 T04 §11): when a Loupe run may start, what it trains on, the cap lifted
only while training is proven free and restored by date, and the run's records, against a fake cookbook loop."""
import contextlib
import importlib.util
import io
import json
import logging
import os
import shutil
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "train_serverless.py"
spec = importlib.util.spec_from_file_location("train_serverless", SCRIPT)
ts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ts)
SAST = ts.SAST

MARKDOWN = """# Training

## Probe

- probe session ts-1: image step loss
{reconciled}

## Dataset

- train.jsonl sha256 {sha}

## Training

## Decisions
"""


def at(*args):
    return datetime(*args, tzinfo=SAST)


class Start(unittest.TestCase):
    def test_no_run_starts_at_the_cutoff_but_one_may_resume(self):
        text = MARKDOWN.format(reconciled="", sha="abc")
        ts.check_start(at(2026, 11, 1, 11, 59), "abc", text, resuming=False)
        with self.assertRaisesRegex(ts.Refused, "12:00 SAST"):
            ts.check_start(at(2026, 11, 1, 12, 0), "abc", text, resuming=False)
        ts.check_start(at(2026, 11, 1, 15, 0), "abc", text, resuming=True)

    def test_a_dataset_whose_hash_is_not_recorded_is_refused(self):
        with self.assertRaisesRegex(ts.Refused, "not recorded under Dataset"):
            ts.check_start(at(2026, 10, 30, 9, 0), "other", MARKDOWN.format(reconciled="", sha="abc"), False)

    def test_versions_name_the_model_and_checkpoint(self):
        self.assertEqual(ts.names("1.0"), ("isitlegit-loupe-1-0", "loupe-1-0"))
        self.assertEqual(ts.names("1.12"), ("isitlegit-loupe-1-12", "loupe-1-12"))
        with self.assertRaises(ts.Refused):
            ts.names("v1")


class Cap(unittest.TestCase):
    def test_lifted_only_while_free_and_reconciled_at_zero(self):
        free = ts.reconciled(MARKDOWN.format(reconciled="- reconciled: US$0.00", sha="x"))
        self.assertEqual(free, 0.0)
        self.assertIsNone(ts.cap_usd(at(2026, 11, 30, 23, 0), free))
        self.assertEqual(ts.cap_usd(at(2026, 12, 1, 0, 0), free), 60.0)
        billed = ts.reconciled(MARKDOWN.format(reconciled="- reconciled: US$0.42", sha="x"))
        self.assertEqual(ts.cap_usd(at(2026, 10, 30, 9, 0), billed), 60.0)
        self.assertEqual(ts.cap_usd(at(2026, 10, 30, 9, 0), ts.reconciled(MARKDOWN.format(reconciled="", sha="x"))),
                         60.0)


class Fit(unittest.TestCase):
    def test_everything_when_it_fits(self):
        self.assertEqual(ts.fit(["a", "b"], [10, 10], 100, 1), [0, 1])

    def test_a_cut_keeps_each_group_in_proportion(self):
        groups = ["phreshphish/credential"] * 600 + ["scamferret/fake_shop"] * 300 + ["benign/none"] * 100
        tokens = [100] * 1000
        chosen = ts.fit(groups, tokens, 50_000, 7)
        self.assertLessEqual(sum(tokens[i] for i in chosen), 50_000)
        share = {g: sum(1 for i in chosen if groups[i] == g) / len(chosen) for g in set(groups)}
        self.assertAlmostEqual(share["phreshphish/credential"], 0.6, delta=0.02)
        self.assertAlmostEqual(share["scamferret/fake_shop"], 0.3, delta=0.02)
        self.assertEqual(chosen, ts.fit(groups, tokens, 50_000, 7))


class Tokens(unittest.TestCase):
    def test_a_screenshot_is_counted_as_the_image_it_is(self):
        seen = []

        class Renderer:
            def build_supervised_example(self, messages, train_on_what=None):
                chunks = []
                for message in messages:
                    for part in message["content"] if isinstance(message["content"], list) else [{"type": "text"}]:
                        seen.append(part.get("type"))
                        if part.get("type") == "image":
                            chunks.append(SimpleNamespace(type="image", expected_tokens=3312))
                        else:
                            chunks.append(SimpleNamespace(type="text", tokens=[0] * 7))
                return SimpleNamespace(chunks=chunks), []

        line = json.dumps({"messages": [{"role": "user", "content": [{"type": "text", "text": "x"},
                                                                     {"type": "image_url", "image_url": {"url": "data:y"}}]},
                                        {"role": "assistant", "content": "{}"}]})
        self.assertEqual(ts.line_tokens(line, Renderer(), None), 7 + 3312 + 7)
        self.assertNotIn("image_url", seen)


class Choose(unittest.TestCase):
    def test_time_is_sized_in_lines_and_a_cap_in_tokens(self):
        groups = ["a/credential"] * 600 + ["b/none"] * 400
        tokens = [4_000] * 1000
        now = at(2026, 11, 1, 21, 0)  # one hour before TRAIN_UNTIL
        by_time = ts.choose(groups, tokens, now, 0.1, None, 5)  # 0.1 lines a second: 360 lines in the hour
        self.assertLessEqual(len(by_time), 360)
        self.assertGreaterEqual(len(by_time), 350)
        share = sum(1 for i in by_time if groups[i] == "a/credential") / len(by_time)
        self.assertAlmostEqual(share, 0.6, delta=0.02)
        by_cap = ts.choose(groups, tokens, now, None, 1.0, 5)  # US$1 buys about 170,000 tokens: about 42 lines
        self.assertLessEqual(sum(tokens[i] for i in by_cap), int(1.0 / ts.USD_PER_TOKEN))
        self.assertEqual(ts.choose(groups, tokens, now, None, None, 5), list(range(1000)))


class TrainingFile(unittest.TestCase):
    """Loupe 1.0's training file is some 20 GB: it is streamed, and copied only when a cut makes a subset."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="loupe-file-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.train = self.dir / "train.jsonl"
        self.train.write_text("".join(f'{{"n": {i}}}\n' for i in range(10)) + "\n", encoding="utf-8")
        self.run = self.dir / "runs" / "loupe-1.0"

    def test_lines_are_streamed_and_counted_without_blank_ones(self):
        self.assertEqual(ts.count_lines(self.train), 10)
        self.assertEqual(next(ts.iter_lines(self.train)), '{"n": 0}\n')

    def test_every_line_chosen_trains_on_the_dataset_file_itself(self):
        self.assertEqual(ts.training_file(self.train, list(range(10)), 10, self.run), self.train)
        self.assertFalse((self.run / "train.subset.jsonl").exists())
        self.assertEqual(ts.resumed_file(self.train, self.run), self.train)

    def test_a_cut_streams_the_chosen_lines_in_order_and_a_resume_finds_them(self):
        chosen = ts.training_file(self.train, [7, 2, 5], 10, self.run)
        self.assertEqual(chosen, self.run / "train.subset.jsonl")
        self.assertEqual(chosen.read_text(encoding="utf-8"), '{"n": 2}\n{"n": 5}\n{"n": 7}\n')
        self.assertEqual(ts.resumed_file(self.train, self.run), chosen)
        self.assertEqual([p.name for p in self.run.iterdir()], ["train.subset.jsonl"])


class FakeLoop:
    """The cookbook's sft_loop as far as the wrapper uses it: a Config, main(), and the W&B logger it calls."""

    def __init__(self, steps, tokens_per_step=1000, fail_at=None, recorder=None):
        self.steps, self.tokens_per_step, self.fail_at, self.recorder = steps, tokens_per_step, fail_at, recorder
        self.logged = []
        self.config = None

    Config = staticmethod(lambda **kwargs: SimpleNamespace(**kwargs))  # the cookbook's dataclass, by its name

    def wandb_log(self, metrics, step=None):
        self.logged.append(step)

    def main(self, config):
        self.config = config
        self.wandb_log({"train/step": 0}, 0)
        for step in range(1, self.steps + 1):
            if self.fail_at == step:
                raise RuntimeError("trainer lost")
            self.wandb_log({"train/total_tokens": self.tokens_per_step, "train/ce_loss": 2.0 / step,
                            "train/tokens_per_sec": 500.0}, step)
            if self.recorder.stopped_at_cap:
                raise SystemExit("SIGTERM")
        promote(config, self.steps)
        return {"steps": self.steps, "job_id": "ts-fake-session"}


def promote(config, steps):
    """What the cookbook's runner writes once it has promoted the final checkpoint (`output_model_path`)."""
    if config.output_model_id:
        Path(config.runner["output_model_path"]).write_text(json.dumps(
            {"model_id": config.output_model_id, "checkpoint": f"step-{steps}", "job_id": "ts-fake-session"}))


class Records(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="loupe-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.md = self.dir / "training.md"
        self.md.write_text(MARKDOWN.format(reconciled="", sha="x"), encoding="utf-8")
        self.run = self.dir / "runs" / "loupe-1.0"

    def recorder(self, cap=None):
        stops = []
        return ts.Recorder(self.run, "1.0", cap, markdown_path=self.md, stop=lambda: stops.append(1)), stops

    def test_one_metrics_line_a_step_progress_every_50_and_totals_in_run_json(self):
        recorder, _ = self.recorder()
        loop = FakeLoop(120, recorder=recorder)
        _, record = ts.train(loop, self.dir / "train.jsonl", "1.0", self.run, recorder, runner_config=dict)
        lines = [json.loads(line) for line in (self.run / "metrics.jsonl").read_text().splitlines()]
        self.assertEqual([line["step"] for line in lines], list(range(1, 121)))
        self.assertEqual(record["tokens_sent"], 120_000)
        self.assertEqual(record["steps"], 120)
        self.assertEqual(record["outcome"], "completed")
        self.assertEqual(record["model_id"], "isitlegit-loupe-1-0")
        self.assertEqual(record["sessions"], ["ts-fake-session"])
        self.assertIsNone(record["lines_trained"])  # the fixture's train.jsonl does not exist
        self.assertEqual(loop.config.output_model_id, "isitlegit-loupe-1-0")
        self.assertEqual(loop.config.dcp_save_interval, 200)
        self.assertTrue(loop.config.serverless)
        training = ts.section(self.md.read_text(), "Training")
        self.assertEqual(training.count("Loupe 1.0 step"), 2)
        self.assertIn("step 100: loss 0.02", training)

    def test_the_cap_stops_the_run_and_records_it(self):
        recorder, stops = self.recorder(cap=60.0)
        tokens_at_cap = int(60.0 / ts.USD_PER_TOKEN)
        loop = FakeLoop(10, tokens_per_step=tokens_at_cap // 4 + 1, recorder=recorder)
        with self.assertRaises(SystemExit):
            ts.train(loop, self.dir / "train.jsonl", "1.0", self.run, recorder, runner_config=dict)
        self.assertEqual(stops, [1])
        self.assertEqual(json.loads((self.run / "run.json").read_text())["outcome"], "stopped at cap")
        self.assertIn("reached the US$60 cap", self.md.read_text())

    def test_a_resumed_run_continues_its_token_count(self):
        recorder, _ = self.recorder()
        with self.assertRaises(RuntimeError):
            ts.train(FakeLoop(30, fail_at=21, recorder=recorder), self.dir / "t.jsonl", "1.0", self.run, recorder,
                     runner_config=dict)
        self.assertEqual(json.loads((self.run / "run.json").read_text())["outcome"], "failed")
        again, _ = self.recorder()
        self.assertEqual(again.tokens, 20_000)
        ts.train(FakeLoop(5, recorder=again), self.dir / "t.jsonl", "1.0", self.run, again, runner_config=dict)
        self.assertEqual(json.loads((self.run / "run.json").read_text())["tokens_sent"], 25_000)

    def test_an_interrupted_run_resumes_in_a_new_process_from_its_newest_checkpoint(self):
        run_id = "run-" + "a" * 32

        class CheckpointingLoop(FakeLoop):
            """Names its session as the cookbook does, saves a checkpoint every 10 steps, and resumes from one."""

            def main(self, config):
                self.config = config
                logging.getLogger("training.utils.serverless").info(
                    "Serverless training session %s, run %s. To continue from one of this run's checkpoints in a new "
                    "process, pass init_from_checkpoint='%s/%s/<checkpoint>' with the same log_path.",
                    "ts-session-1", run_id, "acct", run_id)
                saved = Path(config.log_path) / "dataloader.json"
                start = 0
                if config.init_from_checkpoint:
                    name = config.init_from_checkpoint.rsplit("/", 1)[-1]
                    start = json.loads(saved.read_text())["checkpoints"][name]["step"]
                for step in range(start + 1, self.steps + 1):
                    if self.fail_at == step:
                        raise RuntimeError("trainer lost")
                    self.wandb_log({"train/total_tokens": 1000, "train/ce_loss": 1.0}, step)
                    if step % 10 == 0:
                        saved.parent.mkdir(parents=True, exist_ok=True)
                        state = json.loads(saved.read_text()) if saved.is_file() else {"checkpoints": {}}
                        state["checkpoints"][f"step-{step}"] = {"step": step, "data_consumed": step * 8}
                        saved.write_text(json.dumps(state))
                promote(config, self.steps)
                return {"job_id": "ts-session-1"}

        recorder, _ = self.recorder()
        first = CheckpointingLoop(30, fail_at=25, recorder=recorder)
        with self.assertRaises(RuntimeError):
            ts.train(first, self.dir / "t.jsonl", "1.0", self.run, recorder, runner_config=dict, dataset_sha="d" * 64)
        # The session stays open so its checkpoints outlive the crash, and its ids are kept for the resume.
        self.assertFalse(first.config.close_session_on_exit)
        self.assertEqual(json.loads((self.run / "serverless.json").read_text()),
                         {"session": "ts-session-1", "run": run_id, "account": "acct"})
        # The version's line exists once its job does, the failed attempt included.
        self.assertRegex(ts.section(self.md.read_text(), "Training"),
                         r"Loupe 1\.0: isitlegit-loupe-1-0, trained \d{4}-\d{2}-\d{2}, dataset d{64}, job ts-session-1")
        reference = ts.resume_reference(self.run)
        self.assertEqual(reference, f"acct/{run_id}/step-20")
        again, _ = self.recorder()
        resumed = CheckpointingLoop(30, recorder=again)
        ts.train(resumed, self.dir / "t.jsonl", "1.0", self.run, again, runner_config=dict, resume_from=reference)
        self.assertEqual(resumed.config.init_from_checkpoint, reference)
        steps = [json.loads(line)["step"] for line in (self.run / "metrics.jsonl").read_text().splitlines()]
        self.assertEqual(steps, list(range(1, 25)) + list(range(21, 31)))  # steps 21 to 24 are trained again
        self.assertEqual(json.loads((self.run / "metrics.jsonl").read_text().splitlines()[-1])["session"],
                         "ts-session-1")

    def test_no_checkpoint_yet_is_no_resume_and_checkpoints_without_ids_refuse(self):
        self.assertIsNone(ts.resume_reference(self.run))
        (self.run / "cookbook").mkdir(parents=True)
        (self.run / "cookbook" / "dataloader.json").write_text(json.dumps({"checkpoints": {"step-200": {"step": 200}}}))
        with self.assertRaises(ts.Refused):
            ts.resume_reference(self.run)

    def test_the_unpromoted_measure_closes_its_own_session(self):
        recorder, _ = self.recorder()
        loop = FakeLoop(1, recorder=recorder)
        ts.train(loop, self.dir / "t.jsonl", "1.0", self.run, recorder, runner_config=dict, promote=False)
        self.assertTrue(loop.config.close_session_on_exit)
        self.assertNotIn("Loupe 1.0: isitlegit-loupe-1-0, trained", self.md.read_text())

    def test_the_wrapped_logger_is_put_back(self):
        recorder, _ = self.recorder()
        loop = FakeLoop(1, recorder=recorder)
        original = loop.wandb_log
        ts.train(loop, self.dir / "t.jsonl", "1.0", self.run, recorder, runner_config=dict)
        self.assertEqual(loop.wandb_log, original)
        self.assertEqual(logging.getLogger("training.utils.serverless").level, logging.NOTSET)
        self.assertEqual(logging.getLogger("training.utils.serverless").handlers, [])


class Lifecycle(unittest.TestCase):
    """§11 plan review gaps 1, 3, 4 and 5: a version's lifecycle, a resume held to what it started on, spend counted
    with images and stopped before the batch that passes the cap, and success only on a promotion that reads back."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="loupe-life-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.md = self.dir / "training.md"
        self.md.write_text(MARKDOWN.format(reconciled="", sha="x"), encoding="utf-8")
        self.run = self.dir / "runs" / "loupe-1.0"
        self.run.mkdir(parents=True)
        self.train = self.dir / "train.jsonl"
        self.train.write_text("".join(f'{{"n": {i}}}\n' for i in range(16)), encoding="utf-8")

    def recorder(self, cap=None, line_tokens=None):
        stops = []
        return ts.Recorder(self.run, "1.0", cap, markdown_path=self.md, stop=lambda: stops.append(1),
                           line_tokens=line_tokens), stops

    def test_a_completed_or_failed_version_is_never_reused_and_an_interrupted_one_resumes(self):
        self.assertIsNone(ts.check_version(self.run))  # new
        (self.run / "cookbook").mkdir()
        with self.assertRaisesRegex(ts.Refused, "failed before its first checkpoint"):
            ts.check_version(self.run)
        (self.run / "cookbook" / "dataloader.json").write_text(json.dumps({"checkpoints": {"step-200": {"step": 200}}}))
        (self.run / "serverless.json").write_text(json.dumps({"session": "s", "run": "r", "account": "a"}))
        self.assertEqual(ts.check_version(self.run), "a/r/step-200")
        for outcome in ("completed", "promotion failed"):
            (self.run / "run.json").write_text(json.dumps({"outcome": outcome}))
            with self.assertRaisesRegex(ts.Refused, "never reused"):
                ts.check_version(self.run)

    def test_a_resume_is_held_to_the_dataset_and_file_it_started_on(self):
        sha = ts.sha256(self.train)
        ts.write_selection(self.run, sha, self.train, [10] * 16, 7, 0.5, None)
        self.assertEqual(ts.check_resume(self.run, sha, self.train)["tokens"], [10] * 16)
        with self.assertRaisesRegex(ts.Refused, "another dataset"):
            ts.check_resume(self.run, "f" * 64, self.train)
        self.train.write_text('{"n": "changed"}\n', encoding="utf-8")
        with self.assertRaisesRegex(ts.Refused, "not the file the run started on"):
            ts.check_resume(self.run, sha, self.train)
        (self.run / "selection.json").unlink()
        with self.assertRaisesRegex(ts.Refused, "no selection.json"):
            ts.check_resume(self.run, sha, self.train)

    def test_spend_counts_each_batch_with_its_images_and_stops_before_the_batch_that_passes_the_cap(self):
        # Eight lines a step; the trainer's metric says 100 text tokens, the lines hold 1,000 each with their images.
        per_line = int(60.0 / ts.USD_PER_TOKEN) // 20  # the cap buys 20 lines
        recorder, stops = self.recorder(cap=60.0, line_tokens=[per_line] * 40)
        recorder.step({"train/total_tokens": 100}, 1)
        self.assertEqual(recorder.tokens, 8 * per_line)
        line = json.loads((self.run / "metrics.jsonl").read_text().splitlines()[-1])
        self.assertEqual((line["examples"], line["batch_tokens"], line["tokens"]), (8, 8 * per_line, 100))
        self.assertEqual(stops, [])
        # After step 2 (16 lines) the next batch of 8 would pass 20: the run stops before sending it.
        recorder.step({"train/total_tokens": 100}, 2)
        self.assertEqual(stops, [1])
        self.assertLess(recorder.tokens * ts.USD_PER_TOKEN, 60.0)

    def test_a_run_succeeds_only_on_a_promotion_that_reads_back_ready(self):
        recorder, _ = self.recorder()
        _, record = ts.train(FakeLoop(3, recorder=recorder), self.train, "1.0", self.run, recorder,
                             runner_config=dict, verify=lambda model: "READY")
        self.assertEqual(record["outcome"], "completed")
        self.assertEqual(record["promoted"], {"model_id": "isitlegit-loupe-1-0", "checkpoint": "step-3",
                                              "state": "READY"})
        self.assertIsNone(record["billed_usd"])
        for run, verify, why in ((self.dir / "r1", lambda model: "CREATING", "reads CREATING, not READY"),
                                 (self.dir / "r2", None, "without a promotion")):
            class Unpromoted(FakeLoop):
                def main(inner, config):
                    result = FakeLoop.main(inner, config)
                    if verify is None:
                        Path(config.runner["output_model_path"]).unlink()
                    return result
            again = ts.Recorder(run, "1.0", None, markdown_path=self.md, stop=lambda: None)
            with self.assertRaisesRegex(ts.Refused, why):
                ts.train(Unpromoted(3, recorder=again), self.train, "1.0", run, again, runner_config=dict,
                         verify=verify)
            self.assertEqual(json.loads((run / "run.json").read_text())["outcome"], "promotion failed")
            with self.assertRaisesRegex(ts.Refused, "never reused"):
                ts.check_version(run)

    def test_a_fresh_run_needs_the_measured_rate(self):
        store = self.dir / "store"
        old = os.environ.get("GLIMMER_DATA_DIR")
        os.environ["GLIMMER_DATA_DIR"] = str(store)
        self.addCleanup(lambda: os.environ.pop("GLIMMER_DATA_DIR") if old is None else
                        os.environ.__setitem__("GLIMMER_DATA_DIR", old))
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            self.assertEqual(ts.main(["--version", "9.9", "--train", str(self.train)]), 2)
        self.assertIn("--lines-per-second", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
