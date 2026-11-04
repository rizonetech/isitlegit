#!/usr/bin/env python3
"""Report the CI state of main: the latest completed run of each watched workflow, and runs still in progress.

    python scripts/ci_status.py --sha <40-character-sha> --json  # exact coordinator gate, exit 0 only if all jobs pass
    python scripts/ci_status.py                  # the watched workflows on main
    python scripts/ci_status.py --json           # the same report as one JSON object
    python scripts/ci_status.py --workflow build.yml --branch main

For each watched workflow it reads the last 10 runs with `gh run list` and reports the latest completed run (green, red or cancelled), its verdict,
and how many newer runs are still queued or in progress. A run stopped by hand or by a newer one carries no verdict, so
the verdict is the latest completed run that was not cancelled; with none in the last 10 runs the verdict is `none`. A
cancelled run whose job GitHub stopped at its `timeout-minutes` is a verdict, red: the commit did not pass in the time
the workflow allows (read from each cancelled job's annotations, `gh api repos/{owner}/{repo}/check-runs/<job>/annotations`).
For a red verdict it names the failed (or timed-out) jobs from `gh run view <id> --json jobs`.

The watched workflows are the `--workflow` arguments, else the `workflows` list in `.conclave/ci.json` (the ones whose
results gate main), else every `.yml` and `.yaml` file in `.github/workflows/`.

Without --sha this is historical reporting, not promotion proof. Exact --sha mode requires the latest matching gate and every required job to be completed successfully; missing or incomplete evidence exits 1, unavailable API exits 3.

History mode exit 0: no watched workflow is red. Exit 1: at least one is red (the workflow, the commit, the run's URL and its
failed jobs are printed). Exit 2: bad usage. Exit 3: `gh` is missing, not authenticated, or failed, so the state is
unknown; that is never treated as green. The red-first policy that consumes this is in the `process-phase` skill.
Stdlib only; the `gh` runner is injectable for tests.
"""
import argparse
from collections import Counter
from datetime import datetime
import re
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CONFIG = Path(".conclave") / "ci.json"
FIELDS = "databaseId,headSha,status,conclusion,url,createdAt,event"
LIMIT = 10
GREEN = {"success", "neutral", "skipped"}
# A run that was stopped before it judged the commit: no verdict either way.
NO_VERDICT = {"cancelled", "stale"}
MAX_JOBS = 20
# GitHub's annotation on a job it stopped at its timeout-minutes ("The job has exceeded the maximum execution time of
# 10m0s"); a run cancelled by hand or by a newer one has none.
TIMED_OUT = "has exceeded the maximum execution time"
MAX_MESSAGE = 300


class Unavailable(Exception):
    """gh is missing, unauthenticated or failed: the CI state is unknown (exit 3)."""


