"""Tests for scripts/glimmer/new_rows.py (D03 T04 §44): OWS sublabel filtering and PhishingEval's pairs."""
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "glimmer"))
import new_rows
from inputs import Limits, Receipt


def run(convert, folder):
    receipt, limits = Receipt(), Limits()
    out = new_rows.Rows(folder, receipt, limits)
    convert(folder, receipt, limits, out)
    out.close()
    rows = [json.loads(line) for line in (folder / "rows.jsonl").read_text(encoding="utf-8").splitlines()]
    return rows, receipt


class OwsTest(unittest.TestCase):
    def test_only_phishing_sublabel_becomes_a_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            records = [
                {"url": "https://a.example", "label": "Malicious", "sublabel": "Phishing", "html": "<p>Sign in</p>"},
                {"url": "https://b.example", "label": "Malicious", "sublabel": "Malware", "html": "<p>x</p>"},
                {"url": "https://c.example", "label": "Malicious", "sublabel": "Phishing", "html": ""},
            ]
            (folder / "malicious_OWS_URL_HTML_DS.jsonl").write_text(
                "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8"
            )
            rows, receipt = run(new_rows.convert_ows, folder)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["label"], "phish")
            self.assertEqual(rows[0]["url"], "https://a.example")
            self.assertEqual(receipt.exported, 1)
            self.assertEqual(sum(receipt.rejected.values()), 2)


class PhishingEvalTest(unittest.TestCase):
    def test_benign_brand_folder_and_phishing_pair(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            with zipfile.ZipFile(folder / "phishing4190.zip", "w") as z:
                z.writestr("p/2021-07-15-1.html", "<p>fake sign in</p>")
                z.writestr("p/2021-07-15-1.png", b"\x89PNG fake")
            with zipfile.ZipFile(folder / "crawl_benign.zip", "w") as z:
                z.writestr("c/AcmeBank/login.html", "<p>real sign in</p>")
                z.writestr("c/AcmeBank/login.png", b"\x89PNG real")
                z.writestr("c/AcmeBank/50e9-login.txt", "1 0.25 0.06 0.07 0.08\n")
                z.writestr("c/AcmeBank/login.txt", "https://acmebank.example/\n")
            with zipfile.ZipFile(folder / "archive100.zip", "w") as z:
                z.writestr("a/acme.example/20210101/index.html", "<p>real home</p>")
                z.writestr("a/acme.example/20210101/shot.png", b"\x89PNG home")
            with zipfile.ZipFile(folder / "expand277.zip", "w") as z:
                z.writestr("e/AcmeBank/login_html.txt", "<p>fake sign in</p>")
                z.writestr("e/AcmeBank/1.png", b"\x89PNG fake1")
            rows, receipt = run(new_rows.convert_phishingeval, folder)
            by_label = {(r["label"], r["target"]) for r in rows}
            self.assertIn(("phish", None), by_label)
            self.assertIn(("benign", "AcmeBank"), by_label)
            self.assertIn(("benign", "acme.example"), by_label)
            self.assertIn(("phish", "AcmeBank"), by_label)
            self.assertTrue(all("screenshot" in r for r in rows))
            benign = next(r for r in rows if r["target"] == "AcmeBank" and r["label"] == "benign")
            self.assertEqual(benign["url"], "https://acmebank.example/")


if __name__ == "__main__":
    unittest.main()
