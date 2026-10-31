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
BUILD = re.compile(r"wrangler deploy --dry-run(?: --outdir [\w./-]+)?")
# One definition of a gate: test_worker_gates.py's, loaded by path so this works however the suite is started.
_spec = importlib.util.spec_from_file_location("worker_gates", pathlib.Path(__file__).with_name("test_worker_gates.py"))
_worker_gates = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_worker_gates)
gates = _worker_gates.gates
WORKFLOW = ".github/workflows/ci.yml"
REQUIRED = ["typecheck", "lint", "test", "build"]  # the Worker gates D00 T01 §2 and §3 built; removing one is a scope change
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
    on = re.search(r"^on:\n((?:[ \t]+.*\n?)*)", text, re.M)
    if "on:" not in top or not on or sorted(l.strip() for l in on.group(1).splitlines() if l.strip()) != ["pull_request:", "push:"]:
        out.append("not triggered on every push and pull_request")
    if re.search(r"^\s+(?:- )?(?:if|continue-on-error):", text, re.M):
        out.append("a step or job can be skipped or have its failure ignored")
    if not re.search(r"^permissions:\n  contents: read\s*$", text, re.M) or re.search(r":\s*write\b", text):
        out.append("token is not read-only")
    for line in re.findall(r"uses:\s*\S+.*", text):
        if not re.match(r"uses: [\w.-]+/[\w.-]+@[0-9a-f]{40} # v\d", line):
            out.append(f"unpinned action: {line}")
    for job, lines in jobs(text).items():
        if not any(re.match(r"^    timeout-minutes: \d+\s*$", line) for line in lines):
            out.append(f"job {job} has no timeout-minutes")
    runs = {match.strip() for match in re.findall(r"^\s+(?:- )?run: (.+)$", text, re.M)}
    for job, lines in jobs(text).items():  # a sharded test gate counts as run only when every shard runs
        for line in lines:
            shard = SHARDED.match(line)
            if not shard:
                continue
            wanted, listed = list(range(1, int(shard.group(1)) + 1)), shard_matrix(lines)
            # GitHub drops a matrix entry an `exclude` names (and `include` adds ones the list does not show), so the
            # listed shards are the ones that run only when the job declares neither.
            reshaped = any(re.match(r"^\s+(?:exclude|include):", line) for line in lines)
            if reshaped:
                out.append(f"job {job} shards pnpm test but its matrix has an exclude or include, so a shard can drop out")
            elif listed == wanted:
                runs.add("pnpm test")
            else:
                out.append(f"job {job} shards pnpm test {len(wanted)} ways but its matrix lists shards {listed}")
    for name in REQUIRED:
        if name not in package.get("scripts", {}):
            out.append(f"package.json has no {name} script")
    for command in FIXED + [f"pnpm {name}" for name in sorted(set(gates(package)) | set(REQUIRED))]:
        if command not in runs:
            out.append(f"gate not run: {command}")
    if re.search(r"\bsecrets\b", text):
        out.append("reads a secret")
    if re.search(r"wrangler deploy(?![^\n]*--dry-run)", text) or re.search(r"\bpnpm dev\b", text):
        out.append("deploys or serves")
    if "build" in package.get("scripts", {}) and not BUILD.fullmatch(package["scripts"]["build"]):
        out.append("pnpm build is not only a dry run")
    if "build:assets" in package.get("scripts", {}):
        out.extend(stylesheet_problems(jobs(text)))
    return out


# `pnpm test` split across a job's matrix (D00 T01, 2026-10-31: the suite outgrew one job's time limit).
SHARDED = re.compile(r"^\s+(?:- )?run: pnpm test --shard=\$\{\{ matrix\.shard \}\}/([1-9][0-9]*)\s*$")


def shard_matrix(lines):
    """The shard numbers a job's `matrix: shard: [...]` lists, or None."""
    for line in lines:
        match = re.match(r"^\s+shard: \[([0-9, ]*)\]\s*$", line)
        if match:
            return [int(n) for n in match.group(1).replace(" ", "").split(",") if n]
    return None


