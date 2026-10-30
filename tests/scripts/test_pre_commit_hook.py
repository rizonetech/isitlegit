"""scripts/hooks/pre-commit: a commit that stages TODO changes with a stale plan, or a client name, is refused."""
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
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
        # No auto maintenance: newer git detaches it after a commit and it can outlive the test's temporary directory.
        for args in (["init", "-q"], ["config", "maintenance.auto", "false"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"],
                     ["config", "core.autocrlf", "false"], ["add", "-A"], ["commit", "-qm", "seed"],
                     ["config", "core.hooksPath", "scripts/hooks"]):
            self.git(*args)
        # Every clone needs a client list to commit (D00 T01 §24); one that names a client nothing here mentions.
        self.names("Zzyzx Unlisted Client\n")

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

    def test_a_client_name_inside_a_binary_marked_mail_fixture_is_refused(self):
        self.names("acme\n")
        (self.root / ".gitattributes").write_text("*.eml binary\n", encoding="utf-8")
        self.git("add", ".gitattributes")
        self.assertEqual(self.commit().returncode, 0)
        (self.root / "message.eml").write_bytes(b"From: Billing <billing@acme-holdings.example>\r\nSubject: x\r\n\r\nPay.\r\n")
        self.git("add", "message.eml")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("client name", result.stderr)

    def test_a_client_name_after_a_nul_byte_in_binary_content_is_refused(self):
        self.names("Acme Holdings\n")
        (self.root / "message.eml").write_bytes(b"MIME-Version: 1.0\x00\x01binary\x00From: Acme Holdings\n")
        self.git("add", "message.eml")
        self.assertNotEqual(self.commit().returncode, 0)

    def test_a_client_name_on_a_line_starting_with_plus_signs_is_refused(self):
        self.names("Acme Holdings\n")
        (self.root / "notes.txt").write_text("++ Acme Holdings\n", encoding="utf-8")
        self.git("add", "notes.txt")
        self.assertNotEqual(self.commit().returncode, 0)

    def test_a_non_ascii_client_name_in_a_file_name_is_refused(self):
        self.names("Café Holdings\n")
        (self.root / "Café Holdings.md").write_text("A fictional supplier.\n", encoding="utf-8")
        self.git("add", "Café Holdings.md")
        result = self.commit()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("client name", result.stderr)

    @unittest.skipIf(os.name == "nt" or os.geteuid() == 0, "needs POSIX permissions and a non-root user")
    def test_an_unreadable_client_list_refuses_the_commit(self):
        self.names("Acme Holdings\n")
        (self.root / "notes.txt").write_text("Acme Holdings\n", encoding="utf-8")
        self.git("add", "notes.txt")
        (self.root / "samples/client-names.txt").chmod(0)
        try:
            result = self.commit()
        finally:
            (self.root / "samples/client-names.txt").chmod(0o644)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot be read", result.stderr)

    def test_font_bytes_that_happen_to_match_a_short_name_do_not_block_a_commit(self):
        self.names("qvz\n")
        (self.root / "Font.ttf").write_bytes(b"\x00\x01QVZ\x00\n")
        self.git("add", "Font.ttf")
        result = self.commit()
        self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_a_staged_private_path_is_refused(self):
        for path in ("/home/someone/.local/bin/tool", "C:\\Users\\Someone\\repo", "/mnt/c/GitHub/repo"):
            (self.root / "notes.md").write_text(f"Run `{path}` first.\n", encoding="utf-8")
            self.git("add", "notes.md")
            result = self.commit()
            self.assertNotEqual(result.returncode, 0, path)
            self.assertIn("private path", result.stderr)

    def test_a_home_relative_path_is_accepted(self):
        (self.root / "notes.md").write_text("Run `~/.local/bin/tool` first.\n", encoding="utf-8")
        self.git("add", "notes.md")
        self.assertEqual(self.commit().returncode, 0)

    # D00 T01 §24: without a usable list the commit is refused (it once passed unscanned), each state with its own fix,
    # and following that fix lets a clean commit through while a listed name is still refused.
    def stage(self, text, name="notes.txt"):
        (self.root / name).write_text(text, encoding="utf-8")
        self.git("add", name)

    def repaired(self, cwd=None):
        """After a repair: a clean commit goes through and a listed name is refused."""
        root = cwd or self.root
        (root / "clean.txt").write_text("nothing private\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "clean.txt"], check=True, capture_output=True)
        clean = subprocess.run(["git", "-C", str(root), "commit", "-qm", "clean"], capture_output=True, text=True)
        self.assertEqual(clean.returncode, 0, clean.stderr)
        (root / "listed.txt").write_text("Acme Holdings wrote\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(root), "add", "listed.txt"], check=True, capture_output=True)
        listed = subprocess.run(["git", "-C", str(root), "commit", "-qm", "listed"], capture_output=True, text=True)
        self.assertNotEqual(listed.returncode, 0)
        self.assertIn("client name", listed.stderr)

    def test_without_any_client_list_the_commit_is_refused_until_one_is_provided(self):
        (self.root / "samples/client-names.txt").unlink()
        self.stage("Acme Holdings\n")
        refused = self.commit()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("no client list", refused.stderr)
        self.assertIn(str(self.root / "samples/client-names.txt"), refused.stderr, "names where the list belongs")
        self.git("reset", "-q")
        (self.root / "notes.txt").unlink()
        self.names("Acme Holdings\n")
        self.repaired()

    def test_a_list_that_names_no_one_is_refused_until_a_name_is_added(self):
        self.names("\n   \n")
        self.stage("anything\n")
        refused = self.commit()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("names no one; add the client names, one per line", refused.stderr)
        self.git("reset", "-q")
        self.names("Acme Holdings\n")
        self.repaired()

    def test_a_dangling_link_in_the_main_checkout_is_refused_until_the_list_is_restored(self):
        link = self.root / "samples/client-names.txt"
        link.unlink()
        link.symlink_to(self.root.parent / f"{self.root.name}-gone.txt")
        self.stage("anything\n")
        refused = self.commit()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("which does not exist; put the operator's private list there", refused.stderr)
        self.assertNotIn("ln -sfn", refused.stderr, "the main checkout's list cannot point at itself")
        self.git("reset", "-q")
        link.unlink()  # the displayed repair: replace the link with the list itself
        self.names("Acme Holdings\n")
        self.repaired()

    def worktree(self):
        tree = self.root.parent / f"{self.root.name}-wt"
        self.git("worktree", "add", "-q", "-b", "wt", str(tree))
        self.addCleanup(shutil.rmtree, tree, True)
        return tree

    def test_a_dangling_link_in_a_worktree_is_refused_until_the_shown_command_repairs_it(self):
        self.names("Acme Holdings\n")
        tree = self.worktree()
        link = tree / "samples/client-names.txt"
        link.parent.mkdir(exist_ok=True)
        link.symlink_to(self.root.parent / f"{self.root.name}-gone.txt")
        (tree / "x.txt").write_text("anything\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(tree), "add", "x.txt"], check=True, capture_output=True)
        refused = subprocess.run(["git", "-C", str(tree), "commit", "-qm", "x"], capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        command = re.search(r"repair it with '([^']+)'", refused.stderr)
        self.assertIsNotNone(command, refused.stderr)
        subprocess.run(["git", "-C", str(tree), "reset", "-q"], check=True)
        subprocess.run(["sh", "-c", command[1]], check=True, cwd=tree)  # exactly the repair the message shows
        self.repaired(cwd=tree)

    def test_a_worktree_whose_main_checkout_list_is_a_dangling_link_gets_that_repair(self):
        tree = self.worktree()
        main_list = self.root / "samples/client-names.txt"
        main_list.unlink()
        main_list.symlink_to(self.root.parent / f"{self.root.name}-removed/client-names.txt")
        (tree / "x.txt").write_text("anything\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(tree), "add", "x.txt"], check=True, capture_output=True)
        refused = subprocess.run(["git", "-C", str(tree), "commit", "-qm", "x"], capture_output=True, text=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("the main checkout's client list", refused.stderr)
        self.assertIn("which does not exist; restore the list at that target, or replace the link", refused.stderr)
        self.assertNotIn("no client list", refused.stderr)
        subprocess.run(["git", "-C", str(tree), "reset", "-q"], check=True)
        main_list.unlink()  # the shown repair: replace the link with the list itself
        main_list.write_text("Acme Holdings\n", encoding="utf-8")
        self.repaired(cwd=tree)

    def test_a_temporary_folder_that_cannot_be_written_is_named_not_the_list(self):
        self.names("Acme Holdings\n")
        self.stage("anything\n")
        env = {**os.environ, "TMPDIR": str(self.root / "no-such-folder")}
        refused = subprocess.run(["git", "-C", str(self.root), "commit", "-qm", "x"], capture_output=True, text=True,
                                 env=env)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("no temporary folder could be made", refused.stderr)
        self.assertNotIn("fix its permissions", refused.stderr)

    def test_an_interrupted_scan_leaves_no_copy_of_the_list_behind(self):
        self.names("Acme Holdings\n")
        self.stage("anything\n")
        tmp = self.root.parent / f"{self.root.name}-tmp"
        tmp.mkdir()
        self.addCleanup(shutil.rmtree, tmp, True)
        stub = self.root.parent / f"{self.root.name}-bin"
        stub.mkdir()
        self.addCleanup(shutil.rmtree, stub, True)
        real_git = shutil.which("git")
        # A git whose grep hangs, so the hook is interrupted mid-scan with the copy of the list on disk.
        (stub / "git").write_text(f'''#!/bin/sh
for a in "$@"; do [ "$a" = grep ] && exec sleep 30; done
exec {real_git} "$@"
''', encoding="utf-8")
        (stub / "git").chmod(0o755)
        env = {**os.environ, "TMPDIR": str(tmp), "PATH": f"{stub}{os.pathsep}{os.environ['PATH']}"}
        hook = subprocess.Popen(["sh", str(self.root / HOOK)], cwd=self.root, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE)
        for _ in range(200):
            if any(tmp.iterdir()):
                break
            time.sleep(0.05)
        self.assertTrue(any(tmp.iterdir()), "the hook made its private copy")
        time.sleep(0.3)
        # Round 1 (P1): every scan file sits in one owner-only folder, so no other local user reads the matches.
        made = list(tmp.iterdir())
        self.assertEqual(len(made), 1)
        self.assertTrue(made[0].is_dir())
        self.assertEqual(stat.S_IMODE(made[0].stat().st_mode), 0o700)
        hook.terminate()
        hook.wait(timeout=30)
        for _ in range(100):
            if not any(tmp.iterdir()):
                break
            time.sleep(0.05)
        self.assertEqual(sorted(p.name for p in tmp.iterdir()), [], "no copy of the client list is left")

    def test_a_refusal_says_where_the_name_is_without_repeating_it(self):
        self.names("Acme Holdings\n")
        self.stage("line one\nwritten for Acme Holdings\n", name="report.txt")
        refused = self.commit()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("report.txt:2", refused.stderr)
        self.assertNotIn("Acme", refused.stderr)

    def test_a_linked_worktree_without_its_own_list_scans_with_the_main_checkouts(self):
        self.names("Acme Holdings\n")
        tree = self.worktree()
        self.assertFalse((tree / "samples/client-names.txt").exists(), "git worktree add copies no ignored file")
        (tree / "node_modules").mkdir(exist_ok=True)
        self.repaired(cwd=tree)


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


class PrivatePathPattern(unittest.TestCase):
    def test_the_hook_uses_check_publications_own_pattern(self):
        # The hook greps with a copy (it runs before Python is set up); the two must stay equal.
        import importlib.util

        spec = importlib.util.spec_from_file_location("check_publication", REPO / "scripts/check-publication.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        hook = (REPO / HOOK).read_text(encoding="utf-8")
        self.assertIn(f"-e '{module.PRIVATE_PATH}'", hook)
