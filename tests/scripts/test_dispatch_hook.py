"""scripts/dispatch_hook.py: a review runs only through the Bash tool's background option (operator, 2026-10-27)."""
import json
import subprocess
import sys
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parents[2] / "scripts" / "dispatch_hook.py"
REVIEW = ("python3 scripts/review-dispatch.py --writer claude --prompt /tmp/p.md "
          "--record docs/reviews/01-intake/D01-T02-s1.md")


def run(payload) -> subprocess.CompletedProcess:
    data = payload if isinstance(payload, str) else json.dumps(payload)
    return subprocess.run([sys.executable, str(HOOK)], input=data, capture_output=True, text=True, timeout=30)


def bash(command: str, background=None) -> dict:
    tool_input = {"command": command}
    if background is not None:
        tool_input["run_in_background"] = background
    return {"tool_name": "Bash", "tool_input": tool_input}


class DispatchHook(unittest.TestCase):
    def test_a_review_through_the_background_option_runs(self):
        for command in (REVIEW, f"cd /repo && {REVIEW} > /tmp/log 2>&1; echo \"exit $?\""):
            result = run(bash(command, background=True))
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_detached_review_is_refused_even_with_the_option(self):
        for command in (f"{REVIEW} > /tmp/log 2>&1 &", f"nohup {REVIEW} > /tmp/log 2>&1 &",
                        f"({REVIEW}; echo done) & disown", f"setsid {REVIEW}", f"{REVIEW} & sleep 3"):
            for background in (True, False, None):
                result = run(bash(command, background=background))
                self.assertEqual(result.returncode, 2, f"{command} {background}")
                self.assertIn("run_in_background", result.stderr)
                self.assertIn("not detached", result.stderr)

    def test_a_foreground_review_is_refused(self):
        for background in (False, None):
            result = run(bash(REVIEW, background=background))
            self.assertEqual(result.returncode, 2)
            self.assertIn("a review takes minutes", result.stderr)

    def test_calls_that_run_no_review_pass(self):
        for command in ("python3 scripts/review-dispatch.py --check-pin", "python3 scripts/review-dispatch.py --help",
                        "grep -n final scripts/review-dispatch.py", "sleep 3 && echo done 2>&1 &",
                        "pnpm exec vitest run &> /tmp/log"):
            self.assertEqual(run(bash(command)).returncode, 0, command)
        self.assertEqual(run({"tool_name": "Read", "tool_input": {"file_path": REVIEW}}).returncode, 0)

    def test_text_that_only_mentions_the_dispatcher_passes(self):
        # A heredoc writing documentation, and a commit message, mention it beside an `&` without running it.
        for command in (
            "python3 - <<'EOF'\ns = 'Run every review (`scripts/review-dispatch.py ... --prompt ...`) & so on'\nEOF",
            'git commit -m "docs: review-dispatch.py --prompt runs in the background & is watched"',
        ):
            self.assertEqual(run(bash(command)).returncode, 0, command)
        # Yet each way of running it is still caught.
        for command in (f"./scripts/{REVIEW.split('scripts/')[1]} &", f"cd /r; scripts/{REVIEW.split('scripts/')[1]}",
                        f"exec {REVIEW}", f"python {REVIEW.split('python3 ')[1]} &"):
            self.assertEqual(run(bash(command)).returncode, 2, command)

    def test_redirections_are_not_taken_for_detaching(self):
        result = run(bash(f"{REVIEW} > /tmp/log 2>&1 && echo ok || echo failed &> /dev/null", background=True))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_an_astra_run_goes_through_the_background_option_only(self):
        # D03 T04 §4 and §9: collection and judging take hours, so they follow the review rule.
        for script in ("astra-collect", "astra-judge"):
            command = f"python3 scripts/{script}.py"
            self.assertEqual(run(bash(command, background=True)).returncode, 0, command)
            for background in (False, None):
                result = run(bash(command, background=background))
                self.assertEqual(result.returncode, 2, f"{command} {background}")
                self.assertIn("an Astra run takes hours", result.stderr)
            for detached in (f"{command} &", f"nohup {command} > /tmp/log 2>&1 &", f"setsid {command}",
                             f"cd /r; ./scripts/{script}.py & disown"):
                result = run(bash(detached, background=True))
                self.assertEqual(result.returncode, 2, detached)
                self.assertIn("not detached", result.stderr)
                self.assertIn(script, result.stderr)

    def test_astra_calls_that_run_nothing_pass(self):
        for script in ("astra-collect", "astra-judge"):
            module = f"tests.scripts.test_{script.replace('-', '_')}"
            for command in (f"python3 scripts/{script}.py --dry-run", f"python3 scripts/{script}.py --help",
                            f"grep -n main scripts/{script}.py", f"python3 -m unittest {module}"):
                self.assertEqual(run(bash(command)).returncode, 0, command)

    def test_code_that_names_a_launcher_in_quotes_is_not_a_run(self):
        # A heredoc editing the launcher names its path inside `Path('...')`; that is text, not a run.
        for command in ("python3 - <<'EOF'\np = Path('scripts/astra-collect.py')\nEOF",
                        'grep -n main "scripts/astra-judge.py"', "x=('scripts/review-dispatch.py' --prompt p)"):
            self.assertEqual(run(bash(command)).returncode, 0, command)

    def test_interpreter_options_and_quoted_paths_are_still_runs(self):
        for command in ("python3 -u scripts/astra-collect.py", "python3 -u scripts/astra-collect.py &",
                        "python3 -X dev scripts/astra-judge.py", "python3 'scripts/astra-collect.py'",
                        'python3 -u "scripts/astra-collect.py" > /tmp/log 2>&1', "python3.12 scripts/astra-collect.py",
                        "python3 -u scripts/review-dispatch.py --prompt /tmp/p.md --record x.md",
                        "python3 'scripts/review-dispatch.py' --prompt /tmp/p.md --record x.md"):
            self.assertEqual(run(bash(command)).returncode, 2, command)
        self.assertEqual(run(bash("python3 -u scripts/astra-collect.py", background=True)).returncode, 0)
        self.assertEqual(run(bash("python3 -u scripts/astra-collect.py --dry-run")).returncode, 0)

    def test_a_dry_run_beside_a_real_astra_run_does_not_let_it_through(self):
        for command in ("python3 scripts/astra-collect.py --dry-run && python3 scripts/astra-collect.py",
                        "python3 scripts/astra-judge.py; python3 scripts/astra-collect.py --dry-run"):
            result = run(bash(command))
            self.assertEqual(result.returncode, 2, command)
            self.assertIn("an Astra run takes hours", result.stderr)

    def test_an_unreadable_payload_lets_the_call_run(self):
        for payload in ("", "not json", "[]", json.dumps({"tool_name": "Bash", "tool_input": None})):
            self.assertEqual(run(payload).returncode, 0, payload)


if __name__ == "__main__":
    unittest.main()