GENERATED_CHECK = 'test -z "$(git status --porcelain -- src/web public design/fonts)" || { git status --porcelain -- src/web public design/fonts; exit 1; }'
def steps_of(lines):
    """A job's steps, each as its run command (or None) and its lines."""
    steps, current = [], None
    for line in lines:
        if re.match(r"^      - ", line):
            current = []
            steps.append(current)
        if current is not None:
            current.append(line)
    def run_of(step):
        return next((m.group(1).strip() for line in step for m in [re.match(r"^\s+(?:- )?run: (.+)$", line)] if m), None)
    return [(run_of(step), step) for step in steps]


def stylesheet_problems(all_jobs):
    """The generated assets are rebuilt and any changed or untracked one refused in the Worker job, and every job that
    runs the tests (whole or one shard) builds them first and gives the tests a working Chromium (D07 T01 §2 and §5)."""
    out = []
    order = [run for run, _ in steps_of(all_jobs.get("worker", []))]
    at = [order.index(command) if command in order else -1 for command in ("pnpm build:assets", GENERATED_CHECK)]
    if -1 in at:
        out.append("worker job lacks " + ", ".join(c for c, i in zip(("pnpm build:assets", GENERATED_CHECK), at) if i < 0))
    elif at != sorted(at):
        out.append(f"worker job does not run pnpm build:assets -> {GENERATED_CHECK} in that order")
    testing = {job: steps_of(lines) for job, lines in all_jobs.items()
               if any(run == "pnpm test" or SHARDED.match(f"      - run: {run}") for run, _ in steps_of(lines) if run)}
    if not testing:
        out.append("no job runs pnpm test")
    for job, steps in testing.items():
        runs = [run for run, _ in steps]
        test_at = next(i for i, run in enumerate(runs) if run and (run == "pnpm test" or SHARDED.match(f"      - run: {run}")))
        if "pnpm build:assets" not in runs[:test_at]:
            out.append(f"job {job} runs pnpm test without building the assets first")
        if not any(re.match(r"^\s+MOCKUP_CHROMIUM: \S", line) for line in steps[test_at][1]):
            out.append(f"job {job}: pnpm test has no MOCKUP_CHROMIUM")
    return out


