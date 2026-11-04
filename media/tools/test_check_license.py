import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


MEDIA = Path(__file__).resolve().parents[1]
CHECK = MEDIA / "tools/check-license.py"
FREE = "Remotion licence: free (up to 3 people), Rizonetech has 3 people, confirmed 2026-10-30\n"
COMPANY = "Remotion licence: company licence, ABC-123, confirmed 2026-10-30\n"


class LicenceCheckTests(unittest.TestCase):
    def check_record(self, text):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "record.md"
            path.write_text(text)
            return subprocess.run([sys.executable, str(CHECK), str(path)], capture_output=True, text=True)

    def test_valid_records(self):
        for text in (FREE, COMPANY, "Remotion licence: free (up to 3 people), confirmed 2024-02-29\n"):
            with self.subTest(text=text):
                result = self.check_record(text)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_invalid_records(self):
        invalid = ["", FREE + COMPANY, FREE + FREE, FREE.replace("2026-10-30", "2026-02-30"),
                   FREE.replace("2026-10-30", "2026-2-3"), COMPANY.replace("ABC-123", "abc-123"),
                   COMPANY.replace("ABC-123", "12345"), COMPANY.replace("ABC-123", "<reference>"),
                   COMPANY.replace("ABC-123", "-ABC123"), COMPANY.rstrip() + " trailing\n"]
        invalid += [COMPANY.replace("ABC-123", word) for word in ("PENDING", "TBD", "TODO", "TBD---", "TODO--", "PENDING---")]
        for text in invalid:
            with self.subTest(text=text):
                self.assertNotEqual(self.check_record(text).returncode, 0)

    def test_missing_file_is_actionable(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = subprocess.run([sys.executable, str(CHECK), str(Path(tmp) / "absent")], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cannot read", result.stderr)
            self.assertNotIn("Traceback", result.stderr)

    def test_every_render_command_blocks_invalid_evidence(self):
        self.exercise_commands(COMPANY.replace("ABC-123", "PENDING"), allowed=False)

    def test_every_render_command_allows_valid_evidence(self):
        self.exercise_commands(FREE, allowed=True)

    def exercise_commands(self, record, allowed):
        scripts = json.loads((MEDIA / "package.json").read_text())["scripts"]
        commands = {name: cmd for name, cmd in scripts.items() if re.search(r"\bremotion (render|still)\b", cmd)}
        self.assertTrue(commands)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            media = root / "media"
            (media / "tools").mkdir(parents=True)
            records = root / "todo/10-media"
            records.mkdir(parents=True)
            (records / "TODO-01-channel-videos.md").write_text(record)
            (media / "package.json").write_text(json.dumps({"scripts": scripts}))
            if CHECK.exists():
                shutil.copyfile(CHECK, media / "tools/check-license.py")
            binaries = root / "bin"
            binaries.mkdir()
            # Run the real package shell chains and licence checker, replacing expensive
            # generation/rendering commands only. The sentinel proves short-circuiting.
            wrappers = {
                "pnpm": "import json,subprocess,sys\na=sys.argv[1:]\nn=a[1] if a[0]=='run' else a[0]\nif n in ('preflight','check:license'):\n sys.exit(subprocess.call(json.load(open('package.json'))['scripts'][n],shell=True))\n",
                "python3": "import subprocess,sys\nif sys.argv[1].endswith('check-license.py'):\n sys.exit(subprocess.call([sys.executable,*sys.argv[1:]]))\n",
                "node": "",
                "remotion": "from pathlib import Path\nPath('renderer-reached').touch()\n",
            }
            for name, body in wrappers.items():
                path = binaries / name
                path.write_text(f"#!{sys.executable}\n" + body)
                path.chmod(0o755)
            env = {**os.environ, "PATH": str(binaries) + os.pathsep + os.environ["PATH"]}
            for name, command in commands.items():
                with self.subTest(command=name, allowed=allowed):
                    sentinel = media / "renderer-reached"
                    sentinel.unlink(missing_ok=True)
                    result = subprocess.run(command, shell=True, cwd=media, env=env, capture_output=True, text=True)
                    self.assertEqual(sentinel.exists(), allowed, f"{name}: {result.stderr}")
                    self.assertEqual(result.returncode == 0, allowed, f"{name}: {result.stderr}")


if __name__ == "__main__":
    unittest.main()
