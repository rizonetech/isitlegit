"""scripts/astra-collect.py and the rules that bound it (D03 T04 §4).

The launcher runs a fake `codex` placed first on PATH, which records its arguments, working directory and standard input
and exits with a chosen code, so each test proves what really ran. The Astra rules in AGENTS.md and CONTRIBUTIONS.md are
checked by substance, and each check is shown to fail on a copy with that rule removed.
"""
import errno
import fcntl
import importlib.util
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
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "astra-collect.py"
BRIEF = ROOT / "docs" / "glimmer" / "astra-collection-brief.md"

FAKE_CODEX = """#!/usr/bin/env python3
import json, os, signal, subprocess, sys, time
data = sys.stdin.buffer.read()
record = {"args": sys.argv[1:], "cwd": os.getcwd(), "stdin": data.decode("utf-8"), "pid": os.getpid()}
if os.environ.get("FAKE_CODEX_DESCENDANT"):
    # A download Codex started that ignores SIGTERM and outlives Codex.
    record["descendant"] = subprocess.Popen([sys.executable, "-c",
        "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"]).pid
with open(os.environ["FAKE_CODEX_LOG"], "w") as fh:
    json.dump(record, fh)
if os.environ.get("FAKE_CODEX_IGNORE_TERM"):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(float(os.environ.get("FAKE_CODEX_SLEEP", "0")))
if not os.environ.get("FAKE_CODEX_NO_REPORT"):
    with open(sys.argv[sys.argv.index("-o") + 1], "w") as fh:
        fh.write("Report: 1 accepted\\n")
sys.exit(int(os.environ.get("FAKE_CODEX_EXIT", "0")))
"""


