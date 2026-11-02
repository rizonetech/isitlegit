"""Lane merges regenerate the generated plan instead of conflicting on it (D00 T01 §22): the todo-plan merge driver
keeps one side of todo/implementation-plan.md, scripts/hooks/pre-merge-commit stops a merge that changes the plan's
inputs, and the `git commit --no-edit` that concludes it regenerates the plan in scripts/hooks/pre-commit, validating
both parents' genuine stamps (nothing about ancestry is stubbed)."""
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("tg_fixtures", REPO / "tests" / "scripts" / "test_todo_graph.py")
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
tg = fixtures.tg
PLAN = "todo/implementation-plan.md"
ALPHA = "todo/00-workspace/TODO-01-a.md"
BRAVO = "todo/00-workspace/TODO-02-b.md"
# The pre-commit block §22 adds, so a test can stand up a lane branch that predates it.
REGEN = "# A merge being concluded (D00 T01 §22)"


def without_stamp_tests(cls):
    """Run only this file's tests: the Stamp fixture's own tests stay in test_todo_graph.py."""
    for name in [n for n in dir(fixtures.Stamp) if n.startswith("test_")]:
        setattr(cls, name, None)
    return cls


@without_stamp_tests
@unittest.skipUnless(shutil.which("git") and shutil.which("sh"), "needs git and a shell")
class MergePlan(fixtures.Stamp):
    """Like two lanes: `lane` stamps D00 T01 §1 and `main` stamps D00 T02 §1, two files whose rows sit next to each
    other in the generated plan, so both branches change the same plan lines."""

    def setUp(self):
        super().setUp()
        # The fixture's §2 waits on an owner decision; moved to Phase 1, it leaves the two stamped rows adjacent.
        path = self.root / ALPHA
        path.write_text(path.read_text(encoding="utf-8").replace("**Phase:** 0\n**Needs:** owner-decision",
                                                                 "**Phase:** 1\n**Needs:** owner-decision"),
                        encoding="utf-8")
        self.write(fixtures.todo_file([(1, "Bravo", 0, "none", "--")], ident="bravo").replace(
            "**Test checkpoint:**", fixtures.STARTED + "**Test checkpoint:**", 1), name="TODO-02-b.md")
        shutil.copytree(REPO / "scripts", self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        (self.root / ".gitignore").write_text("build/\n__pycache__/\nsamples/\n", encoding="utf-8")
        # Every clone needs a client list to commit (D00 T01 §24); one naming a client nothing here mentions.
        (self.root / "samples").mkdir(exist_ok=True)
        (self.root / "samples/client-names.txt").write_text("Zzyzx Unlisted Client\n", encoding="utf-8")
        tg.projections(self.root, sync=True)
        for args in (["config", "core.hooksPath", "scripts/hooks"], ["config", "commit.gpgsign", "false"]):
            self.git(*args)
        self.git("add", "-A")
        self.git("commit", "-qm", "base with two TODO files and the hooks")
        self.trunk = self.git("branch", "--show-current").stdout.strip()  # git's default branch name varies

    def git(self, *args, check=True):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        return subprocess.run(["git", "-C", str(self.root), *args], capture_output=True, text=True, check=check,
                              env=env, timeout=120)

    def driver(self):
        """The clone's shared setting: the driver in config and the attribute in info/attributes."""
        self.git("config", "merge.todo-plan.driver", "true")
        info = self.root / ".git" / "info"
        info.mkdir(exist_ok=True)
        (info / "attributes").write_text("todo/implementation-plan.md merge=todo-plan\n", encoding="utf-8")

    def stamp_section(self, todo, ref, report, pin=None):
        """Tick the section's work item and stamp it with a clean round and its own plan and completion reviews, those
        reviews recording `pin` (a reviewer-pin blob id) when given."""
        path = self.root / todo
        path.write_text(path.read_text(encoding="utf-8").replace("- [ ] Work.", "- [x] Work.", 1), encoding="utf-8")
        target = self.root / report
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("# Review findings\n\n" + fixtures.envelope(1), encoding="utf-8")
            self.write_plan(path=report)
        if pin:
            self.write_plan(path=report, pin=pin)
        completion = report.replace(".md", "-completion.md")
        self.write_completion(path=completion, pin=pin)
        tg.projections(self.root, sync=True)  # the ticked item changes the plan; the real pre-commit holds it current
        sha = self.commit(f"work for {ref}")
        tg.stamp(self.root, ref, sha, [{"round": 1, "report": report, "verdict": "clean"}], ["true -> ok"],
                 "2026-10-30", sync_plan=True, completion={"report": completion, "verdict": "complete"}, plan=report)
        self.git("add", "-A")
        self.git("commit", "-qm", f"todo: stamp {ref}")

    def stamp_alpha(self):
        self.stamp_section(ALPHA, "D00 T01 §1", "docs/reviews/00-workspace/D00-T01-s1.md")

    def stamp_bravo(self):
        self.stamp_section(BRAVO, "D00 T02 §1", "docs/reviews/00-workspace/D00-T02-s1.md")

    def diverge(self):
        """Branch `lane` stamps D00 T01 §1 and `main` stamps D00 T02 §1, from the same base."""
        self.git("checkout", "-qb", "lane")
        self.stamp_alpha()
        self.git("checkout", "-q", self.trunk)
        self.stamp_bravo()

    def plan_is_current(self):
        return self.git("show", f"HEAD:{PLAN}").stdout == tg.projection(self.root)

    def concluded(self):
        done = self.git("commit", "--no-edit", check=False)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(len(self.git("log", "-1", "--format=%P").stdout.split()), 2, "a two-parent merge")
        self.assertTrue(self.plan_is_current())
        self.assertEqual(self.git("status", "--porcelain").stdout, "")

    def test_without_the_driver_the_plan_conflicts(self):
        self.diverge()
        done = self.git("merge", "--no-edit", "lane", check=False)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn(f"CONFLICT (content): Merge conflict in {PLAN}", done.stdout)
        self.assertNotIn("Merge conflict in todo/00-workspace", done.stdout, "only the plan, as between real lanes")

    def test_a_stamped_merge_stops_without_a_conflict_and_concludes_with_a_current_plan(self):
        self.driver()
        self.diverge()
        done = self.git("merge", "--no-edit", "lane", check=False)
        self.assertNotEqual(done.returncode, 0, "the merge stops before committing")
        self.assertNotIn("CONFLICT", done.stdout + done.stderr)
        self.assertIn("run 'git commit --no-edit' to validate it and regenerate the plan", done.stderr)
        self.concluded()
        rows = tg.graph(self.root)
        self.assertTrue(rows["D00 T01 §1"].done and rows["D00 T02 §1"].done, "both parents' stamps hold")

    def test_a_merge_with_another_conflict_also_concludes_with_a_current_plan(self):
        self.driver()
        (self.root / "notes.txt").write_text("base\n", encoding="utf-8")
        self.commit("notes")
        self.git("checkout", "-qb", "lane")
        self.stamp_alpha()
        (self.root / "notes.txt").write_text("lane\n", encoding="utf-8")
        self.commit("lane notes")
        self.git("checkout", "-q", self.trunk)
        self.stamp_bravo()
        (self.root / "notes.txt").write_text("main\n", encoding="utf-8")
        self.commit("main notes")
        done = self.git("merge", "--no-edit", "lane", check=False)
        self.assertIn("CONFLICT (content): Merge conflict in notes.txt", done.stdout)
        self.assertNotIn(f"Merge conflict in {PLAN}", done.stdout)
        (self.root / "notes.txt").write_text("both\n", encoding="utf-8")
        self.git("add", "notes.txt")
        self.concluded()

    def test_a_resolved_conflict_in_a_todo_file_concludes_with_a_current_plan(self):
        self.driver()
        path = self.root / BRAVO
        self.git("checkout", "-qb", "lane")
        self.stamp_alpha()
        path.write_text(path.read_text(encoding="utf-8").replace("> **Current state:** c.", "> **Current state:** lane."),
                        encoding="utf-8")
        self.commit("lane's current state")
        self.git("checkout", "-q", self.trunk)
        path.write_text(path.read_text(encoding="utf-8").replace("> **Current state:** c.", "> **Current state:** main."),
                        encoding="utf-8")
        self.commit("main's current state")
        self.stamp_bravo()
        done = self.git("merge", "--no-edit", "lane", check=False)
        self.assertIn(f"CONFLICT (content): Merge conflict in {BRAVO}", done.stdout)
        self.assertNotIn(f"Merge conflict in {PLAN}", done.stdout)
        text = path.read_text(encoding="utf-8")
        start, end = text.index("<<<<<<<"), text.index(">>>>>>>")
        path.write_text(text[:start] + "> **Current state:** both.\n" + text[text.index("\n", end) + 1:],
                        encoding="utf-8")
        self.git("add", BRAVO)
        self.concluded()
        rows = tg.graph(self.root)
        self.assertTrue(rows["D00 T01 §1"].done and rows["D00 T02 §1"].done)

    def test_a_receipt_using_a_pin_committed_only_on_the_incoming_side_concludes(self):
        self.driver()
        self.git("checkout", "-qb", "lane")
        lane_pin = fixtures.UNIFORM_PIN + "# the lane's own pin\n"
        (self.root / tg.PIN).write_text(lane_pin, encoding="utf-8")
        self.commit("the lane's pin")
        self.stamp_section(ALPHA, "D00 T01 §1", "docs/reviews/00-workspace/D00-T01-s1.md",
                           pin=tg.review_dispatch().pin_blob(lane_pin.encode("utf-8")))
        self.git("checkout", "-q", self.trunk)
        (self.root / tg.PIN).write_text(fixtures.UNIFORM_PIN, encoding="utf-8")
        self.stamp_bravo()
        self.git("merge", "--no-edit", "lane", check=False)
        tg._COMMITTED_PINS.clear()
        self.concluded()

    def test_a_stopped_merge_aborts_to_the_commit_it_started_from(self):
        self.driver()
        self.diverge()
        head, plan = self.head(), (self.root / PLAN).read_text(encoding="utf-8")
        self.git("merge", "--no-edit", "lane", check=False)
        self.git("merge", "--abort")
        self.assertEqual(self.head(), head)
        self.assertEqual(self.git("status", "--porcelain").stdout, "")
        self.assertEqual((self.root / PLAN).read_text(encoding="utf-8"), plan)
        self.assertFalse(self.git("rev-parse", "-q", "--verify", "MERGE_HEAD", check=False).stdout.strip())

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores the folder's write bit")
    def test_a_plan_write_that_fails_refuses_the_merge_commit_until_it_can_write(self):
        self.driver()
        self.diverge()
        head = self.head()
        self.git("merge", "--no-edit", "lane", check=False)
        folder = self.root / "todo"
        mode = folder.stat().st_mode
        folder.chmod(0o555)  # plan --sync writes a temporary file beside the plan, then replaces it
        try:
            refused = self.git("commit", "--no-edit", check=False)
        finally:
            folder.chmod(mode)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("plan --sync failed over the merged tree", refused.stderr)
        self.assertEqual(self.head(), head, "no merge commit")
        self.concluded()

    def test_a_merge_outside_the_plans_inputs_commits_by_itself(self):
        self.driver()
        self.git("checkout", "-qb", "lane")
        (self.root / "lane.txt").write_text("lane\n", encoding="utf-8")
        self.commit("lane file")
        self.git("checkout", "-q", self.trunk)
        (self.root / "main.txt").write_text("main\n", encoding="utf-8")
        self.commit("main file")
        done = self.git("merge", "--no-edit", "lane", check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.git("log", "-1", "--format=%P").stdout.split()), 2)

    def test_an_unstaged_todo_edit_refuses_the_merge_commit_until_it_is_stashed(self):
        self.driver()
        self.diverge()
        self.git("merge", "--no-edit", "lane", check=False)
        index_before = self.git("diff", "--cached").stdout
        path = self.root / BRAVO
        path.write_text(path.read_text(encoding="utf-8") + "\nAn unrelated draft line.\n", encoding="utf-8")
        refused = self.git("commit", "--no-edit", check=False)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("todo/ has unstaged or untracked changes", refused.stderr)
        self.assertEqual(self.git("diff", "--cached").stdout, index_before, "the index and its staged plan unchanged")
        self.git("stash", "push", "-q", "-m", "merge-plan-test", "--", BRAVO)
        self.concluded()

    def test_an_evidence_only_merge_that_breaks_the_graph_is_refused(self):
        self.driver()
        self.stamp_alpha()
        self.git("checkout", "-qb", "evidence")
        receipt = self.root / "docs/reviews/d00-t01-s1.json"
        data = json.loads(receipt.read_text(encoding="utf-8"))
        data["implementation_sha"] = "0" * 40  # no longer the commit the Verified line names
        receipt.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        self.git("add", "-A")
        # A commit from a clone without these hooks: the merge must refuse what such a clone could push.
        self.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "a tampered receipt")
        self.git("checkout", "-q", self.trunk)
        (self.root / "main.txt").write_text("main\n", encoding="utf-8")
        self.commit("main file")
        head = self.head()
        stopped = self.git("merge", "--no-edit", "evidence", check=False)
        self.assertIn("run 'git commit --no-edit' to validate it", stopped.stderr)
        refused = self.git("commit", "--no-edit", check=False)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("plan --sync failed over the merged tree", refused.stderr)
        self.assertIn("TODO refused:", refused.stderr, "the validator's own reason is shown")
        self.assertEqual(self.head(), head, "no merge commit")

    def test_a_lane_that_predates_the_change_bootstraps_with_no_commit(self):
        # The base predates §22: no pre-merge-commit hook and a pre-commit without the regeneration block.
        hook = self.root / "scripts/hooks/pre-commit"
        new_hook = hook.read_text(encoding="utf-8")
        start = new_hook.index(REGEN)
        end = new_hook.index("\nfi\n", new_hook.index("git add -- todo/implementation-plan.md", start)) + len("\nfi\n")
        hook.write_text(new_hook[:start] + new_hook[end:], encoding="utf-8")
        merge_hook = self.root / "scripts/hooks/pre-merge-commit"
        new_merge_hook = merge_hook.read_text(encoding="utf-8")
        merge_hook.unlink()
        self.commit("the hooks before §22")
        self.git("checkout", "-qb", "lane")
        self.stamp_alpha()
        self.git("checkout", "-q", self.trunk)
        hook.write_text(new_hook, encoding="utf-8")
        merge_hook.write_text(new_merge_hook, encoding="utf-8")
        merge_hook.chmod(0o755)
        self.commit("§22 lands on main")
        self.stamp_bravo()
        self.driver()  # the shared setting, already in place before the lane merges
        self.git("checkout", "-q", "lane")
        done = self.git("merge", "--no-commit", "--no-edit", self.trunk, check=False)
        self.assertNotIn("CONFLICT", done.stdout + done.stderr)
        self.concluded()
        self.assertTrue((self.root / "scripts/hooks/pre-merge-commit").exists(), "the lane now has the new hook")

    def wrapper(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        return subprocess.run(["sh", "scripts/merge-lane.sh", *args], cwd=self.root, capture_output=True, text=True,
                              env=env, timeout=120)

    def test_merge_lane_concludes_a_stamped_merge_in_one_call(self):
        self.driver()
        self.diverge()
        done = self.wrapper("lane")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(len(self.git("log", "-1", "--format=%P").stdout.split()), 2, "a two-parent merge")
        self.assertTrue(self.plan_is_current())
        self.assertEqual(self.git("status", "--porcelain").stdout, "")

    def test_merge_lane_leaves_a_conflict_open_with_its_message(self):
        self.diverge()
        done = self.wrapper("lane")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn(f"CONFLICT (content): Merge conflict in {PLAN}", done.stdout)
        self.assertTrue((self.root / ".git" / "MERGE_HEAD").exists(), "the merge stays open")
        self.assertIn(PLAN, self.git("diff", "--name-only", "--diff-filter=U").stdout)

    def test_merge_lane_refuses_a_merge_already_in_progress(self):
        self.driver()
        self.diverge()
        self.git("merge", "--no-edit", "lane", check=False)  # stops at the plan stop, merge open
        head = self.git("rev-parse", "HEAD").stdout
        done = self.wrapper("lane")
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("already in progress", done.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout, head, "the open merge is untouched")
        self.assertTrue((self.root / ".git" / "MERGE_HEAD").exists())

    def test_merge_lane_clean_merge_and_up_to_date(self):
        (self.root / "notes.txt").write_text("base\n", encoding="utf-8")
        self.commit("notes")
        self.git("checkout", "-qb", "lane")
        (self.root / "notes.txt").write_text("lane\n", encoding="utf-8")
        lane_tip = self.commit("lane notes")
        self.git("checkout", "-q", self.trunk)
        done = self.wrapper("lane")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual((self.root / "notes.txt").read_text(encoding="utf-8"), "lane\n")
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), lane_tip, "a fast-forward, no extra commit")
        head = self.git("rev-parse", "HEAD").stdout
        again = self.wrapper("lane")
        self.assertEqual(again.returncode, 0)
        self.assertIn("Already up to date", again.stdout)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout, head, "up to date changes nothing")

    def test_merge_lane_clean_divergent_merge(self):
        self.git("checkout", "-qb", "lane")
        (self.root / "lane.txt").write_text("lane\n", encoding="utf-8")
        self.commit("lane file")
        self.git("checkout", "-q", self.trunk)
        (self.root / "main.txt").write_text("main\n", encoding="utf-8")
        self.commit("main file")
        done = self.wrapper("lane")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(len(self.git("log", "-1", "--format=%P").stdout.split()), 2, "a two-parent merge")
        self.assertEqual((self.root / "lane.txt").read_text(encoding="utf-8"), "lane\n")
        self.assertEqual((self.root / "main.txt").read_text(encoding="utf-8"), "main\n")

    def test_merge_lane_passes_a_precommit_refusal_through(self):
        # The concluding commit is where pre-commit runs: a client name in the merged tree refuses it there.
        self.driver()
        self.git("checkout", "-qb", "lane")
        self.stamp_alpha()
        (self.root / "bad.txt").write_text("Zzyzx Unlisted Client\n", encoding="utf-8")
        self.git("add", "bad.txt")
        self.git("commit", "-qm", "lane bad", "--no-verify")
        self.git("checkout", "-q", self.trunk)
        self.stamp_bravo()
        head = self.git("rev-parse", "HEAD").stdout
        done = self.wrapper("lane")
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("client name", done.stdout + done.stderr)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout, head)
        self.assertTrue((self.root / ".git" / "MERGE_HEAD").exists(), "the refused merge stays open")

    def test_merge_lane_argument_contract(self):
        self.assertNotEqual(self.wrapper().returncode, 0)
        self.assertNotEqual(self.wrapper("--abort").returncode, 0)
        self.assertNotEqual(self.wrapper("lane", "extra").returncode, 0)
        self.assertFalse((self.root / ".git" / "MERGE_HEAD").exists(), "nothing merged")

    def test_merge_lane_runs_as_the_executable_itself(self):
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        script = self.root / "scripts" / "merge-lane.sh"
        self.assertTrue(os.access(script, os.X_OK), "the script is executable")
        done = subprocess.run([str(script)], cwd=self.root, capture_output=True, text=True, env=env, timeout=120)
        self.assertNotEqual(done.returncode, 0, "no ref refuses, through the executable entry point")
        self.assertIn("usage", done.stderr)


