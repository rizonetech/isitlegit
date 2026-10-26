"""scripts/hooks/pre-commit: a commit that stages TODO changes with a stale plan, or a client name, is refused."""
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from test_todo_graph import todo_file  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]
KIT = REPO
HOOK = "scripts/hooks/pre-commit"
# Where each installed file comes from: the todo kit, and the reviewer kit for the dispatcher stamping loads.
FILES = {"scripts/todo-graph.py": KIT / "scripts/todo-graph.py",
         "scripts/lib/todo_graph.py": KIT / "scripts/lib/todo_graph.py",
         "scripts/review-dispatch.py": REPO / "scripts/review-dispatch.py",
         HOOK: KIT / HOOK}

class Scratch:
    """A throwaway folder that can still be removed after git marks its objects read-only."""

    def __init__(self):
        self.name = tempfile.mkdtemp()

    def cleanup(self):
        for path in pathlib.Path(self.name).rglob("*"):
            os.chmod(path, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
        shutil.rmtree(self.name, ignore_errors=True)



@unittest.skipUnless(shutil.which("git"), "needs git (which runs the hook with its own shell)")
class PreCommitHook(unittest.TestCase):
    def setUp(self):
        self.tmp = Scratch()
        self.root = pathlib.Path(self.tmp.name)
        for rel, source in FILES.items():
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, self.root / rel)
        (self.root / HOOK).chmod(0o755)  # git runs only an executable hook on Linux
        todo = self.root / "todo/00-workspace"
        todo.mkdir(parents=True)
        (todo / "TODO-01-a.md").write_text(todo_file([(1, "A", 0, "none", "--")]), encoding="utf-8")
        (todo / "INDEX.md").write_text("# Index\n- TODO-01-a.md\n", encoding="utf-8")
        (self.root / "todo/TODO-00-INDEX.md").write_text("# Index\n- 00-workspace/TODO-01-a.md\n", encoding="utf-8")
        self.sync()
        for args in (["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"],
                     ["config", "core.autocrlf", "false"], ["add", "-A"], ["commit", "-qm", "seed"],
                     ["config", "core.hooksPath", "scripts/hooks"]):
            self.git(*args)

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], capture_output=True, text=True, check=True)

    def sync(self):
        subprocess.run([sys.executable, str(self.root / "scripts/todo-graph.py"), "plan", "--sync"], check=True,
                       capture_output=True)

    def commit(self):
        return subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "tick"], capture_output=True, text=True)

    def tick(self):
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace("- [ ] Work.", "- [x] Work."), encoding="utf-8")

    def test_a_todo_change_with_a_stale_plan_is_refused(self):
        self.tick()
        self.git("add", "todo/00-workspace/TODO-01-a.md")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("plan --sync", result.stderr)
        self.sync()
        self.git("add", "-A")
        self.assertEqual(self.commit().returncode, 0)

    def test_a_todo_change_with_a_synced_plan_is_accepted(self):
        self.tick()
        self.sync()
        self.git("add", "-A")
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_unstaged_todo_changes_are_refused(self):
        self.tick()
        self.sync()
        self.git("add", "todo/00-workspace/TODO-01-a.md")  # the synced plan is left unstaged
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("todo/ has unstaged or untracked changes", result.stderr)

    def test_an_untracked_review_file_beside_a_todo_change_is_refused(self):
        self.tick()
        self.sync()
        (self.root / "docs/reviews").mkdir(parents=True)
        (self.root / "docs/reviews/d00-t01-s1.json").write_text("{}\n", encoding="utf-8")  # left out of the commit
        self.git("add", "todo")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("docs/reviews/ has unstaged or untracked changes", result.stderr)

    def test_an_ignored_review_file_beside_a_todo_change_is_refused(self):
        self.tick()
        self.sync()
        (self.root / "docs/reviews").mkdir(parents=True)
        (self.root / "docs/reviews/d00-t01-s1.json").write_text("{}\n", encoding="utf-8")
        (self.root / ".git/info/exclude").write_text("docs/reviews/\n", encoding="utf-8")
        self.git("add", "todo")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("docs/reviews/ has unstaged or untracked changes", result.stderr)

    def test_an_evidence_only_commit_that_breaks_the_graph_is_refused(self):
        (self.root / "docs/reviews").mkdir(parents=True)
        (self.root / "docs/reviews/legacy-receipts.json").write_text("not json\n", encoding="utf-8")
        self.git("add", "docs/reviews")  # no todo/ change staged
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)

    def test_a_commit_without_todo_changes_is_not_checked(self):
        (self.root / "notes.txt").write_text("x\n", encoding="utf-8")
        (self.root / "todo/00-workspace/TODO-01-a.md").write_text("broken\n", encoding="utf-8")  # unstaged, untouched
        self.git("add", "notes.txt")
        self.assertEqual(self.commit().returncode, 0)


    def names(self, text):
        (self.root / "samples").mkdir(exist_ok=True)
        (self.root / "samples/client-names.txt").write_text(text, encoding="utf-8")
        (self.root / ".git/info/exclude").write_text("samples/\n", encoding="utf-8")

    def test_a_staged_client_name_is_refused(self):
        self.names("Acme Holdings\n")
        (self.root / "notes.txt").write_text("The attacker posed as ACME holdings.\n", encoding="utf-8")
        self.git("add", "notes.txt")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("client name", result.stderr)

    def test_a_staged_file_named_after_a_client_is_refused(self):
        self.names("acme\n")
        (self.root / "Acme-invoice.txt").write_text("nothing here\n", encoding="utf-8")
        self.git("add", "Acme-invoice.txt")
        self.assertNotEqual(self.commit().returncode, 0)

    def test_a_blank_line_in_the_client_list_does_not_block_every_commit(self):
        self.names("acme\n\n   \r\n")
        (self.root / "notes.txt").write_text("A fictional supplier.\n", encoding="utf-8")
        self.git("add", "notes.txt")
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_removed_line_with_a_client_name_is_accepted(self):
        (self.root / "notes.txt").write_text("Acme was here.\n", encoding="utf-8")
        self.git("add", "notes.txt")
        self.assertEqual(self.commit().returncode, 0)  # no list yet, so no check
        self.names("acme\n")
        (self.root / "notes.txt").write_text("A fictional supplier was here.\n", encoding="utf-8")
        self.git("add", "notes.txt")
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_without_a_client_list_nothing_is_checked(self):
        (self.root / "notes.txt").write_text("Acme Holdings\n", encoding="utf-8")
        self.git("add", "notes.txt")
        self.assertEqual(self.commit().returncode, 0)


class HookFile(unittest.TestCase):
    def test_the_hook_is_tracked_as_executable(self):
        if not shutil.which("git"):
            self.skipTest("needs git")
        result = subprocess.run(["git", "-C", str(REPO), "ls-files", "-s", "--", str(KIT / HOOK)],
                                capture_output=True, text=True)
        if result.returncode != 0:
            self.skipTest("the repository is not a git repository yet")
        listed = result.stdout.split()
        if not listed:
            self.skipTest("the kit's pre-commit hook is not tracked yet")
        self.assertEqual(listed[0], "100755")

    def test_the_hook_has_lf_line_endings(self):
        self.assertNotIn(b"\r\n", (KIT / HOOK).read_bytes(), "sh cannot run a hook with CRLF line endings")


if __name__ == "__main__":
    unittest.main()
