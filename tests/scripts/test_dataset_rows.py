"""scripts/glimmer/dataset_rows.py (D03 T04 §18): each source's archive read in memory into PhreshPhish-shaped rows,
labels from the source's own index, an oversized entry skipped, and a large source sampled with its seed."""
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "dataset_rows.py"
spec = importlib.util.spec_from_file_location("dataset_rows", SCRIPT)
rows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rows)


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

    def written(self, source):
        return [json.loads(line) for line in (self.dir / "raw" / source / "rows.jsonl").read_text().splitlines()]

    def test_kempf_labels_come_from_the_folders(self):
        folder = self.folder("kempf-html")
        with zipfile.ZipFile(folder / "kempf-html.zip", "w") as archive:
            archive.writestr("training/Phish/1_bank_com.html", "<p>Sign in</p>")
            archive.writestr("validation/NotPhish/2_news_co_za.html", "<p>News</p>")
            archive.writestr("README.txt", "not a page")
        with mock.patch("sys.stdout"):
            rows.main(["kempf-html"])
        got = {row["sha256"]: row["label"] for row in self.written("kempf-html")}
        self.assertEqual(got, {"kempf-training-1_bank_com": "phish", "kempf-validation-2_news_co_za": "benign"})

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
        with mock.patch("sys.stdout"):
            rows.main(["ariyadasa-2021"])
        got = {row["sha256"]: row for row in self.written("ariyadasa-2021")}
        self.assertEqual(sorted(got), ["ariyadasa-100", "ariyadasa-200"])
        self.assertEqual(got["ariyadasa-100"]["url"], "https://bank-login.example/it's")
        self.assertEqual(got["ariyadasa-100"]["label"], "phish")
        self.assertIn("Привет", got["ariyadasa-200"]["html"])

    def test_a_large_source_is_sampled_with_its_seed(self):
        folder = self.folder("kempf-html")
        with zipfile.ZipFile(folder / "kempf-html.zip", "w") as archive:
            for number in range(50):
                archive.writestr(f"training/Phish/{number}_x_com.html", f"<p>{number}</p>")
        with mock.patch("sys.stdout"):
            rows.main(["kempf-html", "--max", "10", "--seed", "3"])
        first = [row["sha256"] for row in self.written("kempf-html")]
        with mock.patch("sys.stdout"):
            rows.main(["kempf-html", "--max", "10", "--seed", "3"])
        self.assertEqual(len(first), 10)
        self.assertEqual(first, [row["sha256"] for row in self.written("kempf-html")])


if __name__ == "__main__":
    unittest.main()
