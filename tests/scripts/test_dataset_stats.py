"""scripts/glimmer/dataset_stats.py (D03 T04 §10): a dataset version's figures, counted with the renderer it is given
(Glimmer's own in real use), equal the files' lines and split as the meta files say."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "dataset_stats.py"
spec = importlib.util.spec_from_file_location("dataset_stats", SCRIPT)
ds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ds)


class FakeRenderer:
    """Ten text tokens a message, 100 image tokens a screenshot, and the answer (the last message) trained."""

    def build_supervised_example(self, messages, train_on_what=None):
        chunks, weights = [], []
        for message in messages:
            parts = message["content"] if isinstance(message["content"], list) else [{"type": "text"}]
            for part in parts:
                if part.get("type") == "image_url":
                    raise AssertionError("the renderer was given an image_url part; it reads image parts")
                if part.get("type") == "image":
                    chunks.append(SimpleNamespace(type="image", expected_tokens=100))
                else:
                    chunks.append(SimpleNamespace(type="text", tokens=[0] * 10))
                    weights.extend([1 if message is messages[-1] else 0] * 10)
        return SimpleNamespace(chunks=chunks), weights


def line(image=True):
    user = [{"type": "text", "text": "page"}] + ([{"type": "image_url", "image_url": {"url": "data:x"}}] if image else [])
    return json.dumps({"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": user},
                                    {"role": "assistant", "content": "{}"}]})


class Stats(unittest.TestCase):
    def test_figures_match_the_files(self):
        root = Path(tempfile.mkdtemp(prefix="stats-"))
        self.addCleanup(shutil.rmtree, root, True)
        folder = root / "store" / "dataset" / "1.0"
        folder.mkdir(parents=True)
        (folder / "train.jsonl").write_text(line() + "\n" + line(image=False) + "\n")
        (folder / "train.meta.jsonl").write_text(
            json.dumps({"origin": "public", "source": "phreshphish", "lure_type": "credential", "south_africa": False, "brand": "FNB"}) + "\n" +
            json.dumps({"origin": "samples", "source": "samples-body", "lure_type": "none", "south_africa": True, "brand": "fnb"}) + "\n")
        (folder / "eval.jsonl").write_text(line() + "\n")
        (folder / "eval.meta.jsonl").write_text(
            json.dumps({"origin": "benign", "source": "benign-sa", "lure_type": "none", "south_africa": True, "brand": None}) + "\n")
        (folder / "summary.json").write_text(json.dumps({"mode": "image", "seed": 3, "dropped": {"near": 2}}))
        with mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(root / "store")}), mock.patch("sys.stdout"):
            self.assertEqual(ds.main(["1.0"], renderer=FakeRenderer(), train_on=None, out_dir=root / "docs"), 0)
        out = json.loads((root / "docs" / "dataset-1.0.json").read_text())
        train = out["train"]
        self.assertEqual(train["lines"], 2)
        self.assertEqual(train["by_origin"], {"public": 1, "samples": 1})
        self.assertEqual(train["south_africa"], 1)
        self.assertEqual(train["brands"], 1)
        self.assertEqual(train["screenshots"], 1)
        # Line 1: 3 text chunks (30) and 1 image (100); line 2: 3 text chunks (30); the answer's 10 tokens trained in each.
        self.assertEqual(train["tokens"], {"total": 160, "text": 60, "image": 100, "trained": 20, "prompt": 140,
                                           "per_line": {"min": 30, "median": 80.0, "max": 130}})
        self.assertEqual(out["eval"]["lines"], 1)
        self.assertEqual(out["dropped"], {"near": 2})

    def test_a_meta_file_out_of_step_is_refused(self):
        root = Path(tempfile.mkdtemp(prefix="stats-"))
        self.addCleanup(shutil.rmtree, root, True)
        folder = root / "1.0"
        folder.mkdir()
        (folder / "train.jsonl").write_text(line() + "\n")
        (folder / "train.meta.jsonl").write_text("")
        with self.assertRaises(ValueError):
            ds.split_stats(folder, "train", FakeRenderer(), None)


if __name__ == "__main__":
    unittest.main()
