"""design/tokens/*.json: every colour pair the boards render is a token pair passing WCAG 2.2 in both themes, and type and spacing sit on the token scales."""
import glob
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_design", REPO / "design/tools/check-design.py")
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def chromium():
    found = sorted(glob.glob(os.path.expanduser(
        "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")))
    return found[-1] if found else shutil.which("chromium") or shutil.which("google-chrome")


class Tokens(unittest.TestCase):
    def test_pairs_scales_and_stylesheet_agree_without_an_audit(self):
        self.assertEqual(check.check_tokens(REPO), [])

    def test_contrast_matches_wcag_reference_values(self):
        self.assertAlmostEqual(check.contrast("#000000", "#FFFFFF"), 21.0, places=2)
        self.assertAlmostEqual(check.contrast("#767676", "#FFFFFF"), 4.54, places=2)


# The audit renders all 70 boards in headless Chromium; where it cannot run, the reconciliation cannot either.
@unittest.skipUnless(shutil.which("node") and chromium(), "needs node and headless Chromium to render the boards")
class RenderedBoards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        out = pathlib.Path(cls.tmp.name)
        run = subprocess.run([sys.executable, str(REPO / "design/tools/export-mockups.py"), "export", "--audit", "--no-png", "--out", str(out)],
                             capture_output=True, text=True, timeout=600)
        if run.returncode != 0:
            raise AssertionError(run.stderr)
        cls.audit = json.loads((out / "audit.json").read_text())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_every_rendered_pair_is_a_passing_token_pair(self):
        self.assertEqual(len(self.audit), 70)
        self.assertEqual(check.check_tokens(REPO, self.audit), [])


class Defects(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        shutil.copytree(REPO / "design/tokens", self.root / "design/tokens")
        shutil.copytree(REPO / "design/mockups/source", self.root / "design/mockups/source")
        shutil.copy(REPO / "design/mockups/approved.json", self.root / "design/mockups/approved.json")

    def tearDown(self):
        self.tmp.cleanup()

    def audit(self, fg, size=14, weight=400, bg="rgb(255, 255, 255)", illustration=False):
        return {"Fixture": {"pairs": [{"fg": fg, "bg": bg, "size": size, "weight": weight, "illustration": illustration, "sample": "planted"}]}}

    def test_a_planted_unlisted_failing_pair_is_caught(self):
        errors = check.check_tokens(self.root, self.audit("rgb(178, 106, 0)"))  # #B26A00 text on white, 4.24:1
        self.assertIn("tokens: Fixture renders #B26A00 on #FFFFFF ('planted'), which is no token pair", errors)

    def fixture_errors(self, audit):
        return [e for e in check.check_tokens(self.root, audit) if "Fixture" in e]

    def test_illustration_content_is_exempt(self):
        self.assertEqual(self.fixture_errors(self.audit("rgb(59, 111, 216)", illustration=True)), [])

    def test_a_listed_pair_is_accepted(self):
        self.assertEqual(self.fixture_errors(self.audit("rgb(24, 21, 25)")), [])

    def test_an_empty_or_partial_audit_is_refused(self):
        errors = check.check_tokens(self.root, {})
        self.assertIn("tokens: the audit has no entry for Main", errors)
        self.assertEqual(sum(e.startswith("tokens: the audit has no entry for") for e in errors), 70)

    def test_a_stale_audit_entry_is_refused(self):
        audit = {"Main": {"fingerprint": "0" * 64, "pairs": []}}
        self.assertIn("tokens: the audit of Main is stale", check.check_tokens(self.root, audit))

    def test_text_off_the_type_scale_is_caught(self):
        errors = check.check_tokens(self.root, self.audit("rgb(24, 21, 25)", size=9))
        self.assertIn("tokens: Fixture renders 9 px text, more than 2 px from the type scale", errors)

    def test_a_dark_theme_value_that_fails_contrast_is_caught(self):
        p = self.root / "design/tokens/colors.json"
        data = json.loads(p.read_text())
        data["themes"]["dark"]["muted"] = "#3A3740"
        p.write_text(json.dumps(data))
        self.assertTrue(any(e.startswith("tokens: muted on surface is") and "dark theme, below 4.5" in e for e in check.check_tokens(self.root)))

    def test_a_stylesheet_size_that_disagrees_with_its_token_is_caught(self):
        p = self.root / "design/mockups/source/ui.css"
        p.write_text(p.read_text().replace("h1 { font-size: 40px;", "h1 { font-size: 42px;"))
        self.assertIn("tokens: ui.css sets h1 to 42 px, the token says 40 px", check.check_tokens(self.root))

    def test_a_stylesheet_colour_that_disagrees_with_its_token_is_caught(self):
        p = self.root / "design/mockups/source/ui.css"
        p.write_text(p.read_text().replace("--orange-text: #CC2E00;", "--orange-text: #E03300;"))
        self.assertIn("tokens: ui.css --orange-text is #E03300, the light token is #CC2E00", check.check_tokens(self.root))

    def test_spacing_off_the_scale_is_caught(self):
        p = self.root / "design/mockups/source/Cases.dc.html"
        p.write_text(p.read_text().replace("padding: 32px 56px;", "padding: 32px 150px;", 1))
        self.assertIn("tokens: Cases uses 150 px spacing, more than 2 px from the spacing scale", check.check_tokens(self.root))


if __name__ == "__main__":
    unittest.main()
