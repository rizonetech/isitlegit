"""scripts/glimmer/train_serverless.py (D03 T04 §11): when a Loupe run may start, what it trains on, the cap lifted
only while training is proven free and restored by date, and the run's records, against a fake cookbook loop."""
import importlib.util
import json
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
        return {"steps": self.steps, "job_id": "ts-fake-session"}


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

    def test_the_wrapped_logger_is_put_back(self):
        recorder, _ = self.recorder()
        loop = FakeLoop(1, recorder=recorder)
        original = loop.wandb_log
        ts.train(loop, self.dir / "t.jsonl", "1.0", self.run, recorder, runner_config=dict)
        self.assertEqual(loop.wandb_log, original)


if __name__ == "__main__":
    unittest.main()
