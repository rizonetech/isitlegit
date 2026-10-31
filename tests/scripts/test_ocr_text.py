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
        with mock.patch("sys.stdin", io.StringIO(json.dumps({"x": 1}))), mock.patch("sys.stderr"):
            self.assertEqual(ocr.main(), 2)


if __name__ == "__main__":
    unittest.main()
