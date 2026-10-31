"""scripts/glimmer/dataset_rows.py (D03 T04 §18): each source's archive read in memory into PhreshPhish-shaped rows,
labels from the source's own index, an oversized entry skipped, and a large source sampled with its seed. Every read is
charged to `inputs.Limits` (D03 T04 §28): index and workbook loading, nested workbook expansion, retained bytes and the
deadline. The workbooks are real openpyxl files, so openpyxl is required: the tests skip without it locally and CI
requires it (REQUIRE_GLIMMER_DATA_TOOLS=1)."""
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HAVE_DATA_TOOLS = importlib.util.find_spec("openpyxl") is not None and importlib.util.find_spec("pyarrow") is not None
if os.environ.get("REQUIRE_GLIMMER_DATA_TOOLS") == "1" and not HAVE_DATA_TOOLS:
    raise RuntimeError(
        "REQUIRE_GLIMMER_DATA_TOOLS=1 but openpyxl or pyarrow is missing: pip install -r scripts/glimmer/requirements.txt")
# The checks read real workbooks and Parquet files: they skip without those libraries locally and are required in CI,
# which sets REQUIRE_GLIMMER_DATA_TOOLS=1.
needs_data_tools = unittest.skipUnless(HAVE_DATA_TOOLS, "needs scripts/glimmer/requirements.txt (openpyxl, pyarrow)")
if HAVE_DATA_TOOLS:
    import openpyxl


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "dataset_rows.py"
spec = importlib.util.spec_from_file_location("dataset_rows", SCRIPT)
rows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rows)


def workbook(table):
    """A real .xlsx (openpyxl) holding `table`, as bytes."""
    book = openpyxl.Workbook()
    for row in table:
        book.active.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


