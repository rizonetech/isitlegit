"""scripts/glimmer/sevendays_rows.py (D03 T04 §18): each crawled URL gives one row, from its earliest capture that
answered 200 with a screenshot and HTML, whatever order the archive holds its captures in; every read is charged to
`inputs.Limits` (D03 T04 §28): the held index, unmatched capture parts, one allocation, and one deadline for both passes."""
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

    def single_capture(self, shot=b"s" * 5000, html=b"<p>x</p>"):
        """An archive of one live capture whose screenshot is `shot`, bound in the manifest."""
        with tarfile.open(self.folder / rows.ARCHIVE, "w:gz") as archive:
            base = "123-example_com/2024-05-14-21:17"
            add(archive, f"{base}/status_code.txt", b"200")
            add(archive, f"{base}/screenshot.jpg", shot)
            add(archive, f"{base}/page.html", html)
        rows.inputs_module.build(self.folder, [{"name": rows.ARCHIVE, "published": None, "pinned": "zenodo"}], "CC BY 4.0")

    def refused(self, pattern, **bounds):
        """Runs the conversion under `bounds`: it is refused naming its limit, the earlier rows file is whole and no
        temporary file is left."""
        (self.folder / "rows.jsonl").write_text("earlier\n")
        with mock.patch.object(rows, "Limits", lambda: rows.inputs_module.Limits(**bounds)), mock.patch("sys.stderr") as err:
            self.assertEqual(rows.main([]), 1)
        self.assertRegex("".join(call.args[0] for call in err.write.call_args_list), pattern)
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")
        self.assertEqual(sorted(p.name for p in self.folder.iterdir()), sorted(["INPUTS.json", "rows.jsonl", rows.ARCHIVE]))

    def test_a_large_index_stops_at_the_retained_byte_limit(self):
        # Every URL folder, status and capture the first pass holds is charged: the setUp archive's index passes 500 bytes.
        self.refused("bytes retained at once", retained=500)

    def test_an_unmatched_capture_part_stops_at_the_retained_byte_limit(self):
        self.single_capture()  # the index fits 3000 bytes, the 5000 byte screenshot held for its page does not
        self.refused("bytes retained at once", retained=3000)

    def test_one_part_over_the_allocation_limit_is_refused_before_it_is_read(self):
        self.single_capture()
        self.refused("screenshot.jpg of 123-example_com of 5000 bytes passes", allocation=1000)

    def test_a_row_over_the_allocation_limit_is_refused_before_it_is_built(self):
        self.single_capture(shot=b"s" * 1500)  # the part fits 2000 bytes, the row built from it (copies) does not
        self.refused("the row for 123-example_com of .* bytes passes the 2000 byte allocation limit", allocation=2000)

    def test_the_first_pass_charges_each_index_it_holds_and_releases_its_scratch(self):
        peak = [0]

        class Tracked(rows.inputs_module.Limits):
            def charge_retained(self, size):
                super().charge_retained(size)
                peak[0] = max(peak[0], self.retained)

        path = self.folder / rows.ARCHIVE
        with tarfile.open(path, "w:gz") as archive:
            for n in range(20):
                base = f"{n}-example_com/2024-05-14-21:17"
                add(archive, f"{base}/status_code.txt", b"200")
                add(archive, f"{base}/screenshot.jpg", b"s")
                add(archive, f"{base}/page.html", b"<p>x</p>")
        limits, met = Tracked(), set()
        earliest = rows.choose(path, limits, met)
        self.assertEqual(len(earliest), 20)
        # What stays: each URL's chosen capture and its name in the receipt's set. What was scratch (the status and
        # file indexes) was held at the peak and is released.
        kept = sum(rows.HELD_ENTRY + len(f"{n}-example_com") + len("2024-05-14-21:17") for n in range(20)) + \
            sum(rows.HELD_ENTRY + len(f"{n}-example_com") for n in range(20))
        self.assertEqual(limits.retained, kept)
        self.assertGreater(peak[0], kept + 20 * 2 * rows.HELD_ENTRY)

    def test_a_written_capture_releases_its_parts_from_the_retained_bytes(self):
        with tarfile.open(self.folder / rows.ARCHIVE, "w:gz") as archive:
            for n in range(5):
                base = f"{n}-example_com/2024-05-14-21:17"
                add(archive, f"{base}/status_code.txt", b"200")
                add(archive, f"{base}/screenshot.jpg", b"s" * 1600)
                add(archive, f"{base}/page.html", b"<p>x</p>")
        rows.inputs_module.build(self.folder, [{"name": rows.ARCHIVE, "published": None, "pinned": "zenodo"}], "CC BY 4.0")
        # 5 x 1600 bytes of screenshots do not fit 10000 beside the index if each stayed held after its row was written.
        with mock.patch.object(rows, "Limits", lambda: rows.inputs_module.Limits(retained=10_000)), mock.patch("sys.stdout"):
            self.assertEqual(rows.main([]), 0)
        self.assertEqual(len((self.folder / "rows.jsonl").read_text().splitlines()), 5)

    def test_the_deadline_is_checked_while_the_first_pass_chooses_captures(self):
        path = self.folder / rows.ARCHIVE
        with tarfile.open(path, "w:gz") as archive:
            for n in range(100):
                base = f"{n}-example_com/2024-05-14-21:17"
                add(archive, f"{base}/status_code.txt", b"200")
                add(archive, f"{base}/screenshot.jpg", b"s")
                add(archive, f"{base}/page.html", b"<p>x</p>")
        ticks = iter(range(10**6))  # one second a look: the 300 members pass 310 seconds, the 100 choices do not
        with self.assertRaisesRegex(rows.inputs_module.Refused, "passed 310 seconds"):
            rows.choose(path, rows.inputs_module.Limits(seconds=310, clock=lambda: next(ticks)))

    def test_a_slow_loop_stops_at_the_deadline(self):
        ticks = iter(range(10**6))  # the fake clock advances one second a look
        self.refused("passed 5 seconds", seconds=5, clock=lambda: next(ticks))

    def test_both_passes_share_one_deadline(self):
        now = [0.0]
        made = []

        def limits():
            made.append(rows.inputs_module.Limits(seconds=100, clock=lambda: now[0]))
            return made[-1]

        original = rows.export

        def late_export(*args, **kwargs):
            now[0] = 101.0  # the first pass was within its time; the second starts after the one deadline
            return original(*args, **kwargs)

        (self.folder / "rows.jsonl").write_text("earlier\n")
        with mock.patch.object(rows, "Limits", limits), mock.patch.object(rows, "export", late_export), \
                mock.patch("sys.stderr") as err:
            self.assertEqual(rows.main([]), 1)
        self.assertEqual(len(made), 1)
        self.assertIn("passed 100 seconds", "".join(call.args[0] for call in err.write.call_args_list))
        self.assertEqual((self.folder / "rows.jsonl").read_text(), "earlier\n")

    def test_the_second_pass_counts_its_own_entries_but_the_run_keeps_one_limits(self):
        # Entries are bounded per pass: the archive (11 members) passes under entries=11 twice, one shared Limits.
        with mock.patch.object(rows, "Limits", lambda: rows.inputs_module.Limits(entries=11)), mock.patch("sys.stdout"):
            self.assertEqual(rows.main([]), 0)


if __name__ == "__main__":
    unittest.main()
