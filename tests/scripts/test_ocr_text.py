"""scripts/glimmer/ocr_text.py (D03 T04 §7): each screenshot's OCR text, one string per image, in order, from a JSON
list on stdin; a fake engine stands in for RapidOCR, which lives in its own venv."""
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "ocr_text.py"
spec = importlib.util.spec_from_file_location("ocr_text", SCRIPT)
ocr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ocr)


def fake(path):
    lines = {"a.jpg": [([0, 0], "Dear [name]", 0.9), ([0, 1], "Sign in", 0.9)], "b.jpg": None}[path]
    return lines, 0.01


class OcrText(unittest.TestCase):
    def test_reads_each_image_in_order(self):
        self.assertEqual(ocr.read_all(["a.jpg", "b.jpg"], engine=fake), ["Dear [name]\nSign in", ""])

    def test_refuses_anything_but_a_list_of_paths(self):
        with mock.patch("sys.stdin", io.StringIO(json.dumps({"x": 1}))), mock.patch("sys.stderr"):
            self.assertEqual(ocr.main(), 2)


if __name__ == "__main__":
    unittest.main()