@needs_data_tools
class Rows(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="dataset-rows-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        patcher = mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(self.dir)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def folder(self, source):
        path = self.dir / "raw" / source
        path.mkdir(parents=True)
        return path

    def bind(self, source):
        """The source's inputs bound in its manifest, pinned as their collection pinned them."""
        folder = self.dir / "raw" / source
        names = rows.INPUT_FILES[source](folder)
        rows.inputs_module.build(folder, [{"name": n, "published": None, "pinned": "kaggle: version 1"} for n in names], "CC BY 4.0")

    def receipt(self, source):
        return json.loads((self.dir / "raw" / source / "EXPORT.json").read_text())

    def written(self, source):
        return [json.loads(line) for line in (self.dir / "raw" / source / "rows.jsonl").read_text().splitlines()]

    def test_kempf_labels_come_from_the_folders(self):
        folder = self.folder("kempf-html")
        with zipfile.ZipFile(folder / "kempf-html.zip", "w") as archive:
            archive.writestr("training/Phish/1_bank_com.html", "<p>Sign in</p>")
            archive.writestr("validation/NotPhish/2_news_co_za.html", "<p>News</p>")
            archive.writestr("README.txt", "not a page")
        self.bind("kempf-html")
        with mock.patch("sys.stdout"):
            rows.main(["kempf-html"])
        got = {row["sha256"]: row["label"] for row in self.written("kempf-html")}
        self.assertEqual(got, {"kempf-training-1_bank_com": "phish", "kempf-validation-2_news_co_za": "benign"})
        # The README is met and rejected, never silently dropped.
        self.assertEqual(self.receipt("kempf-html")["rejected"], {"not a labelled HTML page in the archive's layout": 1})
        rejected = [json.loads(l) for l in (self.dir / "raw" / "kempf-html" / "ITEMS.jsonl").read_text().splitlines()][1:]
        self.assertEqual([e for e in rejected if e["outcome"] == "rejected"][0]["reason"], "not a labelled HTML page in the archive's layout")

    def test_ariyadasa_reads_its_sql_index_without_running_it_and_skips_an_oversized_entry(self):
        folder = self.folder("ariyadasa-2021")
        (folder / "index.sql").write_text(
            "INSERT INTO `index` (`rec_id`, `url`, `website`, `result`, `created_date`) VALUES\n"
            "(1, 'https://bank-login.example/it\\'s', '100.html', 1, '2021-01-01'),\n"
            "(2, 'https://shop.example/', '200.html', 0, '2021-01-01'),\n"
            "(3, 'https://huge.example/', '300.html', 1, '2021-01-01');\n")
        with zipfile.ZipFile(folder / "dataset_part_1.zip", "w") as archive:
            archive.writestr("dataset-part-1/100.html", "<p>Verify</p>")
            archive.writestr("dataset-part-1/200.html", '<meta charset="windows-1251"><p>\xcf\xf0\xe8\xe2\xe5\xf2</p>'
                             .encode("latin1"))
            archive.writestr("dataset-part-1/300.html", "x" * (rows.MAX_ENTRY + 1))
        self.bind("ariyadasa-2021")
        with mock.patch("sys.stdout"):
            rows.main(["ariyadasa-2021"])
        self.assertEqual(self.receipt("ariyadasa-2021")["rejected"], {f"over {rows.MAX_ENTRY} bytes": 1})
        got = {row["sha256"]: row for row in self.written("ariyadasa-2021")}
        self.assertEqual(sorted(got), ["ariyadasa-100", "ariyadasa-200"])
        self.assertEqual(got["ariyadasa-100"]["url"], "https://bank-login.example/it's")
        self.assertEqual(got["ariyadasa-100"]["label"], "phish")
        self.assertIn("Привет", got["ariyadasa-200"]["html"])

    def test_ariyadasa_reads_only_the_parts_its_verified_manifest_lists(self):
        folder = self.folder("ariyadasa-2021")
        (folder / "index.sql").write_text(
            "INSERT INTO `index` (`rec_id`, `url`, `website`, `result`, `created_date`) VALUES\n"
            "(1, 'https://a.example/', '100.html', 1, '2021-01-01'),\n"
            "(2, 'https://b.example/', '200.html', 0, '2021-01-01');\n")
        with zipfile.ZipFile(folder / "dataset_part_1.zip", "w") as archive:
            archive.writestr("dataset-part-1/100.html", "<p>Verify</p>")
        self.bind("ariyadasa-2021")
        manifest = json.loads((folder / "INPUTS.json").read_text())
        # A part copied in after verification (a download still finishing) is not in the manifest, so not read.
        with zipfile.ZipFile(folder / "dataset_part_2.zip", "w") as archive:
            archive.writestr("dataset-part-2/200.html", "<p>Late</p>")
        items = list(rows.ariyadasa(folder, rows.Receipt(), rows.Limits(), manifest))
        self.assertEqual([item[0] for item in items], ["ariyadasa-100"])

    def test_a_large_source_is_sampled_with_its_seed(self):
        folder = self.folder("kempf-html")
        with zipfile.ZipFile(folder / "kempf-html.zip", "w") as archive:
            for number in range(50):
                archive.writestr(f"training/Phish/{number}_x_com.html", f"<p>{number}</p>")
        self.bind("kempf-html")
        with mock.patch("sys.stdout"):
            rows.main(["kempf-html", "--max", "10", "--seed", "3"])
        first = [row["sha256"] for row in self.written("kempf-html")]
        with mock.patch("sys.stdout"):
            rows.main(["kempf-html", "--max", "10", "--seed", "3"])
        self.assertEqual(len(first), 10)
        self.assertEqual((self.receipt("kempf-html")["exported"], self.receipt("kempf-html")["sampled_out"]), (10, 40))
        # The item ledger names all 50, each once: the 10 exported as their rows are named, the 40 sampled out (§28 G3).
        ledger = [json.loads(l) for l in (self.dir / "raw" / "kempf-html" / "ITEMS.jsonl").read_text().splitlines()][1:]
        self.assertEqual(len(ledger), 50)
        self.assertEqual(len({e["item"] for e in ledger}), 50)
        exported = sorted(e["item"] for e in ledger if e["outcome"] == "exported")
        self.assertEqual(exported, sorted(row["sha256"] for row in self.written("kempf-html")))
        self.assertEqual(sum(e["outcome"] == "sampled-out" for e in ledger), 40)
        self.assertEqual(first, [row["sha256"] for row in self.written("kempf-html")])

    def test_refuses_inputs_not_bound_and_keeps_the_earlier_rows(self):
        folder = self.folder("kempf-html")
        with zipfile.ZipFile(folder / "kempf-html.zip", "w") as archive:
            archive.writestr("training/Phish/1_bank_com.html", "<p>Sign in</p>")
        (folder / "rows.jsonl").write_text("earlier\n")
        with mock.patch("sys.stderr"):
            self.assertEqual(rows.main(["kempf-html"]), 1)
        self.assertEqual((folder / "rows.jsonl").read_text(), "earlier\n")

    def test_refuses_mallory_sheets_of_different_lengths(self):
        folder = self.folder("look-for-mallory")
        with zipfile.ZipFile(folder / "look-for-mallory.zip", "w") as archive:
            archive.writestr("html.xlsx", workbook([("category", "html"), ("spam", "<p>a</p>"), ("ham", "<p>b</p>")]))
            archive.writestr("urls.xlsx", workbook([("category", "url"), ("spam", "https://a.example/")]))
        self.bind("look-for-mallory")
        with mock.patch("sys.stderr"):
            self.assertEqual(rows.main(["look-for-mallory"]), 1)
        self.assertFalse((folder / "rows.jsonl").exists())

    # The limits (§28). A refusal happens while the readers list their items, before the temporary rows file is opened:
    # nothing is published, the earlier rows file is whole and no temporary file or receipt is left.
    def refused(self, source, pattern, **bounds):
        folder = self.dir / "raw" / source
        (folder / "rows.jsonl").write_text("earlier\n")
        before = sorted(p.name for p in folder.iterdir())
        bounded = mock.patch.object(rows, "Limits", lambda: rows.inputs_module.Limits(**bounds))
        with bounded, mock.patch("sys.stderr") as err:
            self.assertEqual(rows.main([source]), 1)
        self.assertRegex("".join(call.args[0] for call in err.write.call_args_list), pattern)
        self.assertEqual((folder / "rows.jsonl").read_text(), "earlier\n")
        self.assertEqual(sorted(p.name for p in folder.iterdir()), before)

    def compphish(self, count=1):
        folder = self.folder("compphish")
        (folder / "Mapping_File.xlsx").write_bytes(
            workbook([("serial", "url", "label")] + [(n, f"https://{n}.example/", n % 2) for n in range(count)]))
        with zipfile.ZipFile(folder / "All_HTML.zip", "w") as archive:
            for n in range(count):
                archive.writestr(f"{n}.html", "<p>x</p>")
        self.bind("compphish")
        return folder

    def test_a_nested_sheet_bomb_in_the_mapping_workbook_stops_at_the_expanded_limit(self):
        folder = self.compphish(count=3000)
        on_disk = (folder / "Mapping_File.xlsx").stat().st_size
        with zipfile.ZipFile(folder / "Mapping_File.xlsx") as book:
            declared = sum(info.file_size for info in book.infolist())
        self.assertGreater(declared, 3 * on_disk)  # the file is small, what it expands to is not
        self.refused("compphish", "bytes expanded", expanded=on_disk * 2)

    def test_a_nested_sheet_bomb_inside_mallory_stops_at_the_expanded_limit(self):
        folder = self.folder("look-for-mallory")
        big = workbook([("category", "html")] + [("spam", "<p>" + "a" * 50 + "</p>")] * 3000)
        with zipfile.ZipFile(folder / "look-for-mallory.zip", "w") as archive:
            archive.writestr("html.xlsx", big)
            archive.writestr("urls.xlsx", workbook([("category", "url")]))
        self.bind("look-for-mallory")
        with zipfile.ZipFile(io.BytesIO(big)) as book:
            declared = sum(info.file_size for info in book.infolist())
        # The nested workbook's own size passes the limit; what it expands to does not.
        self.assertGreater(declared, 2 * len(big))
        self.refused("look-for-mallory", "bytes expanded", expanded=len(big) * 2)

    def test_a_nested_workbook_over_the_allocation_limit_is_refused_before_it_is_read(self):
        folder = self.folder("look-for-mallory")
        with zipfile.ZipFile(folder / "look-for-mallory.zip", "w") as archive:
            archive.writestr("html.xlsx", workbook([("category", "html"), ("spam", "<p>a</p>")]))
            archive.writestr("urls.xlsx", workbook([("category", "url"), ("spam", "https://a.example/")]))
        self.bind("look-for-mallory")
        self.refused("look-for-mallory", "html.xlsx of .* bytes passes the 500 byte allocation limit", allocation=500)

    def test_a_large_sql_index_is_refused_before_it_is_read(self):
        folder = self.folder("ariyadasa-2021")
        (folder / "index.sql").write_text("-- " + "x" * 5000 + "\n")
        with zipfile.ZipFile(folder / "dataset_part_1.zip", "w") as archive:
            archive.writestr("dataset-part-1/100.html", "<p>x</p>")
        self.bind("ariyadasa-2021")
        unread = mock.Mock(finditer=mock.Mock(side_effect=AssertionError("index.sql was parsed")))
        with mock.patch.object(rows, "SQL_ROW", unread):
            self.refused("ariyadasa-2021", "index.sql read whole of .* bytes passes the 10000 byte allocation limit",
                         allocation=10_000)

    def test_a_retained_byte_overrun_in_the_sql_index_stops_at_its_limit(self):
        folder = self.folder("ariyadasa-2021")
        (folder / "index.sql").write_text("INSERT INTO `index` VALUES\n" + ",\n".join(
            f"({n}, 'https://{n}.example/', '{n}.html', 1, '2021-01-01')" for n in range(100)) + ";\n")
        with zipfile.ZipFile(folder / "dataset_part_1.zip", "w") as archive:
            archive.writestr("dataset-part-1/1.html", "<p>x</p>")
        self.bind("ariyadasa-2021")
        self.refused("ariyadasa-2021", "bytes retained at once", retained=5000)

    def test_a_retained_byte_overrun_in_the_mapping_labels_stops_at_its_limit(self):
        self.compphish(count=100)
        self.refused("compphish", "bytes retained at once", retained=5000)

    def test_a_retained_byte_overrun_in_mallory_sheets_stops_at_its_limit(self):
        folder = self.folder("look-for-mallory")
        with zipfile.ZipFile(folder / "look-for-mallory.zip", "w") as archive:
            spam = [("spam", "<p>" + "a" * 400 + "</p>")]
            archive.writestr("html.xlsx", workbook([("category", "html")] + spam * 50))
            archive.writestr("urls.xlsx", workbook([("category", "url")] + [("spam", "https://a.example/")] * 50))
        self.bind("look-for-mallory")
        self.refused("look-for-mallory", "bytes retained at once", retained=10_000)

    def test_a_listing_inside_the_default_bounds_is_exported_whole(self):
        self.compphish(count=100)
        folder = self.dir / "raw" / "compphish"
        with mock.patch("sys.stdout"):
            self.assertEqual(rows.main(["compphish"]), 0)  # at the default bounds the same listing is exported whole
        self.assertEqual(len(self.written("compphish")), 100)
        self.assertTrue((folder / "EXPORT.json").exists())

    def test_a_slow_loop_stops_at_the_deadline_in_each_reader(self):
        kempf = self.folder("kempf-html")
        with zipfile.ZipFile(kempf / "kempf-html.zip", "w") as archive:
            for n in range(200):
                archive.writestr(f"training/Phish/{n}_x_com.html", "<p>x</p>")
        self.bind("kempf-html")
        ticks = iter(range(10**6))  # the fake clock advances one second a look
        self.refused("kempf-html", "passed 20 seconds", seconds=20, clock=lambda: next(ticks))
        self.compphish(count=200)
        ticks = iter(range(10**6))
        self.refused("compphish", "passed 20 seconds", seconds=20, clock=lambda: next(ticks))
        mallory = self.folder("look-for-mallory")
        with zipfile.ZipFile(mallory / "look-for-mallory.zip", "w") as archive:
            archive.writestr("html.xlsx", workbook([("category", "html")] + [("spam", "<p>a</p>")] * 200))
            archive.writestr("urls.xlsx", workbook([("category", "url")] + [("spam", "https://a.example/")] * 200))
        self.bind("look-for-mallory")
        ticks = iter(range(10**6))
        self.refused("look-for-mallory", "passed 20 seconds", seconds=20, clock=lambda: next(ticks))

    # The same limits, proved one reader at a time: a reader called directly has no main loop beside it, so each
    # charge and each deadline check inside the reader's own loops is the only thing that can stop it.
    def test_each_reader_charges_what_it_holds_and_checks_the_deadline_in_its_own_loops(self):
        def ticking(**bounds):
            ticks = iter(range(10**6))  # the fake clock advances one second a look
            return rows.Limits(clock=lambda: next(ticks), **bounds)

        # compphish: the labels are retained as read, and the deadline is checked in the label loop.
        self.compphish(count=300)
        folder = self.dir / "raw" / "compphish"
        with self.assertRaisesRegex(rows.inputs_module.Refused, "bytes retained at once"):
            next(rows.compphish(folder, rows.Receipt(), rows.Limits(retained=5000)))
        with self.assertRaisesRegex(rows.inputs_module.Refused, "passed 40 seconds"):
            next(rows.compphish(folder, rows.Receipt(), ticking(seconds=40)))
        # ariyadasa: the index rows are retained as matched, and the deadline is checked in the match loop.
        sql = self.folder("ariyadasa-2021")
        (sql / "index.sql").write_text("INSERT INTO `index` VALUES\n" + ",\n".join(
            f"({n}, 'https://{n}.example/', '{n}.html', 1, '2021-01-01')" for n in range(300)) + ";\n")
        manifest = {"files": [{"name": "dataset_part_1.zip"}]}
        with zipfile.ZipFile(sql / "dataset_part_1.zip", "w") as archive:
            archive.writestr("dataset-part-1/1.html", "<p>x</p>")
        with self.assertRaisesRegex(rows.inputs_module.Refused, "passed 40 seconds"):
            next(rows.ariyadasa(sql, rows.Receipt(), ticking(seconds=40), manifest))
        # mallory: each sheet's rows are retained as read, and the deadline is checked in the row loop.
        mallory = self.folder("look-for-mallory")
        with zipfile.ZipFile(mallory / "look-for-mallory.zip", "w") as archive:
            spam = [("spam", "<p>" + "a" * 400 + "</p>")]
            archive.writestr("html.xlsx", workbook([("category", "html")] + spam * 300))
            archive.writestr("urls.xlsx", workbook([("category", "url")] + [("spam", "https://a.example/")] * 300))
        with self.assertRaisesRegex(rows.inputs_module.Refused, "bytes retained at once"):
            next(rows.mallory(mallory, rows.Receipt(), rows.Limits(retained=20_000)))
        with self.assertRaisesRegex(rows.inputs_module.Refused, "passed 60 seconds"):
            next(rows.mallory(mallory, rows.Receipt(), ticking(seconds=60)))

    def test_main_charges_every_item_it_lists_to_the_retained_bytes(self):
        folder = self.folder("kempf-html")
        with zipfile.ZipFile(folder / "kempf-html.zip", "w") as archive:
            for n in range(100):
                archive.writestr(f"training/Phish/{n}_x_com.html", "<p>x</p>")
        self.bind("kempf-html")
        self.refused("kempf-html", "bytes retained at once", retained=5000)


if __name__ == "__main__":
    unittest.main()
