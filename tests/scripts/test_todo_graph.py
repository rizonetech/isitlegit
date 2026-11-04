"""Tests for scripts/lib/todo_graph.py and scripts/todo-graph.py: the graph refuses malformed work and stamps only real evidence."""
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
import unittest.mock
from unittest import mock

REPO = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = REPO / "scripts"
sys.path.insert(0, str(SCRIPTS / "lib"))
import todo_graph as tg  # noqa: E402

# The kits keep the dispatcher in the reviewer kit; an installed project has both side by side.
tg.DISPATCHER = REPO / "scripts/review-dispatch.py"

ADJACENCY = ("**Adjacency:** list=not-applicable (fixture); document=not-applicable (fixture); "
             "settings=not-applicable (fixture); reporting=not-applicable (fixture); "
             "notifications=not-applicable (fixture); permissions=not-applicable (fixture); "
             "audit=not-applicable (fixture); exchange=not-applicable (fixture); "
             "reverse=not-applicable (fixture)")


def section(n, title, phase, needs, extra=""):
    return (f"## {n}. {title}\n\n**Phase:** {phase}\n**Needs:** {needs}\n**Surface:** no\n\n**Build order:**\n\n"
            f"1. Do it. Done when: it shows.\n\n- [ ] Work.\n- [ ] Commit: `x: {title.lower()}`\n\n"
            f"**Test checkpoint:** `true` exits 0.{extra}\n")


def envelope(n, reviewer="astra (`m` via `codex`)", overall="approve", light=False):
    """One round as scripts/review-dispatch.py records it (without the optional Lines and Digest fields), at the
    uniform schedule the Stamp fixture pins (light: a round on the light schedule, as a Risk: light section runs)."""
    return (f"## Round {n}: {reviewer}\n\n- Writer: claude\n- Run: 2026-10-21T00:00:00Z\n- Effort: low\n"
            f"- Lenses: adversarial\n{'- Schedule: light' + chr(10) if light else ''}\nReview text.\n\n"
            f"OVERALL: {overall}\n\n")


# A reviewer pin whose schedule runs every round at the same effort and lens, so tests that are not about the schedule
# need not follow one; SCHEDULE_PIN is the live shape the schedule tests use.
UNIFORM_PIN = """schema_version = 1

[reviewers.astra]
cli = "codex"
model = "m"
effort = "medium"

[routes]
claude = ["astra"]

[schedule]
severity_stop_after = 3
plan = { effort = "medium", lenses = ["plan"] }
completion = { effort = "medium" }
rounds = [{ effort = "low", lenses = ["adversarial"] }]
rotation = { effort = "low", lenses = ["adversarial"] }
escalation = { effort = "low", lenses = ["adversarial"] }
"""
SCHEDULE_PIN = UNIFORM_PIN.split("[schedule]")[0] + """[schedule]
severity_stop_after = 3
plan = { effort = "medium", lenses = ["plan"] }
completion = { effort = "medium" }
rounds = [{ effort = "high", lenses = ["adversarial", "integration", "source-defect", "plan-delivery"] },
          { effort = "medium", lenses = ["adversarial"] }, { effort = "low", lenses = ["adversarial"] }]
rotation = { effort = "low", lenses = ["consistency", "quality", "design", "optimization", "record"] }
escalation = { effort = "medium", lenses = ["adversarial"] }
light = { rounds = [{ effort = "medium", lenses = ["adversarial", "plan-delivery"] }] }
"""
STARTED = "> **Started:** 2026-10-23T00:00Z\n\n"


def todo_file(rows, *, ident="alpha", domain="00-workspace", status="active", depends_on=None,
              table_override=None, inputs="- i"):
    """rows: (number, title, phase, needs, depends) tuples."""
    front = ["schema_version: 1", f"id: {ident}", f"domain: {domain}", f"status: {status}",
             'title: "TODO-01 -- A"']
    if depends_on is not None:
        front.append("depends_on: " + json.dumps(depends_on))
    table = table_override or "\n".join(
        f"| {i} | §{n} | {t} | {dep} | [ ] |" for i, (n, t, _, _, dep) in enumerate(rows, 1))
    bodies = "\n".join(section(n, t, ph, nd) for n, t, ph, nd, _ in rows)
    return ("---\n" + "\n".join(front) + "\n---\n\n# TODO-01 -- A\n\n> **Goal:** g.\n\n"
            "> **Current state:** c.\n\n## Inputs\n\n" + inputs + "\n\n## Outcome\n\n- o\n\n"
            + ADJACENCY + "\n\n"
            "## Implementation Order\n\n| Order | Section | Deliverable | Depends On | Status |\n"
            "| ----- | ------- | ----------- | ---------- | ------ |\n"
            + table + "\n\n" + bodies + "\n## Verification\n\n- v\n")


class Tree(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / "todo/00-workspace").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, text, name="TODO-01-a.md", domain="00-workspace", index=True):
        d = self.root / "todo" / domain
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(text, encoding="utf-8")
        if index:
            self.index(name, domain)

    def index(self, name, domain="00-workspace"):
        domain_index = self.root / "todo" / domain / "INDEX.md"
        existing = domain_index.read_text(encoding="utf-8") if domain_index.exists() else "# Index\n"
        if name not in existing:
            domain_index.write_text(existing + f"- {name}\n", encoding="utf-8")
        root_index = self.root / "todo/TODO-00-INDEX.md"
        root_existing = root_index.read_text(encoding="utf-8") if root_index.exists() else "# Index\n"
        entry = f"{domain}/{name}"
        if entry not in root_existing:
            root_index.write_text(root_existing + f"- {entry}\n", encoding="utf-8")

    def refuses(self, fragment):
        with self.assertRaises(tg.Refused) as ctx:
            tg.graph(self.root)
        self.assertIn(fragment, str(ctx.exception))


class Graph(Tree):
    def test_valid_tree_orders_by_phase_and_dependency(self):
        self.write(todo_file([(1, "Late", 1, "none", "--"), (2, "Early", 0, "none", "--"),
                              (3, "After early", 0, "meta-api", "§2")]))
        rows = tg.graph(self.root)
        self.assertEqual([r.ref for r in tg.ordered(rows)],
                         ["D00 T01 §2", "D00 T01 §3", "D00 T01 §1"])
        self.assertEqual(tg.disposition(rows["D00 T01 §2"], rows), 0)
        self.assertEqual(tg.disposition(rows["D00 T01 §3"], rows), 4)

    def test_table_order_decides_among_ready_sections(self):
        table = "| 1 | §2 | B | -- | [ ] |\n| 2 | §1 | A | -- | [ ] |"
        self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")],
                             table_override=table))
        self.assertEqual([r.ref for r in tg.ordered(tg.graph(self.root))],
                         ["D00 T01 §2", "D00 T01 §1"])

    def test_empty_tree_refuses(self):
        self.refuses("missing or empty")

    def test_malformed_row_is_not_empty_work(self):
        self.write(todo_file([(1, "A", 0, "none", "--")], table_override="| 1 | §1 | A | -- | [?] |"))
        self.refuses("malformed implementation row")

    def test_row_without_body_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            "| 1 | §1 | A | -- | [ ] |", "| 1 | §1 | A | -- | [ ] |\n| 2 | §2 | B | -- | [ ] |")
        self.write(text)
        self.refuses("row/body mismatch")

    def test_cycle_refuses(self):
        self.write(todo_file([(1, "A", 0, "none", "§2"), (2, "B", 0, "none", "§1")]))
        self.refuses("dependency cycle")

    def test_prerequisite_in_a_later_phase_refuses(self):
        self.write(todo_file([(1, "A", 0, "none", "§2"), (2, "B", 1, "none", "--")]))
        self.refuses("prerequisite in later phase")

    def test_unknown_need_refuses(self):
        self.write(todo_file([(1, "A", 0, "novamira", "--")]))
        self.refuses("unknown/duplicate Needs")

    def test_the_isitlegit_environment_needs_are_accepted(self):
        self.write(todo_file([(1, "A", 0, "meta-api, cloudflare, live-mail, whatsapp, attended", "--")]))
        self.assertIn("D00 T01 §1", tg.graph(self.root))

    def test_needs_from_the_desktop_apps_the_kit_came_from_refuse(self):
        for need in ("windows-host", "arm64-host", "display-session", "office", "libreoffice", "store-account"):
            with self.subTest(need=need):
                self.write(todo_file([(1, "A", 0, need, "--")]))
                self.refuses("unknown/duplicate Needs")

    def test_commit_must_be_the_last_item(self):
        self.write(todo_file([(1, "A", 0, "none", "--")]).replace(
            "- [ ] Commit: `x: a`", "- [ ] Commit: `x: a`\n- [ ] After."))
        self.refuses("Commit last")

    def test_table_line_without_its_leading_pipe_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            "| 1 | §1 | A | -- | [ ] |", "| 1 | §1 | A | -- | [ ] |\n | 2 | §999 | Orphan | -- | [ ] |")
        self.write(text)
        self.refuses("without a leading pipe")

    def test_unknown_level_two_heading_refuses(self):
        for bad in ("## Remaining work", "## Inputs ", "##\tNotes", "## Inputs", "## Verification", "## Outcome"):
            self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")]).replace(
                "## 2. B\n", bad + "\n\n- [ ] Unfinished required work.\n\n## 2. B\n"))
            self.refuses("level-two headings must be")

    def test_deferral_marker_outside_a_blockquote_refuses(self):
        for bad in ("**Deferred:** Unimplemented required work.", ">**Resolved:** done -> XREF: §1",
                    "Note **Deferred:** later -> XREF: §2"):
            self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")]).replace(
                "- [ ] Work.", "- [ ] Work.\n\n" + bad + "\n", 1))
            self.refuses("must open a blockquote line and say something")

    def test_checklist_item_in_another_spelling_refuses(self):
        for bad in ("1. [ ] Unfinished work.", "2) [x] Done elsewhere.", "> - [ ] Quoted work.", ">- [ ] Quoted.",
                    "  - [ ] Indented work.", "> 1. [ ] Quoted and numbered."):
            self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")]).replace(
                "- [ ] Work.", "- [ ] Work.\n" + bad, 1))
            self.refuses("malformed checklist item")

    def test_two_deferral_markers_on_one_line_refuse(self):
        self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")]).replace(
            "**Test checkpoint:** `true` exits 0.\n\n## 2. B",
            "**Test checkpoint:** `true` exits 0.\n> **Resolved:** old -> XREF: §2 **Deferred:** new unowned work.\n\n## 2. B"))
        self.refuses("one Deferred or Resolved marker per line")

    def test_reference_run_into_more_text_does_not_resolve(self):
        self.write(todo_file([(1, "A", 0, "none", "--")]))
        rows = tg.graph(self.root)
        for text in ("D00 T01 §1oops", "D00 T01 §1.5", "todo/00-workspace/TODO-01-a.md §1x"):
            self.assertEqual(tg.extract_ref(text, rows), (None, 2))
        for text in ("D00 T01 §1", "process D00 T01 §1.", "D00 T01 §1 (run file x)", "| 1 | D00 T01 §1 | A |"):
            self.assertEqual(tg.extract_ref(text, rows), ("D00 T01 §1", 0))

    def test_empty_deferral_marker_refuses(self):
        for bad in ("> **Deferred:**", "> **Resolved:**   "):
            self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")]).replace(
                "**Test checkpoint:** `true` exits 0.\n\n## 2. B", "**Test checkpoint:** `true` exits 0.\n" + bad + "\n\n## 2. B"))
            self.refuses("must open a blockquote line and say something")

    def test_malformed_xref_does_not_resolve_to_another_section(self):
        for bad in ("-> XREF: D00 T999 §1", "-> XREF: §1x", "-> XREF: D00 T01 §1.5", "-> XREF:§1", "-> XREF: D00 T01 §1 -> XREF: D00 T99 §999",
                    "-> XREF: none yet"):
            self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")], inputs="- i " + bad))
            with self.assertRaises(tg.Refused):
                tg.graph(self.root)
        self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")],
                             inputs="- see §2 -> XREF: §2 (the second)"))
        tg.graph(self.root)

    def test_malformed_checklist_item_refuses(self):
        for bad in ("- [?] Work.", "- [] Work.", "- [X] Work.", "- Work without checkbox."):
            self.write(todo_file([(1, "A", 0, "none", "--")]).replace("- [ ] Work.", bad))
            self.refuses("malformed checklist item")

    def test_empty_build_order_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            "1. Do it. Done when: it shows.\n\n- [ ] Work.",
            "- [ ] Work. Done when: it shows.")
        self.write(text)
        self.refuses("executable Build order required")
        missing_second = todo_file([(1, "A", 0, "none", "--")]).replace(
            "1. Do it. Done when: it shows.",
            "1. Do it. Done when: it shows.\n2. Second step without acceptance criterion.")
        self.write(missing_second)
        self.refuses("executable Build order required")

    def test_empty_field_does_not_borrow_next_line(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            "**Test checkpoint:** `true` exits 0.",
            "**Test checkpoint:**\n> **Deferred:** `later` -> XREF: D00 T01 §1")
        self.write(text)
        self.refuses("missing Test checkpoint field")

    def test_missing_todo_heading_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace("# TODO-01 -- A\n\n", "")
        self.write(text)
        self.refuses("missing TODO heading")

    def test_section_zero_refuses(self):
        self.write(todo_file([(0, "Zero", 0, "none", "--")]))
        self.refuses("malformed implementation row")

    def test_waiting_needs_are_not_ready(self):
        self.write(todo_file([(1, "A", 0, "owner-decision, meta-api", "--")]))
        rows = tg.graph(self.root)
        self.assertEqual(tg.disposition(rows["D00 T01 §1"], rows), 4)

    def test_operator_needs_are_not_ready(self):
        self.write(todo_file([(1, "A", 99, "operator", "--")]))
        rows = tg.graph(self.root)
        self.assertEqual(tg.disposition(rows["D00 T01 §1"], rows), 4)

    def test_withdrawn_cloud_phase_98_refuses(self):
        # The phase list is closed: an unlisted phase refuses.
        self.write(todo_file([(1, "Cloud", 98, "none", "--")]))
        self.refuses("invalid Phase")

    def test_phase_outside_the_closed_list_refuses(self):
        self.write(todo_file([(1, "A", 50, "none", "--")]))
        self.refuses("invalid Phase")

    def test_draft_file_is_not_ready(self):
        self.write(todo_file([(1, "A", 0, "none", "--")], status="draft"))
        rows = tg.graph(self.root)
        self.assertEqual(tg.disposition(rows["D00 T01 §1"], rows), 4)

    def test_file_dependency_reaches_every_section(self):
        self.write(todo_file([(1, "A", 0, "none", "--")], ident="first"))
        self.write(todo_file([(1, "B", 1, "none", "--"), (2, "C", 1, "none", "--")],
                             ident="second", depends_on=["first"]), name="TODO-02-b.md")
        rows = tg.graph(self.root)
        self.assertEqual(rows["D00 T02 §2"].depends, ["D00 T01 §1"])

    def test_checked_row_without_stamp_refuses(self):
        self.write(todo_file([(1, "A", 0, "none", "--")]).replace("| [ ] |", "| [x] |"))
        self.refuses("checkbox/stamp/receipt mismatch")

    def test_missing_from_index_refuses(self):
        self.write(todo_file([(1, "A", 0, "none", "--")]), index=False)
        (self.root / "todo/TODO-00-INDEX.md").write_text("# Index\n", encoding="utf-8")
        (self.root / "todo/00-workspace/INDEX.md").write_text("# Index\n", encoding="utf-8")
        self.refuses("missing from domain index")

    def test_root_index_requires_domain_qualified_entry(self):
        self.write(todo_file([(1, "A", 0, "none", "--")], ident="first"))
        self.write(todo_file([(1, "B", 1, "none", "--")], ident="second", domain="01-engine"),
                   name="TODO-01-a.md", domain="01-engine", index=False)
        (self.root / "todo/01-engine/INDEX.md").write_text("# Index\n- TODO-01-a.md\n", encoding="utf-8")
        self.refuses("missing from root index: 01-engine/TODO-01-a.md")

    def test_adjacency_missing_key_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            "reverse=not-applicable (fixture)", "reverse=not-applicable")
        self.write(text)
        self.refuses("adjacency entry malformed")

    def test_adjacency_blanket_form_is_valid(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            ADJACENCY, "**Adjacency:** all=not-applicable (fixture with no record of its own)")
        self.write(text)
        self.assertEqual(len(tg.graph(self.root)), 1)

    def test_adjacency_blanket_reason_may_contain_semicolons(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            ADJACENCY, "**Adjacency:** all=not-applicable (tooling over files; its records are the "
                       "files themselves, owned by their own sections)")
        self.write(text)
        self.assertEqual(len(tg.graph(self.root)), 1)

    def test_one_sided_xref_refuses(self):
        self.write(todo_file([(1, "A", 0, "none", "--")], ident="first"))
        self.write(todo_file([(1, "B", 0, "none", "--")], ident="second",
                             inputs="- -> XREF: D00 T01 §1 -- consumes it"), name="TODO-02-b.md")
        self.refuses("one-sided XREF")

    def test_reciprocal_xref_is_valid(self):
        self.write(todo_file([(1, "A", 0, "none", "--")], ident="first",
                             inputs="- -> XREF: D00 T02 §1 -- feeds it"))
        self.write(todo_file([(1, "B", 0, "none", "--")], ident="second",
                             inputs="- -> XREF: D00 T01 §1 -- consumes it"), name="TODO-02-b.md")
        self.assertEqual(len(tg.graph(self.root)), 2)

    def test_surface_yes_without_fidelity_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace("**Surface:** no", "**Surface:** yes")
        self.write(text)
        self.refuses("missing Fidelity field")

    def test_freeze_check_without_frozen_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            "**Test checkpoint:**", "**Freeze check:** fixtures hold.\n\n**Test checkpoint:**")
        self.write(text)
        self.refuses("Freeze check must match frozen")

    def test_deferral_without_owner_refuses(self):
        text = todo_file([(1, "A", 0, "none", "--")]).replace(
            "**Test checkpoint:**", "> **Deferred:** later, somehow\n\n**Test checkpoint:**")
        self.write(text)
        self.refuses("without a resolving owner")

    def test_max_sections_per_file_refuses(self):
        rows = [(n, f"S{n}", 0, "none", "--") for n in range(1, 57)]
        self.write(todo_file(rows))
        self.refuses("over 55 sections")

    def test_max_items_per_section_refuses(self):
        many = "\n".join(f"- [ ] Item {i}." for i in range(1, 31))
        text = todo_file([(1, "A", 0, "none", "--")]).replace("- [ ] Work.", many)
        self.write(text)
        self.refuses("2-30 items")

    def test_deliverable_or_title_over_max_len_refuses(self):
        self.write(todo_file([(1, "X" * 89, 0, "none", "--")]))
        self.refuses("deliverable/title over 88 chars (wraps raw md table): D00 T01 §1")
        # The limit is the title's, which the table shows; the "## N. " prefix appears in no table.
        self.write(todo_file([(1, "X" * 88, 0, "none", "--")]))
        tg.graph(self.root)

    def test_superseded_without_successor_refuses(self):
        self.write(todo_file([(1, "A", 0, "none", "--")], status="superseded"))
        self.refuses("superseded TODO must name its successor")

    def test_projection_check_detects_drift(self):
        self.write(todo_file([(1, "A", 0, "none", "--")]))
        tg.projections(self.root, sync=True)
        tg.projections(self.root)
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace("**Phase:** 0", "**Phase:** 2"),
                        encoding="utf-8")
        with self.assertRaises(tg.Refused):
            tg.projections(self.root)

    def test_resolve_accepts_windows_and_posix_paths_and_plan_rows(self):
        self.write(todo_file([(1, "A", 0, "none", "--")]))
        rows = tg.graph(self.root)
        for query in (
            "D00 T01 §1",
            "| [ ] | D00 T01 §1 | A | none | 2 |",
            "todo/00-workspace/TODO-01-a.md §1",
            r"R:\GitHub\Project\todo\00-workspace\TODO-01-a.md §1",
        ):
            self.assertEqual(tg.extract_ref(query, rows), ("D00 T01 §1", 0))
        self.assertEqual(tg.extract_ref(r"R:\GitHub\Project\todo\00-workspace\TODO-01-a.md §9", rows),
                         ("D00 T01 §9", 1))
        self.assertEqual(tg.extract_ref("no reference here", rows), (None, 2))

    def test_deep_dependency_chain_validates_without_recursion_error(self):
        for file_num in range(1, 21):
            rows = []
            for sec_num in range(1, 56):
                if file_num == 20 and sec_num == 55:
                    dep = "--"
                elif sec_num < 55:
                    dep = f"D00 T{file_num:02d} §{sec_num + 1}"
                else:
                    dep = f"D00 T{file_num + 1:02d} §1"
                rows.append((sec_num, f"S{sec_num}", 0, "none", dep))
            self.write(todo_file(rows, ident=f"file-{file_num:02d}"),
                       name=f"TODO-{file_num:02d}-chain.md")
        parsed = tg.graph(self.root)
        self.assertEqual(len(parsed), 1100)
        ordered_refs = [r.ref for r in tg.ordered(parsed)]
        self.assertEqual(len(ordered_refs), 1100)
        self.assertEqual(ordered_refs[0], "D00 T20 §55")
        self.assertEqual(ordered_refs[-1], "D00 T01 §1")


