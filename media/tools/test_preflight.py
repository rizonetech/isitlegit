"""Tests for preflight.py: a render stops before its first frame when master.py's numpy or the Python version is
missing (D10 T01 §1 completion review)."""

import importlib.util
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("preflight.py"))
pre = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pre)


class PreflightTest(unittest.TestCase):
    def test_passes_when_everything_is_present(self):
        self.assertEqual(pre.missing((3, 12, 0), lambda name: object()), [])

    def test_names_a_missing_numpy_with_its_install_command(self):
        got = pre.missing((3, 12, 0), lambda name: None)
        self.assertEqual(len(got), 1)
        self.assertIn("numpy is missing", got[0])
        self.assertIn("pip install --user numpy", got[0])

    def test_refuses_an_old_python(self):
        self.assertIn("Python 3.11 or newer is needed, not 3.10", pre.missing((3, 10, 4), lambda name: object()))


if __name__ == "__main__":
    unittest.main()
