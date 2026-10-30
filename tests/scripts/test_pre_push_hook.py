"""scripts/hooks/pre-push (D00 T01 §13): a push whose tree fails the type check or the lint is refused before anything
leaves, and the check only ever judges the commit actually pushed."""
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
HOOK = "scripts/hooks/pre-push"
# A pnpm that records each command and the folder it ran in, and fails the one named in PNPM_FAIL, after PNPM_NOISE
# warning lines. With PUSH_ERR (the push's stderr, a file), it also records whether the hook had already announced it.
# A failing lint with PNPM_BIOME set prints Biome-like warning blocks (whose words a word search matches) before its
# one error; its error-level rerun (`lint --diagnostic-level=error`) then does what PNPM_ERRLEVEL says: `errors`
# prints only the error and exits 1, `pass` exits 0 silently, `launch` fails to start (exit 127, a shell's message).
FAKE_PNPM = """#!/bin/sh
echo "$1 $(pwd)${2:+ $2}" >> "$PNPM_LOG"
if [ -n "$PUSH_ERR" ] && [ -z "$2" ]; then
    grep -c "running pnpm $1" "$PUSH_ERR" >> "$PNPM_LOG.announced"
fi
if [ "$1" = lint ] && [ "$2" = "--diagnostic-level=error" ] && [ -n "$PNPM_ERRLEVEL" ]; then
    case "$PNPM_ERRLEVEL" in
        errors) echo "test/a.test.ts format ━━━━━━━━━━"; echo "  × Formatter would have printed the following content"
                exit 1 ;;
        pass) exit 0 ;;
        launch) echo "sh: 1: biome: not found" >&2; exit 127 ;;
    esac
fi
if [ "$1" = lint ] && [ "$1" = "$PNPM_FAIL" ] && [ -n "$PNPM_BIOME" ]; then
    echo "scripts/glimmer/source-pages.ts:9:3 lint/complexity/noCommaOperator ━━━━━━━━━━"
    echo "  ! The comma operator is disallowed: an error-prone pattern that failed review."
    echo "  × Warning block one, whose words match a search for error."
    echo "test/a.test.ts format ━━━━━━━━━━"
    echo "  × Formatter would have printed the following content"
    echo "Checked 266 files. Found 1 error. Found 13 warnings."
    exit 1
fi
if [ "$1" = "$PNPM_FAIL" ]; then
    i=0
    while [ "$i" -lt "${PNPM_NOISE:-0}" ]; do echo "warning: preliminary line $i"; i=$((i + 1)); done
    echo "src/x.ts(3,7): error TS2339: the $1 failure"
    exit 2
fi
exit 0
"""


