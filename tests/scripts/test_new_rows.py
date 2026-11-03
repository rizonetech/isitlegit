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


class AresTest(unittest.TestCase):
    def test_site_rows_take_their_url_from_the_merged_database(self):
        import sqlite3

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            db_path = folder / "urls.db"
            connection = sqlite3.connect(db_path)
            connection.execute("create table odp_urls (url text, sha256 text)")
            connection.execute("insert into odp_urls values ('https://real.example/', 'abc123')")
            connection.commit()
            connection.close()
            phish_db = folder / "phish.db"
            connection = sqlite3.connect(phish_db)
            connection.execute("create table urls (url text, brand text, sha1 text)")
            connection.execute("insert into urls values ('https://real.example/', 'Acme', 'abc123')")
            connection.commit()
            connection.close()
            for name, db in (("benign-rawdata.zip", db_path), ("phishing-rawdata.zip", phish_db)):
                label = name.split("-")[0]
                with zipfile.ZipFile(folder / name, "w") as z:
                    z.writestr(f"{label}/{label}-urls.merged.db", db.read_bytes())
                    z.writestr(f"{label}/files/abc123/page.html", "<p>a page</p>")
                    z.writestr(f"{label}/files/abc123/screen.png", b"\x89PNG page")
            rows, receipt = run(new_rows.convert_ares, folder)
            self.assertEqual(len(rows), 2)
            self.assertEqual({r["label"] for r in rows}, {"benign", "phish"})
            self.assertTrue(all(r["url"] == "https://real.example/" for r in rows))


class PhishDecloakerAndPutraTest(unittest.TestCase):
    def test_phishdecloaker_exports_largest_kit_html_and_rejects_kit_without_html(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            for empty_zip in ("ablation-dataset.zip", "landscape-dataset.zip"):
                with zipfile.ZipFile(folder / empty_zip, "w"):
                    pass
            with zipfile.ZipFile(folder / "phishing-kits-dataset.zip", "w") as z:
                z.writestr("kits/kit-a/small.html", "<p>a</p>")
                z.writestr("kits/kit-a/login.html", "<p>larger login page</p>")
                z.writestr("kits/kit-b/index.php", "<?php echo 1; ?>")
            rows, receipt = run(new_rows.convert_phishdecloaker, folder)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["label"], "phish")
            self.assertIn("larger login page", rows[0]["html"])
            self.assertEqual(receipt.exported, 1)
            self.assertEqual(sum(receipt.rejected.values()), 1)

    def test_putra_exports_five_zips_and_maps_brand_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "phishing.csv").write_text(
                '_id,url,brands\nsite-p1,https://fake.example/,"[""Acme""]"\n', encoding="utf-8"
            )
            (folder / "not-phishing.csv").write_text(
                '_id,url,brands\nsite-b1,https://real.example/,"[""Acme""]"\n', encoding="utf-8"
            )
            (folder / "brands.csv").write_text("brand\nAcme\n", encoding="utf-8")
            for name in (
                "phishing_0501-1000.zip",
                "phishing_1001-1500.zip",
                "phishing_1501-2000.zip",
            ):
                with zipfile.ZipFile(folder / name, "w"):
                    pass
            with zipfile.ZipFile(folder / "phishing_0001-0500.zip", "w") as z:
                z.writestr("site-p1/original.html", "<p>fake login</p>")
                z.writestr("site-p1/screenshots/original_js_on.jpg", b"\xff\xd8\xff\xd9")
            with zipfile.ZipFile(folder / "not-phishing_0001-0500.zip", "w") as z:
                z.writestr("site-b1/index.html", "<p>real home</p>")
            rows, receipt = run(new_rows.convert_putra, folder)
            self.assertEqual(len(rows), 2)
            self.assertEqual({(r["label"], r["target"]) for r in rows}, {("phish", "Acme"), ("benign", "Acme")})
            self.assertEqual(receipt.exported, 2)


