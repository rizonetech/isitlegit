"""Tests for collect-stats.py: the counting rules the videos' numbers rest on (D10 T01 §1)."""

import importlib.util
import json
import subprocess
import sys
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

## 1. Shipped thing

A table in a section that looks like an order row but is not one:

| 7 | §7 | Cross-reference | -- | [x] |
"""

SECOND = """## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Another shipped thing | -- | [x] |
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
        (self.repo / "todo" / "templates").mkdir()
        (self.repo / "todo" / "templates" / "TODO-template.md").write_text(TODO)
        (self.repo / "docs" / "reviews").mkdir(parents=True)
        (self.repo / "docs" / "reviews" / "D01-T01-s1.md").write_text(RECEIPT)
        (self.repo / "todo" / "02-y").mkdir()
        (self.repo / "todo" / "02-y" / "TODO-01-y.md").write_text(SECOND)
        (self.repo / "docs" / "reviews" / "02-y").mkdir()
        (self.repo / "docs" / "reviews" / "02-y" / "D02-T01-s1.md").write_text("## Round 1: astra\n\n## Round 2: astra\n")
        for args in (["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_counts_rows_stamps_rounds_and_real_final_reviews(self):
        got = stats.collect(self.repo)
        # Order rows only (the §7 row in a section's own table is not one), across both TODO files and both receipts.
        self.assertEqual((got["sections"], got["stamped"], got["rounds"], got["finals"]), (3, 2, 3, 1))
        self.assertEqual(got["receipts"], 2)
        self.assertRegex(got["commit"], r"^[0-9a-f]{7,}$")
        self.assertEqual(got["domains"], [{"domain": "01-x", "sections": 2, "stamped": 1},
                                          {"domain": "02-y", "sections": 1, "stamped": 1}])

    def test_pace_counts_commits_and_stamps_per_day_and_hour(self):
        (self.repo / "a.ts").write_text("x\n")
        for args in (["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "todo: stamp 'D01 T01 §1'"]):
            subprocess.run(["git", *args], cwd=self.repo, check=True)
        got = stats.collect(self.repo)["pace"]
        self.assertEqual(got["commits"], 2)
        self.assertEqual(sum(d["stamps"] for d in got["days"]), 1)
        self.assertEqual(sum(got["hours"]), 2)

    def test_write_replaces_the_file_whole(self):
        out = self.repo / "out" / "stats.json"
        out.parent.mkdir()
        out.write_text("stale")
        stats.write({"sections": 2}, out)
        self.assertEqual(json.loads(out.read_text()), {"sections": 2})
        self.assertEqual([p.name for p in out.parent.iterdir()], ["stats.json"])

    def test_write_failure_keeps_the_previous_file_and_leaves_no_temporary(self):
        out = self.repo / "out" / "stats.json"
        out.parent.mkdir()
        out.write_text('{"sections": 1}\n')
        with self.assertRaises(TypeError):
            stats.write({"sections": object()}, out)
        self.assertEqual(json.loads(out.read_text()), {"sections": 1})
        self.assertEqual([p.name for p in out.parent.iterdir()], ["stats.json"])

    def test_cli_reads_the_named_root_and_writes_the_named_file(self):
        out = self.repo / "out" / "stats.json"
        done = subprocess.run([sys.executable, str(Path(__file__).with_name("collect-stats.py")), str(self.repo), str(out)],
                              check=True, capture_output=True, text=True)
        printed = json.loads(done.stdout)
        self.assertEqual(json.loads(out.read_text()), printed)
        head = subprocess.run(["git", "log", "-1", "--format=%h|%ad", "--date=format:%-d %b %Y"], cwd=self.repo,
                              check=True, capture_output=True, text=True).stdout.strip().split("|")
        self.assertEqual((printed["commit"], printed["date"]), (head[0], head[1]))
        self.assertEqual(printed["sections"], 3)


if __name__ == "__main__":
    unittest.main()
