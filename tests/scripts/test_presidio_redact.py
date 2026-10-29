"""scripts/glimmer/presidio_redact.py (D03 T04 §19): Presidio as the benchmark's other redaction step, one model load a
run, one JSON line a page, and a failure answered without the page's content. Runs only where its own venv exists."""
import json
import subprocess
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "presidio_redact.py"
PYTHON = Path.home() / ".venvs" / "presidio" / "bin" / "python"


# WORKAROUND: Presidio's model is a 600 MB local install in its own venv, which no CI host carries.
@unittest.skipUnless(PYTHON.exists(), "Presidio's venv (~/.venvs/presidio) is not installed here")
class PresidioRedact(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.process = subprocess.Popen([str(PYTHON), "-I", str(SCRIPT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.DEVNULL, text=True)
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

    def test_reports_its_versions_and_the_model_digest_once(self):
        self.assertTrue(self.ready["ready"])
        self.assertIn("presidio-analyzer", self.ready["versions"])
        self.assertRegex(self.ready["model_sha256"], r"^[0-9a-f]{64}$")

    def test_removes_a_name_an_address_and_a_denied_term(self):
        page = ("<p>Your account is on hold. Regards, Hendrik Grobbelaar</p>"
                "<p>Write to thandiwe.mokoena@kestrel-holdings.co.za or call 082 555 1234.</p>"
                "<p>Kestrel Holdings thanks you.</p>")
        html = self.ask({"html": page, "deny": ["Kestrel Holdings"]})["html"]
        # The runner's contract: what Presidio finds and every denied term replaced. How much of a name Presidio finds
        # is what the benchmark measures, not what this test asserts (it took "Hendrik" and left "Grobbelaar").
        for detail in ("thandiwe.mokoena@", "082 555 1234", "Kestrel Holdings", "Hendrik"):
            self.assertNotIn(detail, html)
        self.assertIn("[detail]", html)
        self.assertIn("Your account is on hold", html)

    def test_answers_a_malformed_request_with_its_failure_and_no_content(self):
        answer = self.ask('{"html": 5, "deny": "secret-term"}')
        self.assertEqual(set(answer), {"error"})
        self.assertNotIn("secret-term", json.dumps(answer))
        self.assertEqual(set(self.ask("not json")), {"error"})


if __name__ == "__main__":
    unittest.main()
