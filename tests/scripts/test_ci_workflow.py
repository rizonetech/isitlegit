""".github/workflows/ci.yml runs every gate on coordinator batches, pull requests and manual dispatch, with pinned actions, a read-only token, a
time bound on every job, and no deploy or secret.

The gates are the package.json scripts test_worker_gates.py treats as gates, plus the frozen install, the TODO graph checks
and both Python suites, so a script added later fails here until CI runs it; with the marketing site's workspace package
(`site/`, D07 T06 §1), its build, check and test too. The workflow is read as text (the file is ours and plain), keeping
tests/scripts on the standard library."""
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


TRIGGERS = "on:\n  push:\n    branches: [coordinator-gate]\n  pull_request:\n  workflow_dispatch:\n"
PROJECT_SHARD = "python3 scripts/ci_unittest_shard.py --shard ${{ matrix.shard }} --shards 4"


def trigger_problems(text):
    match = re.search(r"^on:\n((?:[ \t]+.*\n?)*)", text, re.M)
    return [] if match and match.group(0) == TRIGGERS else ["not triggered on coordinator-gate push, pull_request and workflow_dispatch only"]


def project_shard_problems(all_jobs):
    lines = all_jobs.get("project-scripts", [])
    text = "\n".join(lines)
    requirements = (
        shard_matrix(lines) == [1, 2, 3, 4],
        "      fail-fast: false" in lines,
        not re.search(r"^\s+(?:include|exclude):", text, re.M),
        "    timeout-minutes: 15" in lines,
        "    name: Project script tests (${{ matrix.shard }} of 4)" in lines,
        "        run: " + PROJECT_SHARD in lines,
        '          REQUIRE_FONT_TOOLS: "1"' in lines,
        "          MOCKUP_CHROMIUM: /usr/bin/google-chrome" in lines,
        "          fetch-depth: 0" in lines,
        "        run: pip install -r design/tools/requirements.txt" in lines,
    )
    return [] if all(requirements) else ["project tests require all four isolated complete shards and original setup/limits"]


def problems(text, package, site=None):
    """Every way the workflow falls short, as readable strings (empty when it is right). `site` is the marketing site's
    `site/package.json`, when the repository has one."""
    out = []
    top = {line.rstrip() for line in text.splitlines() if re.match(r"^\S", line)}
    out.extend(trigger_problems(text))
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
        # A stalled shard must end in its own step, under the job's limit, so it stops with the reporter's heartbeat
        # naming its open files instead of a job cancellation that names nothing (2026-10-31). Checked once per job,
        # for every shard step in it, not only the first (review round 2).
        job_limit = next((int(m.group(1)) for l in lines for m in [re.match(r"^    timeout-minutes: (\d+)\s*$", l)] if m), None)
        for run, step in steps_of(lines):
            if not (run and SHARDED.match(f"      - run: {run}")):
                continue
            limit = next((int(m.group(1)) for l in step for m in [re.match(r"^        timeout-minutes: (\d+)\s*$", l)] if m), None)
            if limit is None or job_limit is None or not 0 < limit < job_limit:  # 0 sets no step timeout at all
                out.append(f"job {job}: the pnpm test shard step has no timeout-minutes below the job's")
    if any(PROJECT_SHARD in line for lines in jobs(text).values() for line in lines):
        failures = project_shard_problems(jobs(text))
        out.extend(failures)
        if not failures:
            runs.add("python3 -m unittest discover -s tests/scripts")
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
    if site is not None:
        out.extend(site_problems(jobs(text), site))
    return out


SITE_GATES = ["build", "check", "test"]  # the marketing site's gates (D07 T06 §1); its test reads the built site