class Risk(Tree):
    """D00 T01 §15: a section's Risk line, `light` only for a section whose named paths are all tooling, tests or
    docs."""

    def with_risk(self, risk, work="- [ ] Work on `scripts/tool.py`."):
        text = todo_file([(1, "Tool", 0, "none", "--")])
        if risk is not None:
            text = text.replace("**Surface:** no", f"**Risk:** {risk}\n**Surface:** no", 1)
        self.write(text.replace("- [ ] Work.", work, 1))

    def test_a_section_with_no_risk_is_full_and_light_is_accepted_for_tooling(self):
        for risk, work in ((None, "- [ ] Work."), ("full", "- [ ] Work on `src/auth/auth.ts`."),
                           ("light", "- [ ] Work on `scripts/tool.py` and `tests/scripts/test_tool.py`."),
                           ("light", "- [ ] Work on `.claude/skills/x/SKILL.md` and `.github/workflows/ci.yml`."),
                           ("light", "- [ ] Work on `./scripts/tool.py` and `AGENTS.md`."),
                           ("light", "- [ ] Run `python3 -m pytest tests/scripts/test_tool.py` on `scripts/tool.py`."),
                           # The marketing site's and the videos' own files are not the running service (2026-10-31).
                           ("light", "- [ ] Write `site/src/pages/index.astro` and `media/src/Title.tsx`.")):
            with self.subTest(risk=risk):
                self.with_risk(risk, work)
                tg.graph(self.root)

    def test_light_is_refused_for_product_code_guarded_words_or_no_named_path(self):
        for work in ("- [ ] Work on `src/trust/bank.ts`.", "- [ ] Work on `src/agent/loop.ts`.",
                     "- [ ] Add `site/package.json` and update `pnpm-lock.yaml`.",
                     "- [ ] Work on `scripts/tool.py` and `src/db/migrations/0040_x.sql`.",
                     "- [ ] Work on `scripts/redact-samples.py`.", "- [ ] Work on `scripts/glimmer/leak-check.ts`.",
                     "- [ ] Work on `scripts/tool.py` and `wrangler.jsonc`.",
                     "- [ ] Work on `scripts/tool.py` and `package.json`.",
                     "- [ ] Work on `scripts/tool.py`, then change `.dev.vars`.",
                     "- [ ] Work on `scripts/tool.py`, then add `src/db/migrations/<next number>_domains.sql`.",
                     "- [ ] Work on `scripts/tool.py`; its Worker change goes in src/web/app.ts.",
                     "- [ ] Run `pnpm exec wrangler deploy` after `scripts/tool.py`.", "- [ ] Work."):
            with self.subTest(work=work):
                self.with_risk("light", work)
                self.refuses("Risk light needs every path the section names to be tooling, tests or docs")

    def test_the_pages_switch_lets_pages_and_eval_be_light_and_keeps_guarded_pages_full(self):
        # The operator's switch for when time runs out (2026-10-31): off by default, so the two tests above hold.
        self.assertFalse(tg.LIGHT_INCLUDES_PAGES)
        with unittest.mock.patch.object(tg, "LIGHT_INCLUDES_PAGES", True):
            for work in ("- [ ] Build `src/web/pages/report-header.tsx` with `test/node/report-header.test.tsx`.",
                         "- [ ] Work on `scripts/tool.py`; its page change goes in src/web/app.ts.",
                         "- [ ] Write `eval/frontier/run.ts` and `test/node/eval-frontier.test.ts`."):
                with self.subTest(work=work):
                    self.with_risk("light", work)
                    tg.graph(self.root)
            for work in ("- [ ] Build `src/web/pages/signin.tsx`.", "- [ ] Build `src/web/pages/upload.tsx`.",
                         "- [ ] Change `src/web/pages/report-link.ts`.", "- [ ] Change `src/web/pages/report-access.tsx`.",
                         "- [ ] Build `src/web/pages/invite.tsx`.", "- [ ] Work on `src/checks/hidden-text.ts`.",
                         "- [ ] Work on `src/intake/parse.ts`.", "- [ ] Work on `src/invoice/forensics.ts`.",
                         "- [ ] Work on `scripts/tool.py`; its Worker change goes in src/index.ts."):
                with self.subTest(work=work):
                    self.with_risk("light", work)
                    self.refuses("Risk light needs every path the section names to be tooling, tests or docs")
        # Off again, a page is full only.
        self.with_risk("light", "- [ ] Build `src/web/pages/report-header.tsx`.")
        self.refuses("Risk light needs every path the section names to be tooling, tests or docs")

    def test_an_unknown_risk_is_refused(self):
        self.with_risk("medium")
        self.refuses("Risk must be full/light")


