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
