"""scripts/merge_prs.py: dependency pull requests merge only when safe, one at a time, stopping at the first
failure, under the policy .conclave/ci.json configures (Dependabot only without it)."""
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "merge_prs.py"
spec = importlib.util.spec_from_file_location("merge_prs_under_test", SCRIPT)
merge_prs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merge_prs)
SECTION_IN_PROGRESS = merge_prs.section_in_progress  # the real one; the merge tests patch it
SHA = "a" * 40
SLUG = "github.com/example/project"
REQUIRED = ("build", "plan-gates")
GREEN_RUNS = [(name, "completed", "success") for name in sorted(REQUIRED)]
PINS_BRANCH = "pins/toolchain-2026.10.16"
POLICY = {"required_checks": list(REQUIRED), "labels": ["dependencies", "pins"],
          "producers": [{"authors": ["app/github-actions", "github-actions[bot]"],
                         "branch": r"pins/toolchain-[\w.-]+", "files": ["toolchain.json"]}]}

class Scratch:
    """A throwaway folder that can still be removed after git marks its objects read-only."""

    def __init__(self):
        self.name = tempfile.mkdtemp()

    def cleanup(self):
        for path in Path(self.name).rglob("*"):
            os.chmod(path, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
        shutil.rmtree(self.name, ignore_errors=True)



def write_config(root, doc):
    """Write .conclave/ci.json under root: a dict as JSON, a string as it is."""
    path = Path(root) / ".conclave" / "ci.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")


def pr(number, *, author="app/github-actions", labels=("dependencies", "pins"), mergeable="MERGEABLE",
       checks=None, branch=None, base="main"):
    """A pull request as gh pr view shows it, with its head commit's check runs under "_runs" (for the fake)."""
    branch = branch or ("dependabot/github_actions/x" if "dependabot" in author else PINS_BRANCH)
    return {"number": number, "title": f"pin {number}", "author": {"login": author}, "state": "OPEN", "isDraft": False,
            "labels": [{"name": n} for n in labels], "baseRefName": base, "headRefName": branch,
            "headRefOid": f"{number:040d}", "mergeable": mergeable, "mergeCommit": None,
            "files": [{"path": ".github/workflows/build.yml" if "dependabot" in author else "toolchain.json"}],
            "_runs": GREEN_RUNS if checks is None else list(checks), "_statuses": []}


class FakeRun:
    """Answers git and gh the way a test asks, and records every call. after_merge(number, prs) may change later
    answers."""

    def __init__(self, prs, *, dirty="", head=SHA, upstream=SHA, fail=(), after_merge=None, raise_on=None):
        self.raise_on = raise_on
        self.lands = True  # a merge request merges; False models a merge queue that only enqueues
        self.prs = {p["number"]: p for p in prs}
        self.dirty, self.head, self.upstream, self.fail, self.after_merge = dirty, head, upstream, fail, after_merge
        self.calls = []

    def __call__(self, args, root):
        self.calls.append(args)
        if any(f in " ".join(args) for f in self.fail):
            return subprocess.CompletedProcess(args, 1, "", "refused")
        out = ""
        if self.raise_on and self.raise_on in " ".join(args):
            if args[:3] == ["gh", "pr", "merge"]:
                self.prs[int(args[3])]["state"] = "MERGED"  # it landed before the timeout
            raise subprocess.TimeoutExpired(args, 600)
        if args[:4] == ["git", "remote", "get-url", "origin"]:
            out = "https://github.com/example/project.git\n"
        elif args[:2] == ["git", "status"]:
            out = self.dirty
        elif args[:3] == ["git", "rev-parse", "HEAD"]:
            out = self.head
        elif args[:3] == ["git", "rev-parse", "origin/main"]:
            out = self.upstream
        elif args[:3] == ["gh", "pr", "list"]:
            base = args[args.index("--base") + 1]
            out = json.dumps([{"number": n} for n, p in self.prs.items() if p["baseRefName"] == base])
        elif args[:3] == ["gh", "pr", "view"]:
            out = json.dumps({k: v for k, v in self.prs[int(args[3])].items() if not k.startswith("_")})
        elif args[:3] == ["gh", "api", "graphql"]:
            number = int(next(a for a in args if a.startswith("number=")).split("=", 1)[1])
            out = self.prs[number].get("_test_merge", "") + "\n"
        elif args[:2] == ["gh", "api"]:
            path = next(a for a in args if "/commits/" in a)
            sha = path.split("/commits/")[1].split("/")[0]
            status = path.split("?")[0].endswith("/status")
            merge = next((p for p in self.prs.values() if p.get("_test_merge") == sha), None)
            if merge is not None:
                rows = merge.get("_merge_statuses" if status else "_merge_runs", [])
            else:
                p = next(p for p in self.prs.values() if p["headRefOid"] == sha)
                rows = p["_statuses"] if status else p["_runs"]
            out = "".join(json.dumps(list(r)) + "\n" for r in rows)
        elif args[:3] == ["gh", "pr", "merge"]:
            if self.lands:
                self.prs[int(args[3])].update(state="MERGED", mergeCommit={"oid": "c" * 40})
            if self.after_merge:
                self.after_merge(int(args[3]), self.prs)
        return subprocess.CompletedProcess(args, 0, out, "")

    def merges(self):
        return [c[3] for c in self.calls if c[:3] == ["gh", "pr", "merge"]]


