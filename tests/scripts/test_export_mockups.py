"""design/tools/export-mockups.py: boards become faithful standalone pages and PNGs, and every way that can go wrong is refused."""
import glob
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "design/tools/export-mockups.py"
HAS_NODE = shutil.which("node") is not None


def chromium():
    found = sorted(glob.glob(os.path.expanduser(
        "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")))
    return found[-1] if found else shutil.which("chromium") or shutil.which("google-chrome")


PART = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Part</title></head><body>
<x-dc>
<helmet><style>.on{font-weight:700} .off{font-weight:400}</style></helmet>
<nav><a class="{{c.one}}">One</a><a class="{{c.two}}">Two</a><span>{{label}}</span></nav>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"active":{"editor":"enum","options":["one","two"],"default":"one"},"$preview":{"width":200,"height":100}}'>
class Component extends DCLogic {
renderVals() {
const active = this.props.active ?? 'one';
return { c: { one: active === 'one' ? 'on' : 'off', two: active === 'two' ? 'on' : 'off' }, label: 'active is ' + active.toUpperCase() };
}
}
</script>
</body></html>
"""

BOARD = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Board</title><script src="./support.js"></script></head><body>
<x-dc>
<helmet><style>body{margin:0}</style></helmet>
<div style="width: 400px; height: 300px; background: #FFFFFF; font-family: 'Exo 2', sans-serif">
  <dc-import name="Part" active="two" hint-size="200px,100px"></dc-import>
  <dc-import name="Part" hint-size="200px,100px"></dc-import>
  <img src="pic.svg" alt="">
  <p>Board text</p>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":400,"height":300}}'>
class Component extends DCLogic { renderVals() { return {}; } }
</script>
</body></html>
"""

SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#181519"/></svg>'


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.src = self.root / "source"
        self.src.mkdir()
        self.out = self.root / "out"
        self.png = self.root / "png"
        self.write("Part.dc.html", PART)
        self.write("Board.dc.html", BOARD)
        self.write("pic.svg", SVG)
        self.write("ui.css", "body{color:#181519}")
        self.write("canvas.json", json.dumps({"boards": {
            "Board.dc.html": {"w": 400, "h": 300, "title": "Board"}, "Part.dc.html": {"w": 200, "h": 100, "title": "Part"}}}))

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        (self.src / name).write_text(text, encoding="utf-8")

    def run_tool(self, *args, env=None):
        e = dict(os.environ, **(env or {}))
        return subprocess.run([sys.executable, str(TOOL), *args], capture_output=True, text=True, env=e, timeout=300)

    def export(self, *extra, env=None):
        return self.run_tool("export", "--source", str(self.src), "--out", str(self.out), "--png", str(self.png), *extra, env=env)


