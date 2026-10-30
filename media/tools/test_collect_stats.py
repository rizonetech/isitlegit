"""Tests for collect-stats.py: the counting rules the videos' numbers rest on (D10 T01 §1)."""

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("collect_stats", Path(__file__).with_name("collect-stats.py"))
stats = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stats)

TODO = """## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Shipped thing | -- | [x] |
| 2 | §2 | Open thing | §1 | [ ] |
"""

RECEIPT = """## Round 1: astra

body

## Final review: wonder (`muse-wonder-1.0` via `muse`)

body

## Final review: none
"""


class CollectStatsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        (self.repo / "todo" / "01-x").mkdir(parents=True)
        (self.repo / "todo" / "01-x" / "TODO-01-x.md").write_text(TODO)
        (self.repo / "todo" / "01-x" / "INDEX.md").write_text("| 9 | §9 | not a TODO file | -- | [x] |\n")
        (self.repo / "docs" / "reviews").mkdir(parents=True)
        (self.repo / "docs" / "reviews" / "D01-T01-s1.md").write_text(RECEIPT)
        for args in (["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_counts_rows_stamps_rounds_and_real_final_reviews(self):
        got = stats.collect(self.repo)
        self.assertEqual((got["sections"], got["stamped"], got["rounds"], got["finals"]), (2, 1, 1, 1))
        self.assertRegex(got["commit"], r"^[0-9a-f]{7,}$")

    def test_write_replaces_the_file_whole(self):
        out = self.repo / "out" / "stats.json"
        out.parent.mkdir()
        out.write_text("stale")
        stats.write({"sections": 2}, out)
        self.assertEqual(json.loads(out.read_text()), {"sections": 2})
        self.assertEqual([p.name for p in out.parent.iterdir()], ["stats.json"])


if __name__ == "__main__":
    unittest.main()
