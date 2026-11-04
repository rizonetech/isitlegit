"""The launcher cannot start a lane on stale policy, wrong branch or another run."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("codex_lanes", ROOT / "scripts/codex-lanes.py")


class CodexLanes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "main"
        self.lane = Path(self.temp.name) / "checks"
        self.root.mkdir()
        self.lane.mkdir()
        (self.root / "todo").mkdir()
        (self.root / "todo/lanes.json").write_text(json.dumps({"lanes": {
            "checks": {"branch": "checks-lane", "worktree": "../checks", "domains": ["D01"]}}}))
        self.module = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.module)
        for file in self.module.SETUP_FILES:
            for root in (self.root, self.lane):
                path = root / file
                path.parent.mkdir(parents=True, exist_ok=True)
                if file != "todo/lanes.json":
                    path.write_text("setup\n")
        (self.lane / "todo/lanes.json").write_bytes((self.root / "todo/lanes.json").read_bytes())

    def git(self, root, *args):
        if args[:2] == ("symbolic-ref", "--short"):
            return "main" if root == self.root else "checks-lane"
        if args[0] == "status":
            return ""
        self.fail(f"unexpected git invocation: {args}")

    def inspect(self, **kwargs):
        with mock.patch.object(self.module, "git", side_effect=self.git):
            return self.module.inspect_lane(self.root, "checks", **kwargs)

    def test_current_lane_launches_in_existing_worktree(self):
        status = self.inspect()
        self.assertEqual(status["problems"], [])
        cmd = self.module.command(status)
        self.assertEqual(cmd[:3], ["codex", "-C", str(self.lane)])
        self.assertIn("one implementation self-review round", cmd[-1])
        self.assertNotIn("--worktree", cmd)
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", cmd)
        self.assertNotIn("--dangerously-bypass-hook-trust", cmd)
        self.assertIn("checks-inbox.md", cmd[-1])
        self.assertIn("checks-outbox.md", cmd[-1])

    def test_stale_policy_refuses_launch(self):
        (self.lane / "scripts/lib/todo_graph.py").write_text("old gate\n")
        status = self.inspect()
        self.assertIn("scripts/lib/todo_graph.py", " ".join(status["problems"]))
        with self.assertRaises(self.module.LaneError):
            self.module.command(status)

    def test_wrong_branch_refuses_launch(self):
        with mock.patch.object(self.module, "git", return_value="wrong"):
            status = self.module.inspect_lane(self.root, "checks")
        self.assertIn("expected branch checks-lane", " ".join(status["problems"]))

    def test_dirty_start_refused_but_explicit_resume_preserves_work(self):
        def git(root, *args):
            return " M src/work.ts\n" if args[0] == "status" else self.git(root, *args)
        with mock.patch.object(self.module, "git", side_effect=git):
            fresh = self.module.inspect_lane(self.root, "checks")
            resumed = self.module.inspect_lane(self.root, "checks", session="lane-session")
        self.assertTrue(fresh["problems"])
        self.assertEqual(resumed["problems"], [])
        self.assertEqual(self.module.command(resumed, "lane-session")[:5],
                         ["codex", "resume", "-C", str(self.lane), "--dangerously-bypass-approvals-and-sandbox"])
        self.assertEqual(self.module.command(resumed, "lane-session")[-2], "lane-session")

    def test_handover_accepts_dirty_work_without_changing_files(self):
        work = self.lane / "unfinished.txt"
        work.write_text("keep this work")
        def git(root, *args):
            return "?? unfinished.txt" if args[0] == "status" else self.git(root, *args)
        with mock.patch.object(self.module, "git", side_effect=git):
            status = self.module.inspect_lane(self.root, "checks", handover=True)
        self.assertEqual(status["problems"], [])
        self.assertEqual(work.read_text(), "keep this work")
        self.assertIn("previous writer is idle", self.module.command(status)[-1])

    def test_handover_never_bypasses_an_existing_campaign_owner(self):
        path = self.lane / "build/claude-campaign-guard.json"
        path.parent.mkdir()
        path.write_text(json.dumps({"session_id": "muse-owner"}))
        self.assertTrue(self.inspect(handover=True)["problems"])

    def test_main_prompt_reads_the_existing_coordinator_outbox(self):
        with mock.patch.object(self.module, "git", side_effect=self.git):
            status = self.module.inspect_lane(self.root, "main")
        prompt = self.module.command(status)[-1]
        self.assertIn("coordinator-outbox.md", prompt)
        self.assertIn("system-state.md", prompt)

    def test_guard_owned_by_other_session_refuses_resume(self):
        path = self.lane / "build/claude-campaign-guard.json"
        path.parent.mkdir()
        path.write_text(json.dumps({"session_id": "old-writer"}))
        self.assertTrue(self.inspect(session="new-writer")["problems"])
        self.assertEqual(self.inspect(session="old-writer")["problems"], [])

    def test_bad_guard_fails_closed(self):
        path = self.lane / "build/claude-campaign-guard.json"
        path.parent.mkdir()
        path.write_text("broken")
        self.assertIn("unreadable campaign guard", " ".join(self.inspect()["problems"]))

    def test_unknown_lane_refused(self):
        with self.assertRaises(self.module.LaneError):
            self.module.inspect_lane(self.root, "not-a-lane")

    def test_dry_run_never_launches(self):
        with mock.patch.object(self.module, "git", side_effect=self.git), \
                mock.patch.object(self.module.os, "execvp") as launch, \
                mock.patch("builtins.print"):
            self.assertEqual(self.module.main(["--root", str(self.root), "launch", "checks", "--dry-run"]), 0)
            launch.assert_not_called()

    def test_launch_removes_inherited_lane_override(self):
        with mock.patch.object(self.module, "git", side_effect=self.git), \
                mock.patch.object(self.module.shutil, "which", return_value="/bin/codex"), \
                mock.patch.dict(self.module.os.environ, {"TODO_LANE": "eval"}), \
                mock.patch.object(self.module.os, "execvp") as launch:
            self.module.main(["--root", str(self.root), "launch", "checks"])
            self.assertNotIn("TODO_LANE", self.module.os.environ)
            launch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