@without_stamp_tests
class PinsOverMergeHead(fixtures.Stamp):
    """committed_pins reads MERGE_HEAD's history too while a merge is open, as _tips does for stamps."""

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], capture_output=True, text=True, check=False)

    def test_a_pin_committed_only_on_the_incoming_parent_counts_while_the_merge_is_open(self):
        self.git("checkout", "-qb", "lane")
        (self.root / tg.PIN).write_text(fixtures.UNIFORM_PIN + "# the lane's pin\n", encoding="utf-8")
        self.commit("lane pin")
        blob = self.git("rev-parse", f"HEAD:{tg.PIN}").stdout.strip()
        self.git("checkout", "-q", "-")
        tg._COMMITTED_PINS.clear()
        self.assertNotIn(blob, tg.committed_pins(self.root))
        self.git("merge", "--no-commit", "--no-ff", "lane")
        tg._COMMITTED_PINS.clear()
        self.assertIn(blob, tg.committed_pins(self.root))
        self.git("merge", "--abort")
        (self.root / tg.PIN).write_text(fixtures.UNIFORM_PIN + "# staged only\n", encoding="utf-8")
        self.git("add", tg.PIN)
        staged = self.git("rev-parse", f":{tg.PIN}").stdout.strip()
        tg._COMMITTED_PINS.clear()
        self.assertNotIn(staged, tg.committed_pins(self.root))


if __name__ == "__main__":
    unittest.main()
