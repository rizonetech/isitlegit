"""scripts/glimmer/entities.py (D03 T04 §19): the entity pass's contract. The script check runs anywhere; the model's
answers run where its venv (~/.venvs/presidio, spaCy's en_core_web_lg) is installed."""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "entities.py"
PYTHON = Path.home() / ".venvs" / "presidio" / "bin" / "python"
spec = importlib.util.spec_from_file_location("entities", SCRIPT)
entities = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entities)


class UnreadScript(unittest.TestCase):
    def test_a_name_in_a_script_the_model_cannot_read_refuses_the_text(self):
        self.assertEqual(entities.unread_script("Regards, Олена Коваленко"), "cyrillic")
        self.assertEqual(entities.unread_script("مع تحياتي، فاطمة"), "arabic")
        self.assertIsNone(entities.unread_script("Regards, Nomvula Zungu, Anne-Marie Botha"))
        # Latin with its accents, combining ones included, digits, punctuation and symbols are read.
        self.assertIsNone(entities.unread_script("Regards, Zoë Müller, Rene\u0301 Ngcobo: R1 200, 20% off, © 2026"))

    def test_any_letter_or_mark_of_an_unread_script_refuses_however_short_the_name(self):
        # A two-character Chinese name, a Devanagari name whose vowel is a combining sign, and Gujarati.
        self.assertEqual(entities.unread_script("Regards, 王伟"), "han")
        self.assertEqual(entities.unread_script("Regards, रवि"), "devanagari")
        self.assertEqual(entities.unread_script("Regards, અજય"), "gujarati")
        self.assertEqual(entities.unread_script("Regards, \u093f"), "devanagari")  # a lone vowel sign is a mark of it
        # A look-alike left unfolded is a letter of its script: the caller folds look-alikes (`skeleton()` in
        # redact.ts) before it asks, so one that arrives here may be part of a name the model cannot read.
        self.assertEqual(entities.unread_script("kеstrel"), "cyrillic")
        self.assertEqual(entities.unread_script("μ-law"), "greek")
        for text in ("Regards, 王伟", "Regards, रवि", "Regards, અજય"):
            self.assertEqual(set(entities.answer(None, {"text": text})), {"refused"})

    def test_refuses_too_much_text_and_a_request_without_text(self):
        self.assertEqual(entities.answer(None, {"text": "x" * (entities.MAX_TEXT + 1)}),
                         {"refused": f"the text is over {entities.MAX_TEXT} characters"})
        self.assertEqual(entities.answer(None, {"html": "x"}), {"refused": "a request must hold text"})
        self.assertEqual(entities.answer(None, {"text": "Олена Коваленко"}),
                         {"refused": "a name in cyrillic script would go unread"})


class Start(unittest.TestCase):
    def test_does_not_start_where_spacy_or_the_model_is_not_installed(self):
        # This interpreter, isolated, with no spaCy on its path: the pass refuses to start rather than crash unnamed.
        process = subprocess.run([sys.executable, "-I", "-S", str(SCRIPT), "--model-sha256", "0" * 64],
                                 capture_output=True, text=True, timeout=60)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout), {"refused": "the model is not installed"})


# WORKAROUND: the model is a 600 MB local install in its own venv, which no CI host carries.
@unittest.skipUnless(PYTHON.exists(), "the entity pass's venv (~/.venvs/presidio) is not installed here")
class EntityPass(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.digest = subprocess.run(
            [str(PYTHON), "-I", "-c", f"import sys; sys.path.insert(0, {str(SCRIPT.parent)!r}); "
             "import entities; print(entities.model_digest(entities.MODEL))"],
            capture_output=True, text=True, check=True).stdout.strip()

    def start(self, digest):
        return subprocess.Popen([str(PYTHON), "-I", str(SCRIPT), "--model-sha256", digest], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    def test_finds_people_and_places_by_offset_and_refuses_what_it_cannot_read(self):
        process = self.start(self.digest)
        try:
            self.assertEqual(json.loads(process.stdout.readline()),
                             {"ready": True, "model": "en_core_web_lg", "model_sha256": self.digest, "language": "en"})

            def ask(request):
                process.stdin.write(json.dumps(request) + "\n")
                process.stdin.flush()
                return json.loads(process.stdout.readline())

            text = "Please call Hendrik Grobbelaar at the Sandton branch in Johannesburg."
            spans = ask({"text": text})["spans"]
            found = {(text[s["start"]:s["end"]], s["label"]) for s in spans}
            self.assertIn(("Hendrik Grobbelaar", "person"), found)
            self.assertIn(("Johannesburg", "place"), found)
            self.assertEqual(ask({"text": "يوسف المنصوري"}), {"refused": "a name in arabic script would go unread"})
            self.assertEqual(set(ask("not an object")), {"refused"})
        finally:
            process.stdin.close()
            process.wait(timeout=30)
            process.stdout.close()

    def test_does_not_start_in_an_environment_its_requirements_file_does_not_pin(self):
        # The script, its table and `pins.py` beside a requirements file that pins another spaCy: the real venv is now
        # an upgraded one, so the pass refuses by name rather than answer under the old audit (round 1 finding 2).
        with tempfile.TemporaryDirectory() as folder:
            for name in ("entities.py", "pins.py", "unread-scripts.json"):
                shutil.copy(SCRIPT.parent / name, folder)
            pinned = (SCRIPT.parent / "requirements-entities.txt").read_text()
            self.assertIn("\nspacy==3.8.18\n", pinned)
            upgraded = pinned.replace("\nspacy==3.8.18\n", "\nspacy==3.8.17\n")
            (Path(folder) / "requirements-entities.txt").write_text(upgraded)
            process = subprocess.run(
                [str(PYTHON), "-I", str(Path(folder) / "entities.py"), "--model-sha256", self.digest],
                capture_output=True, text=True, timeout=120)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout), {
            "refused": "the environment does not match requirements-entities.txt (spacy is 3.8.18, pinned 3.8.17)"})

    def test_does_not_start_on_a_model_other_than_the_pinned_one(self):
        process = self.start("0" * 64)
        self.assertEqual(json.loads(process.stdout.readline()), {"refused": "the model is not the pinned one"})
        self.assertEqual(process.wait(timeout=60), 1)
        process.stdout.close()
        process.stdin.close()


if __name__ == "__main__":
    unittest.main()