def site_problems(all_jobs, site):
    """The Worker job runs the site's build, check and test after the Worker's own build, the test after the site build."""
    out = [f"site/package.json has no {name} script" for name in SITE_GATES if name not in site.get("scripts", {})]
    order = [run for run, _ in steps_of(all_jobs.get("worker", []))]
    at = {command: order.index(command) if command in order else -1
          for command in ["pnpm build"] + [f"pnpm --filter site {name}" for name in SITE_GATES]}
    for name in SITE_GATES:
        command = f"pnpm --filter site {name}"
        if at[command] < 0:
            out.append(f"worker job does not run {command}")
        elif at[command] < at["pnpm build"] or at["pnpm build"] < 0:
            out.append(f"worker job runs {command} before pnpm build")
    if 0 <= at["pnpm --filter site test"] < at["pnpm --filter site build"]:
        out.append("worker job runs pnpm --filter site test before pnpm --filter site build")
    return out


# `pnpm test` split across a job's matrix (D00 T01, 2026-10-31: the suite outgrew one job's time limit).
SHARDED = re.compile(r"^\s+(?:- )?run: pnpm test (?:--project [a-z0-9]+ |--no-file-parallelism )*--shard=\$\{\{ matrix\.shard \}\}/([1-9][0-9]*)\s*$")


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
        site_path = REPO / "site/package.json"
        site = json.loads(site_path.read_text(encoding="utf-8")) if site_path.exists() else None
        self.assertEqual(problems(text, package, site), [])
        self.assertGreaterEqual(len(jobs(text)), 2)


class Defects(unittest.TestCase):
    PACKAGE = {"scripts": {"dev": "wrangler dev", "typecheck": "tsc", "lint": "biome check .", "test": "vitest run",
                           "build": "wrangler deploy --dry-run"}}
    GOOD = """name: CI
on:
  push:
    branches: [coordinator-gate]
  pull_request:
  workflow_dispatch:
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
        self.assertEqual(self.check(self.GOOD.replace("  pull_request:\n", "")), ["not triggered on coordinator-gate push, pull_request and workflow_dispatch only"])

    def test_a_narrowed_trigger_is_caught(self):
        for narrowing in ("    branches: [main]\n", '    paths-ignore: ["src/**"]\n'):
            with self.subTest(narrowing=narrowing):
                bad = self.GOOD.replace("  push:\n", "  push:\n" + narrowing)
                self.assertEqual(self.check(bad), ["not triggered on coordinator-gate push, pull_request and workflow_dispatch only"])

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
        "          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n        timeout-minutes: 15\n  todo:\n")

    def test_the_sharded_suite_passes(self):
        self.assertEqual(self.check(self.SHARDED_GOOD, self.STYLED), [])

    def test_a_shard_step_without_a_timeout_below_the_job_is_caught(self):
        # 2026-10-31: shards went silent until the 20-minute job limit and the cancellation named no file.
        message = "job tests: the pnpm test shard step has no timeout-minutes below the job's"
        for bad in (self.SHARDED_GOOD.replace("        timeout-minutes: 15\n", ""),
                    self.SHARDED_GOOD.replace("        timeout-minutes: 15\n", "        timeout-minutes: 25\n"),
                    # Review round 1 (P3): GitHub installs a step timeout only for a positive value.
                    self.SHARDED_GOOD.replace("        timeout-minutes: 15\n", "        timeout-minutes: 0\n")):
            with self.subTest(bad=bad[-80:]):
                self.assertEqual(self.check(bad, self.STYLED), [message])
        # Review round 2 (P3): a second shard step without its own timeout was passed by checking only the first.
        second = "      - run: pnpm test --shard=${{ matrix.shard }}/3\n        env:\n          MOCKUP_CHROMIUM: /usr/bin/google-chrome\n"
        bad = self.SHARDED_GOOD.replace("        timeout-minutes: 15\n", "        timeout-minutes: 15\n" + second)
        self.assertEqual(self.check(bad, self.STYLED), [message])

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


class SiteDefects(unittest.TestCase):
    """The marketing site's gates (D07 T06 §1)."""
    SITE = {"scripts": {"build": "astro build", "check": "astro check", "test": "node --test"}}
    STEPS = "      - run: pnpm --filter site build\n      - run: pnpm --filter site check\n      - run: pnpm --filter site test\n"
    GOOD = Defects.GOOD.replace("      - run: pnpm build\n", "      - run: pnpm build\n" + STEPS)

    def check(self, text, site=None):
        return problems(text, Defects.PACKAGE, site or self.SITE)

    def test_the_site_steps_pass_after_the_build(self):
        self.assertEqual(self.check(self.GOOD), [])

    def test_a_workflow_without_a_site_package_needs_no_site_steps(self):
        self.assertEqual(problems(Defects.GOOD, Defects.PACKAGE), [])

    def test_each_dropped_site_step_is_caught(self):
        for name in ("build", "check", "test"):
            with self.subTest(name=name):
                bad = self.GOOD.replace(f"      - run: pnpm --filter site {name}\n", "")
                self.assertEqual(self.check(bad), [f"worker job does not run pnpm --filter site {name}"])

    def test_a_site_step_in_another_job_is_caught(self):
        bad = self.GOOD.replace("      - run: pnpm --filter site check\n", "").replace(
            "      - run: python3 -m unittest discover -s scripts/tests\n",
            "      - run: python3 -m unittest discover -s scripts/tests\n      - run: pnpm --filter site check\n")
        self.assertEqual(self.check(bad), ["worker job does not run pnpm --filter site check"])

    def test_site_steps_before_the_worker_build_are_caught(self):
        bad = self.GOOD.replace("      - run: pnpm build\n" + self.STEPS, self.STEPS + "      - run: pnpm build\n")
        self.assertEqual(self.check(bad), [f"worker job runs pnpm --filter site {name} before pnpm build"
                                           for name in ("build", "check", "test")])

    def test_the_site_test_before_the_site_build_is_caught(self):
        bad = self.GOOD.replace(self.STEPS, "      - run: pnpm --filter site test\n      - run: pnpm --filter site build\n"
                                "      - run: pnpm --filter site check\n")
        self.assertEqual(self.check(bad), ["worker job runs pnpm --filter site test before pnpm --filter site build"])

    def test_a_missing_site_script_is_caught(self):
        site = {"scripts": {k: v for k, v in self.SITE["scripts"].items() if k != "check"}}
        self.assertEqual(self.check(self.GOOD, site), ["site/package.json has no check script"])


