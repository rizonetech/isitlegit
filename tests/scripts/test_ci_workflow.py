""".github/workflows/ci.yml runs every gate, on every push and pull request, with pinned actions, a read-only token, a
time bound on every job, and no deploy or secret.

The gates are the package.json scripts test_worker_gates.py treats as gates, plus the frozen install, the TODO graph checks
and both Python suites, so a script added later fails here until CI runs it. The workflow is read as text (the file is
ours and plain), keeping tests/scripts on the standard library."""
import importlib.util
import json
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
# One definition of a gate: test_worker_gates.py's, loaded by path so this works however the suite is started.
_spec = importlib.util.spec_from_file_location("worker_gates", pathlib.Path(__file__).with_name("test_worker_gates.py"))
_worker_gates = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_worker_gates)
gates = _worker_gates.gates
WORKFLOW = ".github/workflows/ci.yml"
FIXED = ["pnpm install --frozen-lockfile", "python3 scripts/todo-graph.py validate", "python3 scripts/todo-graph.py plan --check",
         "python3 -m unittest discover -s tests/scripts", "python3 -m unittest discover -s scripts/tests"]


def jobs(text):
    """{job id: its block of lines} for the jobs under the top-level `jobs:` key."""
    found, current, inside = {}, None, False
    for line in text.splitlines():
        if re.match(r"^\S", line):
            inside, current = line.startswith("jobs:"), None
            continue
        match = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if inside and match:
            current = match.group(1)
            found[current] = []
        elif inside and current:
            found[current].append(line)
    return found


def problems(text, package):
    """Every way the workflow falls short, as readable strings (empty when it is right)."""
    out = []
    top = {line.rstrip() for line in text.splitlines() if re.match(r"^\S", line)}
    if "on:" not in top or not re.search(r"^  push:\s*$", text, re.M) or not re.search(r"^  pull_request:\s*$", text, re.M):
        out.append("not triggered on push and pull_request")
    if not re.search(r"^permissions:\n  contents: read\s*$", text, re.M) or re.search(r":\s*write\b", text):
        out.append("token is not read-only")
    for line in re.findall(r"uses:\s*\S+.*", text):
        if not re.match(r"uses: [\w.-]+/[\w.-]+@[0-9a-f]{40} # v\d", line):
            out.append(f"unpinned action: {line}")
    for job, lines in jobs(text).items():
        if not any(re.match(r"^    timeout-minutes: \d+\s*$", line) for line in lines):
            out.append(f"job {job} has no timeout-minutes")
    runs = {match.strip() for match in re.findall(r"^\s+(?:- )?run: (.+)$", text, re.M)}
    for command in FIXED + [f"pnpm {name}" for name in gates(package)]:
        if command not in runs:
            out.append(f"gate not run: {command}")
    if re.search(r"secrets\.", text):
        out.append("reads a secret")
    if re.search(r"wrangler deploy(?![^\n]*--dry-run)", text) or re.search(r"\bpnpm dev\b", text):
        out.append("deploys or serves")
    if "--dry-run" not in package.get("scripts", {}).get("build", "--dry-run"):
        out.append("pnpm build is not a dry run")
    return out


class Repository(unittest.TestCase):
    def test_the_workflow_runs_every_gate_safely(self):
        text = (REPO / WORKFLOW).read_text(encoding="utf-8")
        package = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(problems(text, package), [])
        self.assertGreaterEqual(len(jobs(text)), 2)


class Defects(unittest.TestCase):
    PACKAGE = {"scripts": {"dev": "wrangler dev", "typecheck": "tsc", "build": "wrangler deploy --dry-run"}}
    GOOD = """name: CI
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  worker:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm build
  todo:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - run: python3 scripts/todo-graph.py validate
      - run: python3 scripts/todo-graph.py plan --check
      - run: python3 -m unittest discover -s tests/scripts
      - run: python3 -m unittest discover -s scripts/tests
"""

    def check(self, text, package=None):
        return problems(text, package or self.PACKAGE)

    def test_the_good_workflow_passes(self):
        self.assertEqual(self.check(self.GOOD), [])

    def test_a_tag_pin_is_caught(self):
        bad = self.GOOD.replace("@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", "@v7")
        self.assertEqual(self.check(bad), ["unpinned action: uses: actions/checkout@v7"])

    def test_a_missing_trigger_is_caught(self):
        self.assertEqual(self.check(self.GOOD.replace("  pull_request:\n", "")), ["not triggered on push and pull_request"])

    def test_a_write_token_is_caught(self):
        bad = self.GOOD.replace("  contents: read\n", "  contents: read\n  pull-requests: write\n")
        self.assertEqual(self.check(bad), ["token is not read-only"])

    def test_a_job_without_a_timeout_is_caught(self):
        self.assertEqual(self.check(self.GOOD.replace("    timeout-minutes: 5\n", "")), ["job todo has no timeout-minutes"])

    def test_a_dropped_gate_is_caught(self):
        self.assertEqual(self.check(self.GOOD.replace("      - run: pnpm typecheck\n", "")), ["gate not run: pnpm typecheck"])

    def test_a_new_package_gate_is_caught_until_run(self):
        package = {"scripts": dict(self.PACKAGE["scripts"], lint="biome check .")}
        self.assertEqual(self.check(self.GOOD, package), ["gate not run: pnpm lint"])

    def test_a_commented_out_gate_is_caught(self):
        bad = self.GOOD.replace("      - run: pnpm build\n", "      # - run: pnpm build\n")
        self.assertEqual(self.check(bad), ["gate not run: pnpm build"])

    def test_a_secret_or_a_deploy_is_caught(self):
        secret = self.GOOD.replace("      - run: pnpm build\n", "      - run: pnpm build\n        env:\n          T: ${{ secrets.T }}\n")
        self.assertEqual(self.check(secret), ["reads a secret"])
        deploy = self.GOOD.replace("      - run: pnpm build\n", "      - run: pnpm build\n      - run: pnpm exec wrangler deploy\n")
        self.assertEqual(self.check(deploy), ["deploys or serves"])

    def test_a_build_script_that_really_deploys_is_caught(self):
        package = {"scripts": dict(self.PACKAGE["scripts"], build="wrangler deploy")}
        self.assertEqual(self.check(self.GOOD, package), ["pnpm build is not a dry run"])


if __name__ == "__main__":
    unittest.main()
