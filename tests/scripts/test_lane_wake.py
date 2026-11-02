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
        self.assertIn("the merge's conclusion failed", text)
        self.assertIn(": backed out", text)
        self.assertTrue(self.lane_clean())
        receipt.write_text(good, encoding="utf-8")
        self.run_git(self.root, "add", "-A")
        self.run_git(self.root, "commit", "-qm", "the receipt restored")
        self.run_git(self.root, "push", "-q", "origin", "main")
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 0, text)
        self.assertTrue(text.startswith("READY"), text)


    # Completion review of §20 (docs/reviews/00-workspace/D00-T01-s20.md).
    def test_heartbeat_bookkeeping_in_the_run_file_never_blocks_the_merge(self):
        self.start_waiting()
        for beat in (1, 2):  # two ordinary waiting heartbeats, each writing its line and committing nothing
            self.assertTrue(guard.wake(str(self.lane), SESSION)[1].startswith("WAITING"))
            with open(self.lane / RUN_FILE, "a", encoding="utf-8") as fh:
                fh.write(f"- bookkeeping: waiting 2026-10-30T19:0{beat}Z\n")
        self.stamp_prerequisite_on_main()
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 0, text)
        self.assertTrue(text.startswith(f"READY {DEPENDENT}"), text)
        self.assertIn("bookkeeping: waiting 2026-10-30T19:02Z", (self.lane / RUN_FILE).read_text(encoding="utf-8"))

    def test_a_worktree_on_another_lanes_branch_is_left_untouched(self):
        self.start_waiting()
        self.stamp_prerequisite_on_main()
        self.run_git(self.lane, "checkout", "-qb", "something-else")  # a branch no lane works: the main lane's
        head = self.run_git(self.lane, "rev-parse", "HEAD").stdout
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("LANE MISMATCH guard=checks branch=something-else", text)
        self.assertEqual(self.run_git(self.lane, "rev-parse", "HEAD").stdout, head)
        self.assertTrue(self.lane_clean())
        self.assertNotEqual(self.run_git(self.lane, "rev-parse", "origin/main").stdout,
                            self.run_git(self.root, "rev-parse", "main").stdout, "not even fetched")

    def test_an_abort_that_fails_is_reported_open_and_the_next_wake_recovers(self):
        self.start_waiting()
        (self.lane / "notes.txt").write_text("the lane's\n", encoding="utf-8")
        self.commit_lane("lane notes")
        (self.root / "notes.txt").write_text("main's\n", encoding="utf-8")
        self.commit("main notes")
        self.stamp_prerequisite_on_main()
        real = guard._run_git

        def abort_fails(root, *args, **kw):
            if args[:2] == ("merge", "--abort"):
                return subprocess.CompletedProcess(args, 128, "", "fatal: Unable to create index.lock")
            return real(root, *args, **kw)
        with mock.patch.object(guard, "_run_git", abort_fails):
            code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("the merge is STILL OPEN", text)
        self.assertNotIn(": backed out", text, "a failed abort is never reported as backed out")
        code, text = guard.wake(str(self.lane), SESSION)  # the lock is gone: the leftover merge is backed out first
        self.assertIn("an earlier merge left open was backed out", text)
        self.assertIn("merge conflict in notes.txt", text)
        self.assertTrue(self.lane_clean())

    def test_a_leftover_merge_with_an_unreadable_graph_is_backed_out_before_the_lane_check(self):
        self.start_waiting()
        shared = "todo/00-workspace/TODO-01-a.md"
        for clone, text in ((self.lane, "the lane's"), (self.root, "main's")):
            path = clone / shared
            path.write_text(path.read_text(encoding="utf-8").replace("> **Current state:** c.",
                                                                     f"> **Current state:** {text}."), encoding="utf-8")
        self.commit_lane("the lane's note in the coordinator's file")
        tg.projections(self.root, sync=True)
        self.commit("main's note")
        self.stamp_prerequisite_on_main()
        real = guard._run_git

        def abort_fails(root, *args, **kw):
            if args[:2] == ("merge", "--abort"):
                return subprocess.CompletedProcess(args, 128, "", "fatal: Unable to create index.lock")
            return real(root, *args, **kw)
        with mock.patch.object(guard, "_run_git", abort_fails):  # wake's own merge, left on its conflict
            guard.wake(str(self.lane), SESSION)
        self.assertIn(shared, self.run_git(self.lane, "diff", "--name-only", "--diff-filter=U").stdout)
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertIn("an earlier merge left open was backed out", text)
        self.assertNotIn("ROWS UNKNOWN", text, "the lane check ran on the restored tree, not the conflicted graph")
        self.assertIn(f"merge conflict in {shared}", text, "then the merge is tried again and backed out again")
        self.assertTrue(self.lane_clean())

    def test_a_merge_someone_else_began_is_never_backed_out(self):
        self.start_waiting()
        (self.lane / "notes.txt").write_text("the lane's\n", encoding="utf-8")
        self.commit_lane("lane notes")
        (self.root / "notes.txt").write_text("main's\n", encoding="utf-8")
        self.commit("main notes")
        self.stamp_prerequisite_on_main()
        self.run_git(self.lane, "fetch", "-q", "origin")
        self.run_git(self.lane, "merge", "--no-edit", "origin/main", check=False)  # the operator's own merge
        (self.lane / "notes.txt").write_text("resolved by hand\n", encoding="utf-8")
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("a merge this run did not begin is open; it is left as it is", text)
        self.assertEqual((self.lane / "notes.txt").read_text(encoding="utf-8"), "resolved by hand\n")
        self.assertEqual(self.run_git(self.lane, "rev-parse", "-q", "--verify", "MERGE_HEAD",
                                      check=False).returncode, 0, "the merge is still open")

    def test_a_merge_on_another_branch_is_never_touched(self):
        self.start_waiting()
        self.stamp_prerequisite_on_main()
        self.run_git(self.lane, "checkout", "-qb", "elsewhere")
        (self.lane / "notes.txt").write_text("elsewhere\n", encoding="utf-8")
        self.run_git(self.lane, "commit", "-qam", "elsewhere", check=False)
        self.run_git(self.lane, "fetch", "-q", "origin")
        self.run_git(self.lane, "merge", "--no-commit", "--no-ff", "origin/main", check=False)
        merging = self.run_git(self.lane, "rev-parse", "-q", "--verify", "MERGE_HEAD", check=False).returncode == 0
        code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("LANE MISMATCH guard=checks branch=elsewhere", text)
        self.assertIn("nothing fetched, merged or backed out", text)
        self.assertEqual(self.run_git(self.lane, "rev-parse", "-q", "--verify", "MERGE_HEAD",
                                      check=False).returncode == 0, merging, "the merge there is untouched")

    def test_a_merge_that_times_out_is_backed_out(self):
        self.start_waiting()
        self.stamp_prerequisite_on_main()
        real = guard._run_git

        def slow_merge(root, *args, **kw):
            if args[:1] == ("merge",) and "--abort" not in args:
                real(root, *args, **kw)  # the merge lands in the tree, then the wait for it runs out
                raise subprocess.TimeoutExpired(["git", *args], 600)
            return real(root, *args, **kw)
        with mock.patch.object(guard, "_run_git", slow_merge):
            code, text = guard.wake(str(self.lane), SESSION)
        self.assertEqual(code, 1)
        self.assertIn("the merge did not finish", text)
        self.assertTrue(self.lane_clean(), "nothing left open after the timeout")
        self.assertTrue(guard.wake(str(self.lane), SESSION)[1].startswith("READY"))

    # D00 T01 \u00a727: which waiting lanes a push of main wakes, and the message to send each.

    def lane_wake(self, *args, root=None):
        return subprocess.run([guard.sys.executable, "-B", str(REPO / "scripts/lane_wake.py"), *args, "--root",
                               str(root or self.root)], capture_output=True, text=True, env=clean_env(), timeout=120)

    def write_lanes(self, **lanes):
        """The main clone's todo/lanes.json: the checks lane (the real lane clone) and any more as plain directories."""
        config = {"checks": {"branch": "checks-lane", "worktree": f"../{self.lane.name}", "domains": ["D01"]}}
        for name, directory in lanes.items():
            config[name] = {"branch": f"{name}-lane", "worktree": f"../{directory}", "domains": ["D07"]}
        (self.root / "todo/lanes.json").write_text(json.dumps({"lanes": config}), encoding="utf-8")

    def other_lane(self, name, waiting_on, session="99999999-0000-0000-0000-000000000000"):
        directory = self.root.parent / f"{self.root.name}-{name}"
        (directory / "build").mkdir(parents=True)
        (directory / "build/claude-campaign-guard.json").write_text(
            json.dumps({"session_id": session, "waiting_on": waiting_on, "lane": name}), encoding="utf-8")
        self.addCleanup(shutil.rmtree, directory, True)
        return directory.name

    def head(self):
        return self.run_git(self.root, "rev-parse", "HEAD").stdout.strip()

    def test_a_push_wakes_only_the_lane_waiting_on_a_section_it_stamped(self):
        self.start_waiting()
        other = self.other_lane("app", ["D07 T01 \u00a71"])
        old = self.head()
        self.stamp_prerequisite_on_main()
        self.write_lanes(app=other)  # after the stamp: the graph checks each lane's domains against todo/ folders
        guards = {d: (d / "build/claude-campaign-guard.json").read_bytes() for d in (self.lane, self.root.parent / other)}
        result = self.lane_wake("waiters", old, self.head())
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual([r["lane"] for r in out["wake"]], ["checks"])
        (record,) = out["wake"]
        self.assertEqual((record["refs"], record["session_id"]), ([PREREQ], SESSION))
        self.assertEqual(out["skipped"], [])
        for directory, before in guards.items():
            self.assertEqual((directory / "build/claude-campaign-guard.json").read_bytes(), before,
                             "discovery changed a lane's guard")

    def test_a_section_already_stamped_before_the_push_wakes_nobody(self):
        self.start_waiting()
        self.stamp_prerequisite_on_main()
        self.write_lanes()
        new = self.head()
        self.assertEqual(json.loads(self.lane_wake("waiters", new, new).stdout)["wake"], [])

    def test_one_record_names_every_waited_section_the_push_stamps(self):
        module = importlib.util.spec_from_file_location("lane_wake_unit", REPO / "scripts/lane_wake.py")
        lane_wake = importlib.util.module_from_spec(module)
        module.loader.exec_module(lane_wake)
        waiting = ["D00 T01 \u00a71", "D00 T01 \u00a72", "D00 T01 \u00a73", "D09 T01 \u00a71"]
        self.assertEqual(lane_wake.newly_stamped(waiting, {"D00 T01 \u00a71"}, {"D00 T01 \u00a71", "D00 T01 \u00a72", "D00 T01 \u00a73"}),
                         ["D00 T01 \u00a72", "D00 T01 \u00a73"])

    def test_an_absent_worktree_an_absent_guard_and_a_malformed_guard_are_skipped_and_the_rest_still_wake(self):
        self.start_waiting()
        gone = "no-such-worktree"
        no_guard = self.root.parent / f"{self.root.name}-quiet"
        no_guard.mkdir()
        self.addCleanup(shutil.rmtree, no_guard, True)
        broken = self.other_lane("app", ["D07 T01 \u00a71"])
        (self.root.parent / broken / "build/claude-campaign-guard.json").write_text("{", encoding="utf-8")
        old = self.head()
        self.stamp_prerequisite_on_main()
        self.write_lanes(ghost=gone, quiet=no_guard.name, app=broken)
        out = json.loads(self.lane_wake("waiters", old, self.head()).stdout)
        self.assertEqual([r["lane"] for r in out["wake"]], ["checks"])
        reasons = {s["lane"]: s["reason"] for s in out["skipped"]}
        self.assertIn("is absent", reasons["ghost"])
        self.assertIn("no guard", reasons["quiet"])
        self.assertIn("unreadable", reasons["app"])
        # Repaired, the same push now also wakes that lane.
        (self.root.parent / broken / "build/claude-campaign-guard.json").write_text(
            json.dumps({"session_id": "s2", "waiting_on": [PREREQ]}), encoding="utf-8")
        again = json.loads(self.lane_wake("waiters", old, self.head()).stdout)
        self.assertEqual(sorted(r["lane"] for r in again["wake"]), ["app", "checks"])

    def test_an_input_that_is_not_a_commit_is_refused_with_a_diagnostic(self):
        self.write_lanes()
        result = self.lane_wake("waiters", "f" * 40, self.head())
        self.assertEqual(result.returncode, 2)
        self.assertIn("lane_wake: not a commit: " + "f" * 40, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_the_message_works_as_received_through_merge_ready_and_the_cleared_wait(self):
        import re
        self.start_waiting()
        old = self.head()
        self.stamp_prerequisite_on_main()
        self.write_lanes()
        (record,) = json.loads(self.lane_wake("waiters", old, self.head()).stdout)["wake"]
        found = re.search(r"`(python3 scripts/campaign_guard\.py wake --session (\S+))`", record["text"])
        self.assertIsNotNone(found, record["text"])
        self.assertEqual(found[2], SESSION)
        self.assertIn("steps 7 and 8", record["text"])
        # A failure that comes with WAITING is not to be ignored: the message sends the lane to the heartbeat's own handling.
        self.assertIn("step 4a of the heartbeat", record["text"])
        self.assertIn("`wake:` failure line", record["text"])
        self.assertNotIn("do nothing more;", record["text"].replace("on a plain WAITING do nothing more;", ""))
        ran = subprocess.run([guard.sys.executable, "-B", *found[1].split()[1:]], cwd=str(self.lane), capture_output=True,
                             text=True, env=clean_env(), timeout=300)
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        self.assertTrue(ran.stdout.startswith(f"READY {DEPENDENT}"), ran.stdout)
        self.assertTrue(self.lane_clean())
        self.assertNotIn("waiting_on", guard.read_guard(str(self.lane)))

    def test_the_message_after_the_run_has_ended_is_harmless(self):
        self.start_waiting()
        old = self.head()
        self.stamp_prerequisite_on_main()
        self.write_lanes()
        (record,) = json.loads(self.lane_wake("waiters", old, self.head()).stdout)["wake"]
        guard.end(str(self.lane), SESSION, "operator-stop")
        before = self.run_git(self.lane, "rev-parse", "HEAD").stdout
        ran = subprocess.run([guard.sys.executable, "-B", "scripts/campaign_guard.py", "wake", "--session", SESSION],
                             cwd=str(self.lane), capture_output=True, text=True, env=clean_env(), timeout=300)
        self.assertEqual(ran.returncode, 1)
        self.assertIn("NO GUARD", ran.stdout + ran.stderr)
        self.assertEqual(self.run_git(self.lane, "rev-parse", "HEAD").stdout, before, "an ended run merged main anyway")

    def test_the_coordinator_procedure_names_the_command_and_the_send(self):
        text = (REPO / "docs/coordinator.md").read_text(encoding="utf-8")
        self.assertIn("lane_wake.py waiters <old> <new>", text)
        self.assertIn("`SendMessage`", text)
        self.assertIn("was not notified", text)


@unittest.skipUnless(shutil.which("git"), "needs git")
class PushMain(unittest.TestCase):
    """D00 T01 §32: the coordinator pushes through scripts/push_main.py, and the wake selection runs from the push."""

    def setUp(self):
        import tempfile

        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="push-main-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / "main"
        self.root.mkdir()
        self.git(self.root, "init", "-q", "-b", "main")
        self.git(self.root, "config", "user.email", "test@example.com")
        self.git(self.root, "config", "user.name", "Test")
        shutil.copytree(REPO / "scripts", self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        (self.root / "todo").mkdir()
        (self.root / "todo" / "lanes.json").write_text(
            json.dumps({"lanes": {"checks": {"branch": "checks-lane", "worktree": "../lane", "domains": ["D01"]}}}),
            encoding="utf-8",
        )
        self.plan("base")
        self.git(self.root, "add", "-A")
        self.git(self.root, "commit", "-qm", "base")
        self.remote = self.tmp / "remote.git"
        self.git(self.tmp, "clone", "-q", "--bare", str(self.root), str(self.remote))
        self.git(self.root, "remote", "add", "origin", str(self.remote))
        self.git(self.root, "fetch", "-q", "origin")

    def git(self, cwd, *args):
        ran = subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, env=clean_env())
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        return ran

    def plan(self, text):
        (self.root / "todo" / "implementation-plan.md").write_text(f"# plan\n{text}\n", encoding="utf-8")

    def wrapper(self):
        return subprocess.run(
            ["python3", "scripts/push_main.py", "--root", str(self.root)],
            cwd=str(self.root),
            capture_output=True,
            text=True,
            env=clean_env(),
        )

    def test_push_through_the_wrapper_moves_the_remote_and_prints_the_selection(self):
        self.plan("stamped")
        self.git(self.root, "add", "-A")
        self.git(self.root, "commit", "-qm", "stamp")
        ran = self.wrapper()
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        out = json.loads(ran.stdout)
        self.assertEqual(out["wake"], [])
        self.assertEqual([s["lane"] for s in out["skipped"]], ["checks"])
        moved = self.git(self.root, "ls-remote", "origin", "main").stdout.split()[0]
        self.assertEqual(moved, self.git(self.root, "rev-parse", "main").stdout.strip())
        # Nothing new to publish: an empty selection, still exit 0.
        again = self.wrapper()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(json.loads(again.stdout), {"wake": [], "skipped": []})

    def test_a_waiting_lane_is_woken_from_the_refreshed_baseline(self):
        # Another clone publishes a stamp the lane also waits on; this clone's tracking ref is left stale.
        other = self.tmp / "other"
        self.git(self.tmp, "clone", "-q", str(self.remote), str(other))
        self.git(other, "config", "user.email", "test@example.com")
        self.git(other, "config", "user.name", "Test")
        (other / "todo" / "implementation-plan.md").write_text("# plan\n| [x] | D02 T01 §1 |\n", encoding="utf-8")
        self.git(other, "add", "-A")
        self.git(other, "commit", "-qm", "stamp D02")
        self.git(other, "push", "-q", "origin", "main")
        self.git(self.root, "fetch", "-q", "origin")
        self.git(self.root, "reset", "-q", "--hard", "origin/main")
        (self.root / "todo" / "implementation-plan.md").write_text(
            "# plan\n| [x] | D02 T01 §1 |\n| [x] | D01 T01 §1 |\n", encoding="utf-8"
        )
        self.git(self.root, "add", "-A")
        self.git(self.root, "commit", "-qm", "stamp D01")
        self.git(self.root, "update-ref", "refs/remotes/origin/main", self.git(other, "rev-parse", "HEAD~1").stdout.strip())
        lane = self.tmp / "lane"
        (lane / "build").mkdir(parents=True)
        (lane / "build" / "claude-campaign-guard.json").write_text(
            json.dumps({"session_id": SESSION, "waiting_on": ["D01 T01 §1", "D02 T01 §1"]}), encoding="utf-8"
        )
        ran = self.wrapper()
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        (record,) = json.loads(ran.stdout)["wake"]
        self.assertEqual(record["lane"], "checks")
        # Only this push's stamp is selected: D02 was already published at the refreshed baseline.
        self.assertEqual(record["refs"], ["D01 T01 §1"])
        self.assertIn(SESSION, record["text"])

    def test_a_rejected_push_and_a_failing_selection(self):
        other = self.tmp / "other"
        self.git(self.tmp, "clone", "-q", str(self.remote), str(other))
        self.git(other, "config", "user.email", "test@example.com")
        self.git(other, "config", "user.name", "Test")
        (other / "todo" / "implementation-plan.md").write_text("# plan\nahead\n", encoding="utf-8")
        self.git(other, "add", "-A")
        self.git(other, "commit", "-qm", "ahead")
        self.git(other, "push", "-q", "origin", "main")
        self.plan("diverged")
        self.git(self.root, "add", "-A")
        self.git(self.root, "commit", "-qm", "diverged")
        refused = self.wrapper()
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("push refused", refused.stderr)
        self.assertEqual(refused.stdout, "", "a refused push ran the selection")
        # Rebase onto the published main, drop the plan the selection reads, and push: publication
        # succeeds, the selection cannot, and the wrapper says so with both SHAs.
        self.git(self.root, "reset", "-q", "--hard", "origin/main")
        (self.root / "todo" / "implementation-plan.md").unlink()
        self.git(self.root, "add", "-A")
        self.git(self.root, "commit", "-qm", "no plan")
        old = self.git(self.root, "rev-parse", "HEAD~1").stdout.strip()
        new = self.git(self.root, "rev-parse", "HEAD").stdout.strip()
        failed = self.wrapper()
        self.assertEqual(failed.returncode, 3, failed.stdout + failed.stderr)
        self.assertIn("wake selection failed", failed.stderr)
        self.assertIn(f"{old}..{new}", failed.stderr)
        self.assertIn("implementation-plan.md is not at", failed.stderr)


if __name__ == "__main__":
    unittest.main()
