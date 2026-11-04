"""scripts/ci_status.py: the CI state of main read through a fake gh, and never green when gh cannot answer."""
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
import unittest.mock
from contextlib import redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "ci_status.py"
spec = importlib.util.spec_from_file_location("ci_status_under_test", SCRIPT)
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

SHA_OLD, SHA_NEW = "a" * 40, "b" * 40

class Scratch:
    """A throwaway folder that can still be removed after git marks its objects read-only."""

    def __init__(self):
        self.name = tempfile.mkdtemp()

    def cleanup(self):
        for path in Path(self.name).rglob("*"):
            os.chmod(path, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
        shutil.rmtree(self.name, ignore_errors=True)



def run(n, status="completed", conclusion="success", sha=SHA_NEW):
    return {"databaseId": n, "headSha": sha, "status": status, "conclusion": conclusion if status == "completed" else "",
            "url": f"https://github.com/o/r/actions/runs/{n}", "createdAt": f"2026-10-23T00:00:{n:02d}Z", "event": "push"}


def workspace(root, workflows=("build.yml", "plan.yml"), config=None):
    """A checkout with the given workflow files and, when config is not None, a .conclave/ci.json holding it."""
    folder = Path(root) / ".github" / "workflows"
    folder.mkdir(parents=True, exist_ok=True)
    for name in workflows:
        (folder / name).write_text("name: x\non: push\n", encoding="utf-8")
    if config is not None:
        (Path(root) / ".conclave").mkdir(exist_ok=True)
        text = config if isinstance(config, str) else json.dumps(config)
        (Path(root) / ".conclave" / "ci.json").write_text(text, encoding="utf-8")


class FakeGh:
    """An in-process gh: runs per workflow, jobs per run id, annotations per job id, or a failure for every call."""

    def __init__(self, runs=None, jobs=None, fail=None, missing=False, notes=None):
        self.runs, self.jobs, self.fail, self.missing, self.calls = runs or {}, jobs or {}, fail, missing, []
        self.notes = notes or {}

    def __call__(self, args):
        self.calls.append(args)
        if self.missing:
            raise FileNotFoundError("gh")
        if self.fail:
            return self.fail
        if args[:2] == ["run", "list"]:
            assert args[args.index("--json") + 1] == ci.FIELDS and args[args.index("--limit") + 1] == "10"
            assert args[args.index("--branch") + 1] == "main"
            return 0, json.dumps(self.runs.get(args[args.index("--workflow") + 1], [])), ""
        if args[:2] == ["run", "view"]:
            return 0, json.dumps({"jobs": self.jobs.get(int(args[2]), [])}), ""
        if args[0] == "api" and args[1].startswith("repos/{owner}/{repo}/check-runs/"):
            job = int(args[1].split("/")[4])
            if job not in self.notes:
                return 1, "", "HTTP 404: Not Found"
            return 0, json.dumps(self.notes[job]), ""
        raise AssertionError(args)

    def workflows(self):
        return [c[c.index("--workflow") + 1] for c in self.calls if c[:2] == ["run", "list"]]


class CiStatus(unittest.TestCase):
    def setUp(self):
        self._tmp = Scratch()
        self.root = Path(self._tmp.name)
        workspace(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def status(self, fake, *argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = ci.main(["--json", *argv], runner=fake, root=self.root)
        return code, json.loads(out.getvalue())

    def usage_error(self, argv, fake=None):
        with self.assertRaises(SystemExit) as ctx, redirect_stdout(io.StringIO()):
            with unittest.mock.patch("sys.stderr", io.StringIO()) as err:
                ci.main(argv, runner=fake or FakeGh(), root=self.root)
        return ctx.exception.code, err.getvalue()

    def test_green(self):
        code, report = self.status(FakeGh({"build.yml": [run(2), run(1, sha=SHA_OLD)], "plan.yml": [run(3)]}))
        self.assertEqual(code, 0)
        self.assertEqual([(w["workflow"], w["verdict"], w["in_progress"]) for w in report["workflows"]],
                         [("build.yml", "green", 0), ("plan.yml", "green", 0)])
        self.assertEqual(report["workflows"][0]["verdict_run"]["headSha"], SHA_NEW)

    def test_red_names_the_workflow_commit_url_and_failed_jobs(self):
        fake = FakeGh({"build.yml": [run(5, conclusion="failure"), run(4)], "plan.yml": [run(3)]},
                      jobs={5: [{"name": "x64 Release", "status": "completed", "conclusion": "failure", "url": "u1"},
                                {"name": "ARM64 Debug", "status": "completed", "conclusion": "success", "url": "u2"},
                                {"name": "asan", "status": "completed", "conclusion": "timed_out", "url": "u3"}]})
        code, report = self.status(fake)
        self.assertEqual(code, 1)
        build = report["workflows"][0]
        self.assertEqual((build["verdict"], build["verdict_run"]["headSha"], build["verdict_run"]["url"]),
                         ("red", SHA_NEW, "https://github.com/o/r/actions/runs/5"))
        self.assertEqual([j["name"] for j in build["failed_jobs"]], ["x64 Release", "asan"])
        self.assertIn(["run", "view", "5", "--json", "jobs"], fake.calls)
        out = io.StringIO()
        with redirect_stdout(out):
            ci.main([], runner=fake, root=self.root)
        text = out.getvalue()
        for expected in ("build.yml: red at bbbbbbbbbbbb (https://github.com/o/r/actions/runs/5)",
                         "failed job: x64 Release (failure) u1", "failed job: asan (timed_out) u3"):
            self.assertIn(expected, text)

    def test_in_progress_runs_are_reported_and_do_not_decide(self):
        fake = FakeGh({"build.yml": [run(9, status="in_progress"), run(8, status="queued"), run(7, conclusion="failure")],
                       "plan.yml": [run(6, status="in_progress"), run(5)]}, jobs={7: []})
        code, report = self.status(fake)
        self.assertEqual(code, 1, "a newer run still in progress does not make an older red run green")
        self.assertEqual([(w["verdict"], w["in_progress"]) for w in report["workflows"]], [("red", 2), ("green", 1)])

    def test_a_cancelled_run_carries_no_verdict(self):
        code, report = self.status(FakeGh({"build.yml": [run(3, conclusion="cancelled"), run(2)],
                                           "plan.yml": [run(4, conclusion="cancelled"), run(1, conclusion="failure")]}))
        self.assertEqual(code, 1)
        build, plan = report["workflows"]
        self.assertEqual((build["latest_completed_state"], build["verdict"]), ("cancelled", "green"))
        self.assertEqual((plan["latest_completed_state"], plan["verdict"]), ("cancelled", "red"))
        code, report = self.status(FakeGh({"build.yml": [run(3, conclusion="cancelled")], "plan.yml": [run(1)]}))
        self.assertEqual((code, report["workflows"][0]["verdict"]), (0, "none"))

    def test_a_run_cancelled_at_its_time_limit_is_red(self):
        # Every main run from 2026-10-30 19:49 UTC was cancelled at the Worker job's 10 minutes, with nothing reported.
        timeout = [{"annotation_level": "failure", "message": "The job has exceeded the maximum execution time of 10m0s"},
                   {"annotation_level": "failure", "message": "The operation was canceled."}]
        fake = FakeGh({"build.yml": [run(3, conclusion="cancelled"), run(2)], "plan.yml": [run(1)]},
                      jobs={3: [{"databaseId": 31, "name": "Worker gates", "status": "completed",
                                 "conclusion": "cancelled", "url": "u31"},
                                {"databaseId": 32, "name": "TODO graph", "status": "completed",
                                 "conclusion": "success", "url": "u32"}]},
                      notes={31: timeout})
        code, report = self.status(fake)
        self.assertEqual(code, 1)
        build = report["workflows"][0]
        self.assertEqual((build["latest_completed_state"], build["verdict"], build["verdict_run"]["databaseId"]),
                         ("cancelled", "red", 3))
        self.assertEqual(build["failed_jobs"], [{"name": "Worker gates", "conclusion": "timed out", "url": "u31"}])
        self.assertNotIn(["api", "repos/{owner}/{repo}/check-runs/32/annotations"], fake.calls)
        out = io.StringIO()
        with redirect_stdout(out):
            ci.main([], runner=fake, root=self.root)
        self.assertIn("failed job: Worker gates (timed out) u31", out.getvalue())

    def test_a_run_cancelled_by_hand_still_carries_no_verdict(self):
        by_hand = [{"annotation_level": "failure", "message": "The run was canceled by @someone."}]
        fake = FakeGh({"build.yml": [run(3, conclusion="cancelled"), run(2)], "plan.yml": [run(1)]},
                      jobs={3: [{"databaseId": 31, "name": "Worker gates", "status": "completed",
                                 "conclusion": "cancelled", "url": "u31"}]},
                      notes={31: by_hand})
        code, report = self.status(fake)
        self.assertEqual((code, report["workflows"][0]["verdict"], report["workflows"][0]["verdict_run"]["databaseId"]),
                         (0, "green", 2))

    def test_a_cancelled_run_whose_annotations_cannot_be_read_is_unknown(self):
        fake = FakeGh({"build.yml": [run(3, conclusion="cancelled"), run(2)], "plan.yml": [run(1)]},
                      jobs={3: [{"databaseId": 31, "name": "Worker gates", "status": "completed",
                                 "conclusion": "cancelled", "url": "u31"}]})
        code, report = self.status(fake)
        self.assertEqual((code, report["exit"]), (3, 3))
        self.assertIn("exited 1", report["error"])

    def test_no_runs(self):
        code, report = self.status(FakeGh({}))
        self.assertEqual(code, 0)
        self.assertEqual([(w["verdict"], w["latest_completed"], w["in_progress"]) for w in report["workflows"]],
                         [("none", None, 0), ("none", None, 0)])

    def test_gh_missing_unauthenticated_or_failing_is_never_green(self):
        cases = {"missing": FakeGh(missing=True),
                 "unauthenticated": FakeGh(fail=(4, "", "To get started with GitHub CLI, please run:  gh auth login")),
                 "not json": FakeGh(fail=(0, "<html>", ""))}
        for name, fake in cases.items():
            with self.subTest(name):
                code, report = self.status(fake)
                self.assertEqual(code, 3)
                self.assertEqual(report["exit"], 3)
                self.assertNotIn("workflows", report)
        self.assertIn("gh auth login", self.status(cases["unauthenticated"])[1]["error"])

    def test_bad_usage(self):
        for argv in (["--workflow", "nightly.yml"], ["--workflow", "../build.yml"], ["--branch", " "], ["--nope"]):
            with self.subTest(argv=argv):
                self.assertEqual(self.usage_error(argv)[0], 2)

    def test_without_ci_json_every_workflow_file_is_watched(self):
        workspace(self.root, workflows=("nightly.yaml", "deploy.yml"))
        (self.root / ".github" / "workflows" / "README.md").write_text("not a workflow\n", encoding="utf-8")
        self.assertEqual(ci.watched(self.root), ["build.yml", "deploy.yml", "nightly.yaml", "plan.yml"])
        fake = FakeGh({})
        self.assertEqual(self.status(fake)[0], 0)
        self.assertEqual(fake.workflows(), ["build.yml", "deploy.yml", "nightly.yaml", "plan.yml"])

    def test_ci_json_names_the_watched_workflows(self):
        workspace(self.root, workflows=("lint.yml",), config={"workflows": ["plan.yml", "build.yml"]})
        self.assertEqual(ci.watched(self.root), ["plan.yml", "build.yml"])
        fake = FakeGh({"plan.yml": [run(1)], "build.yml": [run(2)]})
        code, report = self.status(fake)
        self.assertEqual(code, 0)
        self.assertEqual([w["workflow"] for w in report["workflows"]], ["plan.yml", "build.yml"])
        self.assertEqual(fake.workflows(), ["plan.yml", "build.yml"], "lint.yml is not watched")

    def test_ci_json_without_a_workflows_list_falls_back_to_every_file(self):
        workspace(self.root, config={"merge": {}})
        self.assertEqual(ci.watched(self.root), ["build.yml", "plan.yml"])

    def test_a_malformed_ci_json_is_a_usage_error(self):
        for config in ("{not json", {"workflows": "build.yml"}, {"workflows": ["build.yml", ""]},
                       {"workflows": ["build.yml", 3]}):
            with self.subTest(config=config):
                workspace(self.root, config=config)
                fake = FakeGh({})
                code, err = self.usage_error(["--json"], fake)
                self.assertEqual(code, 2)
                self.assertIn(".conclave/ci.json", err)
                self.assertEqual(fake.calls, [], "gh is never asked on a malformed config")

    def test_an_explicit_workflow_overrides_ci_json(self):
        workspace(self.root, config={"workflows": ["build.yml", "plan.yml"]})
        fake = FakeGh({"plan.yml": [run(1)]})
        code, report = self.status(fake, "--workflow", "plan.yml")
        self.assertEqual(code, 0)
        self.assertEqual([w["workflow"] for w in report["workflows"]], ["plan.yml"])
        self.assertEqual(fake.workflows(), ["plan.yml"])

    def test_a_ci_json_naming_a_missing_workflow_is_a_usage_error(self):
        workspace(self.root, config={"workflows": ["nightly.yml"]})
        code, err = self.usage_error(["--json"])
        self.assertEqual(code, 2)
        self.assertIn("nightly.yml", err)

    def test_no_workflow_at_all_is_a_usage_error(self):
        shutil.rmtree(self.root / ".github")
        self.assertEqual(ci.watched(self.root), [])
        self.assertEqual(self.usage_error(["--json"])[0], 2)


FAKE_GH = textwrap.dedent('''\
    import json, os, sys
    args = sys.argv[1:]
    if os.environ.get("FAKE_GH") == "unauth":
        sys.stderr.write("To get started with GitHub CLI, please run:  gh auth login\\n")
        sys.exit(4)
    if args[:2] == ["run", "list"]:
        print(json.dumps([{"databaseId": 1, "headSha": "c" * 40, "status": "completed", "conclusion": "success",
                           "url": "https://example.invalid/1", "createdAt": "2026-10-23T00:00:00Z", "event": "push"}]))
''')


class RealProcess(unittest.TestCase):
    """The default runner against a fake gh executable on PATH, and with no gh at all, from an installed copy."""

    def setUp(self):
        self._tmp = Scratch()
        self.project = Path(self._tmp.name) / "project"
        (self.project / "scripts").mkdir(parents=True)
        self.script_path = self.project / "scripts" / "ci_status.py"
        shutil.copyfile(SCRIPT, self.script_path)
        workspace(self.project)
        self.bin = Path(self._tmp.name) / "bin"
        self.bin.mkdir()
        fake = Path(self._tmp.name) / "fake_gh.py"
        fake.write_text(FAKE_GH, encoding="utf-8")
        if os.name == "nt":
            (self.bin / "gh.cmd").write_text(f'@"{sys.executable}" "{fake}" %*\r\n', encoding="utf-8")
        else:
            launcher = self.bin / "gh"
            launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{fake}" "$@"\n', encoding="utf-8")
            launcher.chmod(0o755)

    def tearDown(self):
        self._tmp.cleanup()

    def script(self, path, **env):
        system = {"SYSTEMROOT": os.environ["SYSTEMROOT"]} if os.name == "nt" else {}
        return subprocess.run([sys.executable, str(self.script_path), "--json"], capture_output=True, text=True,
                              timeout=120, env={"PATH": path, **system, **env}, cwd=self._tmp.name)

    def test_green_through_a_fake_gh(self):
        result = self.script(str(self.bin))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([w["verdict"] for w in json.loads(result.stdout)["workflows"]], ["green", "green"])

    def test_unauthenticated_gh_exits_3(self):
        result = self.script(str(self.bin), FAKE_GH="unauth")
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertIn("gh auth login", json.loads(result.stdout)["error"])

    def test_no_gh_on_path_exits_3(self):
        empty = Path(self._tmp.name) / "empty"
        empty.mkdir()
        result = self.script(str(empty))
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["error"], "gh is not installed or not on PATH")


if __name__ == "__main__":
    unittest.main()


class ExactGate(unittest.TestCase):
    def jobs(self):
        return [{'name': n, 'status':'completed','conclusion':'success'} for n in ci.GATE_JOBS]

    def fake(self, runs=None, jobs=None, **changes):
        latest={'databaseId':2,'headSha':SHA_NEW,'headBranch':'coordinator-gate','event':'push','status':'completed','conclusion':'success','createdAt':'2026-11-04T12:00:00Z','url':'https://example.test/2'}
        latest.update(changes)
        def call(args):
            if args[:2]==['run','list']:
                self.assertEqual(args[args.index('--commit')+1],SHA_NEW)
                self.assertEqual(args[args.index('--branch')+1],'coordinator-gate')
                self.assertEqual(args[args.index('--workflow')+1],'ci.yml')
                return 0,json.dumps([latest] if runs is None else runs),''
            if args[:2]==['run','view']:
                return 0,json.dumps({**latest,'jobs': self.jobs() if jobs is None else jobs}),''
            raise AssertionError(args)
        return call

    def test_exact_complete_job_set_only_is_green(self):
        doc,code=ci.gate_report(self.fake(),SHA_NEW)
        self.assertEqual(code,0)
        self.assertEqual(doc['verdict'],'green')

    def test_wrong_identity_state_event_and_newer_failure_never_fall_back(self):
        for patch in ({'headSha':SHA_OLD},{'headBranch':'main'},{'event':'pull_request'},
                      {'status':'in_progress'},{'conclusion':'skipped'},{'conclusion':'cancelled'},
                      {'conclusion':'failure'}):
            with self.subTest(patch=patch):
                _,code=ci.gate_report(self.fake(**patch),SHA_NEW)
                self.assertNotEqual(code,0)
        _,code=ci.gate_report(self.fake(runs=[]),SHA_NEW)
        self.assertNotEqual(code,0)
        old={'databaseId':1,'headSha':SHA_NEW,'headBranch':'coordinator-gate','event':'push','status':'completed','conclusion':'success','createdAt':'2026-11-04T11:00:00Z'}
        newer={**old,'databaseId':2,'createdAt':'2026-11-04T12:00:00Z','status':'queued','conclusion':None}
        self.assertNotEqual(ci.gate_report(self.fake(runs=[old,newer]),SHA_NEW)[1],0)

    def test_every_job_required_once_and_successful(self):
        jobs=self.jobs()
        for bad in (jobs[:-1],jobs+[jobs[0]],jobs+[{'name':'extra','status':'completed','conclusion':'success'}]):
            self.assertNotEqual(ci.gate_report(self.fake(jobs=bad),SHA_NEW)[1],0)
        for status,conclusion in [('completed','skipped'),('completed','cancelled'),('completed','failure'),('queued',None),('in_progress',None)]:
            for i in range(len(jobs)):
                bad=[dict(j) for j in jobs];bad[i].update(status=status,conclusion=conclusion)
                self.assertNotEqual(ci.gate_report(self.fake(jobs=bad),SHA_NEW)[1],0)

    def test_unreadable_api_and_mismatched_view_fail_closed(self):
        with self.assertRaises(ci.Unavailable): ci.gate_report(lambda args:(1,'','offline'),SHA_NEW)
        good=self.fake()
        def altered(args):
            code,out,err=good(args)
            if args[:2]==['run','view']:
                d=json.loads(out);d['headSha']=SHA_OLD;out=json.dumps(d)
            return code,out,err
        self.assertNotEqual(ci.gate_report(altered,SHA_NEW)[1],0)

    def test_cli_explicit_mode_rejects_invalid_scope_and_reports_unknown(self):
        for argv in (['--sha','abc'],['--sha',SHA_NEW,'--branch','main'],['--sha',SHA_NEW,'--workflow','other.yml']):
            with self.assertRaises(SystemExit) as raised, unittest.mock.patch('sys.stderr',io.StringIO()):
                ci.main(argv,runner=self.fake())
            self.assertEqual(raised.exception.code,2)
        output=io.StringIO()
        with redirect_stdout(output):
            code=ci.main(['--sha',SHA_NEW,'--json'],runner=self.fake())
        self.assertEqual(code,0)
        self.assertEqual(json.loads(output.getvalue())['mode'],'exact-gate')
        output=io.StringIO()
        with redirect_stdout(output):
            code=ci.main(['--sha',SHA_NEW,'--json'],runner=lambda args:(1,'','offline'))
        self.assertEqual(code,3)
        self.assertEqual(json.loads(output.getvalue())['verdict'],'unknown')

    def test_malformed_remote_records_and_successful_old_run_do_not_pass(self):
        for payload in ({},[None],[{'databaseId':'2','createdAt':None}], [{'databaseId':2,'createdAt':'bad'}], [{'databaseId':True,'createdAt':'2026-11-04T12:00:00Z'}]):
            with self.assertRaises(ci.Unavailable):
                ci.gate_report(self.fake(runs=payload),SHA_NEW)
        good=self.fake()
        for jobs in (None,{},[None],[{'name':None}]):
            def malformed(args):
                code,out,err=good(args)
                if args[:2]==['run','view']:
                    d=json.loads(out);d['jobs']=jobs;out=json.dumps(d)
                return code,out,err
            with self.assertRaises(ci.Unavailable):ci.gate_report(malformed,SHA_NEW)
        old={'databaseId':1,'headSha':SHA_NEW,'headBranch':'coordinator-gate','event':'push','status':'completed','conclusion':'success','createdAt':'2026-11-04T11:00:00Z'}
        for conclusion in ('failure','cancelled'):
            newer={**old,'databaseId':2,'createdAt':'2026-11-04T12:00:00Z','conclusion':conclusion}
            self.assertNotEqual(ci.gate_report(self.fake(runs=[old,newer]),SHA_NEW)[1],0)