def run_gh(args):
    """Run gh with args; returns (exit code, stdout, stderr). Raises Unavailable when gh is not installed."""
    # An explicit path: on Windows a bare which() also searches the working directory, where a planted gh could sit.
    executable = shutil.which("gh", path=os.environ.get("PATH", ""))
    if executable is None:
        raise Unavailable("gh is not installed or not on PATH")
    try:
        done = subprocess.run([executable, *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=120)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Unavailable(f"gh could not run: {exc}") from None
    return done.returncode, done.stdout, done.stderr


def gh_json(runner, args):
    try:
        code, out, err = runner(args)
    except FileNotFoundError:
        raise Unavailable("gh is not installed or not on PATH") from None
    if code != 0:
        reason = (err or out or "").strip().splitlines()
        raise Unavailable(f"gh {' '.join(args[:2])} exited {code}: {(reason[0] if reason else 'no output')[:MAX_MESSAGE]}")
    try:
        return json.loads(out)
    except ValueError:
        raise Unavailable(f"gh {' '.join(args[:2])} did not return JSON") from None


def watched(root):
    """The workflows .conclave/ci.json names, else every workflow file; a malformed config is a usage error."""
    path = Path(root) / CONFIG
    if path.is_file():
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            raise ValueError(f"{CONFIG.as_posix()} is not JSON") from None
        names = doc.get("workflows") if isinstance(doc, dict) else None
        if names is not None:
            if not (isinstance(names, list) and all(isinstance(n, str) and n for n in names)):
                raise ValueError(f"{CONFIG.as_posix()} workflows must be a list of workflow file names")
            return list(names)
    directory = Path(root) / ".github" / "workflows"
    if not directory.is_dir():
        return []
    return sorted(p.name for p in directory.iterdir() if p.is_file() and p.suffix in (".yml", ".yaml"))


def verdict_of(run):
    if run is None:
        return "none"
    conclusion = (run.get("conclusion") or "").lower()
    if conclusion in GREEN:
        return "green"
    if conclusion in NO_VERDICT:
        return "cancelled"
    return "red"


def brief(run):
    return None if run is None else {k: run.get(k) for k in ("databaseId", "headSha", "status", "conclusion", "url",
                                                              "createdAt", "event")}


def workflow_status(runner, workflow, branch):
    runs = gh_json(runner, ["run", "list", "--branch", branch, "--workflow", workflow, "--limit", str(LIMIT),
                            "--json", FIELDS])
    if not isinstance(runs, list) or not all(isinstance(r, dict) for r in runs):
        raise Unavailable(f"gh run list for {workflow} did not return a list of runs")
    runs = sorted(runs, key=lambda r: str(r.get("createdAt") or ""), reverse=True)
    completed = [r for r in runs if r.get("status") == "completed"]
    latest = completed[0] if completed else None
    decisive, timed_out = None, []
    for candidate in completed:
        if verdict_of(candidate) != "cancelled":
            decisive = candidate
            break
        timed_out = timed_out_jobs(runner, candidate.get("databaseId"))
        if timed_out:  # stopped at its time limit: the commit did not pass
            decisive = candidate
            break
    newer = [r for r in runs if r.get("status") != "completed"
             and (latest is None or str(r.get("createdAt") or "") > str(latest.get("createdAt") or ""))]
    entry = {"workflow": workflow, "verdict": "red" if timed_out else verdict_of(decisive),
             "latest_completed": brief(latest), "latest_completed_state": verdict_of(latest),
             "verdict_run": brief(decisive), "in_progress": len(newer)}
    if entry["verdict"] == "red":
        entry["failed_jobs"] = timed_out or failed_jobs(runner, decisive.get("databaseId"))
    return entry



# Exact gate names are checked against the workflow by test_ci_workflow.py. History mode is not promotion evidence.
GATE_JOBS = (
    "Worker gates", "Voice decoder against FFmpeg", "TODO graph", "Kit script tests",
    *(f"Worker tests ({i} of 4)" for i in range(1, 5)),
    *(f"Browser tests ({i} of 3)" for i in range(1, 4)),
    *(f"Project script tests ({i} of 4)" for i in range(1, 5)),
)
GATE_FIELDS = FIELDS + ",headBranch"


def gate_report(runner, sha):
    """Only the latest exact-candidate coordinator gate can approve promotion, never branch history."""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("gate SHA must be 40 lowercase hexadecimal characters")
    runs = gh_json(runner, ["run", "list", "--branch", "coordinator-gate", "--workflow", "ci.yml",
                            "--commit", sha, "--limit", str(LIMIT), "--json", GATE_FIELDS])
    if not isinstance(runs, list) or any(not isinstance(r, dict) for r in runs):
        raise Unavailable("gate run list is malformed")
    result = {"mode":"exact-gate", "sha":sha, "branch":"coordinator-gate", "verdict":"not-green", "run":None}
    def refused(reason):
        return {**result, "reason":reason, "exit":1}, 1
    if not runs:
        return refused("no exact-candidate gate run")
    def ordering(run):
        if type(run.get("databaseId")) is not int or run["databaseId"] <= 0:
            raise Unavailable("gate run identities are malformed")
        try:
            timestamp = datetime.fromisoformat(run["createdAt"].replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                raise ValueError("missing timezone")
        except (KeyError, AttributeError, TypeError, ValueError):
            raise Unavailable("gate run timestamps are malformed") from None
        return timestamp, run["databaseId"]
    latest = max(runs, key=ordering)
    result["run"] = brief(latest)
    def identity(r):
        return (r.get("headSha") == sha and r.get("headBranch") == "coordinator-gate"
                and r.get("event") in ("push", "workflow_dispatch"))
    if not identity(latest):
        return refused("gate run identity differs")
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        return refused("latest exact-candidate gate is not completed successfully")
    view = gh_json(runner, ["run", "view", str(latest["databaseId"]), "--json", GATE_FIELDS + ",jobs"])
    if not isinstance(view, dict):
        raise Unavailable("gate run details are malformed")
    if (not identity(view) or view.get("databaseId") != latest["databaseId"]
            or view.get("status") != "completed" or view.get("conclusion") != "success"):
        return refused("gate run changed or its detail identity differs")
    jobs = view.get("jobs")
    if not isinstance(jobs, list) or any(not isinstance(j, dict) or not isinstance(j.get("name"), str) for j in jobs):
        raise Unavailable("gate job list is malformed")
    if Counter(j["name"] for j in jobs) != Counter(GATE_JOBS):
        return refused("required job multiset differs")
    if any(j.get("status") != "completed" or j.get("conclusion") != "success" for j in jobs):
        return refused("a required job is not completed successfully")
    return {**result, "verdict":"green", "exit":0}, 0


def timed_out_jobs(runner, run_id):
    """The jobs of a cancelled run that GitHub stopped at their timeout-minutes, each as a failed job whose conclusion
    is `timed out`; empty when every cancelled job was stopped by hand or by a newer run. Unreadable jobs or
    annotations raise Unavailable: a cancelled run of unknown cause is never taken as no verdict."""
    view = gh_json(runner, ["run", "view", str(run_id), "--json", "jobs"])
    jobs = view.get("jobs") if isinstance(view, dict) else None
    if not isinstance(jobs, list):
        raise Unavailable(f"gh run view {run_id} returned no job list")
    found = []
    for job in jobs:
        if not isinstance(job, dict) or (job.get("conclusion") or "").lower() != "cancelled":
            continue
        notes = gh_json(runner, ["api", f"repos/{{owner}}/{{repo}}/check-runs/{job.get('databaseId')}/annotations"])
        if not isinstance(notes, list):
            raise Unavailable(f"the annotations of job {job.get('databaseId')} are not a list")
        if any(isinstance(n, dict) and TIMED_OUT in str(n.get("message") or "") for n in notes):
            found.append({"name": job.get("name"), "conclusion": "timed out", "url": job.get("url")})
    return found[:MAX_JOBS]


def failed_jobs(runner, run_id):
    """The failed jobs of one run, or a one-line note when they cannot be read (the run is still red)."""
    try:
        view = gh_json(runner, ["run", "view", str(run_id), "--json", "jobs"])
    except Unavailable as exc:
        return [{"name": f"jobs unavailable: {exc}", "conclusion": None, "url": None}]
    jobs = view.get("jobs") if isinstance(view, dict) else None
    if not isinstance(jobs, list):
        return [{"name": "jobs unavailable: gh run view returned no job list", "conclusion": None, "url": None}]
    failed = [j for j in jobs if isinstance(j, dict) and verdict_of(j) == "red" and j.get("status") == "completed"]
    return [{"name": j.get("name"), "conclusion": j.get("conclusion"), "url": j.get("url")} for j in failed[:MAX_JOBS]]


def report(runner, workflows, branch):
    """The report dict and its exit code; Unavailable propagates (exit 3)."""
    entries = [workflow_status(runner, w, branch) for w in workflows]
    code = 1 if any(e["verdict"] == "red" for e in entries) else 0
    return {"branch": branch, "workflows": entries, "exit": code}, code


def describe(entry):
    run = entry["verdict_run"]
    where = f" at {run['headSha'][:12]} ({run['url']})" if run and run.get("headSha") and run.get("url") else ""
    lines = [f"{entry['workflow']}: {entry['verdict']}{where}"]
    if entry["latest_completed_state"] == "cancelled":
        lines.append(f"  latest completed run was cancelled: {entry['latest_completed']['url']}")
    if entry["in_progress"]:
        lines.append(f"  {entry['in_progress']} newer run(s) still queued or in progress")
    for job in entry.get("failed_jobs", []):
        lines.append(f"  failed job: {job['name']} ({job['conclusion']}) {job['url'] or ''}".rstrip())
    return lines


def main(argv=None, runner=run_gh, root=ROOT):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="print the report as one JSON object")
    parser.add_argument("--sha", help="full candidate SHA; require complete coordinator-gate CI before promotion")
    parser.add_argument("--branch", default=None, help="the branch whose runs are read (default main)")
    parser.add_argument("--workflow", action="append", dest="workflows",
                        help="a workflow file in .github/workflows/ (repeatable; default: .conclave/ci.json, else all)")
    args = parser.parse_args(argv)
    args.branch = args.branch or ("coordinator-gate" if args.sha else "main")
    if args.sha:
        if not re.fullmatch(r"[0-9a-f]{40}", args.sha) or args.branch != "coordinator-gate" or args.workflows not in (None, ["ci.yml"]):
            parser.error("--sha requires a full lowercase SHA, coordinator-gate and ci.yml")
        try:
            result, code = gate_report(runner, args.sha)
        except Unavailable as exc:
            result, code = {"mode":"exact-gate", "sha":args.sha, "verdict":"unknown", "error":str(exc), "exit":3}, 3
        print(json.dumps(result) if args.json else f"CI {args.sha}: {result['verdict']} ({result.get('reason', result.get('error', 'all required jobs passed'))})")
        return code
    directory = Path(root) / ".github" / "workflows"
    try:
        workflows = args.workflows or watched(root)
    except ValueError as exc:
        parser.error(str(exc))
    missing = [w for w in workflows if "/" in w or "\\" in w or not (directory / w).is_file()]
    if missing or not workflows or not args.branch.strip():
        parser.error(f"no such workflow in .github/workflows/: {', '.join(missing)}" if missing
                     else "no workflow to watch, or an empty --branch")
    try:
        result, code = report(runner, workflows, args.branch)
    except Unavailable as exc:
        if args.json:
            print(json.dumps({"branch": args.branch, "error": str(exc), "exit": 3}))
        else:
            print(f"ci-status unknown: {exc}")
        return 3
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for entry in result["workflows"]:
            print("\n".join(describe(entry)))
    return code


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