@unittest.skipUnless(HAS_NODE, "needs node for renderVals")
class Export(Fixture):
    def test_parts_are_inlined_with_their_props_and_render_vals(self):
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 0, run.stderr)
        page = (self.out / "Board.html").read_text(encoding="utf-8")
        self.assertIn('<a class="off">One</a><a class="on">Two</a>', page)  # active="two"
        self.assertIn('<a class="on">One</a><a class="off">Two</a>', page)  # the part's default, "one"
        self.assertIn("active is TWO", page)
        self.assertIn("active is ONE", page)
        self.assertIn(".on{font-weight:700}", page)
        self.assertNotIn("<dc-import", page)
        self.assertNotIn("{{", page)
        self.assertIn("Exo2%5Bwght%5D.ttf", page)

    def test_an_unknown_import_is_refused(self):
        self.write("Board.dc.html", BOARD.replace('name="Part" active="two"', 'name="Missing"'))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("import of Missing", run.stderr)

    def test_a_template_value_without_render_vals_is_refused(self):
        self.write("Part.dc.html", PART.replace("{{label}}", "{{nothing.here}}"))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("nothing.here", run.stderr)

    def test_a_missing_asset_is_refused(self):
        (self.src / "pic.svg").unlink()
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("pic.svg does not exist", run.stderr)

    def test_a_canvas_asset_link_is_refused(self):
        self.write("Board.dc.html", BOARD.replace('src="pic.svg"', 'src="/_blob/0123456789abcdef0123456789abcdef"'))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("/_blob/", run.stderr)

    def test_a_chromium_failure_leaves_the_old_png(self):
        self.png.mkdir()
        (self.png / "Board.png").write_bytes(b"old")
        fake = self.root / "fake-chrome"
        fake.write_text("#!/bin/sh\nexit 3\n")
        fake.chmod(0o755)
        run = self.export("--only", "Board", env={"MOCKUP_CHROMIUM": str(fake)})
        self.assertEqual(run.returncode, 1)
        self.assertEqual((self.png / "Board.png").read_bytes(), b"old")
        self.assertEqual(sorted(p.name for p in self.png.iterdir()), ["Board.png"])

    def test_a_png_of_the_wrong_size_is_refused(self):
        fake = self.root / "fake-chrome"
        one_pixel = ("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                     "1f15c4890000000d49444154789c6360000002000100e221bc330000000049454e44ae426082")
        fake.write_text("#!/usr/bin/env python3\nimport sys\nfor a in sys.argv:\n"
                        "    if a.startswith('--screenshot='):\n"
                        f"        open(a.split('=', 1)[1], 'wb').write(bytes.fromhex('{one_pixel}'))\n")
        fake.chmod(0o755)
        run = self.export("--only", "Board", env={"MOCKUP_CHROMIUM": str(fake)})
        self.assertEqual(run.returncode, 1)
        self.assertIn("PNG is 1x1, board is 400x300", run.stderr)
        self.assertFalse((self.png / "Board.png").exists())


@unittest.skipUnless(HAS_NODE and chromium(), "needs node and headless Chromium")
class Render(Fixture):
    def test_png_matches_the_board_and_the_audit_sees_fonts_images_and_text(self):
        run = self.export("--audit", "--only", "Board")
        self.assertEqual(run.returncode, 0, run.stderr)
        head = (self.png / "Board.png").read_bytes()[:24]
        self.assertEqual((int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")), (400, 300))
        audit = json.loads((self.out / "audit.json").read_text())["Board"]
        self.assertEqual(audit["fonts"], {"Exo 2": True})
        self.assertEqual([i["ok"] for i in audit["images"]], [True])
        # pairs are deduplicated by colour, size and weight: the bold active item is its own pair
        pairs = {(p["fg"], p["bg"], p["size"], p["weight"]) for p in audit["pairs"]}
        self.assertIn(("rgb(24, 21, 25)", "rgb(255, 255, 255)", 16, 700), pairs)
        self.assertIn(("rgb(24, 21, 25)", "rgb(255, 255, 255)", 16, 400), pairs)

    def test_an_unloaded_font_is_refused(self):
        run = self.export("--audit", "--no-png", "--only", "Board", env={"MOCKUP_FONTS": str(self.root / "no-fonts")})
        self.assertEqual(run.returncode, 1)
        self.assertIn("font not loaded: Exo 2", run.stderr)

    def test_an_image_that_does_not_load_is_refused(self):
        self.write("pic.svg", "not an image")
        run = self.export("--audit", "--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("image not loaded", run.stderr)


class Import(Fixture):
    def setUp(self):
        super().setUp()
        self.canvas = self.root / "canvas"
        self.canvas.mkdir()
        self.dest = self.root / "mockups/source"
        self.dest.mkdir(parents=True)
        (self.dest / "assets.json").write_text(json.dumps({"0123456789abcdef0123456789abcdef": "../../brand/logo.svg"}))
        (self.canvas / "canvas.json").write_text(json.dumps({"boards": {"Board.dc.html": {"w": 400, "h": 300, "title": "Board"}}}))
        (self.canvas / "ui.css").write_text("body{}")

    def test_canvas_assets_are_rewritten_and_the_inventory_recorded(self):
        (self.canvas / "Board.dc.html").write_text('<img src="/_blob/0123456789abcdef0123456789abcdef">')
        run = self.run_tool("import", str(self.canvas), "--source", str(self.dest), "--approve", "2026-10-26")
        self.assertEqual(run.returncode, 0, run.stderr)
        text = (self.dest / "Board.dc.html").read_text()
        self.assertEqual(text, '<img src="../../brand/logo.svg">')
        approved = json.loads((self.dest.parent / "approved.json").read_text())
        self.assertEqual(approved["boards"]["Board"]["sha256"], hashlib.sha256(text.encode()).hexdigest())

    def test_an_unmapped_canvas_asset_stops_the_import(self):
        (self.canvas / "Board.dc.html").write_text('<img src="/_blob/ffffffffffffffffffffffffffffffff">')
        run = self.run_tool("import", str(self.canvas), "--source", str(self.dest))
        self.assertEqual(run.returncode, 1)
        self.assertIn("no entry in assets.json", run.stderr)
        self.assertFalse((self.dest / "Board.dc.html").exists())


if __name__ == "__main__":
    unittest.main()
