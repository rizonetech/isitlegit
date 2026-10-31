"""design/tools/check-design.py: the approved boards, their coverage matrix and design/SPEC.md agree, and a defect in any of them is caught."""
import importlib.util
import json
import pathlib
import shutil
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_design", REPO / "design/tools/check-design.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class Repository(unittest.TestCase):
    def test_the_approved_inventory_is_complete(self):
        self.assertEqual(check.check_inventory(REPO), [])

    def test_every_section_0_row_accounts_for_its_controls_and_states(self):
        self.assertEqual(check.check_coverage(REPO), [])

    def test_the_spec_links_every_board_and_lists_every_item(self):
        self.assertEqual(check.check_spec(REPO), [])


class Defects(unittest.TestCase):
    """Each test plants one defect in a copy of the design folder and expects the matching error."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        d = self.root / "design"
        (d / "mockups").mkdir(parents=True)
        shutil.copy(REPO / "design/SPEC.md", d / "SPEC.md")
        shutil.copytree(REPO / "design/mockups/source", d / "mockups/source")
        for f in ("approved.json", "coverage.json"):
            shutil.copy(REPO / "design/mockups" / f, d / "mockups" / f)
        (d / "mockups/png").symlink_to(REPO / "design/mockups/png")
        (d / "brand").symlink_to(REPO / "design/brand")
        (d / "tokens").symlink_to(REPO / "design/tokens")
        self.design = d

    def tearDown(self):
        self.tmp.cleanup()

    def edit(self, rel, old, new):
        p = self.design / rel
        text = p.read_text(encoding="utf-8")
        self.assertIn(old, text, f"fixture text missing from {rel}")
        p.write_text(text.replace(old, new, 1), encoding="utf-8")

    def json_edit(self, rel, fn):
        p = self.design / rel
        data = json.loads(p.read_text(encoding="utf-8"))
        fn(data)
        p.write_text(json.dumps(data), encoding="utf-8")

    def test_a_board_dropped_from_canvas_and_disk_is_caught(self):
        self.json_edit("mockups/source/canvas.json", lambda c: c["boards"].pop("Upload-States.dc.html"))
        (self.design / "mockups/source/Upload-States.dc.html").unlink()
        errors = check.check_inventory(self.root)
        self.assertIn("inventory: approved board Upload-States is missing from canvas.json", errors)
        self.assertIn("inventory: approved board Upload-States is missing from design/mockups/source", errors)

    def test_a_board_changed_after_approval_is_caught(self):
        self.edit("mockups/source/Pricing.dc.html", "R499", "R399")
        self.assertIn("inventory: Pricing differs from the approved version", check.check_inventory(self.root))

    def test_a_canvas_asset_link_is_caught(self):
        self.edit("mockups/source/Signin.dc.html", "../../brand/logo-svg/isitlegit-logo-on-dark.svg", "/_blob/ff56ed85b79e0f4ad878f18e383f229f")
        self.assertIn("inventory: Signin still links a canvas asset", check.check_inventory(self.root))

    def test_a_state_removed_from_its_board_is_caught(self):
        coverage = json.loads((self.design / "mockups/coverage.json").read_text())
        item = next(i for i in coverage["A1"]["items"] if i["name"] == "rate limited")
        self.edit(f"mockups/source/{item['board']}.dc.html", item["evidence"], "")
        self.assertIn(f"coverage: A1 'rate limited' evidence is not on {item['board']}", check.check_coverage(self.root))

    def test_a_named_state_missing_from_coverage_is_caught(self):
        self.json_edit("mockups/coverage.json", lambda c: c["A1"].update(items=[i for i in c["A1"]["items"] if i["name"] != "rate limited"]))
        self.assertIn("coverage: A1 does not account for the state 'rate limited'", check.check_coverage(self.root))

    def test_a_universal_state_missing_from_coverage_is_caught(self):
        self.json_edit("mockups/coverage.json", lambda c: c["M4"].update(items=[i for i in c["M4"]["items"] if i["name"] != "empty"]))
        self.assertIn("coverage: M4 does not account for the state 'empty'", check.check_coverage(self.root))

    def test_a_deferral_to_a_missing_section_is_caught(self):
        def bogus(c):
            for i in c["X3"]["items"]:
                if "deferred" in i:
                    i["deferred"] = "D98 T98 §98"
                    return
            c["X3"]["items"].append({"name": "loading", "kind": "state", "deferred": "D98 T98 §98", "reason": "test"})
        self.json_edit("mockups/coverage.json", bogus)
        self.assertTrue(any("defers to D98 T98 §98, which does not resolve" in e for e in check.check_coverage(self.root)))

    def test_the_resolver_reads_a_reference_as_resolve_does(self):
        # Review of the in-process resolver (P2): exact membership refused forms `resolve` accepts.
        for ref in ("D07 T03 §5", "D07  T03 §5", "todo/07-app/TODO-03-report-page.md §5"):
            with self.subTest(ref=ref):
                self.assertTrue(check.resolver(ref))
        for ref in ("D98 T98 §98", "no reference here"):
            with self.subTest(ref=ref):
                self.assertFalse(check.resolver(ref))

    def test_a_row_without_coverage_is_caught(self):
        self.json_edit("mockups/coverage.json", lambda c: c.pop("E6"))
        self.assertIn("coverage: section 0 row E6 has no entry", check.check_coverage(self.root))

    def test_an_unlinked_board_is_caught(self):
        self.edit("SPEC.md", "(mockups/png/Plan.png)", "(mockups/png/Plan-missing.png)")
        errors = check.check_spec(self.root)
        self.assertIn("spec: mockups/png/Plan.png is not linked from design/SPEC.md", errors)
        self.assertIn("spec: mockups/png/Plan-missing.png does not exist", errors)

    def test_an_item_missing_from_its_spec_section_is_caught(self):
        self.edit("SPEC.md", "- rate limited:", "- throttled:")
        self.assertIn("spec: A1 does not list 'rate limited'", check.check_spec(self.root))


    def test_a_truncated_or_resized_png_is_caught(self):
        (self.design / "mockups/png").unlink()
        shutil.copytree(REPO / "design/mockups/png", self.design / "mockups/png")
        png = self.design / "mockups/png/Plan.png"
        png.write_bytes(png.read_bytes()[:500])
        self.assertIn("inventory: the PNG of Plan is None, not its approved 1440x1100", check.check_inventory(self.root))

    def test_an_asset_outside_design_is_caught(self):
        self.edit("mockups/source/Signin.dc.html", "../../brand/logo-svg/isitlegit-logo-on-dark.svg", "../../../samples/x.png")
        self.assertIn("inventory: Signin links ../../../samples/x.png, which is outside design/", check.check_inventory(self.root))

    def test_a_shared_part_without_coverage_is_caught(self):
        self.json_edit("mockups/coverage.json", lambda c: c.pop("P1"))
        self.assertIn("coverage: shared part P1 has no entry", check.check_coverage(self.root))

    def test_a_shared_stylesheet_change_is_caught(self):
        self.edit("mockups/source/ui.css", "body {", "body { line-height: 3; ")
        errors = check.check_inventory(self.root)
        self.assertIn("inventory: ui.css differs from the approved version", errors)
        self.assertIn("inventory: the PNG of Main is stale; run design/tools/export-mockups.py export", errors)

    def test_a_board_size_change_is_caught(self):
        self.json_edit("mockups/source/canvas.json", lambda c: c["boards"]["Plan.dc.html"].update(h=900))
        self.assertIn("inventory: Plan is 1440x900 in canvas.json, approved at 1440x1100", check.check_inventory(self.root))

    def test_a_required_control_removed_from_coverage_and_spec_is_caught(self):
        self.json_edit("mockups/coverage.json", lambda c: c["M4"].update(items=[i for i in c["M4"]["items"] if "csv import" not in i["name"].lower()]))
        self.edit("SPEC.md", "- CSV import with row errors: Row error table and Download a template. (Suppliers)\n", "")
        self.assertNotIn("- CSV import with row errors:", (self.design / "SPEC.md").read_text())
        errors = check.check_coverage(self.root) + check.check_spec(self.root)
        # section 0 still names it, so the gap is found even with both representations gone
        self.assertTrue(any(e.startswith("coverage: M4 does not account for 'CSV import") for e in errors), errors)

    def test_a_spec_colour_that_is_no_token_is_caught(self):
        self.edit("SPEC.md", "orange text `#CC2E00`", "orange text `#E03300`")
        self.assertIn("spec: design/SPEC.md quotes #E03300, which is no token value", check.check_spec(self.root))


if __name__ == "__main__":
    unittest.main()
