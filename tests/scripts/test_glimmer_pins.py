"""scripts/glimmer/pins.py (D03 T04 §19, round 1 finding 2): an environment checked against its requirements file. An
injected version reader stands in for the installed packages; the real venvs are checked where they are installed."""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

GLIMMER = Path(__file__).resolve().parents[2] / "scripts" / "glimmer"
spec = importlib.util.spec_from_file_location("pins", GLIMMER / "pins.py")
pins = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pins)
VENVS = Path.home() / ".venvs"


class Pins(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.file = Path(folder.name) / "requirements-entities.txt"
        self.file.write_text(
            "# a comment\n\nspacy==3.8.18\nen_core_web_lg @ https://example.test/en_core_web_lg-3.8.0/"
            "en_core_web_lg-3.8.0-py3-none-any.whl#sha256=" + "0" * 64 + "\n")

    def test_reads_each_pin_a_url_pinned_wheel_included(self):
        self.assertEqual(pins.pins(self.file), [("spacy", "3.8.18"), ("en_core_web_lg", "3.8.0")])

    def test_an_environment_at_every_pin_matches(self):
        installed = {"spacy": "3.8.18", "en_core_web_lg": "3.8.0"}
        self.assertIsNone(pins.mismatch(self.file, installed.get))

    def test_a_different_or_missing_version_refuses_by_name(self):
        self.assertEqual(pins.mismatch(self.file, {"spacy": "3.9.0", "en_core_web_lg": "3.8.0"}.get),
                         "the environment does not match requirements-entities.txt (spacy is 3.9.0, pinned 3.8.18)")
        self.assertEqual(pins.mismatch(self.file, {"spacy": "3.8.18"}.get),
                         "the environment does not match requirements-entities.txt "
                         "(en_core_web_lg is not installed, pinned 3.8.0)")

    def test_a_line_that_pins_no_version_refuses(self):
        self.file.write_text("spacy>=3.8\n")
        with self.assertRaisesRegex(ValueError, "pins no version"):
            pins.mismatch(self.file, {}.get)

    def test_the_installed_venvs_are_the_ones_their_files_pin(self):
        checked = 0
        for venv, name in (("presidio", "requirements-entities.txt"), ("ocr", "requirements-ocr.txt")):
            python = VENVS / venv / "bin" / "python"
            if not python.exists():  # WORKAROUND: the venvs are local installs no CI host carries
                continue
            run = subprocess.run(
                [str(python), "-I", "-c", "import importlib.util, sys; s = importlib.util.spec_from_file_location("
                 f"'pins', {str(GLIMMER / 'pins.py')!r}); m = importlib.util.module_from_spec(s); "
                 f"s.loader.exec_module(m); print(m.mismatch({str(GLIMMER / name)!r}))"],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(run.stdout.strip(), "None", venv)
            checked += 1
        if not checked:
            self.skipTest("neither venv is installed here")


if __name__ == "__main__":
    unittest.main()