def alive(pid: int) -> bool:
    """Whether `pid` runs (a zombie waiting for its reaper counts as gone)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        return Path(f"/proc/{pid}/stat").read_text().split(") ")[1][0] != "Z"
    except OSError:
        return False


def load_launcher():
    spec = importlib.util.spec_from_file_location("astra_collect", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
        # The brief's downloader is in place where Astra starts, byte for byte the repository's.
        fetcher = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "fetch.py"
        self.assertEqual((raw / ".fetch.py").read_bytes(), fetcher.read_bytes())

    def test_placed_pinned_downloader_uses_shared_validator_outside_repository(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        raw = self.home / 'isitlegit-data/glimmer/raw'
        helper = raw / '.fetch-inputs.py'
        self.assertEqual(helper.read_bytes(), (ROOT / 'scripts/glimmer/inputs.py').read_bytes())
        spec = importlib.util.spec_from_file_location('placed_pin_inputs', helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        folder = raw / 'fixture'
        folder.mkdir()
        data = folder / 'data.bin'
        data.write_bytes(b'fictional data')
        pin = 'github: fictional/corpus, ' + 'a' * 40
        url = 'https://raw.githubusercontent.com/fictional/corpus/' + 'a' * 40 + '/data.bin'
        module.save_pin_receipt(folder, 'data.bin', pin, module.pin_artifact(pin, url), module.file_digest(data), data.stat().st_size)
        args = [sys.executable, '-I', str(raw / '.fetch.py'), '--url', url, '--dest', 'fixture/data.bin', '--pin', pin, '--min-free', '0']
        present = subprocess.run(args, cwd=raw, capture_output=True, text=True, check=False)
        self.assertEqual(present.returncode, 0, present.stderr)
        self.assertEqual(json.loads(present.stdout)['status'], 'present')
        helper.unlink()
        refused = subprocess.run(args, cwd=raw, capture_output=True, text=True, check=False)
        self.assertNotEqual(refused.returncode, 0)
        self.assertNotIn('Traceback', refused.stderr)
        self.assertIn('validator', refused.stdout)

    def test_validator_placement_failure_refuses_collection(self):
        raw = self.home / 'isitlegit-data/glimmer/raw'
        (raw / '.fetch-inputs.py').mkdir(parents=True)
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.log.exists())

    def test_a_later_brief_is_sent_instead_and_one_outside_docs_glimmer_is_refused(self):
        later = BRIEF.with_name("astra-collection-brief-2.md")
        made = not later.exists()
        if made:
            later.write_text("a later sweep's brief\n", encoding="utf-8")
            self.addCleanup(later.unlink)
        self.assertEqual(self.run_script("--brief", "docs/glimmer/astra-collection-brief-2.md").returncode, 0)
        self.assertEqual(self.recorded()["stdin"], later.read_text(encoding="utf-8"))
        refused = self.run_script("--brief", "AGENTS.md")
        self.assertEqual(refused.returncode, 2)
        self.assertIn("docs/glimmer/astra-collection-brief", refused.stderr)

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

    def test_a_download_left_by_an_exited_codex_is_killed_too(self):
        result = self.run_script("--deadline-seconds", "1", FAKE_CODEX_SLEEP="60", FAKE_CODEX_DESCENDANT="1")
        self.assertEqual(result.returncode, 124, result.stderr)
        descendant = self.recorded()["descendant"]
        deadline = time.monotonic() + 3
        while alive(descendant) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(alive(descendant))

    def test_a_zero_exit_without_a_report_is_a_failure_with_a_partial_report(self):
        result = self.run_script(FAKE_CODEX_NO_REPORT="1")
        self.assertEqual(result.returncode, 1)
        status = self.status()
        self.assertEqual((status["outcome"], status["report"]), ("failed", "fallback"))
        self.assertIn("without writing its report", status["reason"])
        report = (self.home / "isitlegit-data" / "glimmer" / "raw" / "ASTRA-REPORT.md").read_text()
        self.assertIn("# Partial collection report", report)

    def test_a_timed_out_run_leaves_a_partial_report_naming_each_source(self):
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        (raw / "phishpedia").mkdir(parents=True)
        (raw / "phishpedia" / "COLLECTED.md").write_text("URL: x\n")
        (raw / "visualphishnet").mkdir()
        result = self.run_script("--deadline-seconds", "1", FAKE_CODEX_SLEEP="60")
        self.assertEqual(result.returncode, 124)
        report = (raw / "ASTRA-REPORT.md").read_text()
        self.assertIn("timed-out", report)
        self.assertIn("- phishpedia: accepted", report)
        self.assertIn("- visualphishnet: incomplete", report)
        self.assertEqual(self.status()["report"], "fallback")

    def test_a_codex_that_cannot_start_is_a_failure_with_its_reason(self):
        (self.bin / "codex").write_text("#!/nonexistent/interpreter\n")
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(self.status()["outcome"], "failed")
        self.assertIn("could not start", self.status()["reason"])

    def test_a_run_that_died_unrecorded_is_kept_as_abandoned_and_the_relaunch_runs(self):
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        raw.mkdir(parents=True)
        gone = subprocess.Popen(["true"])
        gone.wait()
        (raw / "RUN-STATUS.json").write_text(json.dumps({"outcome": "running", "pid": gone.pid, "started": "t0"}))
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("abandoned", result.stdout)
        kept = [json.loads(p.read_text()) for p in raw.glob("RUN-STATUS.*Z.json")]
        self.assertEqual([k["outcome"] for k in kept], ["abandoned"])
        self.assertEqual(self.status()["outcome"], "completed")

    def test_a_live_collection_is_not_raced(self):
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        raw.mkdir(parents=True)
        with open(raw / ".astra-collect.lock", "a+") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = self.run_script()
        self.assertEqual(result.returncode, 2)
        self.assertIn("another collection is running", result.stderr)
        self.assertFalse(self.log.exists())

    def test_codex_left_by_a_killed_launcher_is_never_raced(self):
        environment = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.home),
                       "FAKE_CODEX_LOG": str(self.log), "FAKE_CODEX_SLEEP": "60"}
        launcher = subprocess.Popen([sys.executable, str(SCRIPT)], env=environment, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while not self.log.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        codex = self.recorded()["pid"]
        self.addCleanup(lambda: subprocess.run(["kill", "-KILL", "--", f"-{codex}"], check=False,
                                               capture_output=True))
        launcher.kill()  # SIGKILL: no cleanup runs, and the launcher's own lock descriptor is gone
        launcher.wait()
        self.log.unlink()
        result = self.run_script()
        self.assertEqual(result.returncode, 2)
        self.assertIn("another collection is running", result.stderr)
        self.assertFalse(self.log.exists())
        self.assertTrue(alive(codex))

    def test_a_recorded_codex_group_still_running_is_never_raced(self):
        # A Codex that closed its inherited lock is still found through the process group the status recorded.
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        raw.mkdir(parents=True)
        survivor = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.addCleanup(lambda: (survivor.kill(), survivor.wait()))
        (raw / "RUN-STATUS.json").write_text(json.dumps({"outcome": "running", "codex_pgid": survivor.pid}))
        result = self.run_script()
        self.assertEqual(result.returncode, 2)
        self.assertIn(f"process group {survivor.pid}", result.stderr)
        self.assertFalse(self.log.exists())

    def test_two_launchers_started_together_run_one_collection(self):
        environment = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.home),
                       "FAKE_CODEX_LOG": str(self.log), "FAKE_CODEX_SLEEP": "2"}
        launchers = [subprocess.Popen([sys.executable, str(SCRIPT)], env=environment, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE, text=True) for _ in range(2)]
        codes = sorted(launcher.wait(timeout=60) for launcher in launchers)
        errors = "".join(launcher.stderr.read() for launcher in launchers)
        for launcher in launchers:
            launcher.stderr.close()
        self.assertEqual(codes, [0, 2])
        self.assertIn("another collection is running", errors)

    def test_a_raw_folder_that_resolves_into_a_repository_is_refused(self):
        checkout = self.tmp / "checkout"
        (checkout / "collection").mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(checkout)], check=True)
        store = self.tmp / "store"
        store.mkdir()
        (store / "raw").symlink_to(checkout / "collection")
        result = self.run_script(GLIMMER_DATA_DIR=str(store))
        self.assertEqual(result.returncode, 2)
        self.assertIn("git work tree", result.stderr)
        self.assertFalse(self.log.exists())
        self.assertEqual(list((checkout / "collection").iterdir()), [])

    def test_a_second_signal_does_not_cut_the_shutdown_short(self):
        environment = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "HOME": str(self.home),
                       "FAKE_CODEX_LOG": str(self.log), "FAKE_CODEX_SLEEP": "60", "FAKE_CODEX_IGNORE_TERM": "1",
                       "FAKE_CODEX_DESCENDANT": "1"}
        launcher = subprocess.Popen([sys.executable, str(SCRIPT)], env=environment, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 20
        while not self.log.exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        time.sleep(0.2)
        launcher.send_signal(signal.SIGTERM)
        time.sleep(1)
        launcher.send_signal(signal.SIGTERM)  # inside the 5-second grace period
        code = launcher.wait(timeout=30)
        stderr = launcher.stderr.read()
        launcher.stderr.close()
        self.assertEqual(code, 130, stderr)
        self.assertNotIn("Traceback", stderr)
        self.assertEqual(self.status()["outcome"], "interrupted")
        for pid in (self.recorded()["pid"], self.recorded()["descendant"]):
            end = time.monotonic() + 3
            while alive(pid) and time.monotonic() < end:
                time.sleep(0.05)
            self.assertFalse(alive(pid))

    def test_an_unreadable_count_does_not_stop_the_outcome_being_recorded(self):
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        raw.mkdir(parents=True)
        rejected = raw / "REJECTED.md"
        rejected.write_text("a: unclear\n")
        rejected.chmod(0)
        self.addCleanup(lambda: rejected.chmod(0o600))
        result = self.run_script("--progress-seconds", "0.2", FAKE_CODEX_SLEEP="0.5")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("progress unavailable", result.stdout)
        self.assertEqual(self.status()["outcome"], "completed")

    def test_progress_is_reported_while_codex_runs(self):
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        (raw / "phishpedia").mkdir(parents=True)
        (raw / "phishpedia" / "COLLECTED.md").write_text("URL: x\n")
        (raw / "visualphishnet" / ".partial").mkdir(parents=True)
        (raw / "REJECTED.md").write_text("a: research-only\nb: unclear\n")
        result = self.run_script("--progress-seconds", "0.2", FAKE_CODEX_SLEEP="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        # What the store held before the run is an earlier sweep's, not this run's (2026-10-31).
        self.assertIn("0 accepted, 0 rejected, 0 in progress or incomplete, 0.00 GB collected", result.stdout)
        self.assertGreaterEqual(result.stdout.count(" min: "), 2)

    def test_a_later_sweeps_rejections_file_is_counted_beside_the_first(self):
        module = load_launcher()
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        raw.mkdir(parents=True)
        (raw / "REJECTED.md").write_text("a: research-only\n")
        baseline = module.snapshot(raw)
        self.assertEqual(baseline["rejected"], {"REJECTED.md": 1})
        (raw / "REJECTED-2.md").write_text("b: unclear\nc: non-commercial\n")
        self.assertIn("0 accepted, 2 rejected,", module.progress(raw, time.monotonic(), baseline))
        # The first sweep's own line is still not this run's.
        with open(raw / "REJECTED.md", "a") as handle:
            handle.write("d: unclear\n")
        self.assertIn("3 rejected", module.progress(raw, time.monotonic(), baseline))

    def test_the_fallback_report_marks_this_runs_sources_and_holds_only_its_rejections(self):
        module = load_launcher()
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        (raw / "earlier").mkdir(parents=True)
        (raw / "earlier" / "COLLECTED.md").write_text("URL: x\n")
        (raw / "REJECTED.md").write_text("old: research-only\n")
        baseline = module.snapshot(raw)
        (raw / "fresh").mkdir()
        (raw / "fresh" / "COLLECTED.md").write_text("URL: y\n")
        (raw / "REJECTED-2.md").write_text("new: unclear\n")
        which = module.write_fallback_report(raw, {"outcome": "interrupted"}, baseline)
        self.assertEqual(which, "fallback")
        report = (raw / module.REPORT).read_text()
        self.assertIn("- fresh: accepted (COLLECTED.md present) [this run]", report)
        self.assertIn("- earlier: accepted (COLLECTED.md present) [earlier sweep]", report)
        self.assertIn("new: unclear", report)
        self.assertNotIn("old: research-only", report)

    def test_progress_counts_only_what_the_run_added(self):
        module = load_launcher()
        raw = self.home / "isitlegit-data" / "glimmer" / "raw"
        (raw / "phishpedia").mkdir(parents=True)
        (raw / "phishpedia" / "COLLECTED.md").write_text("URL: x\n")
        (raw / "earlier-incomplete").mkdir()
        (raw / "REJECTED.md").write_text("a: research-only\n")
        baseline = module.snapshot(raw)
        # During the run: one new source collected, one begun, one earlier one finished, two rejections, 2 MB.
        (raw / "new-set").mkdir()
        (raw / "new-set" / "COLLECTED.md").write_text("URL: y\n")
        (raw / "new-set" / "data.bin").write_bytes(b"0" * 2_000_000)
        (raw / "begun" / ".partial").mkdir(parents=True)
        (raw / "earlier-incomplete" / "COLLECTED.md").write_text("URL: z\n")
        with open(raw / "REJECTED.md", "a") as handle:
            handle.write("b: unclear\nc: non-commercial\n")
        line = module.progress(raw, time.monotonic(), baseline)
        self.assertIn("2 accepted, 2 rejected, 1 in progress or incomplete, 0.00 GB collected", line)
        self.assertEqual(module.count_progress(raw, time.monotonic(), baseline).split("incomplete, ")[1], "0.00 GB collected")
        (raw / "new-set" / "more.bin").write_bytes(b"0" * 20_000_000)
        self.assertIn("0.02 GB collected", module.progress(raw, time.monotonic(), baseline))

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
        self.assertEqual((raw / "ASTRA-REPORT.md").read_text(), "Report: 1 accepted\n")
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


class FaultInjection(unittest.TestCase):
    """Failures a subprocess cannot stage reliably, injected into the launcher run in this process."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="astra-faults-"))
        self.addCleanup(lambda: subprocess.run(["rm", "-rf", str(self.tmp)], check=False))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        fake = self.bin / "codex"
        fake.write_text(FAKE_CODEX)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self.raw = self.tmp / "store" / "raw"
        env = {"PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}", "GLIMMER_DATA_DIR": str(self.tmp / "store"),
               "FAKE_CODEX_LOG": str(self.tmp / "codex.json")}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.launcher = load_launcher()

    def test_a_broken_pipe_ends_as_a_failure_and_stops_codex(self):
        real = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.addCleanup(lambda: (real.kill(), real.wait()))

        class Pipe:
            def write(self, _data):
                raise BrokenPipeError(errno.EPIPE, "Broken pipe")

            def close(self):
                pass

        class Child:
            pid, stdin = real.pid, Pipe()
            poll, wait = real.poll, real.wait

        original = subprocess.Popen

        def launch(command, *args, **kwargs):  # only the Codex launch is faked; git's probe runs for real
            return Child() if "exec" in command else original(command, *args, **kwargs)

        with mock.patch.object(self.launcher.subprocess, "Popen", launch), \
                mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            code = self.launcher.main([])
        self.assertEqual(code, 1)
        status = json.loads((self.raw / "RUN-STATUS.json").read_text())
        self.assertEqual(status["outcome"], "failed")
        self.assertIn("closed its input", status["reason"])
        self.assertIsNotNone(real.poll())

    def test_a_report_that_cannot_be_read_ends_as_a_recorded_failure(self):
        real_stat = Path.stat

        def failing_stat(path, *args, **kwargs):
            found = real_stat(path, *args, **kwargs)  # a missing file stays missing; an existing report fails to read
            if path.name == "ASTRA-REPORT.md":
                raise OSError(errno.EIO, "Input/output error")
            return found

        with mock.patch.object(Path, "stat", failing_stat), mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            code = self.launcher.main([])
        self.assertEqual(code, 1)
        status = json.loads((self.raw / "RUN-STATUS.json").read_text())
        self.assertEqual(status["outcome"], "failed")
        self.assertIn("could not be read (Input/output error)", status["reason"])

    def test_an_earlier_report_that_cannot_be_read_refuses_before_launching(self):
        self.raw.mkdir(parents=True)
        (self.raw / "ASTRA-REPORT.md").write_text("the earlier run")
        real_stat = Path.stat

        def failing_stat(path, *args, **kwargs):
            found = real_stat(path, *args, **kwargs)
            if path.name == "ASTRA-REPORT.md":
                raise OSError(errno.EIO, "Input/output error")
            return found

        with mock.patch.object(Path, "stat", failing_stat), mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            code = self.launcher.main([])
        self.assertEqual(code, 2)
        self.assertFalse((self.tmp / "codex.json").exists())

    def test_a_full_disk_at_the_end_is_reported_and_the_next_run_recovers(self):
        write = self.launcher.write_status
        calls = []

        def failing(raw, status):
            calls.append(status["outcome"])
            if status["outcome"] != "running":
                raise OSError(errno.ENOSPC, "No space left on device")
            write(raw, status)

        with mock.patch.object(self.launcher, "write_status", failing), mock.patch("sys.stdout"), \
                mock.patch("sys.stderr") as stderr:
            code = self.launcher.main([])
        self.assertEqual(code, 1)  # a run whose end is not on record has not completed
        self.assertEqual(calls, ["running", "running", "completed"])  # start, Codex's group, end
        printed = "".join(c.args[0] for c in stderr.write.call_args_list)
        self.assertIn("No space left on device", printed)
        self.assertIn("next run sets it aside as abandoned", printed)
        self.assertEqual(json.loads((self.raw / "RUN-STATUS.json").read_text())["outcome"], "running")
        # The relaunch, once space is back, keeps the stuck status aside and runs.
        with mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            self.assertEqual(self.launcher.main([]), 0)
        self.assertEqual(json.loads((self.raw / "RUN-STATUS.json").read_text())["outcome"], "completed")
        self.assertEqual(len(list(self.raw.glob("RUN-STATUS.*Z.json"))), 1)


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
