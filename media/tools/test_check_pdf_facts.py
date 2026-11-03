import json
import subprocess
import tempfile
import unittest
from pathlib import Path

MEDIA = Path(__file__).resolve().parent.parent
SCRIPT = MEDIA / "tools" / "check-pdf-facts.mjs"
SPEC = MEDIA / "data" / "pdf-facts.json"


class CheckPdfFactsTest(unittest.TestCase):
    def test_real_pdf_facts_hold(self):
        r = subprocess.run(["node", str(SCRIPT)], cwd=MEDIA, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("7 PDF facts across 4 primary PDFs hold", r.stdout)

    def test_fails_on_modified_quote_or_checksum(self):
        data = json.loads(SPEC.read_text())
        data["facts"]["sabricLosses2025"]["quote"] = "Reported client claim amounts were R9.99 billion"
        data["facts"]["sabricLosses2025"]["value"] = "R9.99 billion"
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(data, fh)
            bad_spec = Path(fh.name)
        try:
            r = subprocess.run(["node", str(SCRIPT), str(bad_spec)], cwd=MEDIA, capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("sabricLosses2025: quote not found", r.stderr)
        finally:
            bad_spec.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
