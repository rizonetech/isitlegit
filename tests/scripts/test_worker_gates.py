"""The Worker's gate commands are documented where sessions and contributors read them, and the Node pin agrees.

Every package.json script except the developer tools in TOOLS is a gate, so a script added later (lint, test) fails here
until AGENTS.md "Validation", CONTRIBUTING.md "Validation gates" and the README quickstart all name it. Standard library only."""
import json
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
# Run by hand or by another script, not gates: the local server, the type-file regenerator, build:css, which
# build:assets runs first, the D1 migration commands (D01 T01 §1), run by hand: the remote one changes the live
# database (before each deploy, AGENTS.md) and must never run in CI, and db:auth-schema, which regenerates Better Auth's migration (D07 T02 §1)
# and is gated by test/node/auth-schema.test.ts inside `pnpm test`; deploy:site deploys the marketing site (D07 T06 §6): it runs
# the site's own gates first and then changes production, so it is run by hand by the coordinator and never in CI;
# eval:run (D08 T02 §1) is the evaluation runner: it spends Meta credit and creates cases on the deployment, so it is run by hand under a
# stated cap and never in CI; eval:metrics (D08 T02 §2) reads a stored run and prints its figures, run by hand;
# eval:baseline (D08 T02 §11) runs the per-set batches, so it spends and creates cases like eval:run, run by hand.
TOOLS = {"dev", "types", "build:css", "db:migrate:local", "db:migrate:remote", "db:auth-schema", "deploy:site", "eval:run", "eval:metrics", "eval:baseline", "eval:ablate"}
DOCS = (("AGENTS.md", "## Validation"), ("CONTRIBUTING.md", "## Validation gates"), ("README.md", "### Run the Worker locally"))


def gates(package):
    return sorted(name for name in package.get("scripts", {}) if name not in TOOLS)


def section_commands(text, heading):
    """Every line of every fenced bash block under `heading` (written with its hashes), up to the next heading of the
    same or a higher level outside a code fence (a `# comment` inside a bash block is not a heading)."""
    level = len(heading) - len(heading.lstrip("#"))
    commands, inside, fence = [], False, None
    for line in text.splitlines():
        if fence is None and line.startswith("```"):
            fence = line[3:].strip()
            continue
        if fence is not None:
            if line.startswith("```"):
                fence = None
            elif inside and fence == "bash":
                commands.append(line.split("#", 1)[0].strip())
            continue
        hashes = len(line) - len(line.lstrip("#"))
        if line == heading:
            inside = True
        elif inside and 0 < hashes <= level and line[hashes:hashes + 1] == " ":
            break
    return commands


def missing_gates(package, text, heading):
    """The gate commands the section does not list, with the frozen install first."""
    listed = set(section_commands(text, heading))
    wanted = ["pnpm install --frozen-lockfile"] + [f"pnpm {name}" for name in gates(package)]
    return [command for command in wanted if command not in listed]


# A gate runs in CI and in every session's checks, so one that applied migrations remotely, deployed, rolled back or set
# a secret would change production on every run.
LIVE = re.compile(r"--remote\b|wrangler (deploy|versions deploy|rollback|secret put)\b(?!.*--dry-run)")


def live_database_gates(package):
    """The gates whose command would change the live Worker or database."""
    return [name for name in gates(package) if LIVE.search(package["scripts"][name])]


def stack_node_pin(text):
    match = re.search(r"^\| Runtime and package manager \(local\) \| Node 24, pnpm 11 \| ([0-9.]+) / ([0-9.]+) \|", text, re.M)
    return match.groups() if match else None


class Repository(unittest.TestCase):
    def setUp(self):
        self.package = json.loads((REPO / "package.json").read_text(encoding="utf-8"))

    def test_every_gate_is_in_each_validation_section(self):
        self.assertIn("typecheck", gates(self.package))
        for path, heading in DOCS:
            with self.subTest(path=path):
                self.assertEqual(missing_gates(self.package, (REPO / path).read_text(encoding="utf-8"), heading), [])

    def test_no_gate_touches_the_live_database(self):
        self.assertEqual(live_database_gates(self.package), [])

    def test_node_and_pnpm_pins_match_the_stack_doc(self):
        node, pnpm = stack_node_pin((REPO / "docs/specs/2026-10-26-tech-stack-design.md").read_text(encoding="utf-8"))
        self.assertEqual((REPO / ".nvmrc").read_text(encoding="utf-8").strip(), node)
        self.assertEqual(self.package["engines"]["node"], f">={node}")
        self.assertEqual(self.package["packageManager"], f"pnpm@{pnpm}")


class Defects(unittest.TestCase):
    PACKAGE = {"scripts": {"dev": "wrangler dev", "typecheck": "tsc", "build": "wrangler deploy --dry-run"}}
    DOC = "## Validation\n\n```bash\npnpm install --frozen-lockfile\npnpm typecheck   # types\npnpm build\n```\n\n## Next\n"
    NESTED = "## Built\n\n### Run it\n\n```bash\npnpm install --frozen-lockfile\npnpm typecheck\n```\n\n### Later\n\n```bash\npnpm build\n```\n"

    def test_a_complete_section_passes(self):
        self.assertEqual(missing_gates(self.PACKAGE, self.DOC, "## Validation"), [])

    def test_a_dropped_command_is_caught(self):
        self.assertEqual(missing_gates(self.PACKAGE, self.DOC.replace("pnpm build\n", ""), "## Validation"), ["pnpm build"])

    def test_a_new_script_is_caught_until_documented(self):
        package = {"scripts": dict(self.PACKAGE["scripts"], lint="biome check .")}
        self.assertEqual(missing_gates(package, self.DOC, "## Validation"), ["pnpm lint"])

    def test_a_command_outside_the_section_does_not_count(self):
        doc = self.DOC.replace("pnpm build\n", "") + "```bash\npnpm build\n```\n"
        self.assertEqual(missing_gates(self.PACKAGE, doc, "## Validation"), ["pnpm build"])

    def test_a_commented_out_command_does_not_count(self):
        doc = self.DOC.replace("pnpm build\n", "# pnpm build\n")
        self.assertEqual(missing_gates(self.PACKAGE, doc, "## Validation"), ["pnpm build"])

    def test_a_level_3_section_ends_at_the_next_level_3_heading(self):
        self.assertEqual(missing_gates(self.PACKAGE, self.NESTED, "### Run it"), ["pnpm build"])

    def test_a_level_3_section_includes_its_own_blocks(self):
        complete = self.NESTED.replace("pnpm typecheck\n", "pnpm typecheck\npnpm build\n")
        self.assertEqual(missing_gates(self.PACKAGE, complete, "### Run it"), [])

    def test_a_gate_that_would_change_production_is_caught(self):
        package = {"scripts": dict(self.PACKAGE["scripts"], **{
            "migrate": "wrangler d1 migrations apply DB --remote",
            "ship": "wrangler deploy",
            "undo": "wrangler rollback",
            "token": "wrangler secret put X",
            "local": "wrangler d1 migrations apply DB --local",
        })}
        self.assertEqual(sorted(live_database_gates(package)), ["migrate", "ship", "token", "undo"])
        self.assertEqual(live_database_gates(self.PACKAGE), [])  # build's deploy is a --dry-run

    def test_a_missing_section_lists_every_gate(self):
        self.assertEqual(missing_gates(self.PACKAGE, "## Other\n", "## Validation"),
                         ["pnpm install --frozen-lockfile", "pnpm build", "pnpm typecheck"])


if __name__ == "__main__":
    unittest.main()
