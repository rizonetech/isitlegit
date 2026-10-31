"""scripts/check-publication.py: nothing private reaches the public repository, and a check that cannot run says so."""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = "scripts/check-publication.py"


@unittest.skipUnless(shutil.which("git"), "needs git")
class CheckPublication(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "scripts").mkdir()
        shutil.copyfile(REPO / SCRIPT, self.root / SCRIPT)
        (self.root / "samples").mkdir()
        (self.root / "samples/.gitignore").write_text("*\n!.gitignore\n!README.md\n", encoding="utf-8")
        (self.root / "samples/README.md").write_text("# Samples\n", encoding="utf-8")
        (self.root / "README.md").write_text("A fictional supplier.\n", encoding="utf-8")
        self.names("acme\n")
        for args in (["init", "-q"], ["add", "-A"]):
            self.git(*args)

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], capture_output=True, text=True, check=True)

    def names(self, text):
        (self.root / "samples/client-names.txt").write_text(text, encoding="utf-8")

    def check(self):
        return subprocess.run([sys.executable, str(self.root / SCRIPT)], capture_output=True, text=True)

    def stage(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data) if isinstance(data, bytes) else path.write_text(data, encoding="utf-8")
        self.git("add", "-f", rel)

    def test_a_clean_index_passes(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("clean", result.stdout)

    def test_a_missing_list_means_the_check_cannot_run(self):
        (self.root / "samples/client-names.txt").unlink()
        result = self.check()
        self.assertEqual(result.returncode, 2)
        self.assertIn("missing", result.stderr)

    def test_a_list_of_blank_lines_means_the_check_cannot_run(self):
        self.names("\n   \n\r\n")
        result = self.check()
        self.assertEqual(result.returncode, 2)
        self.assertIn("lists no names", result.stderr)

    @unittest.skipIf(os.name == "nt" or os.geteuid() == 0, "needs POSIX permissions and a non-root user")
    def test_an_unreadable_list_means_the_check_cannot_run(self):
        (self.root / "samples/client-names.txt").chmod(0)
        try:
            result = self.check()
        finally:
            (self.root / "samples/client-names.txt").chmod(0o644)
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot be read", result.stderr)

    def worktree(self):
        """A linked worktree of the fixture repository, which `git worktree add` gives no ignored file, so no list."""
        for args in (["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["commit", "-qm", "x"]):
            self.git(*args)
        tree = self.root.parent / (self.root.name + "-wt")
        self.git("worktree", "add", "-q", str(tree))
        self.addCleanup(shutil.rmtree, tree, True)
        self.assertFalse((tree / "samples/client-names.txt").exists())
        return tree

    def check_in(self, tree):
        return subprocess.run([sys.executable, str(tree / SCRIPT)], capture_output=True, text=True)

    def clean(self, tree, names):
        result = self.check_in(tree)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"{names} client names", result.stdout)

    def refused(self, tree, fragment):
        result = self.check_in(tree)
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn(fragment, result.stderr)
        self.assertNotIn("acme", (result.stdout + result.stderr).lower())

    def test_a_linked_worktree_without_its_own_list_scans_with_the_main_checkouts(self):
        # D00 T01 §25: the media lane's new worktree exited 2 here while its commits scanned with the main list.
        tree = self.worktree()
        self.clean(tree, 1)
        (tree / "notes.txt").write_text("Invoice from ACME\n", encoding="utf-8")
        (tree / "acme-invoice.txt").write_text("an invoice\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(tree), "add", "notes.txt", "acme-invoice.txt"], check=True)
        result = self.check_in(tree)
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in content: notes.txt:1", result.stdout)
        self.assertIn("client name in 1 tracked path(s)", result.stdout)
        # The hint names the list the check used, which this worktree does not hold itself.
        self.assertIn(f"`git ls-files | grep -iFf {self.root / 'samples/client-names.txt'}`", result.stdout)
        self.assertNotIn("acme", (result.stdout + result.stderr).lower())

    def test_the_worktrees_own_list_wins_as_a_file_or_a_resolving_link(self):
        tree = self.worktree()
        (tree / "notes.txt").write_text("Invoice from ACME\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(tree), "add", "notes.txt"], check=True)
        own = tree / "samples/client-names.txt"
        own.write_text("globex\ninitech\n", encoding="utf-8")
        self.clean(tree, 2)  # the main list's acme is not this worktree's list
        own.unlink()
        other = tree.parent / (tree.name + "-list.txt")
        other.write_text("globex\ninitech\n", encoding="utf-8")
        self.addCleanup(other.unlink)
        own.symlink_to(other)
        self.clean(tree, 2)

    def test_an_unusable_own_list_refuses_and_never_falls_back(self):
        tree = self.worktree()
        own = tree / "samples/client-names.txt"
        own.write_text("\n  \n", encoding="utf-8")
        self.refused(tree, f"{own} lists no names")
        if os.name != "nt" and os.geteuid() != 0:
            own.write_text("globex\n", encoding="utf-8")
            own.chmod(0)
            try:
                self.refused(tree, f"{own} cannot be read")
            finally:
                own.chmod(0o644)
        own.unlink()
        self.clean(tree, 1)  # the repair: no own list, the main checkout's serves

    def test_an_unusable_main_list_refuses_from_a_worktree(self):
        tree = self.worktree()
        main_list = self.root / "samples/client-names.txt"
        main_list.write_text("\n", encoding="utf-8")
        self.refused(tree, f"{main_list} lists no names")
        if os.name != "nt" and os.geteuid() != 0:
            main_list.write_text("acme\n", encoding="utf-8")
            main_list.chmod(0)
            try:
                self.refused(tree, f"{main_list} cannot be read")
            finally:
                main_list.chmod(0o644)
        main_list.write_text("acme\n", encoding="utf-8")
        self.clean(tree, 1)

    def test_a_dangling_link_refuses_with_a_repair_that_works(self):
        tree = self.worktree()
        main_list = self.root / "samples/client-names.txt"
        own = tree / "samples/client-names.txt"
        own.symlink_to(tree / "samples/gone.txt")
        self.refused(tree, f"'ln -sfn {main_list} {own}'")
        subprocess.run(["ln", "-sfn", str(main_list), str(own)], check=True)  # the repair it names
        self.clean(tree, 1)
        # With no usable main list the repair is to put the list there instead.
        own.unlink()
        own.symlink_to(tree / "samples/gone.txt")
        main_list.rename(self.root / "samples/real.txt")
        self.refused(tree, "put the operator's private list there, or replace the link with the list itself")
        own.unlink()
        main_list.symlink_to(self.root / "samples/gone.txt")
        self.refused(tree, f"the main checkout's client list {main_list} is a link to")
        # The main checkout's own dangling link cannot be repaired by pointing at itself.
        result = self.check()
        self.assertEqual(result.returncode, 2)
        self.assertIn("put the operator's private list there", result.stderr)
        main_list.unlink()
        self.refused(tree, "no client list: samples/client-names.txt is missing in this checkout and the main checkout")
        self.refused(tree, str(main_list))
        (self.root / "samples/real.txt").rename(main_list)  # the repair: the list back at the main checkout
        self.clean(tree, 1)

    def test_a_client_name_inside_a_binary_marked_mail_fixture_is_found(self):
        self.stage(".gitattributes", "*.eml binary\n")
        self.stage("test/fixtures/message.eml", b"From: <billing@ACME-holdings.example>\r\n\r\nPay.\r\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in content: test/fixtures/message.eml:1", result.stdout)
        self.assertNotIn("ACME", result.stdout + result.stderr)  # the matching header is never echoed

    def test_content_in_a_file_whose_path_names_a_client_is_reported_without_the_path(self):
        self.stage("docs/Acme notes.md", "Billing contact at Acme.\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in content: <path naming a client>:1", result.stdout)
        self.assertNotIn("Acme", result.stdout + result.stderr)

    def test_font_and_image_bytes_are_not_read_as_text_but_their_paths_are(self):
        self.stage("design/fonts/Font.ttf", b"\x00\x01binary\x00ACME\x00tables\n")
        self.stage("design/brand/logo.png", b"\x89PNG\r\n\x1a\nACME")
        self.assertEqual(self.check().returncode, 0)
        self.stage("design/fonts/Acme.woff2", b"\x00\x01")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in 1 tracked path(s)", result.stdout)

    def test_a_pdf_is_still_read_as_text(self):
        self.stage("test/fixtures/invoice.pdf", b"%PDF-1.7\n1 0 obj << /Author (Acme Holdings) >>\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in content: test/fixtures/invoice.pdf:2", result.stdout)

    def test_a_client_name_in_a_path_is_found(self):
        self.stage("docs/Acme-case.md", "A fictional supplier.\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in 1 tracked path(s)", result.stdout)
        self.assertNotIn("Acme", result.stdout + result.stderr)

    def test_a_non_ascii_client_name_in_a_path_is_found(self):
        self.names("Café Holdings\n")
        self.stage("docs/Café Holdings.md", "A fictional supplier.\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in 1 tracked path(s)", result.stdout)
        self.assertNotIn("Café", result.stdout + result.stderr)

    def test_a_private_checkout_path_is_found_outside_the_test_folders_only(self):
        self.stage("tests/scripts/test_x.py", 'FIXTURE = r"R:\\GitHub\\Project\\todo"\n')
        self.assertEqual(self.check().returncode, 0)
        self.stage("docs/notes.md", "Logs are in /home/someone/isitlegit/build.\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("private path: docs/notes.md:1", result.stdout)
        self.assertNotIn("/home/someone", result.stdout)

    def test_a_home_folder_is_found_wherever_a_path_starts_but_a_web_address_is_not(self):
        for line in ('cd /home/someone/x\n', 'path="/home/someone"\n', '`/home/someone`\n', '(/home/someone)\n',
                     "file:/home/someone/a\n"):
            with self.subTest(line):
                self.stage("docs/notes.md", line)
                self.assertEqual(self.check().returncode, 1, line)
        self.stage("docs/notes.md", "See https://personal.bank.example/home/fraud-awareness/cybercrime.html\n")
        self.assertEqual(self.check().returncode, 0)

    def test_no_diagnostic_prints_a_client_bearing_path(self):
        self.stage("samples/Acme Holdings.eml", b"From: nobody\r\n")
        self.stage("sources/Acme Holdings/mail.md", "capture\n")
        self.stage("docs/notes:Acme Holdings.md", "Billing contact at Acme.\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Acme", result.stdout + result.stderr)
        self.assertIn("must stay local: <path naming a client>", result.stdout)
        self.assertIn("client name in content: <path naming a client>:1", result.stdout)

    def test_an_extra_samples_file_or_a_local_only_folder_is_found(self):
        self.stage("samples/real.eml", b"From: someone\r\n")
        self.stage("sources/discord/raw.txt", "capture\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("samples/ must track exactly", result.stdout)
        self.assertIn("must stay local: sources/discord/raw.txt", result.stdout)


if __name__ == "__main__":
    unittest.main()
