"""A lane run waits on another lane's row and resumes by itself (D00 T01 §20), end to end over a bare remote: the
prerequisite is stamped in a main clone and pushed, and `campaign_guard.py wake` in the lane clone fetches main, merges
it through the plan's merge stop (D00 T01 §22) and reads READY on the dependent, with no other step. Each git failure
is backed out to a state the next wake retries."""
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import unittest
from unittest import mock

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("tg_fixtures_wake", REPO / "tests" / "scripts" / "test_todo_graph.py")
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
tg = fixtures.tg
gspec = importlib.util.spec_from_file_location("campaign_guard_wake", REPO / "scripts" / "campaign_guard.py")
guard = importlib.util.module_from_spec(gspec)
gspec.loader.exec_module(guard)

SESSION = "11111111-2222-3333-4444-555555555555"
RUN_FILE = "docs/phase-runs/2099-01-01-checks-phase-0.md"
PREREQ, DEPENDENT = "D00 T01 §1", "D01 T01 §1"
INTAKE = "todo/01-intake/TODO-01-a.md"


def without_stamp_tests(cls):
    for name in [n for n in dir(fixtures.Stamp) if n.startswith("test_")]:
        setattr(cls, name, None)
    return cls


def clean_env():
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k != "TODO_LANE"}


@without_stamp_tests
@unittest.skipUnless(shutil.which("git") and shutil.which("sh"), "needs git and a shell")
class LaneWake(fixtures.Stamp):
    """`self.root` is the main clone (the coordinator's); `self.lane` the checks lane's clone, whose D01 row depends
    on the main lane's D00 T01 §1."""

    def setUp(self):
        super().setUp()
        self.env = mock.patch.dict(os.environ, clean_env(), clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.write(fixtures.todo_file([(1, "Needs the coordinator", 0, "none", PREREQ)], ident="intake",
                                      domain="01-intake"), domain="01-intake")
        (self.root / "todo/lanes.json").write_text(json.dumps({"lanes": {"checks": {
            "branch": "checks-lane", "worktree": "../lane", "domains": ["D01"]}}}), encoding="utf-8")
        shutil.copytree(REPO / "scripts", self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        # This test is about merges: the pre-push type check and lint need pnpm and node_modules this scratch repository
        # lacks (pre-push has its own tests, test_pre_push_hook.py).
        (self.root / "scripts/hooks/pre-push").unlink()
        (self.root / ".gitignore").write_text("build/\n__pycache__/\nsamples/\n", encoding="utf-8")
        (self.root / "notes.txt").write_text("shared\n", encoding="utf-8")
        tg.projections(self.root, sync=True)
        self.setup_clone(self.root)
        self.run_git(self.root, "add", "-A")
        self.run_git(self.root, "commit", "-qm", "base: two lanes and the hooks")
        self.run_git(self.root, "branch", "-M", "main")
        self.remote = self.root.parent / f"{self.root.name}-remote.git"
        self.run_git(self.root.parent, "clone", "-q", "--bare", str(self.root), str(self.remote))
        self.addCleanup(shutil.rmtree, self.remote, True)
        self.run_git(self.root, "remote", "add", "origin", str(self.remote))
        self.run_git(self.root, "fetch", "-q", "origin")
        self.lane = self.root.parent / f"{self.root.name}-lane"
        self.run_git(self.root.parent, "clone", "-q", str(self.remote), str(self.lane))
        self.addCleanup(shutil.rmtree, self.lane, True)
        self.setup_clone(self.lane)
        self.run_git(self.lane, "checkout", "-qb", "checks-lane")
        # The lane's own work under todo/, so merging main is a real merge through the plan's stop.
        path = self.lane / INTAKE
        path.write_text(path.read_text(encoding="utf-8").replace("> **Current state:** c.",
                                                                 "> **Current state:** the lane's."), encoding="utf-8")
        self.write_lane_file(RUN_FILE, "# Phase run: checks, Phase 0\n\n## Critical events\n")
        self.commit_lane("the lane's own work and run file")

    @staticmethod
    def run_git(cwd, *args, check=True):
        return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, check=check,
                              env=clean_env(), timeout=120)

    def setup_clone(self, root):
        for args in (["config", "user.email", "t@example.com"], ["config", "user.name", "T"],
                     ["config", "maintenance.auto", "false"], ["config", "commit.gpgsign", "false"],
                     ["config", "core.hooksPath", "scripts/hooks"], ["config", "merge.todo-plan.driver", "true"]):
            self.run_git(root, *args)
        info = root / ".git" / "info"
        info.mkdir(parents=True, exist_ok=True)
        (info / "attributes").write_text("todo/implementation-plan.md merge=todo-plan\n", encoding="utf-8")
        (root / "samples").mkdir(exist_ok=True)
        (root / "samples/client-names.txt").write_text("Zzyzx Unlisted Client\n", encoding="utf-8")

    def write_lane_file(self, rel, text):
        path = self.lane / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def commit_lane(self, message):
        subprocess.run([guard.sys.executable, str(self.lane / "scripts/todo-graph.py"), "plan", "--sync"],
                       cwd=self.lane, capture_output=True, env=clean_env(), check=True)
        self.run_git(self.lane, "add", "-A")
        self.run_git(self.lane, "commit", "-qm", message)

    def stamp_prerequisite_on_main(self):
        """The coordinator stamps D00 T01 §1 in the main clone and pushes it."""
        self.tick_work()
        tg.projections(self.root, sync=True)
        sha = self.commit("work for §1")
        self.stamp(PREREQ, sha, self.reviews, ["true -> ok"], "2026-10-30", sync_plan=True)
        self.run_git(self.root, "add", "-A")
        self.run_git(self.root, "commit", "-qm", "todo: stamp D00 T01 §1")
        self.run_git(self.root, "push", "-q", "origin", "main")

    def start_waiting(self, scope="plan"):
        guard.acquire(str(self.lane), SESSION, 0, RUN_FILE, "job-1", scope=scope)
        self.assertEqual(guard.read_guard(str(self.lane))["lane"], "checks")
        guard.wait(str(self.lane), SESSION, [PREREQ])

    def lane_clean(self):
        merging = self.run_git(self.lane, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False).returncode == 0
        return not merging and self.run_git(self.lane, "status", "--porcelain").stdout == ""

    def test_the_lane_resumes_by_itself_once_the_prerequisite_reaches_main(self):
        for scope in ("plan", "phase"):
            with self.subTest(scope=scope):
                if scope == "phase":
                    self.setUp_again()
                self.start_waiting(scope)
                self.assertTrue(guard.wake(str(self.lane), SESSION)[1].startswith(f"WAITING on {PREREQ}"))
                self.stamp_prerequisite_on_main()
                code, text = guard.wake(str(self.lane), SESSION)
                self.assertEqual(code, 0, text)
                self.assertTrue(text.startswith(f"READY {DEPENDENT}"), text)
                self.assertTrue(self.lane_clean(), "the merge concluded and nothing is left over")
                parents = self.run_git(self.lane, "log", "-1", "--format=%P").stdout.split()
                self.assertEqual(len(parents), 2, "main was merged, not fast-forwarded over the lane's work")
                self.assertNotIn("waiting_on", guard.read_guard(str(self.lane)))

    def setUp_again(self):
        """A fresh pair of clones for the second scope."""
        self.doCleanups()
        self.tmp.cleanup()
        self.setUp()

    def test_skipping_the_fetch_the_merge_or_the_conclusion_never_reads_ready_cleanly(self):
        for step in ("_fetch_main", "_merge_main", "_conclude"):
            with self.subTest(step=step):
                self.setUp_again()
                self.start_waiting()
                self.stamp_prerequisite_on_main()
                with mock.patch.object(guard, step, return_value=None):
                    _, text = guard.wake(str(self.lane), SESSION)
                self.assertFalse(text.startswith("READY") and self.lane_clean(), f"{step} skipped: {text}")

    def test_a_fetch_that_fails_leaves_the_run_waiting_and_a_retry_succeeds(self):
        self.start_waiting()
        self.stamp_prerequisite_on_main()
        self.run_git(self.lane, "remote", "set-url", "origin", str(self.root.parent / "no-such-remote.git"))
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("wake: fetch failed", text)
        self.assertTrue(text.startswith("WAITING"), text)
        self.assertTrue(self.lane_clean())
        self.run_git(self.lane, "remote", "set-url", "origin", str(self.remote))
        self.assertTrue(guard.wake(str(self.lane), SESSION)[1].startswith("READY"))

    def test_a_dirty_tree_is_left_untouched_and_a_retry_succeeds(self):
        self.start_waiting()
        self.stamp_prerequisite_on_main()
        (self.lane / "draft.txt").write_text("unsaved work\n", encoding="utf-8")
        head = self.run_git(self.lane, "rev-parse", "HEAD").stdout
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("the working tree has changes", text)
        self.assertEqual((self.lane / "draft.txt").read_text(encoding="utf-8"), "unsaved work\n")
        self.assertEqual(self.run_git(self.lane, "rev-parse", "HEAD").stdout, head, "nothing merged over unsaved work")
        (self.lane / "draft.txt").unlink()
        self.assertTrue(guard.wake(str(self.lane), SESSION)[1].startswith("READY"))

    def test_a_conflict_is_backed_out_and_a_retry_succeeds_once_it_is_gone(self):
        self.start_waiting()
        (self.lane / "notes.txt").write_text("the lane's\n", encoding="utf-8")
        self.commit_lane("lane notes")
        (self.root / "notes.txt").write_text("main's\n", encoding="utf-8")
        self.commit("main notes")
        self.stamp_prerequisite_on_main()
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("merge conflict in notes.txt: backed out", text)
        self.assertTrue(self.lane_clean(), "no merge left open")
        self.assertEqual((self.lane / "notes.txt").read_text(encoding="utf-8"), "the lane's\n")
        (self.root / "notes.txt").write_text("the lane's\n", encoding="utf-8")  # the coordinator resolves it
        self.commit("notes agreed")
        self.run_git(self.root, "push", "-q", "origin", "main")
        self.assertTrue(guard.wake(str(self.lane), SESSION)[1].startswith("READY"))

    def test_a_conclusion_that_fails_is_backed_out_and_a_retry_succeeds_once_main_is_fixed(self):
        self.start_waiting()
        self.stamp_prerequisite_on_main()
        receipt = self.root / "docs/reviews/d00-t01-s1.json"
        good = receipt.read_text(encoding="utf-8")
        data = json.loads(good)
        data["implementation_sha"] = "0" * 40  # main pushed an invalid receipt from a clone without the hooks
        receipt.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        self.run_git(self.root, "add", "-A")
        self.run_git(self.root, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "a broken receipt")
        self.run_git(self.root, "push", "-q", "origin", "main")
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("the merge's conclusion failed and was backed out", text)
        self.assertTrue(self.lane_clean())
        receipt.write_text(good, encoding="utf-8")
        self.run_git(self.root, "add", "-A")
        self.run_git(self.root, "commit", "-qm", "the receipt restored")
        self.run_git(self.root, "push", "-q", "origin", "main")
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 0, text)
        self.assertTrue(text.startswith("READY"), text)


if __name__ == "__main__":
    unittest.main()
