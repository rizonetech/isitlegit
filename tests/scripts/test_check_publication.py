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

    def test_a_client_name_inside_a_binary_marked_mail_fixture_is_found(self):
        self.stage(".gitattributes", "*.eml binary\n")
        self.stage("test/fixtures/message.eml", b"From: <billing@ACME-holdings.example>\r\n\r\nPay.\r\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in content: test/fixtures/message.eml", result.stdout)

    def test_a_client_name_in_a_path_is_found(self):
        self.stage("docs/Acme-case.md", "A fictional supplier.\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("client name in path: docs/Acme-case.md", result.stdout)

    def test_a_private_checkout_path_is_found_outside_the_test_folders_only(self):
        self.stage("tests/scripts/test_x.py", 'FIXTURE = r"R:\\GitHub\\Project\\todo"\n')
        self.assertEqual(self.check().returncode, 0)
        self.stage("docs/notes.md", "Logs are in /home/someone/isitlegit/build.\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("private path: docs/notes.md:1", result.stdout)

    def test_an_extra_samples_file_or_a_local_only_folder_is_found(self):
        self.stage("samples/real.eml", b"From: someone\r\n")
        self.stage("sources/discord/raw.txt", "capture\n")
        result = self.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("samples/ must track exactly", result.stdout)
        self.assertIn("must stay local: sources/discord/raw.txt", result.stdout)


if __name__ == "__main__":
    unittest.main()
