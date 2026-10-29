"""scripts/glimmer/sevendays_rows.py (D03 T04 §18): each crawled URL gives one row, from its earliest capture that
answered 200 with a screenshot and HTML, whatever order the archive holds its captures in."""
import base64
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

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "sevendays_rows.py"
spec = importlib.util.spec_from_file_location("sevendays_rows", SCRIPT)
rows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rows)


def add(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))


class SevenDays(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="sevendays-"))
        self.addCleanup(shutil.rmtree, self.dir, True)
        patcher = mock.patch.dict(os.environ, {"GLIMMER_DATA_DIR": str(self.dir)})
        patcher.start()
        self.addCleanup(patcher.stop)
        folder = self.dir / "raw" / "7-days-later"
        folder.mkdir(parents=True)
        with tarfile.open(folder / rows.ARCHIVE, "w:gz") as archive:
            # Newest first, as the real archive holds them: the takedown, then the live lure, then a dead capture.
            for stamp, status, shot, html in (("2024-05-16-17:07", b"404", b"gone", b"<p>Not found</p>"),
                                              ("2024-05-14-21:17", b"200", b"lure-shot", b"<p>Sign in to Meta</p>"),
                                              ("2024-05-14-20:47", b"000", None, None)):
                base = f"123-graph_transparancymeta_my_id/{stamp}"
                add(archive, f"{base}/status_code.txt", status)
                if shot:
                    add(archive, f"{base}/screenshot.jpg", shot)
                    add(archive, f"{base}/page.html", html)
            add(archive, "456-bad_host_/2024-05-01-10:00/status_code.txt", b"200")
            add(archive, "456-bad_host_/2024-05-01-10:00/screenshot.jpg", b"shot")
            add(archive, "456-bad_host_/2024-05-01-10:00/page.html", b"<p>x</p>")
            # A URL whose only capture never answered: met, and rejected in the receipt.
            add(archive, "789-dead_example_com/2024-05-01-10:00/status_code.txt", b"000")
        self.folder = folder
        rows.inputs_module.build(folder, [{"name": rows.ARCHIVE, "published": None, "pinned": "zenodo: 14885725"}], "CC BY 4.0")

    def test_one_row_a_url_from_its_earliest_live_capture(self):
        with mock.patch("sys.stdout"):
            self.assertEqual(rows.main([]), 0)
        written = [json.loads(line) for line in
                   (self.dir / "raw" / "7-days-later" / "rows.jsonl").read_text().splitlines()]
        by_id = {row["sha256"]: row for row in written}
        self.assertEqual(sorted(by_id), ["7dl-123", "7dl-456"])
        lure = by_id["7dl-123"]
        self.assertEqual(base64.b64decode(lure["screenshot"]), b"lure-shot")
        self.assertEqual(lure["html"], "<p>Sign in to Meta</p>")
        self.assertEqual(lure["url"], "https://graph.transparancymeta.my.id/")
        self.assertEqual(lure["label"], "phish")
        self.assertIsNone(by_id["7dl-456"]["url"])  # "bad.host." is not a host name
        receipt = json.loads((self.folder / "EXPORT.json").read_text())
        self.assertEqual((receipt["met"], receipt["exported"], receipt["sampled_out"]), (3, 2, 0))
        self.assertEqual(receipt["rejected"], {"no capture answered 200 with a screenshot and HTML": 1})

    def test_a_capture_whose_parts_repeat_is_written_once(self):
        archive_path = self.folder / rows.ARCHIVE
        with tarfile.open(archive_path, "w:gz") as archive:
            base = "123-graph_transparancymeta_my_id/2024-05-14-21:17"
            add(archive, f"{base}/status_code.txt", b"200")
            for html in (b"<p>first</p>", b"<p>second</p>"):
                add(archive, f"{base}/screenshot.jpg", b"shot")
                add(archive, f"{base}/page.html", html)
        rows.inputs_module.build(self.folder, [{"name": rows.ARCHIVE, "published": None, "pinned": "zenodo: 14885725"}], "CC BY 4.0")
        with mock.patch("sys.stdout"):
            self.assertEqual(rows.main([]), 0)
        written = (self.folder / "rows.jsonl").read_text().splitlines()
        self.assertEqual([json.loads(line)["sha256"] for line in written], ["7dl-123"])
        self.assertEqual(json.loads((self.folder / "EXPORT.json").read_text())["exported"], 1)

    def test_a_url_sampled_out_is_counted_as_such(self):
        with mock.patch("sys.stdout"):
            self.assertEqual(rows.main(["--max", "1"]), 0)
        receipt = json.loads((self.folder / "EXPORT.json").read_text())
        self.assertEqual((receipt["exported"], receipt["sampled_out"]), (1, 1))

    def test_refuses_an_archive_not_bound_or_changed_and_keeps_the_earlier_rows(self):
        (self.folder / "rows.jsonl").write_text("earlier\n")
        (self.folder / "INPUTS.json").unlink()
        with mock.patch("sys.stderr"):
            self.assertEqual(rows.main([]), 1)
        rows.inputs_module.build(self.folder, [{"name": rows.ARCHIVE, "published": None, "pinned": "zenodo"}], "CC BY 4.0")
        with (self.folder / rows.ARCHIVE).open("ab") as handle:
            handle.write(b"x")
        with mock.patch("sys.stderr"):
            self.assertEqual(rows.main([]), 1)
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")

    def test_a_limit_stops_the_conversion_with_the_earlier_rows_whole(self):
        (self.folder / "rows.jsonl").write_text("earlier\n")
        with mock.patch.object(rows, "Limits", lambda: rows.inputs_module.Limits(entries=3)), mock.patch("sys.stderr"):
            self.assertEqual(rows.main([]), 1)
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")


if __name__ == "__main__":
    unittest.main()