class Stamp(Tree):
    def setUp(self):
        super().setUp()
        text = todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "owner-decision", "--")]).replace(
            "**Test checkpoint:**", STARTED + "**Test checkpoint:**", 1)
        if getattr(self, "light", False):  # §1 as a non-critical section (make_light)
            text = text.replace("**Surface:** no", "**Risk:** light\n**Surface:** no", 1).replace(
                "- [ ] Work.", "- [ ] Work on `scripts/tool.py`.", 1)
        self.write(text)
        report_path = self.root / "docs/reviews/00-workspace/D00-T01-s1.md"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text("# Review findings\n\n" + envelope(1), encoding="utf-8")
        (self.root / ".conclave").mkdir()
        light_step = 'light = { rounds = [{ effort = "low", lenses = ["adversarial"] }] }\n'
        (self.root / tg.PIN).write_text(UNIFORM_PIN + (light_step if getattr(self, "light", False) else ""),
                                        encoding="utf-8")
        # A test fixture the build start already holds, for a later commit to reformat (D00 T01 §28).
        fixture = self.root / "test/fixtures/rdap/dns.json"
        fixture.parent.mkdir(parents=True)
        fixture.write_text('{"a": [1, 2]}\n', encoding="utf-8")
        # No auto maintenance: newer git detaches it after a commit, and it can still be writing .git/objects/pack when
        # tearDown removes the repository ("Directory not empty", seen on the GitHub runner).
        for args in (["init", "-q"], ["config", "maintenance.auto", "false"], ["config", "user.email", "t@example.com"],
                     ["config", "user.name", "T"], ["add", "-A"], ["commit", "-qm", "x"]):
            subprocess.run(["git", "-C", str(self.root), *args], check=True)
        self.sha = self.head()
        self.start = self.sha  # the commit that records §1's Started line: the build began here
        self.reviews = [{"round": 1, "report": "docs/reviews/00-workspace/D00-T01-s1.md",
                         "verdict": "clean"}]
        self.write_completion()
        self.write_plan()

    COMPLETION = "docs/reviews/00-workspace/D00-T01-s1-completion.md"
    PLAN = "docs/reviews/00-workspace/D00-T01-s1.md"  # the section's own findings file, beside its rounds

    @staticmethod
    def only(text, plans):
        """The findings file text with only its plan reviews (plans) or with every record but them, header kept."""
        head, *records = re.split(r"(?m)^(?=## (?:Round |Plan review))", text)
        return head + "".join(r for r in records if r.startswith("## Plan review") == plans)

    def head(self):
        return subprocess.run(["git", "-C", str(self.root), "rev-parse", "HEAD"],
                              capture_output=True, text=True).stdout.strip()

    def commit(self, message="more"):
        for args in (["add", "-A"], ["commit", "-q", "--allow-empty", "-m", message]):
            subprocess.run(["git", "-C", str(self.root), *args], check=True)
        return self.head()

    def write_plan(self, review="1. Controls: all present.\n\nHIGHEST: none\n\nPLAN: complete\n\nOVERALL: approve",
                   reviewer="astra", cli="codex", writer="claude", effort="medium", lenses=("plan",), candidate=None,
                   path=None, keep=False, pin=None):
        """A plan review as scripts/review-dispatch.py --kind plan records it (keep: after the attempts already there;
        otherwise the earlier plan reviews are dropped and the file's rounds stay)."""
        target = self.root / (path or self.PLAN)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not keep and target.exists():
            target.write_bytes(self.only(target.read_bytes().decode("utf-8"), plans=False).encode("utf-8"))
        result = {"writer": writer, "reviewer": reviewer, "model": "m", "cli": cli, "effort": effort,
                  "lenses": list(lenses), "failover": [] if reviewer else [{"reviewer": "astra", "reason": "exited 3"}],
                  "review": review if reviewer else None, "pin": pin}
        tg.review_dispatch().record_completion(target, result, "2026-10-22T00:00:00Z", candidate or self.start,
                                               kind="plan")

    def write_completion(self, review="1. Open file: present.\n\nCOMPLETION: complete", notes="", reviewer="sol",
                         candidate=None, path=None, effort="medium", keep=False, pin=None):
        """A completion review as scripts/review-dispatch.py --kind completion records it, then the writer's notes."""
        target = self.root / (path or self.COMPLETION)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not keep:
            target.unlink(missing_ok=True)
        result = {"writer": "claude", "reviewer": reviewer, "model": "gpt-6.1-sol", "cli": "codex", "effort": effort,
                  "failover": [] if reviewer else [{"reviewer": "sol", "reason": "exited 3"}],
                  "review": review if reviewer else None, "pin": pin}
        tg.review_dispatch().record_completion(target, result, "2026-10-23T00:00:00Z", candidate or self.sha)
        if notes:
            with open(target, "a", encoding="utf-8", newline="") as handle:
                handle.write("\n" + notes + "\n")

    def ensure_plan(self, ref="D00 T01 §1"):
        """The returned plan review back in the section's own findings file when a test rewrote that file for its
        rounds (or never wrote it), as the real file carries it beside them. A file holding any plan attempt, or one
        the dispatcher cannot read, is left as the test wrote it. Returns the file."""
        report = tg.section_findings(self.root, ref)
        target = self.root / report
        plans = tg.review_dispatch().read_plans(target.read_bytes().decode("utf-8")) if target.exists() else []
        if plans == []:
            self.write_plan(path=report, keep=True)
        return report

    def stamp(self, *args, completion=None, plan=None, **kwargs):
        """tg.stamp on this tree, with a clean completion review and the section's own plan review unless the test
        names others (see ensure_plan)."""
        if plan is None:
            plan = self.ensure_plan(args[0])
        return tg.stamp(self.root, *args, completion=completion or {"report": self.COMPLETION, "verdict": "complete"},
                        plan=plan, **kwargs)

    def completion_refuses(self, completion, fragment):
        before = self.snapshot()
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23", completion=completion)
        self.assertIn(fragment, str(ctx.exception))
        self.assertEqual(self.snapshot(), before, "a refused stamp wrote something")

    def test_a_stamp_without_a_completion_review_refuses(self):
        self.tick_work()
        before = self.snapshot()
        with self.assertRaises(tg.Refused) as ctx:
            tg.stamp(self.root, "D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23")
        self.assertIn("--completion '<findings file>:<complete|completed|filed>' is required", str(ctx.exception))
        self.assertEqual(self.snapshot(), before)

    def test_an_unknown_completion_verdict_refuses(self):
        self.tick_work()
        for verdict in ("done", "gaps", "Complete", ""):
            with self.subTest(verdict=verdict):
                self.completion_refuses({"report": self.COMPLETION, "verdict": verdict},
                                        "--completion verdict must be one of complete, completed, filed")

    def test_a_findings_file_without_a_completion_review_refuses(self):
        self.tick_work()
        self.completion_refuses({"report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "complete"},
                                "holds no ## Completion review")
        self.completion_refuses({"report": "docs/reviews/00-workspace/none.md", "verdict": "complete"},
                                "missing or empty review report")
        self.completion_refuses({"report": "../outside.md", "verdict": "complete"}, "invalid review report path")

    def test_a_completion_pass_that_returned_no_review_refuses(self):
        self.tick_work()
        self.write_completion(reviewer=None)
        self.completion_refuses({"report": self.COMPLETION, "verdict": "complete"},
                                "must hold exactly one completion review returned by another model family")
        self.write_completion(review="1. Open file: present.\n\nCOMPLETION: unsure")
        self.completion_refuses({"report": self.COMPLETION, "verdict": "complete"},
                                "must hold exactly one completion review returned by another model family")

    def test_the_completion_verdict_must_match_the_review(self):
        self.tick_work()
        self.write_completion(review="1. Ctrl+O: missing-in-scope.\n\nCOMPLETION: gaps")
        self.completion_refuses({"report": self.COMPLETION, "verdict": "complete"},
                                "completion verdict complete needs a review ending COMPLETION: complete")
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23",
                             completion={"report": self.COMPLETION, "verdict": "completed"})
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        self.assertEqual(data["completion"], {"report": self.COMPLETION, "verdict": "completed", "candidate": self.sha,
                                              "reviewer": "sol", "model": "gpt-6.1-sol", "filed": []})
        self.assertEqual(tg.review_rounds(self.root)["sections"][0]["completion"], "completed")

    READINGS = "\n\n### Second reading\n\n- `eval/sets/a/1.json`: agree\n- `eval/sets/a/2.json`: disagree: the date is wrong"

    def test_a_second_reading_block_may_follow_the_completion_verdict(self):
        # D08 T01 §3, 2026-10-31: the eval lane's reviewer wrote its second readings after its verdict line.
        self.tick_work()
        self.write_completion(review="1. Ctrl+O: missing-in-scope.\n\nCOMPLETION: gaps" + self.READINGS)
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23",
                             completion={"report": self.COMPLETION, "verdict": "completed"})
        self.assertEqual(json.loads((self.root / receipt).read_text(encoding="utf-8"))["completion"]["verdict"],
                         "completed")
        tg.graph(self.root)

    def test_a_round_may_close_with_a_second_reading_block(self):
        # D08 T01 §3, 2026-10-31: rounds 1 and 2 closed with the eval lane's second readings after OVERALL.
        self.tick_work()
        report = self.root / "docs/reviews/00-workspace/D00-T01-s1.md"
        report.write_text("# Review findings\n\n" + envelope(1, overall="needs-attention").rstrip("\n") + self.READINGS
                          + "\n\n" + envelope(2), encoding="utf-8")
        self.ensure_plan()
        reviews = [{"round": 1, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "fixed"},
                   {"round": 2, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "clean"}]
        self.stamp("D00 T01 §1", self.sha, reviews, ["true -> ok"], "2026-10-23")
        tg.graph(self.root)

    def test_anything_else_after_the_completion_verdict_is_still_refused(self):
        self.tick_work()
        for tail in ("\n\nAnd one more thought.", self.READINGS + "\n\nA closing remark.",
                     self.READINGS + "\n- not a reading line", "\n\n### Second reading",
                     self.READINGS + self.READINGS,
                     # Review round 1 (P2): a disagreement with no reason, which eval/import-readings.ts refuses.
                     "\n\n### Second reading\n\n- `eval/sets/a/1.json`: disagree",
                     "\n\n### Second reading\n\n- `eval/sets/a/1.json`: disagree:   "):
            with self.subTest(tail=tail[-30:]):
                self.write_completion(review="1. Ctrl+O: missing-in-scope.\n\nCOMPLETION: gaps" + tail)
                self.completion_refuses({"report": self.COMPLETION, "verdict": "completed"},
                                        "must hold exactly one completion review")

    def test_the_completion_verdict_reader(self):
        self.assertEqual(tg.completion_verdict("x\n\nCOMPLETION: complete\n"), "COMPLETION: complete")
        self.assertEqual(tg.completion_verdict("x\nCOMPLETION: gaps" + self.READINGS), "COMPLETION: gaps")
        self.assertEqual(tg.completion_verdict("COMPLETION: gaps\nlater text"), "later text")
        self.assertEqual(tg.completion_verdict(""), "")

    def test_filed_gaps_must_be_listed_and_must_resolve(self):
        self.tick_work()
        gaps = "1. Recent files: missing-out-of-scope.\n\nCOMPLETION: gaps"
        filed = {"report": self.COMPLETION, "verdict": "filed"}
        self.write_completion(review=gaps)
        self.completion_refuses(filed, "completion verdict filed needs each filed section listed")
        self.write_completion(review=gaps, notes="- Filed: D00 T09 §1 (recent files)")
        self.completion_refuses(filed, "completion gap filed as D00 T09 §1, which does not resolve")
        self.write_completion(review=gaps, notes="- Filed: D00 T01 §1 (itself)")
        self.completion_refuses(filed, "cannot file a completion gap to itself")
        self.write_completion(review=gaps, notes="- Filed: D00 T01 §2 (recent files)")
        self.completion_refuses({"report": self.COMPLETION, "verdict": "completed"},
                                "and only filed lists any")
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23", completion=filed)
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        self.assertEqual((data["completion"]["verdict"], data["completion"]["filed"]), ("filed", ["D00 T01 §2"]))
        tg.graph(self.root)

    def test_a_filed_section_that_stops_resolving_refuses(self):
        other = self.root / "todo/00-workspace/TODO-02-b.md"
        other.write_text(todo_file([(1, "Recent files", 0, "none", "--")], ident="bravo"), encoding="utf-8")
        self.index("TODO-02-b.md")
        self.tick_work()
        self.write_completion(review="1. Recent files: missing-out-of-scope.\n\nCOMPLETION: gaps",
                              notes="- Filed: D00 T02 §1 (recent files)")
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23",
                   completion={"report": self.COMPLETION, "verdict": "filed"})
        other.unlink()
        self.refuses("completion gap filed as D00 T02 §1, which does not resolve: D00 T01 §1")

    def test_the_completion_candidate_is_the_stamped_commit_or_before_it(self):
        self.tick_work()
        subprocess.run(["git", "-C", str(self.root), "commit", "-q", "--allow-empty", "-m", "later"], check=True)
        later = subprocess.run(["git", "-C", str(self.root), "rev-parse", "HEAD"], capture_output=True,
                               text=True).stdout.strip()
        self.write_completion(candidate=later)
        self.completion_refuses({"report": self.COMPLETION, "verdict": "complete"},
                                "is not the stamped commit or an ancestor of it")
        self.write_completion(candidate="f" * 40)
        self.completion_refuses({"report": self.COMPLETION, "verdict": "complete"}, "not a commit")

    def test_a_receipt_records_the_completion_review_and_edits_refuse(self):
        self.tick_work()
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23")
        data = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(data["completion"]["verdict"], "complete")
        for key, value in (("verdict", "completed"), ("filed", ["D00 T01 §2"]), ("reviewer", "astra")):
            with self.subTest(key=key):
                edited = json.loads(json.dumps(data))
                edited["completion"][key] = value
                receipt.write_text(json.dumps(edited), encoding="utf-8")
                with self.assertRaises(tg.Refused):
                    tg.graph(self.root)
        receipt.write_text(json.dumps(data), encoding="utf-8")
        tg.graph(self.root)
        # An edit inside the recorded completion review breaks its digest, so the receipt no longer validates.
        path = self.root / self.COMPLETION
        path.write_text(path.read_text(encoding="utf-8").replace("present", "absent"), encoding="utf-8")
        self.refuses("is not a findings file the dispatcher can read")

    def test_a_receipt_from_before_the_completion_review_still_validates(self):
        # Receipts stamped before 2026-10-23 carry no completion field (nor the later plan and schedule); once frozen,
        # their presence-free shape stays valid.
        self.tick_work()
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-23")
        data = json.loads(receipt.read_text(encoding="utf-8"))
        del data["completion"], data["plan"], data["schedule"]
        receipt.write_text(json.dumps(data), encoding="utf-8")
        (self.root / self.COMPLETION).unlink()
        self.refuses(tg.LEGACY_RECEIPTS)
        (self.root / tg.LEGACY_RECEIPTS).write_text(json.dumps(
            {"schema_version": 1, "receipts": {}, "before_plan": {"D00 T01 §1": tg.receipt_digest(data)}}),
            encoding="utf-8")
        tg.graph(self.root)
        self.assertIsNone(tg.review_rounds(self.root)["sections"][0]["completion"])

    def tick_work(self):
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        text = path.read_text(encoding="utf-8").replace("- [ ] Work.", "- [x] Work.", 1)
        path.write_text(text.replace("- [ ] Work on `scripts/tool.py`.", "- [x] Work on `scripts/tool.py`.", 1),
                        encoding="utf-8")

    def test_stamp_writes_receipt_and_validates(self):
        self.tick_work()
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        rows = tg.graph(self.root)
        self.assertTrue(rows["D00 T01 §1"].done)
        self.assertEqual(json.loads((self.root / receipt).read_text(encoding="utf-8"))
                         ["implementation_sha"], self.sha)

    def test_receipt_records_rounds_spent_against_the_cap(self):
        self.tick_work()
        report = self.root / "docs/reviews/00-workspace/D00-T01-s1.md"
        report.write_text("# Review findings\n\n" + envelope(1, "none") + envelope(2, overall="needs-attention")
                          + envelope(3), encoding="utf-8")
        reviews = [{"round": 2, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "fixed"},
                   {"round": 3, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "clean"}]
        receipt = self.stamp("D00 T01 §1", self.sha, reviews, ["true -> ok"], "2026-10-13")
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        self.assertEqual((data["rounds_spent"], data["round_cap"]), (3, tg.REVIEW_ROUND_CAP))
        self.assertNotIn("cap_outcome", data)
        summary = tg.review_rounds(self.root)
        self.assertEqual(summary["sections"][0]["rounds_spent"], 3)
        self.assertEqual(summary["summary"]["stopped_at_cap"], 0)

    def record_rounds(self, last, report="docs/reviews/00-workspace/D00-T01-s1.md"):
        light = getattr(self, "light", False)
        (self.root / report).write_text("".join(envelope(n, overall="needs-attention", light=light)
                                                for n in range(1, last + 1)), encoding="utf-8")
        self.ensure_plan()

    def test_the_cap_is_3_and_earlier_caps_stay_valid(self):
        # Operator decision 2026-11-03: the review-round cap moved to 3 regular rounds (5 reviews total with plan + completion).
        self.assertEqual(tg.REVIEW_ROUND_CAP, 3)
        self.assertIn("stopped-at-3", tg.VERDICTS)
        for earlier in (33, 22, 13, 8, 3):
            self.assertIn(f"stopped-at-{earlier}", tg.VERDICTS)
        self.assertEqual(tg.EARLIER_CAPS, {8, 13, 22, 33})

    def make_light(self):
        """The fixture again, with §1 a `Risk: light` section naming only tooling from its first commit."""
        self.tearDown()
        self.light = True
        self.setUp()

    def test_a_light_section_and_a_full_one_stop_at_3_rounds(self):
        # Operator, 2026-11-03: both light and full sections stamp at 3 regular rounds with their leftovers filed.
        self.assertEqual((tg.round_cap("light"), tg.round_cap("full")), (3, 3))
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        stopped = [{"round": 3, "report": report, "verdict": "stopped-at-3"}]
        self.tick_work()
        self.record_rounds(8)
        with self.assertRaises(tg.Refused) as ctx:  # a full section does not stop at 8
            self.stamp("D00 T01 §1", self.sha, [{"round": 8, "report": report, "verdict": "stopped-at-8"}],
                       ["true -> ok"], "2026-10-13", cap_outcome="filed")
        self.assertIn("stopped-at-3", str(ctx.exception))
        self.make_light()
        self.tick_work()
        self.record_rounds(3)
        receipt = self.stamp("D00 T01 §1", self.sha, stopped, ["true -> ok"], "2026-10-13",
                             cap_outcome="filed the leftovers as D00 T01 §2")
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        self.assertEqual((data["rounds_spent"], data["round_cap"]), (3, 3))
        tg.graph(self.root)

    def test_a_light_section_still_needs_its_3_rounds_to_stop_at_the_cap(self):
        self.make_light()
        self.tick_work()
        self.record_rounds(2)
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §1", self.sha, [{"round": 2, "report": "docs/reviews/00-workspace/D00-T01-s1.md",
                                                 "verdict": "stopped-at-3"}], ["true -> ok"], "2026-10-13",
                       cap_outcome="filed")

    def test_a_receipt_written_under_earlier_round_caps_still_validates(self):
        self.tick_work()
        self.record_rounds(22)
        stopped = [{"round": 22, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "stopped-at-22"}]
        with self.assertRaises(tg.Refused):  # a new stamp stops only at the current cap
            self.stamp("D00 T01 §1", self.sha, stopped, ["true -> ok"], "2026-10-13", cap_outcome="filed")
        self.record_rounds(3)
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, [
            {"round": 3, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "stopped-at-3"}],
            ["true -> ok"], "2026-10-13", cap_outcome="filed")
        # The same section as a receipt from the 22-round era: 22 rounds, stopped-at-22, round_cap 22.
        self.record_rounds(22)
        data = json.loads(receipt.read_text(encoding="utf-8"))
        data.update(reviews=stopped, rounds_spent=22, round_cap=22)
        receipt.write_text(json.dumps(data), encoding="utf-8")
        tg.graph(self.root)
        data["round_cap"] = 33  # but a 22-round stop is not a stop at the 33-round cap
        receipt.write_text(json.dumps(data), encoding="utf-8")
        self.refuses("must be stopped-at-33")

    def test_a_stopped_review_must_say_what_was_done(self):
        self.tick_work()
        cap = tg.REVIEW_ROUND_CAP
        self.record_rounds(cap)
        stopped = [{"round": cap, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": f"stopped-at-{cap}"}]
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, stopped, ["true -> ok"], "2026-10-13")
        self.assertIn("--cap-outcome", str(ctx.exception))
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13",
                     cap_outcome="nothing stopped")
        receipt = self.stamp("D00 T01 §1", self.sha, stopped, ["true -> ok"], "2026-10-13",
                           cap_outcome="filed two leftovers as D00 T01 §2")
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        self.assertEqual((data["rounds_spent"], data["cap_outcome"]), (cap, "filed two leftovers as D00 T01 §2"))
        self.assertEqual(tg.review_rounds(self.root)["summary"]["stopped_at_cap"], 1)
        # A receipt that drops the outcome no longer validates.
        del data["cap_outcome"]
        (self.root / receipt).write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(tg.Refused):
            tg.graph(self.root)

    def test_a_receipt_without_rounds_spent_holds_only_what_the_old_process_wrote(self):
        self.tick_work()
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        data = json.loads(receipt.read_text(encoding="utf-8"))
        del data["rounds_spent"], data["round_cap"], data["plan"], data["schedule"]
        receipt.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:  # the old shape alone does not make a receipt old
            tg.graph(self.root)
        self.assertIn(tg.LEGACY_RECEIPTS, str(ctx.exception))
        legacy = self.root / tg.LEGACY_RECEIPTS
        legacy.write_text(json.dumps({"schema_version": 1, "receipts": {"D00 T01 §1": tg.receipt_digest(data)}}),
                          encoding="utf-8")
        tg.graph(self.root)  # a frozen old receipt still validates
        data["date"] = "2026-10-22"
        receipt.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(tg.Refused):  # and any change to it is no longer the frozen receipt
            tg.graph(self.root)
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        for rounds in ([{"round": 9, "report": report, "verdict": "stopped-low-severity"}],
                       [{"round": 1, "report": report, "verdict": "stopped-at-33"}]):
            data["reviews"] = rounds
            receipt.write_text(json.dumps(data), encoding="utf-8")
            with self.subTest(rounds=rounds), self.assertRaises(tg.Refused) as ctx:
                tg.graph(self.root)
            self.assertIn("without rounds_spent", str(ctx.exception))

    def test_a_loop_past_the_cap_refuses_even_when_it_ends_clean(self):
        self.tick_work()
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        last = tg.REVIEW_ROUND_CAP + 1
        (self.root / report).write_text("".join(envelope(n, overall="needs-attention") for n in range(1, last))
                                        + envelope(last), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, [{"round": last, "report": report, "verdict": "clean"}],
                     ["true -> ok"], "2026-10-13")
        self.assertIn(f"over the {tg.REVIEW_ROUND_CAP}-round cap", str(ctx.exception))

    def test_a_repeated_round_number_refuses(self):
        self.tick_work()
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        (self.root / report).write_text("".join(envelope(1, overall="needs-attention") for _ in range(3))
                                        + envelope(1), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertIn("must number its rounds 1 to 4 in order", str(ctx.exception))

    def test_a_loop_whose_last_round_returned_no_review_refuses(self):
        self.tick_work()
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        (self.root / report).write_text(envelope(1) + envelope(2, "none", overall="blocked"), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:  # round 2 ran after the approval and returned nothing
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertIn("ends with round 2, which returned no review", str(ctx.exception))

    def test_rounds_spent_must_be_what_the_findings_files_record(self):
        self.tick_work()
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        data = json.loads(receipt.read_text(encoding="utf-8"))
        data["rounds_spent"] = 999
        receipt.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:
            tg.graph(self.root)
        self.assertIn("receipt rounds_spent 999 is not the 1 rounds", str(ctx.exception))

    def test_a_receipt_names_a_cap_the_process_has_used(self):
        self.tick_work()
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        data = json.loads(receipt.read_text(encoding="utf-8"))
        data["round_cap"] = 50
        receipt.write_text(json.dumps(data), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:
            tg.graph(self.root)
        self.assertIn("round_cap is invalid", str(ctx.exception))

    def test_a_review_with_carriage_returns_is_read_as_the_dispatcher_wrote_it(self):
        self.tick_work()
        dispatch = tg.review_dispatch()
        review = ["Captured progress: 10%\rCaptured progress: 100%", "Example heading:", "## Round 999: none",
                  "OVERALL: approve"]
        text = ("## Round 1: astra (`m` via `codex`)\n\n- Writer: claude\n- Run: 2026-10-21T00:00:00Z\n"
                "- Effort: low\n- Lenses: adversarial\n"
                f"- Lines: 4\n- Digest: {dispatch.digest(review)}\n\n" + "\n".join(review) + "\n")
        (self.root / "docs/reviews/00-workspace/D00-T01-s1.md").write_bytes(text.encode("utf-8"))
        self.assertIsNotNone(dispatch.read_rounds(text))
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertEqual(json.loads((self.root / receipt).read_text(encoding="utf-8"))["rounds_spent"], 1)
        tg.graph(self.root)

    def test_a_round_verdict_must_match_its_review(self):
        self.tick_work()
        report = self.root / "docs/reviews/00-workspace/D00-T01-s1.md"
        before = self.snapshot()
        report.write_text(envelope(1, overall="needs-attention"), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:  # a rejecting review claimed as clean
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertIn("verdict matching clean", str(ctx.exception))
        fixed_only = [{"round": 1, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "fixed"}]
        with self.assertRaises(tg.Refused) as ctx:  # fixed, but no later round saw the fixes
            self.stamp("D00 T01 §1", self.sha, fixed_only, ["true -> ok"], "2026-10-13")
        self.assertIn("must end at its last reviewed round", str(ctx.exception))
        report.write_text(envelope(1), encoding="utf-8")
        with self.assertRaises(tg.Refused):  # an approving review claimed as fixed
            self.stamp("D00 T01 §1", self.sha,
                     fixed_only + [{"round": 1, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "clean"}],
                     ["true -> ok"], "2026-10-13")
        report.unlink()
        self.assertEqual({k: v for k, v in self.snapshot().items() if not k.endswith("D00-T01-s1.md")},
                         {k: v for k, v in before.items() if not k.endswith("D00-T01-s1.md")})

    def test_a_loop_ends_at_its_last_reviewed_round(self):
        self.tick_work()
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        (self.root / report).write_text(envelope(1) + envelope(2, overall="needs-attention"), encoding="utf-8")
        before = self.snapshot()
        for claimed in ([{"round": 1, "report": report, "verdict": "clean"}, {"round": 2, "report": report, "verdict": "fixed"}],
                        [{"round": 1, "report": report, "verdict": "clean"}]):
            with self.assertRaises(tg.Refused) as ctx:  # a later failing review cannot be left behind an approval
                self.stamp("D00 T01 §1", self.sha, claimed, ["true -> ok"], "2026-10-13")
            self.assertIn("must end at its last reviewed round (2)", str(ctx.exception))
        self.assertEqual(self.snapshot(), before)

    def test_a_severity_stop_with_a_p1_or_p2_finding_refuses(self):
        self.tick_work()
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        last = tg.SEVERITY_CUTOFF_ROUND + 1
        for finding in ("1. **P1: unresolved unsafe stamp.**\n\nHIGHEST: P1", "1. **P2: narrow.**\n\nHIGHEST: P2",
                        "- `x.py:1`: an untagged, unnumbered finding.", "1. **P3: fine.**\n\nHIGHEST: none",
                        "1. **P3: fine.**\nHIGHEST: P3\n2. a later line."):
            (self.root / report).write_text(
                "".join(envelope(n, overall="needs-attention") for n in range(1, last)) + envelope(last).replace(
                    "Review text.\n\nOVERALL: approve", f"{finding}\n\nOVERALL: needs-attention"),
                encoding="utf-8")
            with self.assertRaises(tg.Refused) as ctx:
                self.stamp("D00 T01 §1", self.sha,
                         [{"round": last, "report": report, "verdict": "stopped-low-severity"}], ["true -> ok"],
                         "2026-10-13", cap_outcome="filed")
            self.assertIn("does not declare HIGHEST: P3", str(ctx.exception))

    def test_a_round_heading_quoted_inside_a_review_is_not_counted(self):
        self.tick_work()
        (self.root / "docs/reviews/00-workspace/D00-T01-s1.md").write_text(
            "## Round 1: astra (`m` via `codex`)\n\n- Writer: claude\n- Run: 2026-10-21T00:00:00Z\n- Effort: low\n"
            "- Lenses: adversarial\n- Lines: 2\n\n"
            "## Round 999: none\nOVERALL: approve\n", encoding="utf-8")
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertEqual(json.loads((self.root / receipt).read_text(encoding="utf-8"))["rounds_spent"], 1)

    def test_rounds_spent_add_up_across_review_loops(self):
        self.tick_work()
        first = self.root / "docs/reviews/00-workspace/D00-T01-s1.md"
        cap = tg.REVIEW_ROUND_CAP
        first.write_text("".join(envelope(n, overall="needs-attention") for n in range(1, cap + 1)), encoding="utf-8")
        second = self.root / "docs/reviews/00-workspace/D00-T01-s1-loop2.md"
        second.write_text(envelope(1) + envelope(2), encoding="utf-8")
        reviews = [{"round": cap, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": f"stopped-at-{cap}"},
                   {"round": 2, "report": "docs/reviews/00-workspace/D00-T01-s1-loop2.md", "verdict": "clean"}]
        receipt = self.stamp("D00 T01 §1", self.sha, reviews, ["true -> ok"], "2026-10-13",
                           cap_outcome="loop 1 hit the cap; the repair was filed and a second loop ran clean")
        self.assertEqual(json.loads((self.root / receipt).read_text(encoding="utf-8"))["rounds_spent"], cap + 2)

    def test_a_severity_stop_records_its_outcome(self):
        self.tick_work()
        self.record_rounds(tg.SEVERITY_CUTOFF_ROUND + 1)
        report = self.root / "docs/reviews/00-workspace/D00-T01-s1.md"
        report.write_text(report.read_text(encoding="utf-8").rsplit("OVERALL: needs-attention", 1)[0]
                          + "HIGHEST: P3\n\nOVERALL: needs-attention\n\n", encoding="utf-8")
        low =[{"round": tg.SEVERITY_CUTOFF_ROUND + 1, "report": "docs/reviews/00-workspace/D00-T01-s1.md",
                "verdict": "stopped-low-severity"}]
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §1", self.sha, low, ["true -> ok"], "2026-10-13")
        receipt = self.stamp("D00 T01 §1", self.sha, low, ["true -> ok"], "2026-10-13",
                           cap_outcome="round 9 had two P3 findings, filed as D00 T01 §2")
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        self.assertEqual(data["cap_outcome"], "round 9 had two P3 findings, filed as D00 T01 §2")
        summary = tg.review_rounds(self.root)["summary"]
        self.assertEqual((summary["stopped_low_severity"], summary["stopped_at_cap"]), (1, 0))

    def test_a_cap_stop_must_be_the_current_cap_reached(self):
        self.tick_work()
        self.record_rounds(tg.REVIEW_ROUND_CAP)
        before = self.snapshot()
        for n, verdict in ((1, f"stopped-at-{tg.REVIEW_ROUND_CAP}"), (3, "stopped-at-8"), (13, "stopped-at-13")):
            early = [{"round": n, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": verdict}]
            with self.assertRaises(tg.Refused) as ctx:
                self.stamp("D00 T01 §1", self.sha, early, ["true -> ok"], "2026-10-13", cap_outcome="filed")
            self.assertRegex(str(ctx.exception), f"must be stopped-at-{tg.REVIEW_ROUND_CAP}|"
                                                 f"a cap stop is the round that returns review {tg.REVIEW_ROUND_CAP}")
        self.assertEqual(self.snapshot(), before)

    def test_a_severity_stop_with_only_p3_findings_stamps(self):
        self.tick_work()
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        last = tg.SEVERITY_CUTOFF_ROUND + 1
        (self.root / report).write_text(
            "".join(envelope(n, overall="needs-attention") for n in range(1, last)) + envelope(last).replace(
                "Review text.\n\nOVERALL: approve", "1. **P3: wording.**\n2. **P3: the comment describing P1 findings.**\n\nHIGHEST: P3\n\nOVERALL: needs-attention"),
            encoding="utf-8")
        self.stamp("D00 T01 §1", self.sha, [{"round": last, "report": report, "verdict": "stopped-low-severity"}],
                 ["true -> ok"], "2026-10-13", cap_outcome="two P3 findings filed")

    def test_outage_rounds_do_not_earn_a_stop(self):
        self.tick_work()
        report = "docs/reviews/00-workspace/D00-T01-s1.md"
        # At the live cutoff of 0 any returned review may stop; outages count toward no cutoff, which shows at 3.
        with mock.patch.object(tg, "SEVERITY_CUTOFF_ROUND", 3):
            last = 4
            (self.root / report).write_text(
                "".join(envelope(n, "none") for n in range(1, last)) + envelope(last).replace(
                    "Review text.\n\nOVERALL: approve", "1. **P3: wording.**\n\nHIGHEST: P3\n\nOVERALL: needs-attention"), encoding="utf-8")
            with self.assertRaises(tg.Refused) as ctx:
                self.stamp("D00 T01 §1", self.sha, [{"round": last, "report": report, "verdict": "stopped-low-severity"}],
                         ["true -> ok"], "2026-10-13", cap_outcome="filed")
            self.assertIn("follows only 1 returned reviews", str(ctx.exception))
        cap = tg.REVIEW_ROUND_CAP
        (self.root / report).write_text(envelope(1, "none") + "".join(
            envelope(n, overall="needs-attention") for n in range(2, cap + 1)), encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, [{"round": cap, "report": report, "verdict": f"stopped-at-{cap}"}],
                     ["true -> ok"], "2026-10-13", cap_outcome="filed")
        self.assertIn("a cap stop is the round that returns review", str(ctx.exception))
        # Blocked or empty replies are not returned reviews either (at the cutoff of 3, as above).
        cutoff = mock.patch.object(tg, "SEVERITY_CUTOFF_ROUND", 3)
        cutoff.start()
        self.addCleanup(cutoff.stop)
        for filler in (envelope(1).replace("OVERALL: approve", "OVERALL: blocked"), envelope(1).replace("OVERALL: approve", ""),
                       envelope(1, "claude (`claude-opus-5` via `claude`)", overall="needs-attention")):
            (self.root / report).write_text("".join(filler.replace("## Round 1:", f"## Round {n}:") for n in range(1, last))
                                            + envelope(last).replace("Review text.\n\nOVERALL: approve",
                                                                     "1. **P3: wording.**\n\nHIGHEST: P3\n\nOVERALL: needs-attention"),
                                            encoding="utf-8")
            with self.assertRaises(tg.Refused) as ctx:
                self.stamp("D00 T01 §1", self.sha,
                         [{"round": last, "report": report, "verdict": "stopped-low-severity"}],
                         ["true -> ok"], "2026-10-13", cap_outcome="filed")
            self.assertIn("follows only 1 returned reviews", str(ctx.exception))
        # An outage before the cap moves the cap stop to the round that returns the cap's last review.
        (self.root / report).write_text(envelope(1, "none") + "".join(
            envelope(n, overall="needs-attention") for n in range(2, cap + 2)), encoding="utf-8")
        self.stamp("D00 T01 §1", self.sha, [{"round": cap + 1, "report": report, "verdict": f"stopped-at-{cap}"}],
                 ["true -> ok"], "2026-10-13", cap_outcome="filed")

    def test_a_severity_stop_before_the_cutoff_refuses(self):
        # The live cutoff is 0, so no round comes before it; the refusal is checked at the
        # earlier cutoff of 3, which a later decision could restore.
        with mock.patch.object(tg, "SEVERITY_CUTOFF_ROUND", 3):
            self.tick_work()
            self.record_rounds(3)
            before = self.snapshot()
            for n in (1, 3):
                early = [{"round": n, "report": "docs/reviews/00-workspace/D00-T01-s1.md",
                          "verdict": "stopped-low-severity"}]
                with self.assertRaises(tg.Refused) as ctx:
                    self.stamp("D00 T01 §1", self.sha, early, ["true -> ok"], "2026-10-13", cap_outcome="filed")
                self.assertIn("only after round 3", str(ctx.exception))
            self.assertEqual(self.snapshot(), before)

    def test_the_live_cutoff_stops_on_the_first_p3_round(self):
        self.assertEqual(tg.SEVERITY_CUTOFF_ROUND, 0)

    def test_a_claimed_round_must_be_a_reviewed_round_in_its_report(self):
        self.tick_work()
        report = self.root / "docs/reviews/00-workspace/D00-T01-s1.md"
        before = self.snapshot()
        for text in ("# No independent review has run\n", envelope(1, "none"), envelope(2),
                     envelope(1, "claude (`claude-opus-5` via `claude`)"),
                     envelope(1).replace("- Writer: claude", "- Writer: codex"),
                     envelope(1).replace("- Writer: claude", "- Writer: someone"),
                     envelope(1).replace("OVERALL: approve", "OVERALL: blocked"),
                     envelope(1).replace("OVERALL: approve", ""),
                     "## Round 1: astra (`m` via `codex`)\n\n- Writer: claude\n- Run: 2026-10-21T00:00:00Z\n- Lines: 0\n",
                     "## Round 1: fake\n\nNo reviewer returned a review.\n",
                     "## Round 1: astra (`m` via `codex`)\n\nNo metadata block.\n"):
            report.write_text(text, encoding="utf-8")
            with self.assertRaises(tg.Refused) as ctx:
                self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
            self.assertRegex(str(ctx.exception), "is not a review returned by another model family|"
                                                 "is not a findings file the dispatcher can read|holds no returned review|"
                                                 "must number its rounds")
        for bad in (0, -1, True):
            with self.assertRaises(tg.Refused):
                self.stamp("D00 T01 §1", self.sha,
                         [{"round": bad, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "clean"}],
                         ["true -> ok"], "2026-10-13")
        report.write_text("# Review findings\n\n" + envelope(1), encoding="utf-8")
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        # A receipt edited to claim a round its report never recorded no longer validates.
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        data["reviews"][0]["round"] = 999
        data["rounds_spent"] = 999
        (self.root / receipt).write_text(json.dumps(data), encoding="utf-8")
        self.refuses("round 999 is not a review returned by another model family")

    def test_a_stamped_section_with_a_waiting_need_refuses(self):
        self.tick_work()
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace("**Needs:** none", "**Needs:** owner-decision", 1),
                        encoding="utf-8")
        self.refuses("stamped section has a waiting Need")

    def test_stale_deferral_refuses_when_owner_stamps(self):
        self.tick_work()
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        text = path.read_text(encoding="utf-8")
        target = "## 2. B\n"
        path.write_text(text.replace(target, target + "\n> **Deferred:** wait on 1 -> XREF: §1\n"),
                        encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertIn("stale deferral", str(ctx.exception))

    def test_unticked_items_refuse(self):
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertIn("unticked", str(ctx.exception))

    def test_waiting_section_cannot_be_stamped(self):
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §2", self.sha, self.reviews, ["true -> ok"], "2026-10-13")

    def test_unknown_commit_refuses(self):
        self.tick_work()
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §1", "0" * 40, self.reviews, ["true -> ok"], "2026-10-13")

    def test_no_review_round_refuses(self):
        self.tick_work()
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §1", self.sha, [], ["true -> ok"], "2026-10-13")

    def test_missing_review_report_refuses(self):
        self.tick_work()
        for bad_path in (r"\Users\outside.md", "../outside.md", "docs/reviews/../outside.md", "outside.md"):
            bad_round = [{"round": 1, "report": bad_path, "verdict": "clean"}]
            with self.assertRaises(tg.Refused) as ctx:
                self.stamp("D00 T01 §1", self.sha, bad_round, ["true -> ok"], "2026-10-13")
            self.assertIn("invalid review report path", str(ctx.exception))
        missing = [{"round": 1, "report": "docs/reviews/00-workspace/missing.md", "verdict": "clean"}]
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, missing, ["true -> ok"], "2026-10-13")
        self.assertIn("missing or empty review report", str(ctx.exception))
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        (self.root / "docs/reviews/00-workspace/D00-T01-s1.md").unlink()
        self.refuses("missing or empty review report")

    def test_receipt_for_another_commit_refuses(self):
        self.tick_work()
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        data = json.loads((self.root / receipt).read_text(encoding="utf-8"))
        data["implementation_sha"] = "f" * 40
        (self.root / receipt).write_text(json.dumps(data), encoding="utf-8")
        self.refuses("receipt does not match its stamp")

    def test_matching_fabricated_sha_in_stamp_and_receipt_refuses(self):
        self.tick_work()
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        fake_sha = "0" * 40
        todo_path = self.root / "todo/00-workspace/TODO-01-a.md"
        todo_path.write_text(todo_path.read_text(encoding="utf-8").replace(self.sha, fake_sha),
                             encoding="utf-8")
        receipt_path = self.root / receipt
        receipt_path.write_text(receipt_path.read_text(encoding="utf-8").replace(self.sha, fake_sha),
                                encoding="utf-8")
        self.refuses("not a commit")

    def snapshot(self):
        self.ensure_plan()  # the fixture's plan review is put back before, not during, a refused stamp
        return {str(f.relative_to(self.root)): f.read_bytes()
                for f in self.root.rglob("*") if f.is_file() and ".git" not in f.parts}

    def test_bad_verdict_writes_nothing(self):
        self.tick_work()
        before = self.snapshot()
        bad = [{"round": 1, "report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "cleen"}]
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §1", self.sha, bad, ["true -> ok"], "2026-10-13")
        self.assertEqual(self.snapshot(), before)
        tg.graph(self.root)

    def test_bad_date_writes_nothing(self):
        self.tick_work()
        before = self.snapshot()
        with self.assertRaises(tg.Refused):
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "13 Oct")
        self.assertEqual(self.snapshot(), before)

    def test_failed_stamp_write_rolls_back_receipt_and_allows_retry(self):
        self.tick_work()
        tg.projections(self.root, sync=True)
        before = self.snapshot()
        real_atomic = tg.atomic
        for fail_at in (2, 3):
            calls = []

            def fail_on_nth_write(path, data, target=fail_at):
                calls.append(path)
                if len(calls) == target:
                    raise OSError("simulated disk write failure")
                return real_atomic(path, data)

            tg.atomic = fail_on_nth_write
            try:
                with self.assertRaises(OSError):
                    self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"],
                             "2026-10-13", sync_plan=True)
            finally:
                tg.atomic = real_atomic
            self.assertEqual(len(calls), 4 if fail_at == 3 else 2)
            self.assertFalse((self.root / "docs/reviews/d00-t01-s1.json").exists())
            self.assertEqual(self.snapshot(), before)
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"],
                           "2026-10-13", sync_plan=True)
        self.assertTrue((self.root / receipt).is_file())
        tg.projections(self.root)

    def test_an_interrupted_stamp_rolls_back_and_allows_retry(self):
        self.tick_work()
        tg.projections(self.root, sync=True)
        before = self.snapshot()
        real_atomic = tg.atomic
        calls = []

        def interrupt_on_second_write(path, data):
            calls.append(path)
            if len(calls) == 2:
                raise KeyboardInterrupt
            return real_atomic(path, data)

        tg.atomic = interrupt_on_second_write
        try:
            with self.assertRaises(KeyboardInterrupt):
                self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13", sync_plan=True)
        finally:
            tg.atomic = real_atomic
        self.assertEqual(self.snapshot(), before)
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13", sync_plan=True)

    def test_unstamp_reopens_a_regressed_section_and_allows_a_restamp(self):
        self.tick_work()
        tg.projections(self.root, sync=True)
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13", sync_plan=True)
        before = self.snapshot()
        for bad in (("D00 T01 §2", "x"), ("D00 T01 §1", ""), ("D00 T01 §1", "two\nlines")):
            with self.assertRaises(tg.Refused):
                tg.unstamp(self.root, bad[0], bad[1], "2026-10-21")
        self.assertEqual(self.snapshot(), before)
        revoked = tg.unstamp(self.root, "D00 T01 §1", "checkpoint fails at abc1234; repair -> XREF: §2", "2026-10-21")
        rows = tg.graph(self.root)
        self.assertFalse(rows["D00 T01 §1"].done)
        self.assertEqual(tg.disposition(rows["D00 T01 §1"], rows), 0)
        self.assertFalse((self.root / receipt).exists())
        self.assertEqual((self.root / revoked).read_bytes(), before[str(pathlib.Path(receipt))])
        text = (self.root / "todo/00-workspace/TODO-01-a.md").read_text(encoding="utf-8")
        self.assertIn("> **Unstamped:** 2026-10-21: checkpoint fails", text)
        self.assertIn("- [ ] Commit:", text)
        tg.projections(self.root)  # the plan was synced
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-22", sync_plan=True)
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)

    def test_unstamping_a_prerequisite_leaves_its_consumers_stamped_and_suspect(self):
        path = self.root / "todo/00-workspace/TODO-02-b.md"
        path.write_text(todo_file([(1, "Base", 0, "none", "--"), (2, "Mid", 0, "none", "§1"), (3, "Top", 0, "none", "§2")],
                                  ident="bravo").replace("- [ ] Work.", "- [x] Work.")
                        .replace("**Test checkpoint:**", STARTED + "**Test checkpoint:**"), encoding="utf-8")
        self.index("TODO-02-b.md")
        self.commit("start bravo")
        for n in (1, 2, 3):
            self.stamp(f"D00 T02 §{n}", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        tg.unstamp(self.root, "D00 T02 §1", "checkpoint fails", "2026-10-21")
        rows = tg.graph(self.root)
        self.assertEqual([rows[f"D00 T02 §{n}"].done for n in (1, 2, 3)], [False, True, True])
        self.assertEqual(tg.suspects(self.root, "D00 T02 §1"), ["D00 T02 §2", "D00 T02 §3"])
        # New work on a suspect stamp waits, and cannot stamp, until the reopened ancestor re-stamps.
        extra = self.root / "todo/00-workspace/TODO-03-c.md"
        extra.write_text(todo_file([(1, "On top", 0, "none", "D00 T02 §3")], ident="charlie")
                         .replace("- [ ] Work.", "- [x] Work."), encoding="utf-8")
        self.index("TODO-03-c.md")
        rows = tg.graph(self.root)
        self.assertEqual(tg.disposition(rows["D00 T03 §1"], rows), 4)
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T03 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-21")
        self.assertIn("resting on a reopened section", str(ctx.exception))
        extra.unlink()
        # Without the Unstamped note, a stamped consumer of an open section still refuses.
        path.write_text(path.read_text(encoding="utf-8").replace("> **Unstamped:** ", "> **Note:** "), encoding="utf-8")
        self.refuses("stamped section has open dependency")

    def test_an_interrupted_unstamp_rolls_back(self):
        self.tick_work()
        tg.projections(self.root, sync=True)
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13", sync_plan=True)
        before = self.snapshot()
        real_atomic = tg.atomic
        calls = []

        def interrupt_on_second_write(path, data):
            calls.append(path)
            if len(calls) == 2:
                raise KeyboardInterrupt
            return real_atomic(path, data)

        tg.atomic = interrupt_on_second_write
        try:
            with self.assertRaises(KeyboardInterrupt):
                tg.unstamp(self.root, "D00 T01 §1", "regressed", "2026-10-21")
        finally:
            tg.atomic = real_atomic
        self.assertEqual(self.snapshot(), before)
        tg.graph(self.root)

    def test_stamping_the_last_section_marks_the_file_done(self):
        path = self.root / "todo/00-workspace/TODO-02-b.md"
        path.write_text(todo_file([(1, "Only", 0, "none", "--")], ident="bravo")
                        .replace("- [ ] Work.", "- [x] Work.")
                        .replace("**Test checkpoint:**", STARTED + "**Test checkpoint:**"), encoding="utf-8")
        self.index("TODO-02-b.md")
        self.commit("start bravo")
        self.stamp("D00 T02 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        self.assertIn("status: done", path.read_text(encoding="utf-8"))
        self.assertTrue(tg.graph(self.root)["D00 T02 §1"].done)

    def test_malformed_receipt_refuses_instead_of_crashing(self):
        self.tick_work()
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        unhashable = json.dumps({"ref": "D00 T01 §1", "implementation_sha": self.sha,
                                 "reviews": [{"round": 1, "report": "r", "verdict": []}],
                                 "checks": ["x"], "date": "2026-10-13"})
        for bad in ("[]", json.dumps({"ref": "D00 T01 §1", "implementation_sha": self.sha,
                                      "reviews": [None], "checks": ["x"], "date": "2026-10-13"}),
                    "not json", unhashable):
            (self.root / receipt).write_text(bad, encoding="utf-8")
            self.refuses("receipt")

    def test_missing_receipt_refuses(self):
        self.tick_work()
        receipt = self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-13")
        (self.root / receipt).unlink()
        self.refuses("missing receipt")

    # The plan review and the review schedule (2026-10-24): stamp refuses a section whose reviews did not follow them.

    LOOP = "docs/reviews/00-workspace/D00-T01-s1.md"
    ROUND_1 = ["adversarial", "integration", "source-defect", "plan-delivery"]

    def live(self, surface=False, risk=None):
        """Pin the live schedule shape (and, with surface, make §1 a surface section; with risk, give §1 that Risk
        line, naming a tooling path), committed as the stamped commit."""
        cap_patch = mock.patch.object(tg, "REVIEW_ROUND_CAP", 33)
        cap_patch.start()
        self.addCleanup(cap_patch.stop)
        (self.root / tg.PIN).write_text(SCHEDULE_PIN, encoding="utf-8")
        if risk:
            path = self.root / "todo/00-workspace/TODO-01-a.md"
            path.write_text(path.read_text(encoding="utf-8").replace(
                "**Surface:** no", f"**Risk:** {risk}\n**Surface:** no\n\nIt changes `scripts/tool.py`.", 1),
                encoding="utf-8")
        if surface:
            path = self.root / "todo/00-workspace/TODO-01-a.md"
            path.write_text(path.read_text(encoding="utf-8").replace(
                "**Surface:** no", "**Surface:** yes\n**Fidelity:** f.\n**Job:** j.\n**Treatment:** t.\n**Chrome:** c.",
                1), encoding="utf-8")
        self.sha = self.commit("live schedule")

    def loop(self, steps, surface=False, risk="full", fresh=True, returned=None, run="2026-10-23T00:00:00Z",
             pinned=False):
        """Record a review loop as the dispatcher would, each round at the pass `scheduled` gives it. A step is a
        severity (a returned needs-attention review declaring it), "clean", "outage", "self" (a self-review) or
        "malformed" (a reply without the final OVERALL line)."""
        dispatch = tg.review_dispatch()
        schedule = tg.pin_schedule(self.root, self.sha, "test")
        path = self.root / self.LOOP
        if path.exists() and fresh:  # a fresh loop: the rounds go, the section's plan review stays
            path.write_bytes(self.only(path.read_bytes().decode("utf-8"), plans=True).encode("utf-8"))
        for step in steps:
            existing = path.read_bytes().decode("utf-8") if path.exists() else ""
            plan = dispatch.scheduled(schedule, "round", dispatch.read_rounds(existing), surface, risk, returned=returned)
            result = {"writer": "claude", "effort": plan["effort"], "lenses": plan["lenses"], "failover": [],
                      "schedule": plan["schedule"],
                      "reviewer": "astra", "model": "m", "cli": "codex",
                      "review": "1. ok.\n\nHIGHEST: none\n\nOVERALL: approve"}
            if pinned:  # the pin the dispatcher ran under, as every pass records since D00 T01 §18
                result["pin"] = dispatch.pin_blob((self.root / tg.PIN).read_bytes())
            if step == "outage":
                result.update(reviewer=None, review=None, skipped=[{"reviewer": "astra", "reason": "exited 3"}])
            elif step == "self":
                result.update(reviewer="opus", cli="claude")
            elif step == "malformed":
                result["review"] = "1. The reply stopped before its verdict."
            elif step in ("P2-reading", "P1-reading"):  # a needs-attention round closing with a second reading block
                level = step.split("-")[0]
                result["review"] = (f"1. [{level}] gap.\n\nHIGHEST: {level}\n\nOVERALL: needs-attention\n\n"
                                    "### Second reading\n\n- `eval/sets/a/1.json`: agree")
            elif step != "clean":
                result["review"] = f"1. [{step}] gap.\n\nHIGHEST: {step}\n\nOVERALL: needs-attention"
            dispatch.record(path, result, run)
        rounds = len(dispatch.read_rounds(path.read_bytes().decode("utf-8")))
        self.reviews = [{"round": rounds, "report": self.LOOP, "verdict": "clean"}]

    def edit_round(self, n, effort, lenses):
        """Rewrite round n's Effort and Lenses lines, which sit outside its digest, as a hand edit would."""
        path = self.root / self.LOOP
        text = path.read_bytes().decode("utf-8")
        start = text.index(f"## Round {n}: ")
        end = text.find("\n## Round ", start)
        end = len(text) if end < 0 else end
        block = re.sub(r"^- Effort: .*$", f"- Effort: {effort}", text[start:end], count=1, flags=re.M)
        block = re.sub(r"^- Lenses: .*$", f"- Lenses: {', '.join(lenses)}", block, count=1, flags=re.M)
        path.write_bytes((text[:start] + block + text[end:]).encode("utf-8"))

    def stamp_refuses(self, fragment):
        self.tick_work()
        before = self.snapshot()
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24")
        self.assertIn(fragment, str(ctx.exception))
        self.assertEqual(self.snapshot(), before, "a refused stamp wrote something")
        return str(ctx.exception)

    def test_a_stamp_without_a_plan_review_refuses(self):
        self.tick_work()
        before = self.snapshot()
        with self.assertRaises(tg.Refused) as ctx:
            tg.stamp(self.root, "D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24",
                     completion={"report": self.COMPLETION, "verdict": "complete"})
        self.assertIn("--plan '<findings file>' is required", str(ctx.exception))
        self.assertEqual(self.snapshot(), before)

    def test_a_plan_review_must_be_one_returned_by_another_model_family(self):
        family = "must hold exactly one plan review returned by another model family"
        for kwargs in ({"reviewer": "opus", "cli": "claude"}, {"reviewer": None},
                       {"review": "1. ok.\n\nHIGHEST: none\n\nOVERALL: approve"},
                       {"review": "1. ok.\n\nOVERALL: approve\n\nPLAN: complete"}):
            with self.subTest(kwargs=kwargs):
                self.write_plan(**kwargs)
                self.stamp_refuses(family)
        self.write_plan()
        path = self.root / self.PLAN
        text = path.read_bytes().decode("utf-8")
        path.write_bytes(self.only(text, plans=False).encode("utf-8"))
        self.tick_work()
        with self.assertRaises(tg.Refused) as ctx:
            tg.stamp(self.root, "D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24", plan=self.PLAN,
                     completion={"report": self.COMPLETION, "verdict": "complete"})
        self.assertIn("holds no ## Plan review", str(ctx.exception))
        path.write_bytes(text.encode("utf-8"))
        for plan in ("docs/reviews/00-workspace/D00-T01-s2.md", self.COMPLETION,
                     "docs\\reviews\\00-workspace\\D00-T01-s1.md", "../plan.md"):
            with self.subTest(plan=plan):
                self.tick_work()
                with self.assertRaises(tg.Refused) as ctx:
                    self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24", plan=plan)
                self.assertIn(f"--plan must be the section's own findings file {self.PLAN}", str(ctx.exception))
        path.unlink()
        self.tick_work()
        with self.assertRaises(tg.Refused) as ctx:
            tg.stamp(self.root, "D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24", plan=self.PLAN,
                     completion={"report": self.COMPLETION, "verdict": "complete"})
        self.assertIn("missing or empty review report", str(ctx.exception))

    def test_another_sections_plan_review_does_not_stand_in(self):
        # §2's own findings file holds a returned plan review on the build-start commit; §1 cannot stamp on it.
        other = "docs/reviews/00-workspace/D00-T01-s2.md"
        self.write_plan(path=other)
        self.tick_work()
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24", plan=other)
        self.assertIn(f"--plan must be the section's own findings file {self.PLAN}, not {other}", str(ctx.exception))
        # Nor through a receipt edited after the stamp to name it.
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24")
        data = json.loads(receipt.read_text(encoding="utf-8"))
        data["plan"]["report"] = other
        receipt.write_text(json.dumps(data), encoding="utf-8")
        self.refuses(f"--plan must be the section's own findings file {self.PLAN}, not {other}")

    def cli(self, sha, ref="D00 T01 \u00a71"):
        """`todo-graph.py plan-candidate` run in the fixture (its scripts copied in, left untracked)."""
        if not (self.root / "scripts").exists():
            shutil.copytree(SCRIPTS, self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        return subprocess.run([sys.executable, "-B", str(self.root / "scripts/todo-graph.py"), "plan-candidate", ref,
                               sha], capture_output=True, text=True, timeout=60)

    def stamp_refusal(self, candidate):
        self.write_plan(candidate=candidate)
        self.tick_work()
        with self.assertRaises(tg.Refused) as ctx:
            tg.stamp(self.root, "D00 T01 \u00a71", candidate, self.reviews, ["true -> ok"], "2026-10-30", plan=self.PLAN,
                     completion={"report": self.COMPLETION, "verdict": "complete"})
        return str(ctx.exception)

    def test_the_started_commit_is_accepted_with_no_evidence(self):
        result = self.cli(self.start)
        self.assertEqual((result.returncode, result.stdout.strip(), result.stderr), (0, "ok", ""))

    def test_a_commit_after_a_fixture_reformat_is_accepted_with_the_stamps_own_evidence(self):
        later = self.fixture_commit()
        result = self.cli(later)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.startswith("ok "), result.stdout)
        shown = json.loads(result.stdout[len("ok "):])
        self.assertEqual(shown, {"start": self.start, "commits": [later]})
        _, receipt = self.stamp_after_started(later)
        self.assertEqual(shown, receipt["plan"]["after_started"], "the check shows what the receipt would record")

    def test_a_commit_after_a_src_change_is_refused_with_the_stamps_own_text(self):
        (self.root / "src").mkdir()
        (self.root / "src/feature.ts").write_text("export {}\n", encoding="utf-8")
        later = self.commit("the build")
        result = self.cli(later)
        self.assertEqual((result.returncode, result.stdout), (1, ""))
        refusal = self.stamp_refusal(later)
        self.assertEqual(result.stderr.strip(), "TODO refused: " + refusal)
        self.assertIn(f"{later} changed src/feature.ts in between", refusal)

    def test_the_findings_file_must_be_the_sections_own_as_stamp_requires(self):
        run = lambda findings: subprocess.run(  # noqa: E731
            [sys.executable, "-B", str(self.root / "scripts/todo-graph.py"), "plan-candidate", "D00 T01 \u00a71", self.start,
             "--findings", findings], capture_output=True, text=True, timeout=60)
        self.cli(self.start)  # the scripts are copied in
        self.assertEqual(run(self.PLAN).returncode, 0)
        for wrong in ("docs/reviews/00-wrong/D00-T01-s1.md", "docs/reviews/00-workspace/D00-T01-s2.md",
                      "docs/reviews/00-workspace/notes.md"):
            with self.subTest(wrong=wrong):
                result = run(wrong)
                self.assertEqual(result.returncode, 1)
                self.assertIn(f"--plan must be the section's own findings file {self.PLAN}, not {wrong}", result.stderr)

    def test_a_commit_that_is_not_one_and_a_section_that_does_not_exist_are_refused(self):
        result = self.cli("f" * 40)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not a commit", result.stderr)
        result = self.cli(self.start, ref="D00 T01 \u00a799")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no such section: D00 T01 \u00a799", result.stderr)

    def test_a_plan_review_after_the_build_began_refuses(self):
        (self.root / "src").mkdir()
        (self.root / "src/feature.ts").write_text("export {}\n", encoding="utf-8")
        later = self.commit("the build")
        self.write_plan(candidate=later)
        self.stamp_refuses(f"{later} changed src/feature.ts in between")
        self.write_plan(candidate="f" * 40)
        self.stamp_refuses("not a commit")
        # Without a Started line or a commit naming the section, there is no build start to check the plan against.
        self.write_plan()
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace(STARTED, ""), encoding="utf-8")
        self.stamp_refuses("cannot find the commit the build began at")

    def fixture_commit(self, message="test: the fixtures formatted"):
        """A commit that only reformats the build start's test fixture, as D02 T03 §4's eaa665b did after its Started
        commit."""
        fixture = self.root / "test/fixtures/rdap/dns.json"
        text = fixture.read_text(encoding="utf-8")
        fixture.write_text(text.replace(", ", ",\n  ") if ", " in text else text.replace(",\n  ", ", "), encoding="utf-8")
        return self.commit(message)

    def stamp_after_started(self, candidate):
        """Stamp §1 at `candidate` with its plan review on `candidate`; returns the receipt path and its data."""
        self.write_plan(candidate=candidate)
        self.tick_work()
        path = self.root / self.stamp("D00 T01 §1", candidate, self.reviews, ["true -> ok"], "2026-10-30")
        return path, json.loads(path.read_text(encoding="utf-8"))

    def test_a_plan_review_just_after_started_stamps_when_only_tests_moved(self):
        # D00 T01 §28: the candidate follows the Started commit by a fixture-formatting commit; the contract is the same.
        later = self.fixture_commit()
        listed = subprocess.run(["git", "-C", str(self.root), "rev-list", "--reverse", f"{self.start}..{later}"],
                                capture_output=True, text=True, check=True).stdout.split()
        path, receipt = self.stamp_after_started(later)
        self.assertEqual(receipt["plan"]["candidate"], later)
        self.assertEqual(receipt["plan"]["after_started"], {"start": self.start, "commits": listed})
        tg.graph(self.root)  # the receipt validates, its evidence rebuilt from the repository
        # A receipt edited to name other evidence, or none of the right shape, refuses.
        for bad in ({"start": self.start, "commits": [self.start, later]}, {"start": later, "commits": listed},
                    {"start": self.start, "commits": []}, {"commits": listed}, listed):
            with self.subTest(after_started=bad):
                path.write_text(json.dumps(dict(receipt, plan=dict(receipt["plan"], after_started=bad))),
                                encoding="utf-8")
                self.refuses("after_started")

    def test_a_plan_review_after_a_run_file_note_stamps(self):
        # 2026-10-31: a lane's run-file note between Started and the plan review refused D05 T01 §3's stamp.
        note = self.root / "docs/phase-runs/2026-10-31-lane-phase-1.md"
        note.parent.mkdir(parents=True, exist_ok=True)
        note.write_text("# Run\n\n- a note about another section\n", encoding="utf-8")
        later = self.commit("a run-file note")
        _, receipt = self.stamp_after_started(later)
        self.assertEqual(receipt["plan"]["after_started"], {"start": self.start, "commits": [later]})
        tg.graph(self.root)

    def test_a_plan_review_after_docs_outside_the_quiet_paths_still_refuses(self):
        (self.root / "docs/specs").mkdir(parents=True, exist_ok=True)
        (self.root / "docs/specs/design.md").write_text("a contract change\n", encoding="utf-8")
        later = self.commit("a spec edit")
        self.write_plan(candidate=later)
        self.stamp_refuses(f"{later} changed docs/specs/design.md in between")

    def test_a_plan_review_after_an_empty_commit_stamps(self):
        later = self.commit("an empty commit")
        _, receipt = self.stamp_after_started(later)
        self.assertEqual(receipt["plan"]["after_started"], {"start": self.start, "commits": [later]})

    def test_a_plan_review_on_the_build_start_records_no_after_started(self):
        self.tick_work()
        receipt = json.loads((self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"],
                                                     "2026-10-30")).read_text(encoding="utf-8"))
        self.assertEqual(receipt["plan"]["candidate"], self.start)
        self.assertNotIn("after_started", receipt["plan"])

    def test_a_plan_review_after_a_contract_edit_refuses(self):
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace(STARTED, STARTED + "A step the plan review never read.\n\n", 1), encoding="utf-8")
        edited = self.commit("todo: a step added after Started")
        self.write_plan(candidate=self.fixture_commit())
        self.stamp_refuses(f"{edited} changed the section's contract in todo/00-workspace/TODO-01-a.md")
        # Put back byte for byte, the edit still sat between the start and the candidate.
        path.write_text(text, encoding="utf-8")
        self.commit("todo: the step taken out again")
        self.write_plan(candidate=self.fixture_commit())
        self.stamp_refuses(f"{edited} changed the section's contract")

    def test_a_plan_review_after_the_files_outcome_changed_refuses(self):
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("## Outcome", text)
        path.write_text(text.replace("## Outcome\n", "## Outcome\n\nA promise the plan review never read.\n", 1),
                        encoding="utf-8")
        edited = self.commit("todo: the Outcome grows")
        self.write_plan(candidate=self.fixture_commit())
        self.stamp_refuses(f"{edited} changed the section's contract")

    def test_another_sections_row_and_text_may_change_after_started(self):
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("## 2. B", text)
        path.write_text(text.replace("## 2. B\n", "## 2. B\n\nAnother section's note.\n", 1), encoding="utf-8")
        later = self.commit("todo: §2 noted")
        _, receipt = self.stamp_after_started(later)
        self.assertEqual(receipt["plan"]["after_started"]["commits"], [later])

    def test_a_plan_review_after_test_work_refuses(self):
        fixture = self.root / "test/fixtures/rdap/dns.json"
        self.fixture_commit()
        fixture.write_text(fixture.read_text(encoding="utf-8").replace("2", "3"), encoding="utf-8")
        changed = self.commit("test: a fixture value changed")
        self.write_plan(candidate=changed)
        self.stamp_refuses(f"{changed} changed test/fixtures/rdap/dns.json in between")

    def test_an_added_test_after_started_refuses(self):
        (self.root / "tests").mkdir()
        (self.root / "tests/test_new.py").write_text("assert True\n", encoding="utf-8")
        added = self.commit("tests: a new test")
        self.write_plan(candidate=added)
        self.stamp_refuses(f"{added} changed tests/test_new.py in between")

    def test_a_plan_review_after_product_moved_refuses(self):
        # The product exists before the build start: a fresh Started line makes the start a later commit.
        (self.root / "src").mkdir()
        (self.root / "src/rdap.ts").write_text("export const rdap = 1\n", encoding="utf-8")
        (self.root / "src/whois.ts").write_text("export const whois = 1\n", encoding="utf-8")
        self.commit("the product, before the build")
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace(STARTED, "> **Started:** 2026-10-30T00:00Z\n\n"),
                        encoding="utf-8")
        self.start = self.sha = self.commit("todo: start §1 again")
        (self.root / "test").mkdir(exist_ok=True)
        # A rename out of the product into the tests names the product path it took away.
        subprocess.run(["git", "-C", str(self.root), "mv", "src/rdap.ts", "test/rdap.ts"], check=True)
        moved = self.commit("the helper moves into the tests")
        self.write_plan(candidate=moved)
        self.stamp_refuses(f"{moved} changed src/rdap.ts in between")
        subprocess.run(["git", "-C", str(self.root), "reset", "-q", "--hard", self.start], check=True)
        subprocess.run(["git", "-C", str(self.root), "rm", "-q", "src/whois.ts"], check=True)
        deleted = self.commit("the whois module goes")
        self.write_completion()
        self.write_plan(candidate=deleted)
        self.stamp_refuses(f"{deleted} changed src/whois.ts in between")
        # A merge that brings another branch's product work in names that work.
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", "-b", "side", self.start], check=True)
        (self.root / "wrangler.jsonc").write_text("{}\n", encoding="utf-8")
        side = self.commit("config on another branch")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", "-B", "main", self.start], check=True)
        self.fixture_commit()
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "--no-edit", "--no-ff", side], check=True)
        merged = self.head()
        self.write_completion()  # the checkout to the start took the committed one away
        self.write_plan(candidate=merged)
        self.stamp_refuses("changed wrangler.jsonc in between")
        # A merge of quiet work whose resolution itself changes the product is named too.
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", "-b", "quiet", self.start], check=True)
        (self.root / "docs/reviews/note.md").write_text("a note\n", encoding="utf-8")
        quiet = self.commit("a review note on another branch")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", "-B", "main", self.start], check=True)
        self.fixture_commit()
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "--no-commit", "--no-ff", quiet], check=True)
        (self.root / "src/rdap.ts").write_text("export const rdap = 2\n", encoding="utf-8")
        resolved = self.commit("merge with an evil resolution")
        self.write_completion()
        self.write_plan(candidate=resolved)
        self.stamp_refuses(f"{resolved} changed src/rdap.ts in between")

    def test_a_merge_of_quiet_work_into_a_lane_with_earlier_product_stamps(self):
        # The lane built product before this section started; main gained only a review note. Merging main after
        # Started brings in nothing built, though the merge differs from main's side by the lane's earlier product.
        lane = subprocess.run(["git", "-C", str(self.root), "symbolic-ref", "--short", "HEAD"], capture_output=True,
                              text=True, check=True).stdout.strip()
        subprocess.run(["git", "-C", str(self.root), "branch", "upstream", self.start], check=True)
        (self.root / "src").mkdir()
        (self.root / "src/earlier.ts").write_text("export {}\n", encoding="utf-8")
        self.commit("src: an earlier section's product")
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace(STARTED, "> **Started:** 2026-10-30T00:00Z\n\n"),
                        encoding="utf-8")
        self.start = self.commit("todo: start §1")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", "upstream"], check=True)
        (self.root / "docs/reviews/note.md").write_text("a note\n", encoding="utf-8")
        self.commit("a review note on main")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", lane], check=True)
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "--no-edit", "--no-ff", "upstream"], check=True)
        merged = self.head()
        self.write_completion()
        _, receipt = self.stamp_after_started(merged)
        self.assertEqual(receipt["plan"]["after_started"]["start"], self.start)
        self.assertEqual(receipt["plan"]["after_started"]["commits"], [merged])  # the lane's own line

    def test_whitespace_inside_a_json_string_is_a_change(self):
        self.assertTrue(tg.same_json(b'{"a": [1, 2]}', b'{\n  "a": [1,\n 2]\n}\n'))
        self.assertFalse(tg.same_json(b'{"name": "Red Oak"}', b'{"name": "RedOak"}'))
        # Types Python's == folds together are changes a test reads (round 1, P1).
        self.assertFalse(tg.same_json(b'{"delegationSigned": true}', b'{"delegationSigned": 1}'))
        self.assertFalse(tg.same_json(b'{"n": [false]}', b'{"n": [0]}'))
        self.assertFalse(tg.same_json(b'{"n": 1.0}', b'{"n": 1}'))
        self.assertFalse(tg.same_json(b'{"a": 1}', b'{"a": 1'))
        self.assertFalse(tg.same_json(None, b"{}"))

    def test_a_non_json_test_file_reformatted_refuses(self):
        helper = self.root / "test/helper.py"
        helper.write_text("if True:\n    x = 1\n    y = 2\n", encoding="utf-8")
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace(STARTED, "> **Started:** 2026-10-30T00:00Z\n\n"),
                        encoding="utf-8")
        self.start = self.commit("todo: start §1, the helper already there")
        helper.write_text("if True:\n    x = 1\ny = 2\n", encoding="utf-8")  # whitespace alone, a different program
        dedented = self.commit("test: the helper dedented")
        self.write_plan(candidate=dedented)
        self.stamp_refuses(f"{dedented} changed test/helper.py in between")

    def test_the_contract_keeps_the_sections_row_by_its_section_column(self):
        text = todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "none", "--")],
                         table_override="| 1 | §2 | B | -- | [ ] |\n| 2 | §1 | A | §2 | [ ] |")
        kept = tg.contract_text(text, 1)
        self.assertIn("| 2 | §1 | A | §2 | [ ] |", kept)
        self.assertNotIn("| 1 | §2 |", kept)
        self.assertNotEqual(kept, tg.contract_text(text.replace("| 2 | §1 | A | §2 |", "| 2 | §1 | A | -- |"), 1))
        self.assertEqual(kept, tg.contract_text(text.replace("| 1 | §2 | B | -- |", "| 1 | §2 | B | §1 |"), 1))

    def test_a_plan_review_after_the_sections_dependency_changed_refuses(self):
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        text = path.read_text(encoding="utf-8")
        self.assertIn("| 1 | §1 | A | -- |", text)
        path.write_text(text.replace("| 1 | §1 | A | -- |", "| 1 | §1 | A | §2 |"), encoding="utf-8")
        edited = self.commit("todo: §1 waits on §2")
        path.write_text(text, encoding="utf-8")  # put back, so the stamp is not refused for an open prerequisite
        self.commit("todo: §1 waits on nothing again")
        self.write_plan(candidate=self.fixture_commit())
        self.stamp_refuses(f"{edited} changed the section's contract")

    def test_a_contract_edit_on_a_branch_forked_after_started_refuses(self):
        lane = subprocess.run(["git", "-C", str(self.root), "symbolic-ref", "--short", "HEAD"], capture_output=True,
                              text=True, check=True).stdout.strip()
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-b", "fork"], check=True)
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace(STARTED, STARTED + "A step the plan review never read.\n\n", 1), encoding="utf-8")
        edited = self.commit("todo: a step on the fork")
        path.write_text(text, encoding="utf-8")
        self.commit("todo: the step taken out on the fork")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", lane], check=True)
        self.fixture_commit()
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "--no-edit", "--no-ff", "fork"], check=True)
        self.write_plan(candidate=self.head())
        self.stamp_refuses(f"{edited} changed the section's contract")

    def test_a_receipt_that_drops_its_after_started_evidence_refuses(self):
        later = self.fixture_commit()
        path, receipt = self.stamp_after_started(later)
        for plan in ({k: v for k, v in receipt["plan"].items() if k != "after_started"},
                     dict(receipt["plan"], after_started=None)):
            with self.subTest(after_started=plan.get("after_started", "absent")):
                path.write_text(json.dumps(dict(receipt, plan=plan)), encoding="utf-8")
                self.refuses(f"receipt plan after_started is missing, but its candidate {later} follows")

    def test_dropped_evidence_refuses_when_started_came_in_through_a_merge(self):
        # Round 1, P2: the Started commit is the merge's second parent; its first parent never held the line.
        lane = subprocess.run(["git", "-C", str(self.root), "symbolic-ref", "--short", "HEAD"], capture_output=True,
                              text=True, check=True).stdout.strip()
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace(STARTED, ""), encoding="utf-8")
        self.commit("todo: no Started line yet")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-b", "start-here"], check=True)
        path.write_text(path.read_text(encoding="utf-8").replace(
            "**Test checkpoint:**", "> **Started:** 2026-10-30T00:00Z\n\n**Test checkpoint:**", 1), encoding="utf-8")
        self.start = self.sha = self.commit("todo: start §1 on a branch")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", lane], check=True)
        (self.root / "docs/reviews/note.md").write_text("a note\n", encoding="utf-8")
        self.commit("a review note on the lane")
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "--no-edit", "--no-ff", "start-here"], check=True)
        merged = self.head()
        self.write_completion()
        path, receipt = self.stamp_after_started(merged)
        self.assertEqual(receipt["plan"]["after_started"], {"start": self.start, "commits": [merged]})
        tg.graph(self.root)
        path.write_text(json.dumps(dict(receipt, plan={k: v for k, v in receipt["plan"].items()
                                                       if k != "after_started"})), encoding="utf-8")
        self.refuses(f"receipt plan after_started is missing, but its candidate {merged} follows")

    def test_a_lane_forked_before_the_started_line_validates_while_it_merges_the_stamp(self):
        # 2026-10-31, the media lane merging main: the commit that recorded D02 T03 §4's Started line was reachable only
        # from MERGE_HEAD, so rebuilding the receipt's after_started from HEAD alone refused.
        lane = subprocess.run(["git", "-C", str(self.root), "symbolic-ref", "--short", "HEAD"], capture_output=True,
                              text=True, check=True).stdout.strip()
        subprocess.run(["git", "-C", str(self.root), "branch", "forked", self.start], check=True)
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace(STARTED, "> **Started:** 2026-10-30T18:54Z\n\n"),
                        encoding="utf-8")
        self.start = self.commit("todo: start §1 on the stamping lane")
        later = self.fixture_commit()
        _, receipt = self.stamp_after_started(later)
        self.assertEqual(receipt["plan"]["after_started"]["start"], self.start)
        self.commit("todo: stamp D00 T01 §1")
        subprocess.run(["git", "-C", str(self.root), "checkout", "-q", "-f", "forked"], check=True)
        (self.root / "docs/reviews/note.md").write_text("the other lane's own work\n", encoding="utf-8")
        self.commit("the forked lane's work")
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "--no-commit", "--no-ff", lane], check=True)
        tg.graph(self.root)  # the receipt's evidence is rebuilt across the merge
        subprocess.run(["git", "-C", str(self.root), "commit", "-q", "--no-edit"], check=True)
        tg.graph(self.root)

    def test_a_plan_review_after_a_fallback_start_refuses(self):
        # No Started line: the build start is the first commit naming the section, so nothing after it is quiet.
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace(STARTED, ""), encoding="utf-8")
        self.commit("todo: no Started line")
        (self.root / "src").mkdir()
        (self.root / "src/a.ts").write_text("export {}\n", encoding="utf-8")
        self.sha = self.commit("src: the build (D00 T01 §1)")
        later = self.fixture_commit()
        self.write_plan(candidate=later)
        self.stamp_refuses("is not the commit the build began at")

    def test_rounds_scheduled_before_a_closing_reading_counted_stamp_under_either_rule(self):
        # D08 T01 §3, 2026-10-31: rounds 1 and 2 closed with a second reading, which the dispatcher of their time did not
        # count, so it scheduled rounds 2 and 3 at position 1; today's counts them. Each round is held to its own.
        dispatch = tg.review_dispatch()
        for rule in (dispatch.legacy_returned_review, None):
            with self.subTest(rule=rule):
                self.setUp()
                self.live()
                self.loop(["P2-reading", "P2-reading", "clean"], returned=rule)
                self.reviews[0]["verdict"] = "fixed"
                self.reviews = [{"round": 1, "report": self.LOOP, "verdict": "fixed"},
                                {"round": 2, "report": self.LOOP, "verdict": "fixed"},
                                {"round": 3, "report": self.LOOP, "verdict": "clean"}]
                self.tick_work()
                self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24")

    def test_a_round_run_after_the_cutoff_cannot_take_the_older_count_to_skip_an_escalation(self):
        # Review of the change, round 1 (P2): a low round with a P1 that closes with a reading block must be followed by
        # the medium escalation; the older count, which ignores that round, would allow another low round.
        legacy = tg.review_dispatch().legacy_returned_review
        later = "2026-10-31T18:00:00Z"
        self.live()
        self.loop(["P2", "P2", "P1-reading"], run=later, pinned=True)
        self.loop(["clean"], fresh=False, returned=legacy, run=later, pinned=True)
        self.reviews = [{"round": n, "report": self.LOOP, "verdict": "fixed"} for n in (1, 2, 3)] + \
            [{"round": 4, "report": self.LOOP, "verdict": "clean"}]
        self.stamp_refuses("round 4 ran at low")
        self.assertFalse(tg.before_legacy_cutoff({"run": tg.LEGACY_COUNT_UNTIL}))
        self.assertTrue(tg.before_legacy_cutoff({"run": "2026-10-31T15:32:19Z"}))
        self.assertFalse(tg.before_legacy_cutoff({"run": "not a time"}))

    def test_a_round_at_a_step_neither_rule_schedules_refuses(self):
        self.live()
        self.loop(["P2-reading", "P2-reading", "clean"], returned=tg.review_dispatch().legacy_returned_review)
        self.edit_round(3, "low", ["consistency"])
        self.reviews = [{"round": 1, "report": self.LOOP, "verdict": "fixed"},
                        {"round": 2, "report": self.LOOP, "verdict": "fixed"},
                        {"round": 3, "report": self.LOOP, "verdict": "clean"}]
        self.stamp_refuses("round 3 ran at low with lenses ['consistency']")

    def test_the_plan_and_completion_passes_run_at_their_scheduled_effort(self):
        self.live()
        self.loop(["clean"])
        self.write_plan(effort="high")
        self.stamp_refuses("the plan review in docs/reviews/00-workspace/D00-T01-s1.md ran at high")
        self.write_plan(lenses=("adversarial",))
        self.stamp_refuses("lenses ['adversarial']; the schedule expects medium with ['plan']")
        self.write_plan()
        self.write_completion(effort="xhigh")
        self.stamp_refuses("the completion review in docs/reviews/00-workspace/D00-T01-s1-completion.md ran at xhigh")

    def test_every_plan_and_completion_attempt_runs_at_its_scheduled_effort(self):
        self.live()
        self.loop(["clean"])
        self.write_plan(reviewer=None, effort="low", lenses=("adversarial",))
        self.write_plan(keep=True)
        self.stamp_refuses("the plan review in docs/reviews/00-workspace/D00-T01-s1.md ran at low with lenses "
                           "['adversarial']")
        self.write_plan()
        self.write_completion(reviewer=None, effort="low")
        self.write_completion(keep=True)
        self.stamp_refuses("the completion review in docs/reviews/00-workspace/D00-T01-s1-completion.md ran at low")

    def argon(self):
        """The live schedule with an Antigravity reviewer, routed for Codex, committed as the stamped commit."""
        (self.root / tg.PIN).write_text(SCHEDULE_PIN.replace("[routes]", '[reviewers.argon]\ncli = "agy"\n'
                                        'model = "gemini-4-argon-medium"\n\n[routes]\ncodex = ["argon"]'),
                                        encoding="utf-8")
        self.sha = self.commit("argon pin")

    def test_an_antigravity_plan_review_records_no_effort_and_stamps(self):
        # The dispatcher sends an agy reviewer no effort (its model id carries it) and records none (D03 T04 §34's
        # plan review by argon, 2026-10-31).
        self.live()
        self.argon()
        self.loop(["clean"])
        self.write_plan(reviewer=None, cli="agy", writer="codex", effort=None)
        text = (self.root / self.PLAN).read_text(encoding="utf-8")
        (self.root / self.PLAN).write_text(text.replace("- Skipped: astra (exited 3)", "- Skipped: argon (timed out)"),
                                           encoding="utf-8")
        self.write_plan(reviewer="argon", cli="agy", writer="codex", effort=None, keep=True)
        plans = (self.root / self.PLAN).read_text(encoding="utf-8").split("## Plan review:", 1)[1]
        self.assertNotIn("- Effort:", plans)
        self.tick_work()
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24")

    def test_an_antigravity_plan_review_still_needs_its_lenses(self):
        self.live()
        self.argon()
        self.loop(["clean"])
        self.write_plan(reviewer="argon", cli="agy", writer="codex", effort=None, lenses=("adversarial",))
        self.stamp_refuses("ran at None with lenses ['adversarial']")

    def test_a_codex_plan_review_with_no_effort_is_still_refused(self):
        self.live()
        self.argon()
        self.loop(["clean"])
        self.write_plan(effort=None)
        self.stamp_refuses("the plan review in docs/reviews/00-workspace/D00-T01-s1.md ran at None")

    def test_the_schedule_check_needs_no_temporary_directory(self):
        # A reviewer's read-only sandbox runs validate with no writable temporary directory.
        self.live()
        real = tempfile.tempdir
        tempfile.tempdir = str(self.root / "no-such-directory")
        try:
            schedule = tg.pin_schedule(self.root, self.sha, "D00 T01 §1")
        finally:
            tempfile.tempdir = real
        self.assertEqual(schedule["plan"], {"effort": "medium", "lenses": ["plan"]})

    def test_the_build_start_matches_the_whole_reference(self):
        (self.root / "src").mkdir(exist_ok=True)
        (self.root / "src/a.txt").write_text("a", encoding="utf-8")
        self.commit("build\n\nD00 T01 §11")
        (self.root / "src/b.txt").write_text("b", encoding="utf-8")
        mine = self.commit("build\n\nThe section (D00 T01 §1).")
        self.assertEqual(tg.build_start(self.root, "todo/00-workspace/TODO-01-a.md", "", "D00 T01 §1"), mine)

    def test_the_build_start_is_the_sections_own_whole_started_line(self):
        # §1's Started line is in the first commit; §2 records a prefix of it, then the identical line, later.
        path = "todo/00-workspace/TODO-01-a.md"

        def record(line):
            text = (self.root / path).read_text(encoding="utf-8")
            two = tg.section_text(text, 2)
            two_now = re.sub(r"(?m)^> \*\*Started:\*\* .*\n\n", "", two)
            two_now = two_now.replace("**Test checkpoint:**", line + "\n\n**Test checkpoint:**", 1)
            (self.root / path).write_text(text.replace(two, two_now), encoding="utf-8")
            return self.commit("start §2"), tg.section_text((self.root / path).read_text(encoding="utf-8"), 2)

        prefix, body = record("> **Started:** 2026-10-23")
        self.assertEqual(tg.build_start(self.root, path, body, "D00 T01 §2"), prefix)
        whole, body = record(STARTED.strip())
        self.assertEqual(tg.build_start(self.root, path, body, "D00 T01 §2"), whole)
        self.assertEqual(tg.build_start(self.root, path, tg.section_text((self.root / path).read_text(
            encoding="utf-8"), 1), "D00 T01 §1"), self.start)

    # D00 T01 §15: a section's risk picks its rounds' schedule, and the stamp holds each round to the one it ran on.

    def test_a_light_section_stamps_on_the_light_schedule(self):
        self.live(risk="light")
        self.loop(["clean"], risk="light")
        self.tick_work()
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-30")
        self.assertIn("- Schedule: light", (self.root / self.LOOP).read_text(encoding="utf-8"))

    def test_a_full_section_refuses_light_rounds(self):
        self.live()
        self.loop(["clean"], risk="light")
        self.stamp_refuses("last rounds ran on the light schedule, but the section's Risk is full")

    def test_a_light_section_refuses_full_rounds(self):
        self.live(risk="light")
        self.loop(["clean"])
        self.stamp_refuses("last rounds ran on the full schedule, but the section's Risk is light")

    def test_a_section_made_full_partway_stamps_on_its_full_rounds_run_again(self):
        self.live(risk="light")
        self.loop(["P2"], risk="light")
        path = self.root / "todo/00-workspace/TODO-01-a.md"
        path.write_text(path.read_text(encoding="utf-8").replace("**Risk:** light", "**Risk:** full", 1),
                        encoding="utf-8")
        self.sha = self.commit("the section turns out to need the full schedule")
        self.loop(["P2", "clean"], fresh=False)
        rounds = tg.review_dispatch().read_rounds((self.root / self.LOOP).read_text(encoding="utf-8"))
        self.assertEqual([(r["effort"], r["schedule"]) for r in rounds],
                         [("medium", "light"), ("high", None), ("medium", None)])
        self.tick_work()
        self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-30")

    def test_a_light_round_hand_edited_to_full_effort_is_refused(self):
        self.live(risk="light")
        self.loop(["clean"], risk="light")
        self.edit_round(1, "high", self.ROUND_1)
        self.stamp_refuses("round 1 ran at high")

    def test_round_1_runs_at_high_effort(self):
        self.live()
        self.loop(["clean"])
        self.edit_round(1, "medium", self.ROUND_1)
        message = self.stamp_refuses(f"{self.LOOP} round 1 ran at medium")
        self.assertIn(f"the schedule expects high with {self.ROUND_1} (position 1)", message)

    def test_round_1_runs_all_four_lenses(self):
        self.live()
        self.loop(["clean"])
        self.edit_round(1, "high", self.ROUND_1[:3])
        self.stamp_refuses(f"round 1 ran at high with lenses {self.ROUND_1[:3]}; the schedule expects high with "
                           f"{self.ROUND_1}")

    def test_a_rotation_round_runs_its_one_lens(self):
        self.live()
        self.loop(["P2", "P2", "P2", "clean"])
        self.edit_round(4, "low", ["quality"])
        self.stamp_refuses("round 4 ran at low with lenses ['quality']; the schedule expects low with ['consistency'] "
                           "(position 4)")

    def test_the_design_lens_is_only_for_surface_sections(self):
        self.live()
        self.loop(["P2", "P2", "P2", "P2", "P2", "clean"])
        self.edit_round(6, "low", ["design"])
        self.stamp_refuses("round 6 ran at low with lenses ['design']; the schedule expects low with ['optimization']")

    def test_a_low_round_with_a_p1_escalates_the_next(self):
        self.live()
        self.loop(["P2", "P2", "P1", "clean"])
        self.edit_round(4, "low", ["consistency"])
        self.stamp_refuses("round 4 ran at low with lenses ['consistency']; the schedule expects medium with "
                           "['adversarial'] (position 4, escalated)")

    def test_an_outage_or_a_self_review_does_not_advance_the_schedule(self):
        for skipped in ("outage", "self", "malformed"):
            with self.subTest(skipped=skipped):
                self.live()
                self.loop([skipped, "clean"])
                self.edit_round(2, "medium", ["adversarial"])
                self.stamp_refuses(f"round 2 ran at medium with lenses ['adversarial']; the schedule expects high with "
                                   f"{self.ROUND_1} (position 1)")

    def test_a_receipt_records_the_plan_review_and_schedule_and_edits_refuse(self):
        self.tick_work()
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24")
        data = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(data["plan"], {"report": self.PLAN, "candidate": self.sha, "reviewer": "astra", "model": "m",
                                        "effort": "medium", "lenses": ["plan"]})
        self.assertEqual(data["schedule"]["rounds"], [{"effort": "low", "lenses": ["adversarial"]}])
        edits = [("plan", "effort", "high"), ("plan", "lenses", []), ("plan", "candidate", "f" * 40),
                 ("plan", "reviewer", "sol"), ("plan", "model", "other"), ("plan", "report", self.COMPLETION),
                 ("plan", "extra", 1), ("schedule", "severity_stop_after", 2)]
        for where, key, value in edits:
            with self.subTest(where=where, key=key):
                edited = json.loads(json.dumps(data))
                edited[where][key] = value
                receipt.write_text(json.dumps(edited), encoding="utf-8")
                with self.assertRaises(tg.Refused):
                    tg.graph(self.root)
        for dropped, fragment in ((("plan",), "plan and schedule together"),
                                  (("plan", "schedule"), "a receipt without a plan review must be one of the old")):
            with self.subTest(dropped=dropped):
                edited = json.loads(json.dumps(data))
                for key in dropped:
                    del edited[key]
                receipt.write_text(json.dumps(edited), encoding="utf-8")
                self.refuses(fragment)
        receipt.write_text(json.dumps(data), encoding="utf-8")
        tg.graph(self.root)
        # The recorded plan pass is what the findings file still says: its effort line edited after the stamp refuses.
        path = self.root / self.PLAN
        path.write_bytes(path.read_bytes().replace(b"- Effort: medium", b"- Effort: high"))
        self.refuses("receipt plan does not match its findings file")

    def test_a_loop_that_follows_the_whole_schedule_stamps(self):
        self.live(surface=True)
        self.loop(["P2", "outage", "P2", "self", "P1", "P3", "P2", "P2", "P2", "clean"], surface=True)
        self.tick_work()
        receipt = self.root / self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-10-24")
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)
        rounds = tg.review_dispatch().read_rounds((self.root / self.LOOP).read_bytes().decode("utf-8"))
        self.assertEqual([(r["effort"], r["lenses"]) for r in rounds], [
            ("high", self.ROUND_1), ("medium", ["adversarial"]), ("medium", ["adversarial"]),
            ("low", ["adversarial"]), ("low", ["adversarial"]), ("medium", ["adversarial"]), ("low", ["quality"]),
            ("low", ["design"]), ("low", ["optimization"]), ("low", ["record"])])
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["rounds_spent"], 10)