class MergePrs(unittest.TestCase):
    def setUp(self):
        self.tmp = Scratch()
        self.root = Path(self.tmp.name)
        self.lines = []
        write_config(self.root, {"merge": POLICY})
        merge_prs.load_policy(self.root)  # for the tests that call why_not directly; every run loads it again
        self.addCleanup(merge_prs.load_policy, Path(self.tmp.name) / "absent")
        patcher = mock.patch.object(merge_prs, "section_in_progress", return_value=None)
        self.in_progress = patcher.start()
        self.addCleanup(patcher.stop)
        no_wait = mock.patch.object(merge_prs, "SETTLE_WAIT", 0)
        no_wait.start()
        self.addCleanup(no_wait.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def main(self, fake, *argv):
        return merge_prs.main(list(argv), run=fake, root=self.root, out=self.lines.append)

    def test_eligible_pull_requests_merge_one_at_a_time_with_their_checked_commit(self):
        fake = FakeRun([pr(2), pr(1, author="app/dependabot", labels=("dependencies",))])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["1", "2"])
        merge = next(c for c in fake.calls if c[:3] == ["gh", "pr", "merge"])
        self.assertEqual(merge[4:], ["--repo", SLUG, "--rebase", "--match-head-commit", f"{1:040d}"])
        after = fake.calls[fake.calls.index(merge) + 1 :]
        self.assertEqual(after[0][:3], ["gh", "pr", "view"])  # read back: merged, not merely queued
        self.assertEqual(after[1][:3], ["git", "pull", "--ff-only"])
        self.assertEqual(after[2][:3], ["git", "merge-base", "--is-ancestor"])
        self.assertEqual(after[3][-1], "validate")

    def test_ineligible_pull_requests_are_skipped(self):
        failing = GREEN_RUNS[:-1] + [(GREEN_RUNS[-1][0], "completed", "failure")]
        running = GREEN_RUNS + [("extra", "in_progress", None)]
        all_skipped = [(name, "completed", "skipped") for name, _, _ in GREEN_RUNS]
        fake = FakeRun([pr(1, author="someone"), pr(2, labels=("bug",)), pr(3, mergeable="CONFLICTING"),
                        pr(4, checks=()), pr(5, checks=failing), pr(6, checks=running),
                        pr(7, checks=GREEN_RUNS[1:]),  # a required job never ran
                        pr(8, checks=all_skipped), pr(9, mergeable="UNKNOWN")])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), [])
        self.assertEqual(sum("skipped" in line for line in self.lines), 9)
        text = " ".join(self.lines)
        self.assertIn("#1 skipped: not from Dependabot or a configured producer", text)
        self.assertIn("#2 skipped: not labelled dependencies or pins", text)

    def test_a_failing_or_pending_commit_status_blocks_the_merge(self):
        blocked = pr(1)
        blocked["_statuses"] = [("ci/legacy", "failure")]
        pending = pr(2)
        pending["_statuses"] = [("ci/legacy", "pending")]
        passing = pr(3)
        passing["_statuses"] = [("ci/legacy", "success")]
        fake = FakeRun([blocked, pending, passing])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["3"])

    def test_safety_is_checked_again_before_each_merge(self):
        def edit_after_first(number, prs):
            fake.dirty = " M todo/x.md"

        fake = FakeRun([pr(1), pr(2)], after_merge=edit_after_first)
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["1"])
        self.assertIn("stopped after 1 merged", self.lines[-1])

    def test_commit_statuses_are_read_across_every_page(self):
        fake = FakeRun([pr(1)])
        self.assertEqual(self.main(fake, "--dry-run"), 0)
        status_call = next(c for c in fake.calls if c[:2] == ["gh", "api"] and "/status" in " ".join(c))
        self.assertIn("--paginate", status_call)

    def test_only_pull_requests_into_main_are_considered(self):
        fake = FakeRun([pr(1, base="release/1.0")])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), [])
        listing = next(c for c in fake.calls if c[:3] == ["gh", "pr", "list"])
        self.assertEqual(listing[listing.index("--base") + 1], "main")
        self.assertEqual(merge_prs.why_not(pr(2, base="release/1.0"), GREEN_RUNS), "not an open pull request into main")

    def test_each_pull_request_is_judged_as_it_is_right_before_its_merge(self):
        def rerun_failed(number, prs):  # while #1 merges, #2's checks are rerun and fail on the same head
            if number == 1:
                prs[2]["_runs"] = GREEN_RUNS[:-1] + [(GREEN_RUNS[-1][0], "completed", "failure")]

        fake = FakeRun([pr(1), pr(2)], after_merge=rerun_failed)
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["1"])

    def test_excluded_branches_are_left_for_their_section(self):
        write_config(self.root, {"merge": {**POLICY, "excluded_branches": ["pins/toolchain-section-work"]}})
        fake = FakeRun([pr(1, branch="pins/toolchain-section-work-1"), pr(2)])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["2"])
        self.assertIn("section work", self.lines[0])

    def test_nothing_runs_unless_safe(self):
        for fake, reason in ((FakeRun([pr(1)], dirty=" M x"), "working tree"),
                             (FakeRun([pr(1)], head="b" * 40), "is not origin/main")):
            self.lines.clear()
            with self.subTest(reason=reason):
                self.assertEqual(self.main(fake), 0)
                self.assertEqual(fake.merges(), [])
                self.assertIn(reason, self.lines[0])
        self.in_progress.return_value = "D00 T01 §2"
        fake = FakeRun([pr(1)])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), [])

    def test_the_scheduled_task_stands_aside_while_a_campaign_runs(self):
        (self.root / "build").mkdir()
        (self.root / "build" / "claude-campaign-guard.json").write_text("{}", encoding="utf-8")
        fake = FakeRun([pr(1)])
        self.assertEqual(self.main(fake, "--scheduled"), 0)
        self.assertEqual(fake.calls, [])
        self.assertIn("campaign", self.lines[0])
        self.assertEqual(self.main(fake), 0)  # the loop itself runs it at a section boundary
        self.assertEqual(fake.merges(), ["1"])

    def test_the_scheduled_task_holds_the_guard_lock_for_its_whole_window(self):
        seen = []

        def probe(number, prs):  # during the merge, a campaign's attempt to take the lock must fail
            try:
                with merge_prs.campaign_guard._Lock(str(self.root), wait=0.1):
                    seen.append("free")
            except merge_prs.campaign_guard.GuardError:
                seen.append("held")

        self.assertEqual(self.main(FakeRun([pr(1)], after_merge=probe), "--scheduled"), 0)
        self.assertEqual(seen, ["held"])

    def test_the_first_failure_stops_and_says_what_state_it_left(self):
        fake = FakeRun([pr(1), pr(2)], fail=("merge 1",))
        self.assertEqual(self.main(fake), 1)
        self.assertNotIn("2", fake.merges())
        self.assertIn("state is now OPEN", self.lines[-1])
        for failing in ("pull --ff-only", "validate"):
            self.lines.clear()
            (self.root / merge_prs.STOPPED).unlink()  # each case starts after the operator cleared the last stop
            fake = FakeRun([pr(1), pr(2)], fail=(failing,))
            with self.subTest(failing=failing):
                self.assertEqual(self.main(fake), 1)
                self.assertEqual(fake.merges(), ["1"])
                self.assertIn("merged on GitHub, but the local follow-up failed", self.lines[-1])

    def test_every_github_call_names_the_repository_behind_origin(self):
        fake = FakeRun([pr(1)])
        with mock.patch.dict("os.environ", {"GH_REPO": "someone/else", "GH_HOST": "enterprise.example"}):
            self.assertEqual(self.main(fake), 0)
        gh_calls = [c for c in fake.calls if c[0] == "gh"]
        self.assertTrue(gh_calls)
        for call in gh_calls:
            joined = " ".join(call)
            # The host is named in every call, so neither GH_REPO nor GH_HOST is followed.
            self.assertTrue(f"--repo {SLUG}" in joined
                            or ("--hostname github.com" in joined and "repos/example/project/" in joined)
                            or ("--hostname github.com" in joined and "owner=example" in joined
                                and "name=project" in joined), joined)

    def test_a_timed_out_merge_reports_what_github_says(self):
        fake = FakeRun([pr(1)], raise_on="pr merge")
        self.assertEqual(self.main(fake), 1)
        self.assertIn("state is now MERGED", self.lines[-1])
        self.assertIn("did not finish", self.lines[-1])

    def test_a_non_github_origin_refuses(self):
        class Elsewhere(FakeRun):
            def __call__(self, args, root):
                if args[:4] == ["git", "remote", "get-url", "origin"]:
                    self.calls.append(args)
                    return subprocess.CompletedProcess(args, 0, "https://example.com/x.git\n", "")
                return super().__call__(args, root)

        fake = Elsewhere([pr(1)])
        self.assertEqual(self.main(fake), 1)
        self.assertEqual(fake.merges(), [])

    def test_provenance_is_branch_and_files_not_just_the_author(self):
        feature = pr(1, branch="unrelated-feature")
        foreign = pr(2)
        foreign["files"] = [{"path": "src/app/parser.cpp"}]
        dependabot_code = pr(3, author="app/dependabot")
        dependabot_code["files"] = [{"path": "scripts/merge_prs.py"}]
        fake = FakeRun([feature, foreign, dependabot_code, pr(4, author="app/dependabot")])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["4"])

    def test_a_branch_no_producer_owns_is_refused(self):
        stray = pr(1, branch="release-bot/2.5.2", author="github-actions[bot]")
        fake = FakeRun([stray, pr(2)])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["2"])
        self.assertIn("#1 skipped: not on its producer's branch", " ".join(self.lines))

    def test_a_queued_merge_stops_the_run(self):
        fake = FakeRun([pr(1), pr(2)])
        fake.lands = False
        self.assertEqual(self.main(fake), 1)
        self.assertEqual(fake.merges(), ["1"])
        self.assertIn("queued or refused", self.lines[-1])
        self.assertNotIn("merged #1", " ".join(self.lines))

    def test_an_origin_url_never_reaches_the_output(self):
        class Secret(FakeRun):
            def __call__(self, args, root):
                if args[:4] == ["git", "remote", "get-url", "origin"]:
                    self.calls.append(args)
                    return subprocess.CompletedProcess(args, 0, "https://user:s3cret@example.com/x.git\n", "")
                return super().__call__(args, root)

        self.assertEqual(self.main(Secret([pr(1)])), 1)
        self.assertNotIn("s3cret", " ".join(self.lines))

    def test_a_stop_holds_until_the_operator_clears_it(self):
        fake = FakeRun([pr(1), pr(2)], fail=("validate",))
        self.assertEqual(self.main(fake), 1)
        self.assertEqual(fake.merges(), ["1"])
        self.assertTrue((self.root / merge_prs.STOPPED).exists())
        fake.fail = ()
        self.assertEqual(self.main(fake), 1)  # the next run, scheduled or not, refuses and says why
        self.assertEqual(fake.merges(), ["1"])
        self.assertIn("delete it to resume", self.lines[-1])
        (self.root / merge_prs.STOPPED).unlink()
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["1", "2"])

    def test_a_run_killed_mid_merge_leaves_the_stop_marker(self):
        class Killed(BaseException):
            pass

        fake = FakeRun([pr(1), pr(2)])
        real = fake.__class__.__call__

        def killed_in_validate(args, root):
            if args[-1:] == ["validate"]:
                raise Killed  # the task's timeout or a crash: nothing catches it
            return real(fake, args, root)

        with self.assertRaises(Killed):
            merge_prs.main([], run=killed_in_validate, root=self.root, out=self.lines.append)
        self.assertTrue((self.root / merge_prs.STOPPED).exists())
        self.assertEqual(self.main(FakeRun([pr(2)])), 1)  # the next run refuses
        self.assertIn("delete it to resume", self.lines[-1])

    def test_every_run_holds_the_guard_lock(self):
        seen = []

        def probe(number, prs):
            try:
                with merge_prs.campaign_guard._Lock(str(self.root), wait=0.1):
                    seen.append("free")
            except merge_prs.campaign_guard.GuardError:
                seen.append("held")

        self.assertEqual(self.main(FakeRun([pr(1)], after_merge=probe)), 0)  # not --scheduled
        self.assertEqual(seen, ["held"])
        self.assertFalse((self.root / merge_prs.STOPPED).exists())  # a verified merge clears its marker

    def test_a_draft_is_skipped_and_later_pull_requests_still_merge(self):
        draft = pr(1)
        draft["isDraft"] = True
        fake = FakeRun([draft, pr(2)])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["2"])
        self.assertFalse((self.root / merge_prs.STOPPED).exists())

    def test_a_failing_or_pending_check_on_the_pull_request_blocks(self):
        failing = pr(1)
        failing["statusCheckRollup"] = [{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"}]
        pending = pr(2)
        pending["statusCheckRollup"] = [{"__typename": "StatusContext", "state": "PENDING"}]
        passing = pr(3)
        passing["statusCheckRollup"] = [{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}]
        fake = FakeRun([failing, pending, passing, pr(4)])  # pr(4): no rollup, as a producer that dispatches its builds
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["3", "4"])

    def test_a_failing_or_unfinished_test_merge_blocks(self):
        failing = pr(1)
        failing.update(_test_merge="d" * 40, _merge_runs=[("build", "completed", "failure")])
        pending = pr(2)
        pending.update(_test_merge="e" * 40, _merge_statuses=[("ci", "pending")])
        green = pr(3)
        green.update(_test_merge="f" * 40, _merge_runs=[("build", "completed", "success")])
        fake = FakeRun([failing, pending, green, pr(4)])  # pr(4): GitHub reports no test merge
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["3", "4"])
        self.assertIn("test merge", " ".join(self.lines))

    def test_a_fetch_error_never_shows_the_remote(self):
        fake = FakeRun([pr(1)], fail=("fetch",))
        self.assertEqual(self.main(fake), 1)
        self.assertEqual(merge_prs.redact("unable to access https://user:s3cret@github.com/x.git/"),
                         "unable to access <url>")

    def test_a_base_retargeted_before_the_merge_is_skipped(self):
        fake = FakeRun([pr(1), pr(2)])
        real = fake.__class__.__call__
        views = []

        def retarget_on_second_view(args, root):
            if args[:3] == ["gh", "pr", "view"] and args[3] == "1":
                views.append(1)
                if len(views) == 2:  # the read immediately before the merge request
                    fake.prs[1]["baseRefName"] = "release"
            return real(fake, args, root)

        self.assertEqual(merge_prs.main([], run=retarget_on_second_view, root=self.root, out=self.lines.append), 0)
        self.assertEqual(fake.merges(), ["2"])
        self.assertIn("#1 skipped: not an open pull request into main", " ".join(self.lines))

    def test_a_late_change_to_eligibility_skips_the_merge(self):
        for change in ({"labels": []}, {"isDraft": True}, {"headRefOid": "9" * 40}):
            with self.subTest(change=change):
                fake = FakeRun([pr(1), pr(2)])
                real = fake.__class__.__call__
                views = []

                def late(args, root):
                    if args[:3] == ["gh", "pr", "view"] and args[3] == "1":
                        views.append(1)
                        if len(views) == 2:  # the final read, just before the merge request
                            fake.prs[1].update(change)
                    return real(fake, args, root)

                self.lines.clear()
                self.assertEqual(merge_prs.main([], run=late, root=self.root, out=self.lines.append), 0)
                self.assertEqual(fake.merges(), ["2"])

    def test_a_check_failing_or_an_edit_during_judging_stops_the_merge(self):
        cases = (("check", lambda fake: fake.prs[1].update(_runs=[(n, "completed", "failure") for n in REQUIRED]),
                  ["2"], 0),
                 ("edit", lambda fake: setattr(fake, "dirty", " M src/x.cpp\n"), [], 0))
        for what, change, merges, code in cases:
            with self.subTest(what=what):
                fake = FakeRun([pr(1), pr(2)])
                real = fake.__class__.__call__
                views = []

                def late(args, root):
                    if args[:3] == ["gh", "pr", "view"] and args[3] == "1":
                        views.append(1)
                        if len(views) == 2:  # the second half of the judging read
                            change(fake)
                    return real(fake, args, root)

                self.lines.clear()
                self.assertEqual(merge_prs.main([], run=late, root=self.root, out=self.lines.append), code)
                self.assertEqual(fake.merges(), merges)

    def test_launches_open_no_console_window(self):
        with mock.patch.object(merge_prs.subprocess, "run") as run:
            merge_prs.run_cmd(["git", "status"], self.root)
        self.assertEqual(run.call_args.kwargs["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def test_a_dry_run_merges_nothing(self):
        fake = FakeRun([pr(1)])
        self.assertEqual(self.main(fake, "--dry-run"), 0)
        self.assertEqual(fake.merges(), [])
        self.assertIn("would merge", self.lines[0])

    def test_section_in_progress_means_started_and_ready(self):
        blocked = mock.Mock(ref="D01 T02 §1", done=False, body="> **Started:** x")
        ready = mock.Mock(ref="D02 T01 §3", done=False, body="> **Started:** x")
        untouched = mock.Mock(ref="D02 T01 §4", done=False, body="no start yet")
        stamped = mock.Mock(ref="D02 T01 §2", done=True, body="> **Started:** x")
        rows = [stamped, blocked, untouched, ready]
        disposition = {id(blocked): 4, id(ready): 0, id(untouched): 0, id(stamped): 3}
        with mock.patch.object(merge_prs.todo_graph, "graph", return_value={}), \
                mock.patch.object(merge_prs.todo_graph, "ordered", return_value=rows), \
                mock.patch.object(merge_prs.todo_graph, "disposition", side_effect=lambda r, _: disposition[id(r)]):
            self.assertEqual(SECTION_IN_PROGRESS(self.root), "D02 T01 §3")
            rows.remove(ready)
            self.assertIsNone(SECTION_IN_PROGRESS(self.root))


class Policy(unittest.TestCase):
    """load_policy: Dependabot-only defaults without .conclave/ci.json, configured producers added, malformed refused."""

    def setUp(self):
        self.tmp = Scratch()
        self.root = Path(self.tmp.name)
        self.lines = []
        self.addCleanup(merge_prs.load_policy, Path(self.tmp.name) / "absent")
        patcher = mock.patch.object(merge_prs, "section_in_progress", return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)
        no_wait = mock.patch.object(merge_prs, "SETTLE_WAIT", 0)
        no_wait.start()
        self.addCleanup(no_wait.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def main(self, fake, *argv):
        return merge_prs.main(list(argv), run=fake, root=self.root, out=self.lines.append)

    def test_without_ci_json_only_dependabot_merges(self):
        merge_prs.load_policy(self.root)
        self.assertEqual(merge_prs.PRODUCERS, (merge_prs.DEPENDABOT,))
        self.assertEqual((merge_prs.LABELS, merge_prs.REQUIRED_CHECKS, merge_prs.EXCLUDED_BRANCHES),
                         ({"dependencies"}, set(), ()))
        pins = pr(1, labels=("dependencies",))
        code_change = pr(2, author="app/dependabot", labels=("dependencies",))
        code_change["files"] = [{"path": "requirements.txt"}]
        bump = pr(3, author="dependabot[bot]", labels=("dependencies",))
        fake = FakeRun([pins, code_change, bump])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["3"])
        text = " ".join(self.lines)
        self.assertIn("#1 skipped: not from Dependabot or a configured producer", text)
        self.assertIn("#2 skipped: changes files its producer never changes", text)

    def test_a_ci_json_without_a_merge_object_keeps_the_defaults(self):
        write_config(self.root, {"workflows": ["build.yml"]})
        merge_prs.load_policy(self.root)
        self.assertEqual(merge_prs.PRODUCERS, (merge_prs.DEPENDABOT,))
        self.assertEqual(merge_prs.LABELS, {"dependencies"})

    def test_no_check_runs_never_pass_even_without_required_checks(self):
        merge_prs.load_policy(self.root)
        bump = pr(1, author="app/dependabot", labels=("dependencies",), checks=())
        self.assertFalse(merge_prs.checks_green([]))
        self.assertEqual(merge_prs.why_not(bump, []),
                         "its head commit's checks are not all green, or a required job did not run")
        self.assertIsNone(merge_prs.why_not(bump, [("lint", "completed", "success")]))
        fake = FakeRun([bump])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), [])

    def test_a_configured_producer_is_added_before_dependabot(self):
        write_config(self.root, {"merge": POLICY})
        merge_prs.load_policy(self.root)
        self.assertEqual(len(merge_prs.PRODUCERS), 2)
        self.assertIs(merge_prs.PRODUCERS[-1], merge_prs.DEPENDABOT)
        self.assertEqual(merge_prs.PRODUCERS[0][0], {"app/github-actions", "github-actions[bot]"})
        self.assertEqual(merge_prs.PRODUCERS[0][2], {"toolchain.json"})
        self.assertEqual((merge_prs.LABELS, merge_prs.REQUIRED_CHECKS), ({"dependencies", "pins"}, set(REQUIRED)))
        self.assertIsNone(merge_prs.why_not(pr(1), GREEN_RUNS))
        self.assertEqual(merge_prs.why_not(pr(2, branch="pins/toolchain-"), GREEN_RUNS), "not on its producer's branch")
        fake = FakeRun([pr(1), pr(2, author="app/dependabot", labels=("dependencies",))])
        self.assertEqual(self.main(fake), 0)
        self.assertEqual(fake.merges(), ["1", "2"])

    def test_the_policy_is_reset_before_each_load(self):
        write_config(self.root, {"merge": POLICY})
        merge_prs.load_policy(self.root)
        (self.root / ".conclave" / "ci.json").unlink()
        merge_prs.load_policy(self.root)
        self.assertEqual((merge_prs.PRODUCERS, merge_prs.REQUIRED_CHECKS), ((merge_prs.DEPENDABOT,), set()))

    def test_a_malformed_policy_stops_with_nothing_merged(self):
        producer = POLICY["producers"][0]
        cases = {"not json": "{not json",
                 "merge not an object": {"merge": ["dependencies"]},
                 "unknown key": {"merge": {**POLICY, "auto_approve": True}},
                 "labels not a list": {"merge": {"labels": "dependencies"}},
                 "empty required check": {"merge": {"required_checks": ["build", ""]}},
                 "producers not a list": {"merge": {"producers": producer}},
                 "producer missing files": {"merge": {"producers": [{"authors": ["a"], "branch": "b"}]}},
                 "producer extra key": {"merge": {"producers": [{**producer, "labels": ["x"]}]}},
                 "bad branch pattern": {"merge": {"producers": [{**producer, "branch": "pins/(unclosed"}]}},
                 "authors not strings": {"merge": {"producers": [{**producer, "authors": [1]}]}}}
        for name, doc in cases.items():
            with self.subTest(name):
                write_config(self.root, doc)
                with self.assertRaises(RuntimeError) as ctx:
                    merge_prs.load_policy(self.root)
                self.assertIn(".conclave/ci.json", str(ctx.exception))
                self.lines.clear()
                fake = FakeRun([pr(1, author="app/dependabot", labels=("dependencies",))])
                self.assertEqual(self.main(fake), 1)
                self.assertEqual(fake.merges(), [])
                self.assertEqual(fake.calls, [], "nothing is asked of git or gh on a malformed policy")
                self.assertIn(".conclave/ci.json", self.lines[-1])
                self.assertFalse((self.root / merge_prs.STOPPED).exists())
        write_config(self.root, {"merge": {**POLICY, "auto_approve": True}})
        with self.assertRaises(RuntimeError) as ctx:
            merge_prs.load_policy(self.root)
        self.assertIn("auto_approve", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
