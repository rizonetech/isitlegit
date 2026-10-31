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

    def rewrite_source(self):
        """A later commit drops the quote, as a rewritten run file does; returns that commit."""
        repo = facts.REPO
        (repo / "sources.md").write_text("Rewritten.\n")
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "y"], cwd=repo, check=True)
        return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()

    def test_a_fact_may_pin_the_commit_that_recorded_it(self):
        later = self.rewrite_source()
        data = self.data(pages={"commit": self.commit})
        data["facts"].pop("rejected")
        data["commit"] = later
        self.assertEqual(facts.check(data), [])

    def test_without_its_own_commit_a_fact_is_read_at_the_file_commit(self):
        later = self.rewrite_source()
        data = self.data()
        data["facts"].pop("rejected")
        data["commit"] = later
        self.assertTrue(facts.check(data))

    def test_one_source_read_at_two_commits_keeps_both(self):
        first = self.commit
        later = self.rewrite_source()
        (facts.REPO / "sources.md").write_text("Rewritten. The build read 7 pages.\n")
        data = self.data(pages={"commit": first})
        data["facts"].pop("rejected")
        data["facts"]["later"] = {"value": "7", "status": "measured", "source": "sources.md", "quote": "read 7 pages"}
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "z"], cwd=facts.REPO, check=True)
        data["commit"] = subprocess.run(["git", "rev-parse", "HEAD"], cwd=facts.REPO, check=True, capture_output=True, text=True).stdout.strip()
        self.assertNotEqual(later, data["commit"])
        self.assertEqual(facts.check(data), [])

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