FINAL_PIN = UNIFORM_PIN.replace("[routes]", """[reviewers.wonder]
cli = "muse"
model = "muse-wonder-full-1.0"
effort = "medium"

[routes]""") + 'final = { reviewer = "wonder", effort = "medium", lenses = ["adversarial"] }\n'


class FinalStamp(Stamp):
    """A schedule with a final step: the stamp needs exactly one final review, after the rounds, and a fix it found
    proven by a later round."""
    ROUNDS = "docs/reviews/00-workspace/D00-T01-s1.md"

    def setUp(self):
        super().setUp()
        (self.root / tg.PIN).write_text(FINAL_PIN, encoding="utf-8")
        self.sha = self.commit("final pin")
        self.tick_work()

    def write_final(self, review="1. P3 a name.\n\nHIGHEST: P3\nOVERALL: approve", effort="medium", lenses=("adversarial",),
                    pin=None):
        result = {"writer": "claude", "reviewer": "wonder", "model": "muse-wonder-full-1.0", "cli": "muse",
                  "effort": effort, "lenses": list(lenses), "failover": [], "review": review, "pin": pin}
        tg.review_dispatch().record_completion(self.root / self.ROUNDS, result, "2026-10-24T00:00:00Z", self.sha,
                                               kind="final")

    def later_round(self, n=2):
        with open(self.root / self.ROUNDS, "a", encoding="utf-8", newline="") as handle:
            handle.write(f"\n## Round {n}: astra (`m` via `codex`)\n\n- Writer: claude\n- Run: 2026-10-25T00:00:00Z\n"
                         f"- Effort: low\n- Lenses: adversarial\n\nThe fix holds.\n\nOVERALL: approve\n\n")

    def stamp_final(self, final, reviews=None):
        return self.stamp("D00 T01 §1", self.sha, reviews or self.reviews, ["true -> ok"], "2026-10-24", final=final)

    def refused(self, final, fragment, reviews=None):
        with self.assertRaises(tg.Refused) as ctx:
            self.stamp_final(final, reviews)
        self.assertIn(fragment, str(ctx.exception))

    def test_the_stamp_needs_the_final_review(self):
        self.refused(None, "--final '<findings file>:<clean|fixed>' is required")
        self.refused({"report": self.ROUNDS, "verdict": "clean"}, "must hold exactly one final review")

    def set_mode(self, mode):
        pin = self.root / tg.PIN
        text = pin.read_text(encoding="utf-8")
        old = 'final = { reviewer = "wonder", effort = "medium", lenses = ["adversarial"] }'
        self.assertIn(old, text)
        pin.write_text(text.replace(old, old[:-2] + f', mode = "{mode}" }}'), encoding="utf-8")
        self.sha = self.commit(f"final {mode}")

    def test_an_optional_final_review_may_be_left_out_and_is_checked_when_given(self):
        self.set_mode("optional")
        receipt = self.root / self.stamp_final(None)
        self.assertNotIn("final", json.loads(receipt.read_text(encoding="utf-8")))
        tg.graph(self.root)

    def test_an_optional_final_review_given_must_still_be_real(self):
        self.set_mode("optional")
        self.refused({"report": self.ROUNDS, "verdict": "clean"}, "must hold exactly one final review")

    # D00 T01 §18: each pass is held to the pin it recorded running under, so passes that straddle a pin change stamp.
    LATER_PIN = FINAL_PIN.replace('plan = { effort = "medium"', 'plan = { effort = "high"').replace(
        'completion = { effort = "medium" }', 'completion = { effort = "high" }').replace(
        'rounds = [{ effort = "low"', 'rounds = [{ effort = "medium"').replace(
        'rotation = { effort = "low"', 'rotation = { effort = "medium"').replace(
        'final = { reviewer = "wonder", effort = "medium"', 'final = { reviewer = "wonder", effort = "high"')

    @staticmethod
    def blob(text):
        return tg.review_dispatch().pin_blob(text.encode("utf-8"))

    def straddle(self, plan=("medium", "a"), completion=("medium", "a"), round1=("low", "a"), round2=("medium", "b"),
                 final=("high", "b"), later=True):
        """Plan, completion and round 1 under the first pin, round 2 and the final review under the later one by
        default; each argument is (effort, pin), the pin "a", "b", None (no Pin line) or a blob id. later=False
        commits no later pin: the stamp is at HEAD as it stands."""
        self.assertNotEqual(self.LATER_PIN, FINAL_PIN)
        ids = {"a": self.blob(FINAL_PIN), "b": self.blob(self.LATER_PIN), None: None}
        if later:
            (self.root / tg.PIN).write_text(self.LATER_PIN, encoding="utf-8")
            self.sha = self.commit("the later pin")
        else:
            self.sha = self.head()
        dispatch = tg.review_dispatch()
        rounds = self.root / self.ROUNDS
        rounds.write_text("# Review findings\n", encoding="utf-8")
        for (effort, pin) in (round1, round2):
            dispatch.record(rounds, {"writer": "claude", "reviewer": "astra", "model": "m", "cli": "codex",
                                     "effort": effort, "lenses": ["adversarial"], "failover": [],
                                     "pin": ids.get(pin, pin), "review": "1. ok.\n\nHIGHEST: none\n\nOVERALL: approve"},
                            "2026-10-24T00:00:00Z")
        self.write_plan(effort=plan[0], pin=ids.get(plan[1], plan[1]), keep=True)
        self.write_completion(effort=completion[0], pin=ids.get(completion[1], completion[1]))
        self.write_final(effort=final[0], pin=ids.get(final[1], final[1]))
        return [{"round": 2, "report": self.ROUNDS, "verdict": "clean"}]

    def test_passes_that_straddle_a_pin_change_stamp_each_held_to_its_own_pin(self):
        reviews = self.straddle()
        receipt = self.root / self.stamp_final({"report": self.ROUNDS, "verdict": "clean"}, reviews)
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["schedule"]["plan"]["effort"], "high",
                         "the receipt keeps the stamped commit's schedule")
        tg.graph(self.root)
        # The receipt replays the same way: a Pin line edited to the later pin no longer matches its pass.
        text = (self.root / self.ROUNDS).read_text(encoding="utf-8")
        plan_at = text.index("## Plan review")
        edited = text[:plan_at] + text[plan_at:].replace(f"- Pin: {self.blob(FINAL_PIN)}",
                                                         f"- Pin: {self.blob(self.LATER_PIN)}", 1)
        (self.root / self.ROUNDS).write_text(edited, encoding="utf-8")
        with self.assertRaises(tg.Refused) as ctx:
            tg.graph(self.root)
        self.assertIn("ran at medium with lenses ['plan']; the schedule expects high with ['plan']", str(ctx.exception))

    def test_a_final_review_under_the_earlier_pin_stamps_at_its_effort(self):
        reviews = self.straddle(final=("medium", "a"))
        self.stamp_final({"report": self.ROUNDS, "verdict": "clean"}, reviews)
        tg.graph(self.root)

    def test_a_pass_matching_only_the_stamped_pin_is_refused(self):
        cases = {"plan": ({"plan": ("high", "a")}, "the plan review in", "ran at high with lenses ['plan']"),
                 "completion": ({"completion": ("high", "a")}, "the completion review in", "ran at high"),
                 "round": ({"round1": ("medium", "a")}, "round 1 ran at medium", "expects low"),
                 "final": ({"final": ("high", "a")}, "the final review in", "ran at high")}
        for kind, (change, where, fragment) in cases.items():
            with self.subTest(kind=kind):
                self.setUp()
                reviews = self.straddle(**change)
                self.refused({"report": self.ROUNDS, "verdict": "clean"}, where, reviews)
                self.refused({"report": self.ROUNDS, "verdict": "clean"}, fragment, reviews)

    def test_a_pass_without_a_pin_line_is_held_to_the_stamped_pin_as_before(self):
        reviews = self.straddle(plan=("medium", None))
        self.refused({"report": self.ROUNDS, "verdict": "clean"},
                     "ran at medium with lenses ['plan']; the schedule expects high with ['plan']", reviews)
        self.setUp()
        reviews = self.straddle(plan=("high", None))
        self.stamp_final({"report": self.ROUNDS, "verdict": "clean"}, reviews)

    def test_a_pass_without_a_pin_line_is_held_to_the_pin_committed_when_it_ran(self):
        # 2026-10-31, D03 T04 §19: a plan review recorded before reviews carried `- Pin:` ran at high on 10-29 under
        # that day's pin; the pin moved to medium on 10-31, and the stamp held the old pass to the new pin. Here the
        # first pin is committed (dated) before the plan review's run, 2026-10-22, and the later pin after it.
        dated = FINAL_PIN + "# committed before the plan review ran\n"
        (self.root / tg.PIN).write_text(dated, encoding="utf-8")
        for args in (["add", "-A"], ["commit", "-q", "-m", "the pin the plan review ran under"]):
            subprocess.run(["git", "-C", str(self.root), *args], check=True,
                           env={**os.environ, "GIT_COMMITTER_DATE": "2026-10-21T00:00:00Z"})
        self.assertEqual(tg.pins_at(self.root, "2026-10-22T00:00:00Z", "ref", "where"), [self.blob(dated)])
        self.assertEqual(tg.pins_at(self.root, "2000-01-01T00:00:00Z", "ref", "where"), [])
        reviews = self.straddle(plan=("medium", None))
        self.stamp_final({"report": self.ROUNDS, "verdict": "clean"}, reviews)
        tg.graph(self.root)

    def test_a_pass_without_a_pin_line_at_the_later_pin_is_refused_when_an_earlier_pin_was_committed(self):
        dated = FINAL_PIN + "# committed before the plan review ran\n"
        (self.root / tg.PIN).write_text(dated, encoding="utf-8")
        for args in (["add", "-A"], ["commit", "-q", "-m", "the pin the plan review ran under"]):
            subprocess.run(["git", "-C", str(self.root), *args], check=True,
                           env={**os.environ, "GIT_COMMITTER_DATE": "2026-10-21T00:00:00Z"})
        reviews = self.straddle(plan=("high", None))
        self.refused({"report": self.ROUNDS, "verdict": "clean"},
                     "ran at high with lenses ['plan']; the schedule expects medium with ['plan']", reviews)

    def dated_commit(self, message, when, pin=None, remove=False):
        if remove:
            (self.root / tg.PIN).unlink()
        elif pin is not None:
            (self.root / tg.PIN).write_text(pin, encoding="utf-8")
        else:
            (self.root / "note.txt").write_text(message, encoding="utf-8")
        for args in (["add", "-A"], ["commit", "-q", "-m", message]):
            subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True,
                           env={**os.environ, "GIT_COMMITTER_DATE": when})

    def test_a_lane_that_had_not_merged_a_newer_pin_keeps_its_own(self):
        # Review of the fix, round 1 (P2): main changed the pin before the lane's pass ran, but the lane merged main
        # only later; the lane's pin was still in force on its line.
        def git(*args):
            subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)
        old, new = FINAL_PIN + "# old\n", self.LATER_PIN
        self.dated_commit("old pin", "2026-10-21T00:00:00Z", pin=old)
        git("checkout", "-qb", "lane")
        git("checkout", "-q", "-")
        self.dated_commit("new pin on main", "2026-10-21T02:00:00Z", pin=new)
        git("checkout", "-q", "lane")
        self.dated_commit("lane work", "2026-10-21T03:00:00Z")
        git("checkout", "-q", "-")
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "--no-edit", "lane"], check=True,
                       capture_output=True, env={**os.environ, "GIT_COMMITTER_DATE": "2026-10-21T05:00:00Z"})
        self.assertEqual(tg.pins_at(self.root, "2026-10-21T04:00:00Z", "ref", "where"),
                         sorted({self.blob(old), self.blob(new)}))
        self.assertNotIn(self.blob(new), tg.pins_at(self.root, "2026-10-21T01:00:00+00:00", "ref", "where"))
        self.assertEqual(tg.pins_at(self.root, "2026-10-21T03:00:00+02:00", "ref", "where"),
                         tg.pins_at(self.root, "2026-10-21T01:00:00Z", "ref", "where"),
                         "an offset is the same instant as its UTC time")

    def test_a_lane_with_no_commit_of_its_own_before_its_pass_keeps_its_pin(self):
        # Review of the fix, round 2 (P2): the lane sat at the old pin's commit, main moved the pin, the lane reviewed
        # and only then committed; a branch-tip frontier dropped the lane's pin.
        old, new = FINAL_PIN + "# old\n", self.LATER_PIN
        self.dated_commit("old pin", "2026-10-21T00:00:00Z", pin=old)
        self.dated_commit("new pin on main", "2026-10-21T02:00:00Z", pin=new)
        self.assertIn(self.blob(old), tg.pins_at(self.root, "2026-10-21T04:00:00Z", "ref", "where"))
        self.assertIn(self.blob(new), tg.pins_at(self.root, "2026-10-21T04:00:00Z", "ref", "where"))

    def test_a_pass_whose_run_is_not_an_exact_time_is_refused(self):
        # Review of the fix, round 1 (P2): Git's date parser read `garbage` as now and chose the current pin.
        for run in ("garbage", "2026-10-22", "2026-10-22T00:00:00", "yesterday", None):
            with self.subTest(run=run):
                with self.assertRaises(tg.Refused) as ctx:
                    tg.pins_at(self.root, run, "ref", "the plan review")
                self.assertIn("the plan review has no exact Run time", str(ctx.exception))

    def test_a_pass_run_while_no_branch_held_the_pin_is_refused(self):
        # Review of the fix, round 1 (P2): a pin deleted then restored left the pass on the stamped pin silently.
        self.dated_commit("pin removed", "2026-10-21T00:00:00Z", remove=True)
        self.dated_commit("pin restored", "2026-10-23T00:00:00Z", pin=FINAL_PIN)
        with self.assertRaises(tg.Refused) as ctx:
            tg.pins_at(self.root, "2026-10-22T00:00:00Z", "ref", "the plan review")
        self.assertIn("when no commit in this history held", str(ctx.exception))

    def test_a_pass_under_a_pin_never_committed_is_refused(self):
        never = self.blob(FINAL_PIN + "# an edit never committed\n")
        reviews = self.straddle(round2=("medium", never))
        self.refused({"report": self.ROUNDS, "verdict": "clean"},
                     f"round 2 ran under pin {never}, which no commit in this history holds", reviews)

    def test_a_pass_under_a_pin_only_staged_is_refused(self):
        # Completion review: a pin staged (so its blob is in the object store), reviewed under, then replaced before
        # any commit is readable locally but not in a fresh clone.
        staged = FINAL_PIN + "# staged, then replaced\n"
        (self.root / tg.PIN).write_text(staged, encoding="utf-8")
        subprocess.run(["git", "-C", str(self.root), "add", tg.PIN], check=True)
        self.assertEqual(subprocess.run(["git", "-C", str(self.root), "cat-file", "-e", self.blob(staged)]).returncode,
                         0, "the staged pin's blob is in the object store")
        reviews = self.straddle(round2=("medium", self.blob(staged)))
        self.refused({"report": self.ROUNDS, "verdict": "clean"},
                     f"round 2 ran under pin {self.blob(staged)}, which no commit in this history holds", reviews)

    def test_a_pin_written_by_a_merge_resolution_counts(self):
        # Round 1: a merge whose resolution differs from both parents holds a pin no other commit does.
        def git(*args):
            subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True)
        pin = self.root / tg.PIN
        git("checkout", "-qb", "lane")
        pin.write_text(FINAL_PIN + "# the lane's\n", encoding="utf-8")
        self.commit("lane pin")
        git("checkout", "-q", "-")
        pin.write_text(FINAL_PIN + "# main's\n", encoding="utf-8")
        self.commit("main pin")
        subprocess.run(["git", "-C", str(self.root), "merge", "-q", "lane"], capture_output=True)  # conflicts
        resolved = FINAL_PIN + "# resolved\n"
        pin.write_text(resolved, encoding="utf-8")
        git("add", tg.PIN)
        git("commit", "-q", "--no-edit")
        self.assertEqual(subprocess.run(["git", "-C", str(self.root), "rev-list", "--parents", "-n1", "HEAD"],
                                        capture_output=True, text=True).stdout.count(" "), 2, "HEAD is the merge")
        reviews = self.straddle(round2=("low", self.blob(resolved)), final=("medium", "a"), later=False)
        self.stamp_final({"report": self.ROUNDS, "verdict": "clean"}, reviews)
        tg.graph(self.root)

    def test_a_fresh_clone_validates_the_receipt(self):
        reviews = self.straddle()
        self.stamp_final({"report": self.ROUNDS, "verdict": "clean"}, reviews)
        self.commit("the stamp")
        clone = pathlib.Path(self.tmp.name + "-clone")
        self.addCleanup(shutil.rmtree, clone, True)
        subprocess.run(["git", "clone", "-q", "--no-local", str(self.root), str(clone)], check=True)
        tg.graph(clone)

    def test_a_final_review_switched_off_stamps_without_one_and_refuses_one_given(self):
        self.set_mode("off")
        self.refused({"report": self.ROUNDS, "verdict": "clean"}, "the final review is off")
        receipt = self.root / self.stamp_final(None)
        self.assertNotIn("final", json.loads(receipt.read_text(encoding="utf-8")))
        tg.graph(self.root)

    def test_a_clean_final_review_stamps_and_edits_to_its_record_refuse(self):
        self.write_final()
        receipt = self.root / self.stamp_final({"report": self.ROUNDS, "verdict": "clean"})
        data = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual((data["final"]["reviewer"], data["final"]["verdict"]), ("wonder", "clean"))
        tg.graph(self.root)
        for key, value in (("verdict", "fixed"), ("reviewer", "astra")):
            with self.subTest(key=key):
                edited = json.loads(json.dumps(data))
                edited["final"][key] = value
                receipt.write_text(json.dumps(edited), encoding="utf-8")
                with self.assertRaises(tg.Refused):
                    tg.graph(self.root)
        dropped = json.loads(json.dumps(data))
        del dropped["final"]
        receipt.write_text(json.dumps(dropped), encoding="utf-8")
        self.refuses("a receipt records a final review when its schedule requires one")

    def test_a_p2_final_review_needs_fixed_and_a_later_round(self):
        self.write_final("1. P2 calc.py:2.\n\nHIGHEST: P2\nOVERALL: needs-attention")
        self.refused({"report": self.ROUNDS, "verdict": "clean"}, "does not match the final review, which declares HIGHEST: P2")
        self.refused({"report": self.ROUNDS, "verdict": "fixed"}, "needs a regular round recorded after the final review")
        self.later_round()
        reviews = [{"round": 2, "report": self.ROUNDS, "verdict": "clean"}]
        receipt = self.root / self.stamp_final({"report": self.ROUNDS, "verdict": "fixed"}, reviews)
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["final"]["verdict"], "fixed")

    def test_a_final_review_without_a_severity_line_does_not_count(self):
        self.write_final("1. P1 example.ts:1 unsafe execution.\n\nOVERALL: needs-attention")
        self.refused({"report": self.ROUNDS, "verdict": "clean"}, "with its HIGHEST line and OVERALL verdict, not 0")

    def test_another_sections_final_review_does_not_stand_in(self):
        self.write_final()
        other = "docs/reviews/00-workspace/D00-T01-s2.md"
        (self.root / other).write_bytes((self.root / self.ROUNDS).read_bytes())
        self.refused({"report": other, "verdict": "clean"}, "--final must be the section's own findings file")

    def test_a_fix_after_a_loop_that_ended_at_the_cap_can_still_be_proven(self):
        path = self.root / self.ROUNDS
        path.write_text("# Review findings\n\n" + "".join(envelope(n) for n in range(1, tg.REVIEW_ROUND_CAP + 1)),
                        encoding="utf-8")
        self.write_final("1. P2 calc.py:2.\n\nHIGHEST: P2\nOVERALL: needs-attention")
        self.later_round(tg.REVIEW_ROUND_CAP + 1)
        reviews = [{"round": tg.REVIEW_ROUND_CAP + 1, "report": self.ROUNDS, "verdict": "clean"}]
        before = path.read_bytes()
        for extra in range(2, tg.POST_FINAL_CAP + 2):
            self.later_round(tg.REVIEW_ROUND_CAP + extra)
        self.refused({"report": self.ROUNDS, "verdict": "fixed"},
                     f"rounds after its final review, over the {tg.POST_FINAL_CAP}",
                     [{"round": tg.REVIEW_ROUND_CAP + tg.POST_FINAL_CAP + 1, "report": self.ROUNDS, "verdict": "clean"}])
        path.write_bytes(before)
        receipt = self.root / self.stamp_final({"report": self.ROUNDS, "verdict": "fixed"}, reviews)
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["rounds_spent"], tg.REVIEW_ROUND_CAP + 1)

    def test_the_dispatcher_refuses_a_round_past_the_post_final_cap_before_running_it(self):
        dispatch = tg.review_dispatch()
        self.assertEqual(dispatch.POST_FINAL_CAP, tg.POST_FINAL_CAP)
        path = self.root / self.ROUNDS
        self.write_final("1. P2 calc.py:2.\n\nHIGHEST: P2\nOVERALL: needs-attention")
        self.assertEqual(dispatch.rounds_after_final(path.read_bytes().decode("utf-8")), 0)
        for n in range(2, tg.POST_FINAL_CAP + 2):
            self.later_round(n)
        self.assertEqual(dispatch.rounds_after_final(path.read_bytes().decode("utf-8")), tg.POST_FINAL_CAP)
        prompt = self.root / "prompt.md"
        prompt.write_text("review this", encoding="utf-8")
        before = path.read_bytes()
        import contextlib
        import io
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = dispatch.main(["--writer", "claude", "--prompt", str(prompt), "--record", str(path),
                                  "--pin", str(self.root / tg.PIN)])
        self.assertNotEqual(code, 0)
        self.assertIn(f"already holds {tg.POST_FINAL_CAP} rounds after its final review", err.getvalue())
        self.assertEqual(path.read_bytes(), before)

    def test_the_final_review_runs_at_its_scheduled_step(self):
        self.write_final(effort="high")
        self.refused({"report": self.ROUNDS, "verdict": "clean"}, "the final review in")

    def test_a_final_review_without_a_final_step_refuses(self):
        (self.root / tg.PIN).write_text(UNIFORM_PIN, encoding="utf-8")
        self.sha = self.commit("no final step")
        self.write_final()
        self.refused({"report": self.ROUNDS, "verdict": "clean"}, "has no final step")