class FreeSpaceAndCoverageGuardTest(unittest.TestCase):
    def _write_ows_fixture(self, folder: Path):
        import hashlib

        jsonl = folder / "malicious_OWS_URL_HTML_DS.jsonl"
        csv_file = folder / "OWS_URL_DS.csv"
        records = [
            {"url": "https://a.example", "label": "Malicious", "sublabel": "Phishing", "html": "<p>Sign in 1</p>"},
            {"url": "https://b.example", "label": "Malicious", "sublabel": "Phishing", "html": "<p>Sign in 2</p>"},
        ]
        jsonl.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
        csv_file.write_text("url\nhttps://a.example\n", encoding="utf-8")
        downloads = [
            {"dest": str(jsonl), "md5": hashlib.md5(jsonl.read_bytes()).hexdigest()},
            {"dest": str(csv_file), "md5": hashlib.md5(csv_file.read_bytes()).hexdigest()},
        ]
        (folder / "download.jsonl").write_text("".join(json.dumps(d) + "\n" for d in downloads), encoding="utf-8")

    def test_low_free_space_refuses_preserving_previous_outputs_and_resumes_when_freed(self):
        from collections import namedtuple
        import inputs as inputs_module

        Usage = namedtuple("Usage", ["total", "used", "free"])
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            self._write_ows_fixture(folder)
            policy = {"ows": {"default_max": None, "seed": 20261101, "max_sampled_out": 0, "min_exported": {"phish": 2, "benign": 0}}}
            # First run succeeds with 400 GB free.
            receipt, by_label = new_rows.convert_source(
                "ows",
                folder,
                usage_fn=lambda _: Usage(500 * 10**9, 100 * 10**9, 400 * 10**9),
                policy=policy,
            )
            self.assertEqual(receipt.exported, 2)
            self.assertEqual(by_label["phish"], 2)
            previous_rows = (folder / "rows.jsonl").read_text(encoding="utf-8")
            previous_export = (folder / "EXPORT.json").read_text(encoding="utf-8")

            # Second run drops below 300 GB on the second row write: refuses and preserves previous outputs intact.
            calls = {"n": 0}

            def dropping_usage(_):
                calls["n"] += 1
                free = 400 * 10**9 if calls["n"] < 3 else 250 * 10**9
                return Usage(500 * 10**9, 500 * 10**9 - free, free)

            with self.assertRaises(inputs_module.Refused) as ctx:
                new_rows.convert_source("ows", folder, usage_fn=dropping_usage, policy=policy)
            self.assertIn("must stay free", str(ctx.exception))
            self.assertEqual((folder / "rows.jsonl").read_text(encoding="utf-8"), previous_rows)
            self.assertEqual((folder / "EXPORT.json").read_text(encoding="utf-8"), previous_export)
            self.assertEqual(list(folder.glob(".*.tmp")), [])

            # Resuming once space recovers succeeds cleanly.
            receipt2, _ = new_rows.convert_source(
                "ows",
                folder,
                usage_fn=lambda _: Usage(500 * 10**9, 100 * 10**9, 450 * 10**9),
                policy=policy,
            )
            self.assertEqual(receipt2.exported, 2)

    def test_coverage_guard_rejects_truncated_export(self):
        from collections import namedtuple
        import inputs as inputs_module

        Usage = namedtuple("Usage", ["total", "used", "free"])
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            self._write_ows_fixture(folder)
            with self.assertRaises(inputs_module.Refused) as ctx:
                new_rows.convert_source(
                    "ows",
                    folder,
                    usage_fn=lambda _: Usage(500 * 10**9, 100 * 10**9, 400 * 10**9),
                    policy=new_rows.NEW_SOURCE_POLICY,
                )
            self.assertIn("below the 25189 policy floor", str(ctx.exception))
            self.assertFalse((folder / "rows.jsonl").exists())
            self.assertFalse((folder / "EXPORT.json").exists())


if __name__ == "__main__":
    unittest.main()
