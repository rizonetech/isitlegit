"""The Worker's gate commands are documented where sessions and contributors read them, and the Node pin agrees.

Every package.json script except the developer tools in TOOLS is a gate, so a script added later (lint, test) fails here
until AGENTS.md "Validation" and CONTRIBUTING.md "Validation gates" both name it. Standard library only."""
import json
import pathlib
import re
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOLS = {"dev", "types"}  # run by hand, not gates: the local server and the type-file regenerator
DOCS = (("AGENTS.md", "Validation"), ("CONTRIBUTING.md", "Validation gates"))


def gates(package):
    return sorted(name for name in package.get("scripts", {}) if name not in TOOLS)


def section_commands(text, heading):
    """Every line of every fenced bash block under `## <heading>`, up to the next level-2 heading."""
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not match:
        return []
    blocks = re.findall(r"^```bash\n(.*?)^```", match.group(1), re.M | re.S)
    return [line.split("#", 1)[0].strip() for block in blocks for line in block.splitlines()]


def missing_gates(package, text, heading):
    """The gate commands the section does not list, with the frozen install first."""
    listed = set(section_commands(text, heading))
    wanted = ["pnpm install --frozen-lockfile"] + [f"pnpm {name}" for name in gates(package)]
    return [command for command in wanted if command not in listed]


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

    def test_node_and_pnpm_pins_match_the_stack_doc(self):
        node, pnpm = stack_node_pin((REPO / "docs/specs/2026-10-26-tech-stack-design.md").read_text(encoding="utf-8"))
        self.assertEqual((REPO / ".nvmrc").read_text(encoding="utf-8").strip(), node)
        self.assertEqual(self.package["engines"]["node"], f">={node}")
        self.assertEqual(self.package["packageManager"], f"pnpm@{pnpm}")


class Defects(unittest.TestCase):
    PACKAGE = {"scripts": {"dev": "wrangler dev", "typecheck": "tsc", "build": "wrangler deploy --dry-run"}}
    DOC = "## Validation\n\n```bash\npnpm install --frozen-lockfile\npnpm typecheck   # types\npnpm build\n```\n\n## Next\n"

    def test_a_complete_section_passes(self):
        self.assertEqual(missing_gates(self.PACKAGE, self.DOC, "Validation"), [])

    def test_a_dropped_command_is_caught(self):
        self.assertEqual(missing_gates(self.PACKAGE, self.DOC.replace("pnpm build\n", ""), "Validation"), ["pnpm build"])

    def test_a_new_script_is_caught_until_documented(self):
        package = {"scripts": dict(self.PACKAGE["scripts"], lint="biome check .")}
        self.assertEqual(missing_gates(package, self.DOC, "Validation"), ["pnpm lint"])

    def test_a_command_outside_the_section_does_not_count(self):
        doc = self.DOC.replace("pnpm build\n", "") + "```bash\npnpm build\n```\n"
        self.assertEqual(missing_gates(self.PACKAGE, doc, "Validation"), ["pnpm build"])

    def test_a_commented_out_command_does_not_count(self):
        doc = self.DOC.replace("pnpm build\n", "# pnpm build\n")
        self.assertEqual(missing_gates(self.PACKAGE, doc, "Validation"), ["pnpm build"])

    def test_a_missing_section_lists_every_gate(self):
        self.assertEqual(missing_gates(self.PACKAGE, "## Other\n", "Validation"),
                         ["pnpm install --frozen-lockfile", "pnpm build", "pnpm typecheck"])


if __name__ == "__main__":
    unittest.main()