@unittest.skipUnless(shutil.which("git") and shutil.which("sh"), "needs git and a shell")
class PrePushHook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pre-push-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        base = pathlib.Path(self.tmp)
        self.root, self.remote, self.bin = base / "work", base / "remote.git", base / "bin"
        self.log = base / "pnpm.log"
        for folder in (self.root / "scripts/hooks", self.bin):
            folder.mkdir(parents=True)
        shutil.copyfile(REPO / HOOK, self.root / HOOK)
        (self.root / HOOK).chmod(0o755)
        (self.bin / "pnpm").write_text(FAKE_PNPM, encoding="utf-8")
        (self.bin / "pnpm").chmod(0o755)
        (self.root / "node_modules").mkdir()
        (self.root / ".gitignore").write_text("node_modules/\n", encoding="utf-8")
        (self.root / "a.txt").write_text("a\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", "--bare", str(self.remote)], check=True)
        for args in (["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"],
                     ["config", "maintenance.auto", "false"], ["add", "-A"], ["commit", "-qm", "seed"],
                     ["remote", "add", "origin", str(self.remote)], ["config", "core.hooksPath", "scripts/hooks"]):
            self.git(*args)
        self.git("push", "-q", "origin", "main", env={"PNPM_FAIL": ""})
        self.log.unlink(missing_ok=True)

    def env(self, **extra):
        path = f"{self.bin}{os.pathsep}{os.environ['PATH']}"
        return {**os.environ, "PATH": path, "PNPM_LOG": str(self.log), "PNPM_FAIL": "", **extra}

    def git(self, *args, cwd=None, env=None, check=True):
        return subprocess.run(["git", *args], cwd=cwd or self.root, env=self.env(**(env or {})), capture_output=True,
                              text=True, check=check, timeout=60)

    def commit(self, name="b.txt", text="b\n"):
        (self.root / name).write_text(text, encoding="utf-8")
        self.git("add", name)
        self.git("commit", "-qm", f"add {name}")
        return self.git("rev-parse", "HEAD").stdout.strip()

    def remote_main(self):
        return subprocess.run(["git", "--git-dir", str(self.remote), "rev-parse", "main"], capture_output=True,
                              text=True).stdout.strip()

    def calls(self):
        return self.log.read_text(encoding="utf-8").split("\n")[:-1] if self.log.exists() else []

    def push(self, *refs, fail="", cwd=None):
        return self.git("push", "origin", *(refs or ("main",)), cwd=cwd, env={"PNPM_FAIL": fail}, check=False)

    def refused(self, done, fragment):
        self.assertNotEqual(done.returncode, 0, done.stderr)
        self.assertIn(fragment, done.stderr)

    def test_a_clean_push_runs_the_type_check_and_the_lint(self):
        sha = self.commit()
        done = self.push()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([c.split()[0] for c in self.calls()], ["typecheck", "lint"])
        self.assertEqual(self.remote_main(), sha)

    def test_each_check_is_announced_before_it_runs_and_reported_when_it_passes(self):
        self.commit()
        err = pathlib.Path(self.tmp) / "push.err"
        with err.open("w") as sink:
            done = subprocess.run(["git", "push", "origin", "main"], cwd=self.root, stdout=subprocess.DEVNULL,
                                  stderr=sink, env=self.env(PUSH_ERR=str(err)), timeout=60)
        text = err.read_text(encoding="utf-8")
        self.assertEqual(done.returncode, 0, text)
        self.assertEqual(pathlib.Path(f"{self.log}.announced").read_text().split(), ["1", "1"],
                         "each check was announced before it began")
        order = [text.index(line) for line in ("running pnpm typecheck", "pnpm typecheck passed", "running pnpm lint",
                                               "pnpm lint passed")]
        self.assertEqual(order, sorted(order))

    def test_the_error_is_shown_even_after_many_warning_lines(self):
        self.commit()
        done = self.git("push", "origin", "main", env={"PNPM_FAIL": "typecheck", "PNPM_NOISE": "25"}, check=False)
        self.refused(done, "error TS2339: the typecheck failure")
        self.assertNotIn("preliminary line", done.stderr)

    def test_a_status_that_cannot_be_read_is_refused_with_no_check(self):
        before = self.remote_main()
        self.commit()
        (self.root / ".git" / "index").write_bytes(b"not an index")
        done = self.push()
        self.refused(done, "git status failed")
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.remote_main(), before)

    def test_the_escape_is_gits_own_no_verify_and_nothing_the_hook_reads(self):
        # The repository's rules forbid skipping hooks; this proves, in a scratch clone, that the only way past the hook
        # is git's documented option, so no variable can quietly turn the check off.
        sha = self.commit()
        for name in ("SKIP", "SKIP_PRE_PUSH", "NO_VERIFY", "HUSKY"):
            done = self.git("push", "origin", "main", env={"PNPM_FAIL": "typecheck", name: "1"}, check=False)
            self.refused(done, "'pnpm typecheck' failed")
        done = self.git("push", "--no-verify", "origin", "main", env={"PNPM_FAIL": "typecheck"}, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.remote_main(), sha)

    def test_a_type_error_is_refused_with_its_first_lines_and_the_remote_unchanged(self):
        before = self.remote_main()
        self.commit()
        done = self.push(fail="typecheck")
        self.refused(done, "'pnpm typecheck' failed")
        self.assertIn("the typecheck failure", done.stderr)
        self.assertEqual(self.remote_main(), before)

    def test_a_lint_error_alone_is_refused_after_the_type_check_passed(self):
        before = self.remote_main()
        self.commit()
        done = self.push(fail="lint")
        self.refused(done, "'pnpm lint' failed")
        self.assertIn("the lint failure", done.stderr)
        self.assertIn("'pnpm lint' shows the whole output", done.stderr)
        self.assertEqual([c.split()[0] for c in self.calls()], ["typecheck", "lint", "lint"])
        self.assertTrue(self.calls()[2].endswith(" --diagnostic-level=error"), "the excerpt asks Biome for errors")
        self.assertEqual(self.remote_main(), before)

    def lint(self, errlevel):
        self.commit(name=f"{errlevel}.txt")
        return self.git("push", "origin", "main", env={"PNPM_FAIL": "lint", "PNPM_BIOME": "1",
                                                      "PNPM_ERRLEVEL": errlevel}, check=False)

    def test_a_lint_excerpt_shows_biomes_errors_and_none_of_its_warnings(self):
        before = self.remote_main()
        done = self.lint("errors")
        self.refused(done, "'pnpm lint' failed (exit 1)")
        excerpt = done.stderr.split("its errors:", 1)[1]
        self.assertIn("Formatter would have printed", excerpt)
        self.assertNotIn("noCommaOperator", excerpt)
        self.assertNotIn("Warning block one", excerpt)
        self.assertEqual(self.remote_main(), before)

    def test_an_error_level_run_that_names_no_error_falls_back_to_the_opening_lines(self):
        for errlevel in ("pass", "launch"):
            with self.subTest(errlevel):
                before = self.remote_main()
                done = self.lint(errlevel)
                self.refused(done, "'pnpm lint' failed (exit 1)")
                self.assertIn("Biome's error-level run named no errors; the lint's opening lines:", done.stderr)
                self.assertIn("noCommaOperator", done.stderr, "the first run's opening lines")
                self.assertNotIn("biome: not found", done.stderr, "a launch failure is not the lint's errors")
                self.assertEqual(self.remote_main(), before, "refused on the first run's status")

    def test_a_typecheck_failure_without_a_ts_code_shows_its_opening_lines(self):
        self.commit()
        (self.bin / "pnpm").write_text(FAKE_PNPM.replace(
            'echo "src/x.ts(3,7): error TS2339: the $1 failure"',
            'echo "✘ [ERROR] worker-configuration.d.ts is out of date: run wrangler types"'), encoding="utf-8")
        done = self.push(fail="typecheck")
        self.refused(done, "'pnpm typecheck' failed (exit 2)")
        self.assertIn("worker-configuration.d.ts is out of date", done.stderr)

    def test_a_missing_pnpm_or_node_modules_refuses_naming_what_to_install(self):
        before = self.remote_main()
        self.commit()
        (self.bin / "pnpm").unlink()
        done = self.git("push", "origin", "main", env={"PATH": "/usr/bin:/bin"}, check=False)
        self.refused(done, "pnpm is not on PATH")
        (self.bin / "pnpm").write_text(FAKE_PNPM, encoding="utf-8")
        (self.bin / "pnpm").chmod(0o755)
        shutil.rmtree(self.root / "node_modules")
        self.refused(self.push(), "node_modules is missing")
        self.assertEqual(self.remote_main(), before)

    def test_a_tree_that_differs_from_head_is_refused_naming_its_files(self):
        before = self.remote_main()
        self.commit()
        for change in ("staged", "unstaged", "untracked"):
            with self.subTest(change=change):
                path = self.root / f"{change}.txt"
                if change == "unstaged":
                    path = self.root / "a.txt"
                path.write_text(f"{change}\n", encoding="utf-8")
                if change == "staged":
                    self.git("add", path.name)
                done = self.push()
                self.refused(done, "commit or stash these first")
                self.assertIn(path.name, done.stderr)
                self.assertEqual(self.remote_main(), before)
                self.git("reset", "-q", "--hard")
                self.git("clean", "-qfd", "-e", "node_modules")
        self.assertEqual(self.calls(), [], "no check runs on a tree it cannot judge")

    def test_another_branchs_tip_or_a_second_ref_is_refused(self):
        before = self.remote_main()
        self.git("checkout", "-qb", "lane")
        lane = self.commit("lane.txt")
        self.git("checkout", "-q", "main")
        done = self.push("lane")
        self.refused(done, f"refs/heads/lane ({lane}) is not this worktree's HEAD")
        self.commit("c.txt")
        done = self.push("main", "lane")
        self.refused(done, "refs/heads/lane")
        lanes = subprocess.run(["git", "--git-dir", str(self.remote), "branch", "--list", "lane"], capture_output=True,
                               text=True).stdout
        self.assertEqual(lanes, "", "nothing of either ref reached the remote")
        self.assertEqual(self.remote_main(), before)

    def test_a_deletion_or_an_empty_push_passes_without_any_check_and_a_mixed_one_is_checked(self):
        self.git("checkout", "-qb", "old")
        self.git("push", "-q", "origin", "old", env={"PNPM_FAIL": ""})
        self.git("checkout", "-q", "main")
        self.log.unlink(missing_ok=True)
        (self.bin / "pnpm").unlink()  # no check can run, and none is needed
        done = self.git("push", "origin", "--delete", "old", env={"PATH": "/usr/bin:/bin"}, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.git("push", "origin", "main", env={"PATH": "/usr/bin:/bin"}, check=False)
        self.assertEqual(done.returncode, 0, done.stderr)  # already up to date: nothing goes, no hook line
        (self.bin / "pnpm").write_text(FAKE_PNPM, encoding="utf-8")
        (self.bin / "pnpm").chmod(0o755)
        self.git("checkout", "-qb", "gone")
        self.git("push", "-q", "origin", "gone", env={"PNPM_FAIL": ""})
        self.git("checkout", "-q", "main")
        before = self.remote_main()
        self.commit("d.txt")
        self.log.unlink(missing_ok=True)
        done = self.push("main", ":gone", fail="typecheck")
        self.refused(done, "'pnpm typecheck' failed")
        self.assertEqual(self.remote_main(), before)
        gone = subprocess.run(["git", "--git-dir", str(self.remote), "branch", "--list", "gone"], capture_output=True,
                              text=True).stdout
        self.assertIn("gone", gone, "the deletion did not go through either")

    def test_only_an_all_zero_id_is_a_deletion(self):
        # Round 1: an id that merely starts with zeros is an update to check, never a deletion skipped.
        head = self.git("rev-parse", "HEAD").stdout.strip()
        cases = {"0" * 40: 0, "0" * 64: 0, "00000000" + head[8:]: 1}
        for sha, code in cases.items():
            with self.subTest(sha=sha[:12]):
                done = subprocess.run(["sh", HOOK, "origin", str(self.remote)], cwd=self.root, env=self.env(),
                                      input=f"(delete) {sha} refs/heads/x {head}\n", capture_output=True, text=True,
                                      timeout=60)
                self.assertEqual(done.returncode, code, done.stderr)
                if code:
                    self.assertIn("is not this worktree's HEAD", done.stderr)

    def test_a_linked_worktree_is_checked_in_its_own_folder(self):
        other = pathlib.Path(self.tmp) / "other"
        self.git("worktree", "add", "-q", "-b", "side", str(other))
        (other / "node_modules").mkdir()
        (other / "side.txt").write_text("side\n", encoding="utf-8")
        self.git("add", "side.txt", cwd=other)
        self.git("commit", "-qm", "side", cwd=other)
        done = self.push("side", cwd=other)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual({c.split(" ", 1)[1] for c in self.calls()}, {str(other.resolve())})


if __name__ == "__main__":
    unittest.main()