def concurrency_problems(text):
    """A superseded lane run may be cancelled, a gated one never: main and coordinator-gate keep every run."""
    found = re.search(r"(?m)^concurrency:\n  group: (.+)\n  cancel-in-progress: (.+)$", text)
    if not found:
        return ["no top-level concurrency block"]
    group, cancel = found.group(1), found.group(2)
    out = []
    if "github.ref" not in group:
        out.append("the concurrency group is not per branch")
    for ref in ("refs/heads/main", "refs/heads/coordinator-gate"):
        if f"github.ref != '{ref}'" not in cancel:
            out.append(f"{ref} runs can be cancelled")
        # A group holds one waiting run, and a newer push replaces it whatever cancel-in-progress says: a gated ref's
        # run needs a group of its own.
        if f"github.ref == '{ref}'" not in group or "github.run_id" not in group:
            out.append(f"{ref} runs share a group, so a newer push replaces a waiting one")
    return out


class Concurrency(unittest.TestCase):
    def test_the_workflow_never_cancels_a_gated_run(self):
        self.assertEqual(concurrency_problems((REPO / WORKFLOW).read_text()), [])

    def test_cancelling_the_gate_is_caught(self):
        bad = "concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n"
        self.assertIn("refs/heads/coordinator-gate runs can be cancelled", concurrency_problems(bad))

    def test_a_waiting_gate_run_replaced_is_caught(self):
        bad = ("concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: ${{ github.ref != 'refs/heads/main' "
               "&& github.ref != 'refs/heads/coordinator-gate' }}\n")
        self.assertIn("refs/heads/coordinator-gate runs share a group, so a newer push replaces a waiting one",
                      concurrency_problems(bad))

    def test_a_shared_group_is_caught(self):
        bad = "concurrency:\n  group: ci\n  cancel-in-progress: ${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/coordinator-gate' }}\n"
        self.assertIn("the concurrency group is not per branch", concurrency_problems(bad))