class Repository(unittest.TestCase):
    def test_the_workflow_runs_every_gate_safely(self):
        text = (REPO / WORKFLOW).read_text(encoding="utf-8")
        package = json.loads((REPO / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(problems(text, package), [])
        self.assertGreaterEqual(len(jobs(text)), 2)


class Defects(unittest.TestCase):
    PACKAGE = {"scripts": {"dev": "wrangler dev", "typecheck": "tsc", "lint": "biome check .", "test": "vitest run",
                           "build": "wrangler deploy --dry-run"}}
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
      - run: pnpm lint
      - run: pnpm test
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
        self.assertEqual(self.check(self.GOOD.replace("  pull_request:\n", "")), ["not triggered on every push and pull_request"])

    def test_a_narrowed_trigger_is_caught(self):
        for narrowing in ("    branches: [main]\n", '    paths-ignore: ["src/**"]\n'):
            with self.subTest(narrowing=narrowing):
                bad = self.GOOD.replace("  push:\n", "  push:\n" + narrowing)
                self.assertEqual(self.check(bad), ["not triggered on every push and pull_request"])

    def test_a_skipped_or_ignored_gate_is_caught(self):
        for line in ("        if: false\n", "        continue-on-error: true\n"):
            with self.subTest(line=line):
                bad = self.GOOD.replace("      - run: pnpm typecheck\n", "      - run: pnpm typecheck\n" + line)
                self.assertEqual(self.check(bad), ["a step or job can be skipped or have its failure ignored"])
        bad = self.GOOD.replace("    timeout-minutes: 10\n", "    timeout-minutes: 10\n    continue-on-error: true\n")
        self.assertEqual(self.check(bad), ["a step or job can be skipped or have its failure ignored"])

    def test_a_write_token_is_caught(self):
        bad = self.GOOD.replace("  contents: read\n", "  contents: read\n  pull-requests: write\n")
        self.assertEqual(self.check(bad), ["token is not read-only"])

    def test_a_job_without_a_timeout_is_caught(self):
        self.assertEqual(self.check(self.GOOD.replace("    timeout-minutes: 5\n", "")), ["job todo has no timeout-minutes"])

    def test_a_dropped_gate_is_caught(self):
        self.assertEqual(self.check(self.GOOD.replace("      - run: pnpm typecheck\n", "")), ["gate not run: pnpm typecheck"])

    def test_a_new_package_gate_is_caught_until_run(self):
        package = {"scripts": dict(self.PACKAGE["scripts"], audit="pnpm audit")}
        self.assertEqual(self.check(self.GOOD, package), ["gate not run: pnpm audit"])

    def test_a_removed_required_script_is_caught_everywhere(self):
        scripts = {k: v for k, v in self.PACKAGE["scripts"].items() if k != "build"}
        bad = self.GOOD.replace("      - run: pnpm build\n", "")
        self.assertEqual(self.check(bad, {"scripts": scripts}), ["package.json has no build script", "gate not run: pnpm build"])

    def test_a_commented_out_gate_is_caught(self):
        bad = self.GOOD.replace("      - run: pnpm build\n", "      # - run: pnpm build\n")
        self.assertEqual(self.check(bad), ["gate not run: pnpm build"])

    def test_a_secret_or_a_deploy_is_caught(self):
        for use in ("${{ secrets.T }}", "${{ secrets['T'] }}"):
            with self.subTest(use=use):
                secret = self.GOOD.replace("      - run: pnpm build\n", f"      - run: pnpm build\n        env:\n          T: {use}\n")
                self.assertEqual(self.check(secret), ["reads a secret"])
        deploy = self.GOOD.replace("      - run: pnpm build\n", "      - run: pnpm build\n      - run: pnpm exec wrangler deploy\n")
        self.assertEqual(self.check(deploy), ["deploys or serves"])

    STYLED = {"scripts": dict(PACKAGE["scripts"], **{"build:assets": "pnpm build:css && node scripts/hash-asset.ts"})}
    STYLED_GOOD = GOOD.replace("      - run: pnpm test\n", "      - run: pnpm build:assets\n      - run: " + GENERATED_CHECK + "\n"
                               "      - run: pnpm test\n        env:\n          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n")

    def test_the_styles_steps_pass_in_order(self):
        self.assertEqual(self.check(self.STYLED_GOOD, self.STYLED), [])

    def test_a_dropped_stale_styles_check_is_caught(self):
        bad = self.STYLED_GOOD.replace("      - run: " + GENERATED_CHECK + "\n", "")
        self.assertEqual(self.check(bad, self.STYLED), ["worker job lacks " + GENERATED_CHECK])

    def test_styles_built_after_the_tests_are_caught(self):
        bad = self.STYLED_GOOD.replace("      - run: pnpm build:assets\n", "").replace(
            "          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n",
            "          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n      - run: pnpm build:assets\n")
        self.assertEqual(self.check(bad, self.STYLED),
                         [f"worker job does not run pnpm build:assets -> {GENERATED_CHECK} in that order",
                          "job worker runs pnpm test without building the assets first"])

    def test_a_diff_only_check_that_misses_untracked_files_is_caught(self):
        bad = self.STYLED_GOOD.replace(GENERATED_CHECK, "git diff --exit-code -- src/web public")
        self.assertEqual(self.check(bad, self.STYLED), ["worker job lacks " + GENERATED_CHECK])

    def test_a_test_step_without_chrome_is_caught(self):
        bad = self.STYLED_GOOD.replace("        env:\n          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n", "")
        self.assertEqual(self.check(bad, self.STYLED), ["job worker: pnpm test has no MOCKUP_CHROMIUM"])

    # The suite split across a matrix job (2026-10-31): every shard runs, each after the assets, each with Chromium.
    SHARDED_GOOD = STYLED_GOOD.replace(
        "      - run: pnpm test\n        env:\n          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n", "").replace(
        "  todo:\n", "  tests:\n    runs-on: ubuntu-24.04\n    timeout-minutes: 25\n    strategy:\n      fail-fast: false\n"
        "      matrix:\n        shard: [1, 2, 3]\n    steps:\n      - run: pnpm install --frozen-lockfile\n"
        "      - run: pnpm build:assets\n      - run: pnpm test --shard=${{ matrix.shard }}/3\n        env:\n"
        "          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n  todo:\n")

    def test_the_sharded_suite_passes(self):
        self.assertEqual(self.check(self.SHARDED_GOOD, self.STYLED), [])

    def test_a_dropped_or_extra_shard_is_caught(self):
        for listed, shown in (("[1, 2]", "[1, 2]"), ("[1, 3]", "[1, 3]"), ("[1, 2, 3, 4]", "[1, 2, 3, 4]")):
            with self.subTest(listed=listed):
                bad = self.SHARDED_GOOD.replace("shard: [1, 2, 3]", f"shard: {listed}")
                self.assertEqual(self.check(bad, self.STYLED),
                                 [f"job tests shards pnpm test 3 ways but its matrix lists shards {shown}",
                                  "gate not run: pnpm test"])
        bad = self.SHARDED_GOOD.replace("        shard: [1, 2, 3]\n", "")
        self.assertEqual(self.check(bad, self.STYLED),
                         ["job tests shards pnpm test 3 ways but its matrix lists shards None", "gate not run: pnpm test"])

    def test_a_matrix_that_excludes_or_adds_entries_is_caught(self):
        # Review of the sharding (P1): `exclude: [{shard: 3}]` ran two shards and the contract passed.
        for extra in ("        exclude:\n          - shard: 3\n", "        include:\n          - shard: 4\n"):
            with self.subTest(extra=extra):
                bad = self.SHARDED_GOOD.replace("        shard: [1, 2, 3]\n", "        shard: [1, 2, 3]\n" + extra)
                self.assertEqual(self.check(bad, self.STYLED),
                                 ["job tests shards pnpm test but its matrix has an exclude or include, so a shard can "
                                  "drop out", "gate not run: pnpm test"])

    def test_a_shard_without_its_assets_or_chrome_is_caught(self):
        bad = self.SHARDED_GOOD.replace("      - run: pnpm build:assets\n      - run: pnpm test --shard", "      - run: pnpm test --shard")
        self.assertEqual(self.check(bad, self.STYLED), ["job tests runs pnpm test without building the assets first"])
        bad = self.SHARDED_GOOD.replace("/3\n        env:\n          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n", "/3\n")
        self.assertEqual(self.check(bad, self.STYLED), ["job tests: pnpm test has no MOCKUP_CHROMIUM"])

    def test_a_worker_job_that_stops_checking_the_generated_files_is_caught_when_sharded(self):
        bad = self.SHARDED_GOOD.replace("      - run: " + GENERATED_CHECK + "\n", "")
        self.assertEqual(self.check(bad, self.STYLED), ["worker job lacks " + GENERATED_CHECK])

    def test_a_build_script_that_really_deploys_is_caught(self):
        for build in ("wrangler deploy", "wrangler deploy --dry-run && wrangler deploy", "wrangler deploy --dry-run; wrangler deploy"):
            with self.subTest(build=build):
                package = {"scripts": dict(self.PACKAGE["scripts"], build=build)}
                self.assertEqual(self.check(self.GOOD, package), ["pnpm build is not only a dry run"])


if __name__ == "__main__":
    unittest.main()
