"""scripts/glimmer/staging.py (D03 T04 §5): a dead run's staging is removed, a live run's and other files are kept."""
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "staging.py"
spec = importlib.util.spec_from_file_location("staging", SCRIPT)
staging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(staging)


class Staging(unittest.TestCase):
    def test_a_dead_writers_staging_goes_and_a_live_ones_stays(self):
        folder = Path(tempfile.mkdtemp(prefix="staging-"))
        self.addCleanup(shutil.rmtree, folder, True)
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        (folder / f".rows.jsonl.{dead.pid}.tmp").write_text("half")
        (folder / f".dataset.extracting-{dead.pid}").mkdir()
        (folder / f".rows.jsonl.{os.getppid()}.tmp").write_text("live writer")
        (folder / "rows.jsonl").write_text("finished")
        removed = staging.remove_dead_staging(folder)
        self.assertEqual(removed, sorted([f".dataset.extracting-{dead.pid}", f".rows.jsonl.{dead.pid}.tmp"]))
        self.assertEqual(sorted(p.name for p in folder.iterdir()), sorted([f".rows.jsonl.{os.getppid()}.tmp", "rows.jsonl"]))

        # Round 7 finding 1: if a dead writer died mid-publication with uncommitted staging and .prev backups,
        # remove_dead_staging restores the .prev backup and cleans up all dead staging files.
        (folder / "rows.jsonl").write_text("new-partial")
        (folder / f".prev.rows.jsonl.{dead.pid}.tmp").write_text("previous-whole")
        (folder / f".EXPORT.json.{dead.pid}.tmp").write_text("{}")
        restored = staging.remove_dead_staging(folder)
        self.assertEqual(restored, sorted([f".EXPORT.json.{dead.pid}.tmp", f".prev.rows.jsonl.{dead.pid}.tmp"]))
        self.assertEqual((folder / "rows.jsonl").read_text(), "previous-whole")


if __name__ == "__main__":
    unittest.main()
