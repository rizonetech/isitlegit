"""scripts/glimmer/presidio_redact.py (D03 T04 §19): Presidio as the benchmark's other entity pass, on `entities.py`'s
contract (the same ready line, request, spans and refusals), so the benchmark swaps the detector alone. Runs only where
its own venv exists."""
import importlib.util
import json
import subprocess
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts" / "glimmer"
SCRIPT = SCRIPTS / "presidio_redact.py"
PYTHON = Path.home() / ".venvs" / "presidio" / "bin" / "python"
# The digest the pass is pinned to, read from redact.ts as the benchmark passes it.
PINNED = next(line.split('"')[1] for line in (SCRIPTS / "redact.ts").read_text().splitlines()
              if line.strip().startswith('sha256: "'))


# WORKAROUND: Presidio's model is a 600 MB local install in its own venv, which no CI host carries.
@unittest.skipUnless(PYTHON.exists(), "Presidio's venv (~/.venvs/presidio) is not installed here")
class PresidioPass(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.process = subprocess.Popen([str(PYTHON), "-I", str(SCRIPT), "--model-sha256", PINNED],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       text=True)
        cls.ready = json.loads(cls.process.stdout.readline())

    @classmethod
    def tearDownClass(cls):
        cls.process.stdin.close()
        cls.process.wait(timeout=30)
        cls.process.stdout.close()

    def ask(self, request):
        self.process.stdin.write((request if isinstance(request, str) else json.dumps(request)) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def test_starts_with_entities_py_s_ready_line_and_reports_its_versions_apart(self):
        self.assertEqual(self.ready, {"ready": True, "model": "en_core_web_lg", "model_sha256": PINNED,
                                      "language": "en"})
        versions = json.loads(subprocess.run([str(PYTHON), "-I", str(SCRIPT), "--versions"], capture_output=True,
                                             text=True, check=True).stdout)
        self.assertIn("presidio-analyzer", versions)

    def test_answers_person_and_place_spans_by_offset_and_no_pattern_entities(self):
        text = "Please phone Hendrik Grobbelaar in Johannesburg, or write to info@kestrel-holdings.co.za today."
        spans = self.ask({"text": text})["spans"]
        found = {(text[s["start"]:s["end"]], s["label"]) for s in spans}
        self.assertIn(("Hendrik Grobbelaar", "person"), found)
        self.assertIn(("Johannesburg", "place"), found)
        # Email, URL and domain entities are the shared rules' or the lure's: never a span here.
        self.assertFalse(any("kestrel" in word for word, _ in found))

    def test_refuses_in_entities_py_s_words_with_no_content(self):
        spec = importlib.util.spec_from_file_location("entities", SCRIPTS / "entities.py")
        entities = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(entities)
        self.assertEqual(self.ask({"text": "Regards, Олена"}), {"refused": "a name in cyrillic script would go unread"})
        self.assertEqual(self.ask({"text": "x" * (entities.MAX_TEXT + 1)}),
                         {"refused": f"the text is over {entities.MAX_TEXT} characters"})
        self.assertEqual(self.ask({"html": "secret-term"}), {"refused": "a request must hold text"})
        self.assertEqual(self.ask("not json"), {"refused": "the request failed (JSONDecodeError)"})

    def test_refuses_to_start_on_another_model_digest(self):
        line = subprocess.run([str(PYTHON), "-I", str(SCRIPT), "--model-sha256", "0" * 64], capture_output=True,
                              text=True, timeout=120).stdout.splitlines()[0]
        self.assertEqual(json.loads(line), {"refused": "the model is not the pinned one"})


if __name__ == "__main__":
    unittest.main()
