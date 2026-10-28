"""scripts/glimmer/extract_archive.py (D03 T04 §5): archives unpack whole, every byte read back, and nothing outside the
destination, no link, no oversized expansion and no half-written folder ever results."""
import errno
import importlib.util
import io
import json
import shutil
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "extract_archive.py"
spec = importlib.util.spec_from_file_location("extract_archive", SCRIPT)
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)

FILES = {"pages/a.html": b"<h1>a</h1>", "pages/b.png": bytes(range(256)) * 4}


class Extract(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="extract-"))
        self.addCleanup(shutil.rmtree, self.dir, True)

    def zip_of(self, files, name="set.zip"):
        path = self.dir / name
        with zipfile.ZipFile(path, "w") as zf:
            for member, data in files.items():
                zf.writestr(member, data)
        return path

    def tar_of(self, add, name="set.tar.gz"):
        path = self.dir / name
        with tarfile.open(path, "w:gz") as tf:
            add(tf)
        return path

    def add_files(self, tf, files=FILES):
        for member, data in files.items():
            info = tarfile.TarInfo(member)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))

    def assert_unpacked(self, destination):
        for member, data in FILES.items():
            self.assertEqual((destination / member).read_bytes(), data)

    def test_a_zip_and_a_tar_gz_unpack_with_every_byte(self):
        ex.extract(self.zip_of(FILES), self.dir / "from-zip")
        self.assert_unpacked(self.dir / "from-zip")
        ex.extract(self.tar_of(self.add_files), self.dir / "from-tar")
        self.assert_unpacked(self.dir / "from-tar")

    def test_climbing_out_and_absolute_paths_are_refused(self):
        for bad in ("../escape.txt", "pages/../../escape.txt", "/etc/escape.txt"):
            archive = self.zip_of({bad: b"x"}, name="bad.zip")
            with self.assertRaises(ex.Refused):
                ex.extract(archive, self.dir / "out")
            self.assertFalse((self.dir / "out").exists())
            self.assertFalse((self.dir.parent / "escape.txt").exists())

    def test_links_are_refused(self):
        def add(tf):
            self.add_files(tf)
            link = tarfile.TarInfo("pages/link")
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            tf.addfile(link)
        with self.assertRaises(ex.Refused) as refusal:
            ex.extract(self.tar_of(add), self.dir / "out")
        self.assertIn("link", str(refusal.exception))
        self.assertFalse((self.dir / "out").exists())

    def test_an_archive_that_expands_past_the_limit_is_refused_before_writing(self):
        with self.assertRaises(ex.Refused):
            ex.extract(self.zip_of(FILES), self.dir / "out", limit=100)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ["set.zip"])

    def test_a_write_failure_leaves_no_folder_and_marks_the_import_incomplete(self):
        archive = self.zip_of(FILES)
        record = self.dir / "raw" / "set" / "IMPORT.json"
        real_open = open
        calls = []

        def failing_open(path, mode="r", *args, **kwargs):
            if "w" in mode and str(path).endswith("b.png"):
                calls.append(path)
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_open(path, mode, *args, **kwargs)

        with mock.patch("builtins.open", failing_open), mock.patch("sys.stderr"):
            code = ex.main([str(archive), str(self.dir / "out"), "--import-json", str(record)])
        self.assertEqual(code, 1)
        self.assertTrue(calls)
        self.assertFalse((self.dir / "out").exists())
        self.assertEqual([p for p in self.dir.iterdir() if p.name.startswith(".out.")], [])
        saved = json.loads(record.read_text())
        self.assertEqual(saved["status"], "incomplete")
        self.assertIn("No space left", saved["reason"])

    def test_only_unpacks_the_named_part_but_checks_every_entry(self):
        archive = self.zip_of({**FILES, "evaluation/big.json": b"x" * 500})
        ex.extract(archive, self.dir / "part", limit=2000, only=("pages",))
        self.assert_unpacked(self.dir / "part")
        self.assertFalse((self.dir / "part" / "evaluation").exists())
        hostile = self.zip_of({**FILES, "../escape.txt": b"x"}, name="hostile.zip")
        with self.assertRaises(ex.Refused):
            ex.extract(hostile, self.dir / "part2", only=("pages",))

    def test_an_existing_destination_is_never_overwritten(self):
        (self.dir / "out").mkdir()
        with self.assertRaises(ex.Refused):
            ex.extract(self.zip_of(FILES), self.dir / "out")


if __name__ == "__main__":
    unittest.main()
