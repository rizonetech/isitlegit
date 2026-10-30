"""Tests for check-facts.py: a figure on screen must match its source at the pinned commit (D10 T01 §6)."""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("check_facts", Path(__file__).with_name("check-facts.py"))
facts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(facts)

SOURCE = """| `a` | ... | accepted |
| `b` | ... | rejected |
| `c` | ... | rejected |
The build read 129,892 pages.
"""


class CheckFactsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        repo = Path(self.tmp.name)
        (repo / "sources.md").write_text(SOURCE)
        for args in (["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "x"]):
            subprocess.run(["git", *args], cwd=repo, check=True)
        self.commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
        self.old_repo, facts.REPO = facts.REPO, repo

    def tearDown(self):
        facts.REPO = self.old_repo
        self.tmp.cleanup()

    def data(self, **override):
        base = {
            "pages": {"value": "129,892", "status": "measured", "source": "sources.md", "quote": "read 129,892 pages"},
            "rejected": {"value": "2", "status": "measured", "source": "sources.md", "count": r"^\| `[^`]+` \|.*\| rejected"},
        }
        for key, fact in override.items():
            base[key] = {**base[key], **fact}
        return {"commit": self.commit, "facts": base}

    def test_true_facts_hold(self):
        self.assertEqual(facts.check(self.data()), [])

    def test_a_value_missing_from_its_quote_fails(self):
        self.assertTrue(facts.check(self.data(pages={"value": "129,893"})))

    def test_a_quote_missing_from_the_source_fails(self):
        self.assertTrue(facts.check(self.data(pages={"quote": "read 129,893 pages", "value": "129,893"})))

    def test_a_wrong_count_fails(self):
        self.assertTrue(facts.check(self.data(rejected={"value": "3"})))

    def test_a_missing_source_fails(self):
        self.assertTrue(facts.check(self.data(pages={"source": "missing.md"})))

    def test_a_label_need_not_appear_in_its_quote(self):
        self.assertEqual(facts.check(self.data(pages={"value": "the build", "label": True})), [])

    def test_a_storyboard_naming_an_unknown_fact_fails(self):
        board = Path(self.tmp.name) / "board.json"
        board.write_text('{"text": "read {fact.pages} and {fact.missing}"}')
        self.assertEqual(facts.unknown_refs({"pages"}, [board]), ["board.json: names unknown fact missing"])

    def test_an_unknown_status_fails(self):
        self.assertTrue(facts.check(self.data(pages={"status": "guessed"})))


if __name__ == "__main__":
    unittest.main()