# FinalStamp borrows Stamp's fixture, not its tests: those run once, under Stamp's own pin.
for _name in [n for n in vars(Stamp) if n.startswith("test_") and n not in vars(FinalStamp)]:
    setattr(FinalStamp, _name, None)

class PlanTable(Tree):
    def test_title_that_wraps_the_generated_plan_table_refuses_naming_the_section(self):
        # Within the 88-character cell limit, but the plan pads every row to it: 80 characters make 123-character rows.
        self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B" * 80, 0, "none", "--")]))
        with self.assertRaises(tg.Refused) as ctx:
            tg.projections(self.root, sync=True)
        self.assertIn("plan table for phase 0 wraps raw md", str(ctx.exception))
        self.assertIn("D00 T01 §2", str(ctx.exception))
        self.assertFalse((self.root / tg.PLAN).exists(), "a wrapping plan was written")
        self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B" * 77, 0, "none", "--")]))
        tg.projections(self.root, sync=True)


class QueryPlan(Tree):
    """`query plan`: the plan's names and every section's status, for readers that must not parse todo/."""

    def setUp(self):
        super().setUp()
        self.write(todo_file([(1, "A", 0, "none", "--"), (2, "B", 0, "owner-decision", "--"),
                              (3, "C", 0, "none", "§1")]))
        self.write(todo_file([(1, "D", 1, "none", "--")], ident="beta", domain="01-later", status="draft"),
                   domain="01-later")
        (self.root / "todo/plan.json").write_text(json.dumps({
            "title": "Site plan", "acceptance": "`design/SPEC.md`.", "phases": {"0": "Tooling"}}), encoding="utf-8")
        shutil.copytree(SCRIPTS, self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))

    def query(self):
        return subprocess.run([sys.executable, str(self.root / "scripts/todo-graph.py"), "query", "plan"],
                              capture_output=True, text=True, encoding="utf-8")

    def test_query_plan_reports_config_and_every_section(self):
        result = self.query()
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual((plan["title"], plan["acceptance"]), ("Site plan", "`design/SPEC.md`."))
        self.assertEqual(plan["phases"]["0"], "Tooling")
        self.assertEqual([(s["ref"], s["status"]) for s in plan["sections"]], [
            ("D00 T01 §1", "ready"), ("D00 T01 §2", "blocked"), ("D00 T01 §3", "blocked"), ("D01 T01 §1", "deferred")])
        self.assertEqual(plan["sections"][2]["depends"], ["D00 T01 §1"])

    def test_plan_status_edge_cases(self):
        # Verified reads verified even in an inactive file; waiting on another file or an open prerequisite is blocked.
        spec = importlib.util.spec_from_file_location("todo_graph_cli", SCRIPTS / "todo-graph.py")
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)

        def row(ref, done=False, status="active", needs=(), depends=()):
            return types.SimpleNamespace(ref=ref, done=done, status=status, needs=list(needs), depends=list(depends))

        rows = {r.ref: r for r in (row("D01 T01 §1", done=True, status="done"), row("D02 T01 §1", status="draft"),
                                   row("D00 T01 §1", depends=["D02 T01 §1"]), row("D00 T01 §2"),
                                   row("D00 T01 §3", depends=["D00 T01 §2"]))}
        self.assertEqual({ref: cli.plan_status(r, rows) for ref, r in rows.items()},
                         {"D01 T01 §1": "verified", "D02 T01 §1": "deferred", "D00 T01 §1": "blocked",
                          "D00 T01 §2": "ready", "D00 T01 §3": "blocked"})

    def test_query_plan_refuses_an_unreadable_plan_json(self):
        (self.root / "todo/plan.json").write_text("{", encoding="utf-8")
        result = self.query()
        self.assertEqual(result.returncode, 2)
        self.assertIn("TODO refused: unreadable todo/plan.json", result.stderr)
        self.assertEqual(result.stdout, "")


