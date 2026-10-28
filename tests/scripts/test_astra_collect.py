"""scripts/astra-collect.py and the rules that bound it (D03 T04 §4).

The launcher runs a fake `codex` placed first on PATH, which records its arguments, working directory and standard input
and exits with a chosen code, so each test proves what really ran. The Astra rules in AGENTS.md and CONTRIBUTIONS.md are
checked by substance, and each check is shown to fail on a copy with that rule removed.
"""
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "astra-collect.py"
BRIEF = ROOT / "docs" / "glimmer" / "astra-collection-brief.md"

FAKE_CODEX = """#!/usr/bin/env python3
import json, os, signal, sys, time
data = sys.stdin.buffer.read()
with open(os.environ["FAKE_CODEX_LOG"], "w") as fh:
    json.dump({"args": sys.argv[1:], "cwd": os.getcwd(), "stdin": data.decode("utf-8"), "pid": os.getpid()}, fh)
if os.environ.get("FAKE_CODEX_IGNORE_TERM"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(float(os.environ.get("FAKE_CODEX_SLEEP", "0")))
sys.exit(int(os.environ.get("FAKE_CODEX_EXIT", "0")))
"""


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


class Launcher(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="astra-collect-"))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(self.tmp)], check=False))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        fake = self.bin / "codex"
        fake.write_text(FAKE_CODEX)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.log = self.tmp / "codex.json"

    def run_script(self, *args, exit_code=0, **env):
        environment = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.home),
                       "FAKE_CODEX_LOG": str(self.log), "FAKE_CODEX_EXIT": str(exit_code)}
        environment.update(env)
        return subprocess.run([sys.executable, str(SCRIPT), *args], env=environment, capture_output=True, text=True,
                              timeout=60, check=False)

    def recorded(self):
        return json.loads(self.log.read_text())

    def status(self, store=None):
        raw = (store or self.home / "isitlegit-data" / "glimmer") / "raw"
        return json.loads((raw / "RUN-STATUS.json").read_text())

    def test_it_runs_codex_in_the_default_store_with_the_brief_on_standard_input(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        raw = (self.home / "isitlegit-data" / "glimmer" / "raw").resolve()
        self.assertTrue(raw.is_dir())
        call = self.recorded()
        self.assertEqual(call["args"], [
            "exec", "-m", "gpt-6-astra", "-c", "model_reasoning_effort=high", "--sandbox", "workspace-write",
            "-c", "sandbox_workspace_write.network_access=true", "--skip-git-repo-check", "--ephemeral",
            "--cd", str(raw), "-o", str(raw / "ASTRA-REPORT.md"), "-"])
        self.assertEqual(Path(call["cwd"]).resolve(), raw)
        self.assertEqual(call["stdin"], BRIEF.read_text(encoding="utf-8"))

    def test_it_exits_with_codexs_own_failure(self):
        self.assertEqual(self.run_script(exit_code=7).returncode, 7)
        self.assertEqual(self.status()["outcome"], "failed")
        self.assertEqual(self.status()["exit"], 7)

    def test_a_finished_run_records_its_outcome(self):
        self.assertEqual(self.run_script().returncode, 0)
        status = self.status()
        self.assertEqual((status["outcome"], status["exit"]), ("completed", 0))
        self.assertIn("started", status)
        self.assertIn("ended", status)

    def test_the_deadline_stops_a_stalled_run_and_its_whole_process_group(self):
        # The fake ignores SIGTERM, so only the SIGKILL that follows the grace period stops it.
        began = time.monotonic()
        result = self.run_script("--deadline-seconds", "1", FAKE_CODEX_SLEEP="60", FAKE_CODEX_IGNORE_TERM="1")
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertLess(time.monotonic() - began, 20)
        self.assertEqual(self.status()["outcome"], "timed-out")
        self.assertFalse(alive(self.recorded()["pid"]))

    def test_an_interrupted_launcher_stops_codex_and_says_so(self):
        environment = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.home),
                       "FAKE_CODEX_LOG": str(self.log), "FAKE_CODEX_SLEEP": "60"}
        launcher = subprocess.Popen([sys.executable, str(SCRIPT)], env=environment, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 20
        while not self.log.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        child = self.recorded()["pid"]
        began = time.monotonic()
        launcher.send_signal(signal.SIGTERM)
        code = launcher.wait(timeout=20)
        launcher.stdout.close()
        launcher.stderr.close()
        self.assertEqual(code, 130)
        self.assertLess(time.monotonic() - began, 6)
        self.assertEqual(self.status()["outcome"], "interrupted")
        self.assertEqual(self.status()["signal"], "SIGTERM")
        self.assertFalse(alive(child))

    def test_progress_is_reported_while_codex_runs(self):
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        (raw / "phishpedia").mkdir(parents=True)
        (raw / "phishpedia" / "COLLECTED.md").write_text("URL: x\n")
        (raw / "visualphishnet" / ".partial").mkdir(parents=True)
        (raw / "REJECTED.md").write_text("a: research-only\nb: unclear\n")
        result = self.run_script("--progress-seconds", "0.2", FAKE_CODEX_SLEEP="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 accepted, 2 rejected, 1 in progress or incomplete", result.stdout)
        self.assertGreaterEqual(result.stdout.count(" min: "), 2)

    def test_it_honours_the_store_override(self):
        store = self.tmp / "elsewhere"
        result = self.run_script(GLIMMER_DATA_DIR=str(store))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(Path(self.recorded()["cwd"]).resolve(), (store / "raw").resolve())

    def test_a_store_inside_the_repository_is_refused_without_launching(self):
        for store in (ROOT, ROOT / "build" / "glimmer", ROOT / "samples"):
            result = self.run_script(GLIMMER_DATA_DIR=str(store))
            self.assertEqual(result.returncode, 2, store)
            self.assertIn("inside the repository", result.stderr)
            self.assertFalse(self.log.exists())
        self.assertFalse((ROOT / "build" / "glimmer" / "raw").exists())

    def test_a_store_in_another_git_work_tree_is_refused_without_launching(self):
        other = self.tmp / "other-checkout"
        other.mkdir()
        subprocess.run(["git", "init", "-q", str(other)], check=True)
        result = self.run_script(GLIMMER_DATA_DIR=str(other / "data" / "glimmer"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("another git work tree", result.stderr)
        self.assertFalse(self.log.exists())
        self.assertFalse((other / "data").exists())

    def test_an_uncreatable_store_is_refused_without_launching(self):
        blocker = self.tmp / "file"
        blocker.write_text("not a folder")
        result = self.run_script(GLIMMER_DATA_DIR=str(blocker))
        self.assertEqual(result.returncode, 2)
        self.assertIn("cannot create", result.stderr)
        self.assertFalse(self.log.exists())

    def test_an_earlier_report_is_moved_aside_under_its_stamp(self):
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        raw.mkdir(parents=True)
        (raw / "ASTRA-REPORT.md").write_text("the earlier run")
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((raw / "ASTRA-REPORT.md").exists())
        kept = list(raw.glob("ASTRA-REPORT.*Z.md"))
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0].read_text(), "the earlier run")

    def test_the_dry_run_prints_the_command_and_changes_nothing(self):
        result = self.run_script("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("exec -m gpt-6-astra", result.stdout)
        self.assertIn("--sandbox workspace-write", result.stdout)
        self.assertIn(str((self.home / "isitlegit-data" / "glimmer").resolve()), result.stdout)
        self.assertFalse(self.log.exists())
        self.assertFalse((self.home / "isitlegit-data").exists())

    def test_without_git_the_store_cannot_be_shown_outside_a_repository(self):
        result = self.run_script(PATH=str(self.bin))
        self.assertEqual(result.returncode, 2)
        self.assertIn("another git work tree", result.stderr)
        self.assertFalse(self.log.exists())

    def test_it_refuses_without_codex(self):
        (self.bin / "codex").unlink()
        result = self.run_script(PATH=f"{self.bin}{os.pathsep}{Path(shutil.which('git')).parent}")
        self.assertEqual(result.returncode, 2)
        self.assertIn("not on PATH", result.stderr)


# Each Astra rule in AGENTS.md, and the record of its use in CONTRIBUTIONS.md, as phrases the text must hold.
AGENTS_RULES = (
    "runs collection jobs",
    "`codex exec --sandbox workspace-write` with network access, rooted at the Glimmer data store",
    "never in the repository",
    "Claude writes the brief and every script and verifies all data Astra collects",
    "Astra never reviews data it collected",
    "at `xhigh` in its `read-only` sandbox",
    "only when redacted",
)
CONTRIBUTIONS_RULES = ("dataset collection", "label judging")


def astra_paragraph(text: str) -> str:
    return next((p for p in text.split("\n\n") if "GPT-6 Astra through the Codex CLI" in p), "")


def missing(paragraph: str, rules) -> list:
    return [rule for rule in rules if rule not in paragraph]


class Rules(unittest.TestCase):
    def test_agents_md_states_every_limit_on_astras_collection_and_judging(self):
        paragraph = astra_paragraph((ROOT / "AGENTS.md").read_text(encoding="utf-8"))
        self.assertEqual(missing(paragraph, AGENTS_RULES), [])
        for rule in AGENTS_RULES:
            self.assertEqual(missing(paragraph.replace(rule, ""), AGENTS_RULES), [rule])

    def test_contributions_md_records_both_uses_as_tooling(self):
        text = (ROOT / "CONTRIBUTIONS.md").read_text(encoding="utf-8")
        section = text.split("## Existing before the hackathon")[1].split("\n## ")[0]
        self.assertEqual(missing(section, CONTRIBUTIONS_RULES), [])
        for rule in CONTRIBUTIONS_RULES:
            self.assertEqual(missing(section.replace(rule, ""), CONTRIBUTIONS_RULES), [rule])


if __name__ == "__main__":
    unittest.main()
