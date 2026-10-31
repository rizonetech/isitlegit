"""scripts/glimmer/ocr_text.py (D03 T04 §7): each screenshot's OCR text, one string per image, in order, from a JSON
list on stdin; a fake engine stands in for RapidOCR, which lives in its own venv."""
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "ocr_text.py"
spec = importlib.util.spec_from_file_location("ocr_text", SCRIPT)
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)


def fake(path):
    lines = {"a.jpg": [([0, 0], "Dear [name]", 0.9), ([0, 1], "Sign in", 0.9)], "b.jpg": None}[Path(path).name]
    return lines, 0.01


class OcrText(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.dir = Path(folder.name)
        for name in ("a.jpg", "b.jpg"):
            (self.dir / name).write_bytes(b"\xff\xd8\xff\xd9")  # the engine is fake: any file that exists will do

    def test_reads_each_image_in_order(self):
        paths = [str(self.dir / "a.jpg"), str(self.dir / "b.jpg")]
        self.assertEqual(ocr.read_all(paths, engine=fake), ["Dear [name]\nSign in", ""])

    def test_refuses_a_missing_screenshot_rather_than_read_it_as_empty(self):
        asked = []
        paths = [str(self.dir / "a.jpg"), str(self.dir / "gone.jpg")]
        with self.assertRaisesRegex(FileNotFoundError, "1 screenshots are missing"):
            ocr.read_all(paths, engine=lambda path: asked.append(path) or (None, 0.0))
        self.assertEqual(asked, [])  # nothing is read once one screenshot is missing

    def test_refuses_anything_but_a_list_of_paths(self):
        with (mock.patch.object(ocr, "unpinned", return_value=None),
              mock.patch("sys.stdin", io.StringIO(json.dumps({"x": 1}))), mock.patch("sys.stderr")):
            self.assertEqual(ocr.main(), 2)

    def test_does_not_start_in_an_environment_its_requirements_file_does_not_pin(self):
        # Round 1 finding 2: an upgraded engine was never audited, so it refuses by name before it reads anything.
        pinned = dict(ocr.load_pins().pins(ocr.REQUIREMENTS))
        self.assertIsNone(ocr.unpinned(version=pinned.get))
        self.assertEqual(ocr.unpinned(version={**pinned, "onnxruntime": "1.32.0"}.get),
                         "the environment does not match requirements-ocr.txt (onnxruntime is 1.32.0, pinned 1.31.1)")
        stderr = io.StringIO()
        with (mock.patch.object(ocr, "unpinned", return_value="the environment does not match requirements-ocr.txt"),
              mock.patch("sys.stdin", io.StringIO(json.dumps([str(self.dir / "a.jpg")]))),
              mock.patch("sys.stderr", stderr), mock.patch("sys.stdout", io.StringIO()) as stdout):
            self.assertEqual(ocr.main(), 3)
        self.assertEqual(stderr.getvalue(), "the environment does not match requirements-ocr.txt\n")
        self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