PROJECT_RUN = re.compile(r"^\s+(?:- )?run: pnpm test (.*)--shard=")


def project_problems(text, projects=("worker", "node", "browser")):
    """Between them the sharded test jobs run every vitest project (vitest.config.ts), and the browser project only one
    file at a time: its Chromium tests starved each other side by side (2026-11-01)."""
    runs = [PROJECT_RUN.match(line).group(1) for line in text.splitlines() if PROJECT_RUN.match(line)]
    out = []
    for name in projects:
        with_it = [r for r in runs if f"--project {name} " in r]
        if not with_it:
            out.append(f"no sharded job runs the {name} project")
        if name == "browser" and any("--no-file-parallelism" not in r for r in with_it):
            out.append("the browser project runs files in parallel")
    return out


class Projects(unittest.TestCase):
    def test_every_project_runs_and_the_browser_one_serially(self):
        self.assertEqual(project_problems((REPO / WORKFLOW).read_text()), [])

    def test_a_dropped_browser_job_is_caught(self):
        text = "      - run: pnpm test --project worker --project node --shard=${{ matrix.shard }}/4\n"
        self.assertIn("no sharded job runs the browser project", project_problems(text))

    def test_parallel_browser_files_are_caught(self):
        text = ("      - run: pnpm test --project worker --project node --shard=${{ matrix.shard }}/4\n"
                "      - run: pnpm test --project browser --shard=${{ matrix.shard }}/3\n")
        self.assertIn("the browser project runs files in parallel", project_problems(text))


class BatchedProjectCI(unittest.TestCase):
    def test_complete_project_matrix_and_exact_gate_names(self):
        text=(REPO/WORKFLOW).read_text()
        self.assertEqual(project_shard_problems(jobs(text)), [])
        spec=importlib.util.spec_from_file_location('exact_ci_status', REPO/'scripts/ci_status.py')
        ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)
        names=[]
        for lines in jobs(text).values():
            name=next(re.match(r'^    name: (.+)$',x).group(1) for x in lines if re.match(r'^    name: (.+)$',x))
            shards=shard_matrix(lines)
            names.extend(name.replace('${{ matrix.shard }}',str(i)) for i in shards) if shards else names.append(name)
        self.assertCountEqual(names,ci.GATE_JOBS)

    def test_project_shard_mutations_refuse(self):
        text=(REPO/WORKFLOW).read_text()
        start=text.index('  project-scripts:');end=text.index('  kit-scripts:',start)
        block=text[start:end]
        for old,new in [('shard: [1, 2, 3, 4]','shard: [1, 2, 4]'),
                        ('shard: [1, 2, 3, 4]','shard: [1, 2, 3, 4, 5]'),
                        ('fail-fast: false','fail-fast: true'),
                        ('--shards 4','--shards 3'),
                        ('REQUIRE_FONT_TOOLS: "1"','REQUIRE_FONT_TOOLS: "0"'),
                        ('timeout-minutes: 15','timeout-minutes: 30'),
                        ('matrix:\n','matrix:\n        exclude: []\n')]:
            with self.subTest(old=old):
                self.assertIn(old,block)
                self.assertTrue(project_shard_problems(jobs(text[:start]+block.replace(old,new)+text[end:])))
        self.assertTrue(project_shard_problems(jobs(text[:start]+text[end:])))

    def test_batch_trigger_contract(self):
        text=(REPO/WORKFLOW).read_text()
        self.assertEqual(trigger_problems(text),[])
        for old,new in [('branches: [coordinator-gate]','branches: [main]'),
                        ('branches: [coordinator-gate]','branches: [coordinator-gate, main]'),
                        ('    branches: [coordinator-gate]\n',''),
                        ('  workflow_dispatch:\n',''),('  pull_request:\n',''),
                        ('  pull_request:\n','  pull_request:\n    paths: [src/**]\n')]:
            with self.subTest(old=old):self.assertTrue(trigger_problems(text.replace(old,new)))