class CliOutput(Tree):
    """The CLI's output is a contract other programs parse (the editor extension, process-plan): always UTF-8."""

    def test_query_output_is_utf8_whatever_the_console_code_page(self):
        self.write(todo_file([(1, "Only", 0, "none", "--")]))
        shutil.copytree(SCRIPTS, self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        env = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"}
        result = subprocess.run([sys.executable, str(self.root / "scripts/todo-graph.py"), "query", "ready"],
                                capture_output=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([r["ref"] for r in json.loads(result.stdout.decode("utf-8"))], ["D00 T01 §1"])


class Lanes(Tree):
    """Parallel lanes (todo/lanes.json): a lane's branch alone claims its files' rows; main claims the rest. The plan and
    which rows are ready stay the same on every branch."""

    def setUp(self):
        super().setUp()
        self.write(todo_file([(1, "Main work", 0, "none", "--")]))
        self.write(todo_file([(1, "Lane work", 0, "none", "--")], ident="beta", domain="03-vision"),
                   name="TODO-04-g.md", domain="03-vision")
        self.lane_file = "todo/03-vision/TODO-04-g.md"

    def config(self, lanes):
        (self.root / "todo/lanes.json").write_text(json.dumps({"lanes": lanes}), encoding="utf-8")

    def glimmer(self, **override):
        return {"glimmer": {"branch": "glimmer-screener", "worktree": "../isitlegit-glimmer",
                            "files": [self.lane_file], **override}}

    def claim(self, here):
        rows, config = tg.graph(self.root), tg.lanes(self.root)
        return {ref: tg.claimable(row, rows, config, here) for ref, row in rows.items()}

    def test_without_lanes_main_claims_every_ready_row(self):
        self.assertEqual(tg.lanes(self.root), {})
        self.assertEqual(self.claim("main"), {"D00 T01 §1": 0, "D03 T04 §1": 0})

    def test_each_lane_claims_only_its_own_rows(self):
        self.config(self.glimmer())
        self.assertEqual(self.claim("main"), {"D00 T01 §1": 0, "D03 T04 §1": 4})
        self.assertEqual(self.claim("glimmer"), {"D00 T01 §1": 4, "D03 T04 §1": 0})
        # Readiness itself is the same everywhere, so the plan renders identically on both branches.
        rows = tg.graph(self.root)
        self.assertEqual({ref: tg.disposition(row, rows) for ref, row in rows.items()},
                         {"D00 T01 §1": 0, "D03 T04 §1": 0})

    def test_the_lane_follows_the_checked_out_branch_or_todo_lane(self):
        self.config(self.glimmer())
        git = lambda *args: subprocess.run(["git", "-C", str(self.root), *args], check=True,  # noqa: E731
                                           capture_output=True)
        git("init", "-q", "-b", "main")
        git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "x")
        with mock.patch.dict(os.environ, {"TODO_LANE": ""}):
            self.assertEqual(tg.current_lane(self.root), "main")
            git("checkout", "-q", "-b", "glimmer-screener")
            self.assertEqual(tg.current_lane(self.root), "glimmer")
        with mock.patch.dict(os.environ, {"TODO_LANE": "main"}):
            self.assertEqual(tg.current_lane(self.root), "main")
        with mock.patch.dict(os.environ, {"TODO_LANE": "nobody"}), self.assertRaises(tg.Refused):
            tg.current_lane(self.root)

    def test_a_malformed_lanes_file_refuses_the_graph(self):
        cases = {
            "not a TODO file": self.glimmer(files=["todo/03-vision/TODO-09-missing.md"]),
            "must list its files": self.glimmer(files=[]),
            "cannot work branch main": self.glimmer(branch="main"),
            "holds branch, worktree and domains, files or sections": {"glimmer": {"branch": "g", "files": [self.lane_file]}},
            "must be lower-case": {"Glimmer": self.glimmer()["glimmer"]},
        }
        for fragment, lanes in cases.items():
            with self.subTest(fragment):
                self.config(lanes)
                self.refuses(fragment)
        self.config({**self.glimmer(), "other": {"branch": "other", "worktree": "../o", "files": [self.lane_file]}})
        self.refuses("is listed by lanes glimmer and other")
        (self.root / "todo/lanes.json").write_text("{", encoding="utf-8")
        self.refuses("unreadable todo/lanes.json")

    def test_resolve_and_query_ready_leave_another_lanes_row_to_it(self):
        self.config(self.glimmer())
        shutil.copytree(SCRIPTS, self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        run = lambda *args, lane: subprocess.run(  # noqa: E731
            [sys.executable, str(self.root / "scripts/todo-graph.py"), *args], capture_output=True, text=True,
            env={**os.environ, "TODO_LANE": lane})
        ready = run("query", "ready", lane="main")
        self.assertEqual([r["ref"] for r in json.loads(ready.stdout)], ["D00 T01 §1"])
        resolved = run("resolve", "D03 T04 §1", lane="main")
        self.assertEqual(resolved.returncode, 4)
        self.assertIn("belongs to lane glimmer (branch glimmer-screener, ../isitlegit-glimmer)",
                      json.loads(resolved.stdout)["lane_note"])
        self.assertEqual(run("resolve", "D03 T04 §1", lane="glimmer").returncode, 0)
        self.assertEqual(run("resolve", "D00 T01 §1", lane="glimmer").returncode, 4)


class LaneDomains(Tree):
    """Lanes that claim whole domains (D00 T01 §19; docs/specs/2026-10-30-four-lanes-design.md): two building lanes and
    main over one tree. Queries count only the lane's rows, while readiness is read over the whole graph."""

    def setUp(self):
        super().setUp()
        self.write(todo_file([(1, "Coordinator work", 0, "none", "--")]))
        self.write(todo_file([(1, "Intake", 0, "none", "--"), (2, "Intake later", 1, "meta-api", "--"),
                              (3, "Needs trust", 1, "none", "D05 T01 §1")], ident="intake", domain="01-intake"),
                   domain="01-intake")
        self.write(todo_file([(1, "Trust", 1, "none", "--"), (2, "Trust wait", 1, "operator", "--")],
                             ident="trust", domain="05-trust"), domain="05-trust")
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "domains": ["D01"]},
                     "app": {"branch": "app-lane", "worktree": "../a", "domains": ["D05"]}})

    def config(self, lanes):
        (self.root / "todo/lanes.json").write_text(json.dumps({"lanes": lanes}), encoding="utf-8")

    def query(self, kind, here, **kw):
        rows = tg.graph(self.root)
        return tg.lane_query(kind, rows, tg.lanes(self.root), here, **kw)

    def refs(self, kind, here, **kw):
        return [r["ref"] for r in self.query(kind, here, **kw)]

    def test_a_row_belongs_to_its_listed_file_then_its_domain_then_main(self):
        self.write(todo_file([(1, "Glimmer", 0, "none", "--")], ident="glim", domain="03-vision"),
                   name="TODO-04-g.md", domain="03-vision")
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "domains": ["D01"]},
                     "glimmer": {"branch": "g", "worktree": "../g", "files": ["todo/03-vision/TODO-04-g.md"]}})
        rows, config = tg.graph(self.root), tg.lanes(self.root)
        self.assertEqual({ref: tg.lane_of(row, config) for ref, row in rows.items()},
                         {"D00 T01 §1": "main", "D01 T01 §1": "checks", "D01 T01 §2": "checks",
                          "D01 T01 §3": "checks", "D03 T04 §1": "glimmer", "D05 T01 §1": "main",
                          "D05 T01 §2": "main"})

    def test_a_listed_section_moves_one_row_to_another_lane(self):
        # 2026-10-31: D01 T03 §6, the upload page, moves to the app lane; its ref stays, so receipts naming it resolve.
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "domains": ["D01"]},
                     "app": {"branch": "app-lane", "worktree": "../a", "domains": ["D05"], "sections": ["D01 T01 §2"]}})
        rows, config = tg.graph(self.root), tg.lanes(self.root)
        self.assertEqual(tg.lane_of(rows["D01 T01 §2"], config), "app")
        self.assertEqual(tg.lane_of(rows["D01 T01 §1"], config), "checks")
        # The lane's own queries count it, and the lane it left stops counting it.
        self.assertIn("D01 T01 §2", self.refs("blocked", "app") + self.refs("ready", "app"))
        self.assertNotIn("D01 T01 §2", self.refs("blocked", "checks") + self.refs("ready", "checks"))
        self.assertEqual(tg.lane_info(self.root, config, "app")["sections"], ["D01 T01 §2"])
        self.assertEqual(tg.lane_info(self.root, config, "checks")["sections"], [])
        # A listed section wins over a listed file too.
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "files": ["todo/01-intake/TODO-01-a.md"]},
                     "app": {"branch": "app-lane", "worktree": "../a", "sections": ["D01 T01 §2"]}})
        rows, config = tg.graph(self.root), tg.lanes(self.root)
        self.assertEqual((tg.lane_of(rows["D01 T01 §1"], config), tg.lane_of(rows["D01 T01 §2"], config)),
                         ("checks", "app"))

    def test_a_malformed_section_list_refuses_the_graph(self):
        lane = lambda **kw: {"checks": {"branch": "checks-lane", "worktree": "../c", "domains": ["D01"]},  # noqa: E731
                             "app": {"branch": "app-lane", "worktree": "../a", **kw}}
        cases = {
            "must list its sections": lane(sections=[]),
            "a section is DNN TNN §N": lane(sections=["D01 §2"]),
            "which is no section in todo/": lane(sections=["D01 T01 §9"]),
        }
        for fragment, lanes in cases.items():
            with self.subTest(fragment=fragment):
                self.config(lanes)
                self.refuses(fragment)
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "sections": ["D01 T01 §2"]},
                     "app": {"branch": "app-lane", "worktree": "../a", "sections": ["D01 T01 §2"]}})
        self.refuses("D01 T01 §2 is listed by lanes checks and app")

    def test_a_malformed_domain_list_refuses_the_graph(self):
        lane = lambda **kw: {"checks": {"branch": "checks-lane", "worktree": "../c", **kw}}  # noqa: E731
        cases = {
            "must list its domains": lane(domains=[]),
            "a domain is DNN": lane(domains=["3"]),
            "lists domain 'D3'": lane(domains=["D3"]),
            "lists domain 'vision'": lane(domains=["vision"]),
            "lists D07, which has no todo/07-* folder": lane(domains=["D07"]),
            "holds branch, worktree and domains, files or sections": lane(),
            "holds branch, worktree and domains, files or sections ": lane(domains=["D01"], owner="me"),
        }
        for fragment, lanes in cases.items():
            with self.subTest(fragment):
                self.config(lanes)
                self.refuses(fragment.strip())

    def test_a_domain_or_file_claimed_twice_refuses_the_graph(self):
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "domains": ["D01"]},
                     "app": {"branch": "app-lane", "worktree": "../a", "domains": ["D05", "D01"]}})
        self.refuses("D01 is claimed by lanes checks and app")
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "domains": ["D01"]},
                     "app": {"branch": "app-lane", "worktree": "../a",
                             "files": ["todo/01-intake/TODO-01-a.md"]}})
        self.refuses("todo/01-intake/TODO-01-a.md is listed by lane app inside checks's domain")
        # A lane listing a file inside its own domain is redundant, not a split.
        self.config({"checks": {"branch": "checks-lane", "worktree": "../c", "domains": ["D01"],
                                "files": ["todo/01-intake/TODO-01-a.md"]}})
        self.assertEqual(set(tg.lanes(self.root)), {"checks"})

    def test_each_lane_counts_only_its_own_rows_and_all_counts_every_row(self):
        self.assertEqual(self.refs("ready", "checks"), ["D01 T01 §1", "D01 T01 §2"])
        self.assertEqual(self.refs("ready", "app"), ["D05 T01 §1"])
        self.assertEqual(self.refs("ready", "main"), ["D00 T01 §1"])
        self.assertEqual(self.refs("blocked", "checks"), ["D01 T01 §3"])
        self.assertEqual(self.refs("blocked", "app"), ["D05 T01 §2"])
        self.assertEqual(self.refs("blocked", "main"), [])
        self.assertEqual(self.query("stats", "checks"), {"lane": "checks", "total": 3, "verified": 0, "ready": 2,
                                                        "blocked": 1})
        self.assertEqual(self.query("stats", "app", everything=True),
                         {"lane": "all", "total": 6, "verified": 0, "ready": 4, "blocked": 2})
        self.assertEqual(len(self.refs("ready", "app", everything=True)), 4)
        self.assertEqual(len(self.refs("blocked", "main", everything=True)), 2)

    def test_without_lanes_stats_counts_the_whole_plan_as_main(self):
        (self.root / "todo/lanes.json").unlink()
        self.assertEqual(self.query("stats", "main"), {"lane": "main", "total": 6, "verified": 0, "ready": 4,
                                                      "blocked": 2})

    def test_phase_narrows_a_lane_to_its_share_of_one_phase(self):
        rows = tg.graph(self.root)
        config = tg.lanes(self.root)
        for ref in ("D01 T01 §2", "D01 T01 §3"):  # the checks lane's Phase 1 rows, stamped
            rows[ref].done = True
        self.assertEqual(tg.lane_query("stats", rows, config, "checks", phase=1),
                         {"lane": "checks", "total": 2, "verified": 2, "ready": 0, "blocked": 0, "phase": 1})
        # Another lane's Phase 1 rows stay open, and only the whole plan counts them.
        self.assertEqual(tg.lane_query("stats", rows, config, "checks", everything=True, phase=1),
                         {"lane": "all", "total": 4, "verified": 2, "ready": 1, "blocked": 1, "phase": 1})
        self.assertEqual([r["ref"] for r in tg.lane_query("ready", rows, config, "app", phase=1)], ["D05 T01 §1"])
        self.assertEqual(tg.lane_query("ready", rows, config, "checks", phase=0)[0]["ref"], "D01 T01 §1")

    def test_a_row_waiting_on_another_lanes_row_stays_blocked_until_it_is_stamped(self):
        rows, config = tg.graph(self.root), tg.lanes(self.root)
        self.assertIn("D01 T01 §3", [r["ref"] for r in tg.lane_query("blocked", rows, config, "checks")])
        self.assertNotIn("D01 T01 §3", [r["ref"] for r in tg.lane_query("ready", rows, config, "checks")])
        self.assertEqual(tg.lane_query("stats", rows, config, "checks")["verified"], 0)
        rows["D05 T01 §1"].done = True  # the app lane stamps the prerequisite, and it reaches this lane
        self.assertIn("D01 T01 §3", [r["ref"] for r in tg.lane_query("ready", rows, config, "checks")])
        self.assertNotIn("D05 T01 §1", [r["ref"] for r in tg.lane_query("ready", rows, config, "checks")])

    def test_the_manual_list_names_every_lanes_waiting_rows(self):
        rows, config = tg.graph(self.root), tg.lanes(self.root)
        listed = {r["ref"]: (r["lane"], r["disposition"]) for r in tg.manual_rows(rows, config)}
        self.assertEqual(listed, {"D01 T01 §2": ("checks", 0), "D05 T01 §2": ("app", 4)})
        rows["D01 T01 §2"].done = True
        self.assertEqual([r["ref"] for r in tg.manual_rows(rows, config)], ["D05 T01 §2"])

    def test_query_lane_names_this_checkouts_lane(self):
        shutil.copytree(SCRIPTS, self.root / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        run = lambda *args, lane: json.loads(subprocess.run(  # noqa: E731
            [sys.executable, str(self.root / "scripts/todo-graph.py"), *args], capture_output=True, text=True,
            check=True, env={**os.environ, "TODO_LANE": lane}).stdout)
        self.assertEqual(run("query", "lane", lane="checks"),
                         {"lane": "checks", "branch": "checks-lane", "worktree": "../c", "domains": ["D01"],
                          "files": [], "sections": []})
        self.assertEqual(run("query", "lane", lane="main")["domains"], ["D00"])
        self.assertEqual([r["ref"] for r in run("query", "ready", lane="app")], ["D05 T01 §1"])
        self.assertEqual(run("query", "stats", "--all", "--phase", "1", lane="app")["total"], 4)
        (self.root / "todo/lanes.json").unlink()
        self.assertEqual(run("query", "lane", lane="")["domains"], ["D00", "D01", "D05"])


class MergeInProgress(unittest.TestCase):
    """A lane merging main concludes a merge whose stamps are on MERGE_HEAD, not yet on HEAD (AGENTS.md Parallel lanes):
    the stamp commit is accepted while that merge is open, and refused once it is aborted."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.git("init", "-q", "-b", "main")
        for args in (("config", "maintenance.auto", "false"), ("config", "user.email", "t@example.com"),
                     ("config", "user.name", "T")):
            self.git(*args)
        (self.root / "a.txt").write_text("a\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")
        self.git("checkout", "-qb", "lane")
        (self.root / "lane.txt").write_text("lane\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-qm", "lane work")
        self.git("checkout", "-q", "main")
        (self.root / "stamp.txt").write_text("stamped\n", encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-qm", "main's stamp")
        self.stamp = self.git("rev-parse", "HEAD").strip()
        self.git("checkout", "-q", "lane")

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.root), *args], check=True, capture_output=True, text=True).stdout

    def test_a_stamp_on_the_merged_branch_counts_while_the_merge_is_open(self):
        with self.assertRaises(tg.Refused):
            tg.commit_ok(self.root, self.stamp)
        self.git("merge", "--no-commit", "--no-ff", "main")
        tg.commit_ok(self.root, self.stamp)
        self.assertIn(self.stamp, tg._head_commits(self.root))
        self.git("merge", "--abort")
        with self.assertRaises(tg.Refused):
            tg.commit_ok(self.root, self.stamp)


class Repository(unittest.TestCase):
    def test_the_authoring_template_copy_is_identical(self):
        # todo/README.md and create-todo name todo/templates/TODO-template.md and each agent's skill copy as one file.
        canonical = (REPO / "todo/templates/TODO-template.md").read_bytes()
        self.assertEqual((REPO / ".claude/skills/create-todo/todo-template.md").read_bytes(), canonical)

    def test_the_stamp_command_reads_completion_as_findings_file_and_verdict(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("todo_graph_cli", SCRIPTS / "todo-graph.py")
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        self.assertEqual(cli.completion_review("docs/reviews/00-workspace/D00-T01-s1.md:filed"),
                         {"report": "docs/reviews/00-workspace/D00-T01-s1.md", "verdict": "filed"})
        for bad in ("docs/reviews/x.md", "docs/reviews/x.md:", ":complete"):
            with self.subTest(bad=bad), self.assertRaises(tg.Refused):
                cli.completion_review(bad)

    def test_the_readme_stamp_examples_name_every_required_argument(self):
        # D00 T01 §28, completion review E1: a documented stamp, filled in, runs without a missing-argument retry.
        readme = (REPO / "todo/README.md").read_text(encoding="utf-8")
        examples = [line for line in readme.splitlines() if "todo-graph.py stamp " in line]
        self.assertGreaterEqual(len(examples), 2)
        for line in examples:
            for flag in ("--sha ", "--plan ", "--completion ", "--review ", "--check "):
                self.assertIn(flag, line)

    def test_the_repository_graph_validates_and_its_plan_is_current(self):
        # IsItLegit plans its own work with this graph; CI runs the same check.
        r = subprocess.run([sys.executable, str(REPO / "scripts/todo-graph.py"), "plan", "--check"],
                           capture_output=True, text=True, cwd=REPO)
        self.assertEqual(r.returncode, 0, r.stderr)





class CodexSelfStamp(Stamp):
    """The explicit Codex policy changes the order, never the evidence requirement."""
    COMPLETION = Stamp.PLAN

    def setUp(self):
        super().setUp()
        pin = UNIFORM_PIN.replace('schema_version = 1', 'schema_version = 1\nself_review = ["codex"]')
        pin = pin.replace('claude = ["astra"]', 'codex = ["astra"]')
        (self.root / tg.PIN).write_text(pin, encoding="utf-8")
        self.pin = tg.review_dispatch().pin_blob(pin.encode())
        self.commit("Codex policy before implementation")
        self.tick_work()
        self.sha = self.commit("implement section")
        self.chain()

    def chain(self, round_review="HIGHEST: none\nOVERALL: approve", completion="COMPLETION: complete"):
        path = self.root / self.PLAN
        path.write_text("# Self review\n\n", encoding="utf-8")
        dispatch = tg.review_dispatch()
        common = {"writer": "codex", "reviewer": "astra", "model": "m", "cli": "codex",
                  "effort": "medium", "failover": [], "pin": self.pin}
        dispatch.record_completion(path, {**common, "lenses": ["plan"],
            "review": "PLAN: complete\nOVERALL: approve"}, "2026-11-04T10:00:00Z", self.start, "plan")
        dispatch.record(path, {**common, "effort": "low", "lenses": ["adversarial"],
            "review": round_review}, "2026-11-04T10:01:00Z")
        dispatch.record_completion(path, {**common, "review": completion}, "2026-11-04T10:02:00Z", self.sha)
        text = path.read_text().replace("- Writer: codex\n", "- Writer: codex\n- Policy: codex-self-review\n")
        path.write_text(text, encoding="utf-8")

    def stamp_self(self):
        return self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-11-04")

    def test_self_review_chain_stamps_and_revalidates(self):
        self.stamp_self()
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)

    def test_completion_proves_the_single_round_fixes(self):
        self.chain("P1: fixed before completion.\nHIGHEST: P1\nOVERALL: needs-attention")
        self.reviews[0]["verdict"] = "fixed"
        self.stamp_self()
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)

    def test_stale_completion_cannot_stamp(self):
        self.sha = self.commit("later product change")
        with self.assertRaisesRegex(tg.Refused, "exact stamped commit"):
            self.stamp_self()

    def test_completion_before_round_cannot_stamp(self):
        path = self.root / self.PLAN
        path.write_text(path.read_text().replace("10:02:00Z", "09:59:00Z"))
        with self.assertRaisesRegex(tg.Refused, "plan, one round, then completion"):
            self.stamp_self()

    def test_policy_marker_cannot_authorize_an_old_pin(self):
        old = tg.review_dispatch().pin_blob(UNIFORM_PIN.encode())
        path = self.root / self.PLAN
        path.write_text(path.read_text().replace(self.pin, old))
        with self.assertRaisesRegex(tg.Refused, "does not authorize Codex self-review"):
            self.stamp_self()

    def test_second_returned_round_cannot_stamp(self):
        path = self.root / self.PLAN
        text = path.read_text()
        start, end = text.index("## Round 1:"), text.index("## Completion review:")
        extra = text[start:end].replace("## Round 1:", "## Round 2:")
        path.write_text(text[:end] + extra + text[end:])
        self.reviews.append({**self.reviews[0], "round": 2})
        with self.assertRaisesRegex(tg.Refused, "over the 1-round cap"):
            self.stamp_self()

    def test_forged_reviewer_identity_cannot_stamp(self):
        path = self.root / self.PLAN
        path.write_text(path.read_text().replace("astra (`m`", "impostor (`m`"))
        with self.assertRaisesRegex(tg.Refused, "identity does not match"):
            self.stamp_self()

    def test_mixed_policy_chain_cannot_stamp(self):
        path = self.root / self.PLAN
        text = path.read_text().replace("- Writer: codex\n- Policy: codex-self-review", "- Writer: claude", 1)
        path.write_text(text)
        with self.assertRaisesRegex(tg.Refused, "cannot mix review policies"):
            self.stamp_self()

    def test_failed_round_can_be_retried_before_the_single_returned_round(self):
        path = self.root / self.PLAN
        text = path.read_text()
        failed = ("## Round 1: none\n\n- Writer: codex\n- Policy: codex-self-review\n"
                  "- Run: 2026-11-04T10:00:30Z\n- Effort: low\n- Lenses: adversarial\n"
                  f"- Pin: {self.pin}\n\nNo reviewer returned a review.\n\n")
        text = text.replace("## Round 1:", "## Round 2:")
        at = text.index("## Round 2:")
        path.write_text(text[:at] + failed + text[at:])
        self.reviews[0]["round"] = 2
        receipt = self.stamp_self()
        data = json.loads((self.root / receipt).read_text())
        self.assertEqual((data["round_cap"], data["rounds_spent"]), (1, 2))
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)

    def test_quoted_headings_inside_sealed_reviews_do_not_change_order(self):
        self.chain(completion="Quoted example:\n## Round 7: none\n\nCOMPLETION: complete")
        self.stamp_self()

    def test_self_completion_with_gaps_cannot_stamp(self):
        self.chain(completion="COMPLETION: gaps")
        with self.assertRaisesRegex(tg.Refused, "completion verdict complete"):
            self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-11-04",
                       completion={"report": self.COMPLETION, "verdict": "completed"})


    def reconcile(self, verdict="complete", repair=False, dispatched=False):
        self.chain(completion="COMPLETION: gaps")
        original = self.root / self.PLAN
        before = original.read_bytes()
        if repair:
            (self.root / "repair.txt").write_text("Real repair candidate\n")
            self.sha = self.commit("repair completion finding")
        pin_path = self.root / tg.PIN
        pin_text = pin_path.read_text().replace('self_review = ["codex"]',
            'self_review = ["codex"]\nreconciliation = ["codex"]')
        pin_text += '\n[schedule.reconciliation]\neffort = "medium"\nlenses = ["record"]\n'
        pin_path.write_text(pin_text)
        disposition = "docs/reviews/reconciliation-disposition.md"
        (self.root / disposition).write_text("All original findings: evidence and scope disposition.\n")
        self.commit("authorize reconciliation and record disposition")
        dispatch = tg.review_dispatch()
        binding = dispatch.make_reconciliation_binding(self.root, self.PLAN, self.sha, disposition)
        result = {"writer": "codex", "reviewer": "astra", "model": "m", "cli": "codex",
                  "effort": "medium", "lenses": ["record"], "failover": [],
                  "pin": dispatch.pin_blob(pin_text.encode()), "policy": "codex-self-review",
                  "binding": binding, "review": "RECONCILIATION: " + verdict}
        if dispatched:
            prompt = self.root / "reconciliation-prompt.txt"
            prompt.write_text("Verify original findings and all repairs.\n")
            args = types.SimpleNamespace(writer="codex", record=str(original), disposition=disposition,
                candidate=self.sha, surface=False, prompt=str(prompt), timeout=5)
            with mock.patch.object(dispatch, "ROOT", self.root), \
                 mock.patch.object(dispatch, "review", return_value=result) as reviewer, \
                 mock.patch.object(dispatch, "datetime", wraps=dispatch.datetime) as clock:
                clock.now.return_value = dispatch.datetime.fromisoformat("2026-11-05T10:03:00+00:00")
                response = dispatch.run_reconciliation(args, dispatch.load_pin(data=pin_text.encode()), result["pin"])
            self.assertTrue(response["recorded"])
            self.assertEqual(reviewer.call_count, 1)
        else:
            dispatch.record_completion(original, result, "2026-11-04T10:03:00Z", self.sha, "reconciliation")
        self.assertTrue(original.read_bytes().startswith(before))
        return before

    def stamp_reconciled(self):
        return self.stamp("D00 T01 §1", self.sha, self.reviews, ["true -> ok"], "2026-11-04",
            completion={"report": self.PLAN, "verdict": "gaps"},
            reconciliation={"report": self.PLAN, "verdict": "complete"})

    def test_reconciliation_keeps_original_gaps_and_revalidates(self):
        before = self.reconcile()
        receipt = self.stamp_reconciled()
        data = json.loads((self.root / receipt).read_text())
        self.assertEqual(data["completion"]["verdict"], "gaps")
        self.assertEqual(data["reconciliation"]["candidate"], self.sha)
        self.assertTrue((self.root / self.PLAN).read_bytes().startswith(before))
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)

    def test_reconciliation_dispatch_to_stamp(self):
        self.reconcile(repair=True, dispatched=True)
        self.stamp_reconciled()
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)

    def test_reconciliation_accepts_verified_descendant(self):
        self.reconcile(repair=True)
        self.stamp_reconciled()
        self.assertTrue(tg.graph(self.root)["D00 T01 §1"].done)

    def test_reconciliation_still_gaps_refuses_stamp(self):
        self.reconcile("gaps")
        with self.assertRaisesRegex(tg.Refused, "reconciliation.*complete|RECONCILIATION: complete"):
            self.stamp_reconciled()

    def test_reconciliation_stale_candidate_refuses_stamp(self):
        self.reconcile()
        self.sha = self.commit("later unreviewed code")
        with self.assertRaisesRegex(tg.Refused, "exact.*candidate|exact.*commit"):
            self.stamp_reconciled()

    def test_reconciliation_altered_original_refuses_stamp(self):
        self.reconcile()
        path = self.root / self.PLAN
        path.write_bytes(path.read_bytes().replace(b"# Self review", b"# Changed review"))
        with self.assertRaises(tg.Refused):
            self.stamp_reconciled()

    def test_reconciliation_receipt_tampering_refuses_revalidation(self):
        self.reconcile()
        receipt = self.stamp_reconciled()
        path = self.root / receipt
        data = json.loads(path.read_text())
        data["reconciliation"]["candidate"] = self.start
        path.write_text(json.dumps(data))
        with self.assertRaises(tg.Refused):
            tg.graph(self.root)


for _name in [n for n in vars(Stamp) if n.startswith("test_") and n not in vars(CodexSelfStamp)]:
    setattr(CodexSelfStamp, _name, None)


if __name__ == "__main__":
    unittest.main()
