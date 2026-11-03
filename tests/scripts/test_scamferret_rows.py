"""scripts/glimmer/scamferret_rows.py (D03 T04 §28): the artifact archive's pages become rows bound to an EXPORT.json,
read only from the archive bound in INPUTS.json, and every read is charged to `inputs.Limits` (retained bytes, one
allocation, entries and the deadline). The fixtures are synthetic tar archives."""
import base64
import gzip
import importlib.util
import io
import json
import os
import shutil
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "scamferret_rows.py"
spec = importlib.util.spec_from_file_location("scamferret_rows", SCRIPT)
rows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rows)

ROOT = f"artifact-{rows.COMMIT}/dataset"


def add(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))


def page(archive, folder, category, host, html, png=None, png_first=False):
    base = f"{ROOT}/{folder}/{category}"
    if png is not None and png_first:
        add(archive, f"{base}/sample_screenshot/{host}.png", png)
    add(archive, f"{base}/toppage_html/{host}.html.gz", gzip.compress(html))
    if png is not None and not png_first:
        add(archive, f"{base}/sample_screenshot/{host}.png", png)


class ScamFerretRows(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="scamferret-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        patcher = mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(self.dir)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.folder = self.dir / "raw" / "scamferret"
        self.folder.mkdir(parents=True)
        with tarfile.open(self.folder / rows.ARCHIVE, "w:gz") as archive:
            page(archive, "scam_websites", "online_shopping_english", "cheap-shoes.example", b"<h1>Shoes 90% off</h1>",
                 png=b"png-after")
            page(archive, "scam_websites", "cryptocurrency", "coin.example", b"<h1>Daily returns</h1>",
                 png=b"png-before", png_first=True)
            page(archive, "legitimate_websites", "investment", "bank.example", b"<h1>Annual report</h1>")
            add(archive, f"{ROOT}/legitimate_websites/investment/toppage_html/broken.example.html.gz", b"not gzip")
            add(archive, f"artifact-{rows.COMMIT}/README.md", b"not a page")
        self.bind()

    def bind(self):
        rows.inputs_module.build(self.folder, [{"name": rows.ARCHIVE, "published": None,
                                                "pinned": f"git: ScamFerret/artifact {rows.COMMIT}"}], "GPL-3.0")

    def run_main(self, **bounds):
        limits = (lambda: rows.inputs_module.Limits(**bounds)) if bounds else rows.inputs_module.Limits
        with mock.patch.object(rows, "Limits", limits), mock.patch("sys.stdout"), mock.patch("sys.stderr") as err:
            code = rows.main([])
        return code, "".join(call.args[0] for call in err.write.call_args_list)

    def written(self):
        return {row["sha256"]: row for row in map(json.loads, (self.folder / "rows.jsonl").read_text().splitlines())}

    def test_one_row_a_page_with_its_screenshot_and_a_receipt_bound_to_the_inputs(self):
        self.assertEqual(self.run_main()[0], 0)
        by_id = self.written()
        self.assertEqual(sorted(by_id), [
            "legitimate_websites/investment/bank.example.html.gz",
            "scam_websites/cryptocurrency/coin.example.html.gz",
            "scam_websites/online_shopping_english/cheap-shoes.example.html.gz",
        ])
        shoes = by_id["scam_websites/online_shopping_english/cheap-shoes.example.html.gz"]
        self.assertEqual((shoes["url"], shoes["label"], shoes["category"], shoes["target"]),
                         ("https://cheap-shoes.example/", "phish", "online_shopping_english", None))
        self.assertEqual(shoes["html"], "<h1>Shoes 90% off</h1>")
        self.assertEqual(base64.b64decode(shoes["screenshot"]), b"png-after")
        coin = by_id["scam_websites/cryptocurrency/coin.example.html.gz"]
        self.assertEqual(base64.b64decode(coin["screenshot"]), b"png-before")  # a picture ahead of its page
        bank = by_id["legitimate_websites/investment/bank.example.html.gz"]
        self.assertEqual((bank["label"], "screenshot" in bank), ("benign", False))
        receipt = json.loads((self.folder / "EXPORT.json").read_text())
        self.assertEqual((receipt["met"], receipt["exported"], receipt["sampled_out"]), (4, 3, 0))
        self.assertEqual(receipt["rejected"], {f"not a gzip page of at most {rows.MAX_HTML} bytes": 1})
        self.assertEqual(receipt["inputs"], rows.inputs_module.verify(self.folder, rows.INPUT_FILES)[1])
        self.assertEqual(receipt["rows_sha256"], rows.inputs_module.file_digest(self.folder / "rows.jsonl"))
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()),
                         sorted(["INPUTS.json", "EXPORT.json", "ITEMS.inventory.jsonl", "ITEMS.jsonl", "rows.jsonl", rows.ARCHIVE]))
        # The item ledger names all 4 pages met, the rejected one with its reason (§28 G3).
        ledger = [json.loads(l) for l in (self.folder / "ITEMS.jsonl").read_text().splitlines()]
        self.assertEqual(ledger[0], {"inputs": receipt["inputs"], "rows": receipt["rows_sha256"]})
        self.assertEqual(sorted(e["item"] for e in ledger[1:] if e["outcome"] == "exported"), sorted(by_id))
        self.assertEqual([e["reason"] for e in ledger[1:] if e["outcome"] == "rejected"],
                         [f"not a gzip page of at most {rows.MAX_HTML} bytes"])

    def test_a_page_is_decoded_as_the_importer_decodes_it(self):
        self.assertEqual(rows.decode(b"\xef\xbb\xbfcaf\xc3\xa9"), "café")
        self.assertEqual(rows.decode(b"<meta charset=windows-1251>\xcf\xf0\xe8"), "<meta charset=windows-1251>При")
        self.assertEqual(rows.decode(b"caf\xe9"), "café")  # undeclared and not UTF-8: Windows-1252
        self.assertEqual(rows.decode(b"caf\xc3\xa9"), "café")

    def test_refuses_an_archive_not_bound_or_changed_and_keeps_the_earlier_rows(self):
        (self.folder / "rows.jsonl").write_text("earlier\n")
        (self.folder / "INPUTS.json").unlink()
        code, message = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("INPUTS.json", message)
        self.bind()
        with (self.folder / rows.ARCHIVE).open("ab") as handle:
            handle.write(b"x")
        code, message = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("changed since the manifest was written", message)
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")
        self.assertFalse((self.folder / "EXPORT.json").exists())

    def test_an_archive_missing_from_the_manifest_is_refused(self):
        other = self.folder / "other.tar.gz"
        other.write_bytes(b"x")
        rows.inputs_module.build(self.folder, [{"name": "other.tar.gz", "published": None, "pinned": "pin"}], "GPL-3.0")
        code, message = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn(f"{rows.ARCHIVE}: not in the manifest", message)
        self.assertFalse((self.folder / "rows.jsonl").exists())

    def single_page(self, html=b"<p>x</p>", png=None):
        with tarfile.open(self.folder / rows.ARCHIVE, "w:gz") as archive:
            page(archive, "scam_websites", "technical_support", "help.example", html, png=png)
        self.bind()

    def refused(self, pattern, **bounds):
        """The conversion under `bounds` is refused naming its limit, the earlier rows file is whole and nothing else
        is left behind."""
        (self.folder / "rows.jsonl").write_text("earlier\n")
        code, message = self.run_main(**bounds)
        self.assertEqual(code, 1)
        self.assertRegex(message, pattern)
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")
        left = sorted(p.name for p in self.folder.iterdir())
        self.assertEqual(left, sorted(["INPUTS.json", "rows.jsonl", rows.ARCHIVE]))

    def test_the_retained_byte_limit_stops_the_conversion_with_the_earlier_rows_whole(self):
        # The first pass charges each screenshot's name, the second each page it holds: the fixture passes 600 bytes.
        self.refused("bytes retained at once", retained=600)

    def test_a_page_held_for_its_screenshot_stops_at_the_retained_byte_limit(self):
        self.single_page(html=b"<p>" + b"x" * 5000 + b"</p>", png=b"png")
        self.refused("bytes retained at once", retained=3000)

    def test_a_screenshot_held_for_its_page_stops_at_the_retained_byte_limit(self):
        # The index and the small page fit 2000 bytes; the screenshot held for it does not.
        self.single_page(png=b"p" * 5000)
        self.refused("bytes retained at once", retained=2000)

    def test_a_held_page_releases_its_bytes_once_written(self):
        with tarfile.open(self.folder / rows.ARCHIVE, "w:gz") as archive:
            for n in range(5):
                page(archive, "scam_websites", "technical_support", f"h{n}.example", b"<p>" + b"x" * 1600 + b"</p>",
                     png=b"p" * 1600)
        self.bind()
        # Five 1600 byte pages and as many screenshots do not fit 8000 bytes beside the index if each stayed held.
        self.assertEqual(self.run_main(retained=8000)[0], 0)
        self.assertEqual(len(self.written()), 5)

    def test_one_page_over_the_allocation_limit_is_refused_before_it_is_read(self):
        # Its 23 byte member passes 20 bytes, though the 12 byte row built from it would not.
        self.single_page(html=b"<p>")
        self.assertGreater(len(gzip.compress(b"<p>")), 20)
        self.refused("help.example.html.gz of \\d+ bytes passes the 20 byte allocation limit", allocation=20)

    def test_a_row_over_the_allocation_limit_is_refused_before_it_is_built(self):
        self.single_page(html=b"<p>" + b"x" * 5000 + b"</p>")  # the member is small, the row built from its text is not
        self.refused("the row for .* passes the 1000 byte allocation limit", allocation=1000)

    def test_the_entry_limit_stops_the_conversion(self):
        self.refused("more than 2 archive entries", entries=2)

    def test_the_expanded_byte_limit_counts_each_page_as_it_is_decompressed(self):
        self.single_page(html=b"<p>" + b"x" * 5000 + b"</p>")
        self.refused("bytes expanded", expanded=3000)

    def test_the_first_pass_counts_its_entries_and_checks_the_deadline(self):
        path = self.folder / rows.ARCHIVE
        with self.assertRaisesRegex(rows.inputs_module.Refused, "more than 2 archive entries"):
            rows.screenshots(path, rows.inputs_module.Limits(entries=2))
        ticks = iter(range(10_000))
        with self.assertRaisesRegex(rows.inputs_module.Refused, "passed 3 seconds"):
            rows.screenshots(path, rows.inputs_module.Limits(seconds=3, clock=lambda: next(ticks)))

    def test_the_second_pass_counts_its_own_entries(self):
        made = []

        def limits():
            made.append(rows.inputs_module.Limits())
            return made[-1]

        with mock.patch.object(rows, "Limits", limits), mock.patch("sys.stdout"):
            self.assertEqual(rows.main([]), 0)
        with tarfile.open(self.folder / rows.ARCHIVE) as archive:
            members = len(archive.getmembers())
        self.assertEqual(made[0].entries, members)  # new_pass() cleared the first pass's count: this is the second's

    def test_a_slow_loop_stops_at_the_deadline(self):
        ticks = iter(range(10_000))
        self.refused("passed 3 seconds", seconds=3, clock=lambda: next(ticks))

    def test_a_page_that_expands_past_its_limit_is_rejected_not_read_whole(self):
        self.single_page(html=b"a" * 5000)
        with mock.patch.object(rows, "MAX_HTML", 1000):
            self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(self.written(), {})
        self.assertEqual(json.loads((self.folder / "EXPORT.json").read_text())["rejected"],
                         {"not a gzip page of at most 1000 bytes": 1})

    def test_an_oversized_screenshot_rejects_its_page_rather_than_dropping_the_picture(self):
        self.single_page(png=b"p" * 5000)
        with mock.patch.object(rows, "MAX_SCREENSHOT", 1000):
            self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(self.written(), {})
        self.assertEqual(json.loads((self.folder / "EXPORT.json").read_text())["rejected"],
                         {"its screenshot is over 1000 bytes": 1})

    def test_a_page_named_twice_is_one_item(self):
        with tarfile.open(self.folder / rows.ARCHIVE, "w:gz") as archive:
            for html in (b"<p>first</p>", b"<p>second</p>"):
                page(archive, "scam_websites", "technical_support", "help.example", html)
        self.bind()
        self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(len(self.written()), 1)
        self.assertEqual(json.loads((self.folder / "EXPORT.json").read_text())["met"], 1)

    def test_a_killed_runs_staging_is_removed(self):
        stale = self.folder / ".rows.jsonl.999999999.tmp"
        stale.write_text("half")
        self.assertEqual(self.run_main()[0], 0)
        self.assertFalse(stale.exists())


if __name__ == "__main__":
    unittest.main()
