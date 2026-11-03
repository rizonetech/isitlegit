"""design/tools/export-mockups.py: boards become faithful standalone pages and PNGs, and every way that can go wrong is refused."""
import glob
import hashlib
import http.server
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "design/tools/export-mockups.py"


def chromium():
    """The browser design/tools/export-mockups.py would pick (find_chromium): MOCKUP_CHROMIUM first, so a host whose
    `chromium` has no usable sandbox (the GitHub ubuntu-24.04 image) tests with the one the tool is told to use."""
    if os.environ.get("MOCKUP_CHROMIUM"):
        return os.environ["MOCKUP_CHROMIUM"]
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
        self.write("ui.css", "body{color:#181519;font-family:'Exo 2',sans-serif} button,input,select,textarea{font-family:inherit}")
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
        return self.run_tool("export", "--source", str(self.src), "--out", str(self.out), "--png", str(self.png),
                             "--asset-root", str(self.src), *extra, env=env)


# Part scripts run in headless Chromium's sandbox, so exporting needs Chromium; without it nothing can be rendered.
@unittest.skipUnless(chromium(), "needs headless Chromium")
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

    def static_board(self):
        """The fixture board without its parts: the fake browsers below only take screenshots."""
        self.write("Board.dc.html", "\n".join(l for l in BOARD.splitlines() if "<dc-import" not in l))

    def test_a_chromium_failure_leaves_the_old_png(self):
        self.static_board()
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
        self.static_board()
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


    def test_a_board_name_that_is_not_a_plain_file_name_is_refused(self):
        self.write("canvas.json", json.dumps({"boards": {"../escape.dc.html": {"w": 10, "h": 10}}}))
        run = self.export("--no-png")
        self.assertEqual(run.returncode, 1)
        self.assertIn("is not a plain .dc.html file name", run.stderr)

    def test_a_malformed_canvas_is_refused_without_a_traceback(self):
        self.write("canvas.json", "{not json")
        run = self.export("--no-png")
        self.assertEqual(run.returncode, 1)
        self.assertIn("is not a readable canvas.json", run.stderr)
        self.assertNotIn("Traceback", run.stderr)

    def test_an_import_name_that_escapes_the_folder_is_refused(self):
        self.write("Board.dc.html", BOARD.replace('name="Part" active="two"', 'name="../Part"'))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("is not a plain board name", run.stderr)

    def test_part_scripts_have_no_host_process_or_modules(self):
        for probe in ("require('fs')", "process.env", "this.constructor.constructor('return process')().env"):
            with self.subTest(probe=probe):
                self.write("Part.dc.html", PART.replace("const active = this.props.active ?? 'one';", f"{probe}; const active = 'one';"))
                run = self.export("--no-png", "--only", "Board")
                self.assertEqual(run.returncode, 1, probe)
                self.assertIn("renderVals failed", run.stderr)

    def test_part_scripts_cannot_reach_a_local_server(self):
        hits = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/probe"
            self.write("Part.dc.html", PART.replace("const active = this.props.active ?? 'one';",
                                                    f"fetch('{url}', {{mode: 'no-cors'}}); new Image().src = '{url}'; const active = 'one';"))
            run = self.export("--no-png", "--only", "Board")
            self.assertEqual(run.returncode, 0, run.stderr)
        finally:
            server.shutdown()
        self.assertEqual(hits, [])

    def test_multiplying_imports_are_stopped_before_they_expand(self):
        boards = {}
        for i in range(9):
            inner = "x" * 1024 if i == 8 else "".join(f'<dc-import name="B{i + 1}"></dc-import>' for _ in range(32))
            self.write(f"B{i}.dc.html", BOARD.replace(BOARD[BOARD.index("<div style"):BOARD.index("</x-dc>")], f"<div>{inner}</div>\n"))
            boards[f"B{i}.dc.html"] = {"w": 10, "h": 10, "title": f"B{i}"}
        self.write("canvas.json", json.dumps({"boards": boards}))
        started = time.monotonic()
        run = self.export("--no-png", "--only", "B0")
        self.assertEqual(run.returncode, 1)
        self.assertIn("expands to more than 200 imported parts", run.stderr)
        self.assertLess(time.monotonic() - started, 30)

    def test_an_asset_outside_design_is_refused(self):
        (self.root / "outside.svg").write_text(SVG)
        for src in ("../outside.svg", "/etc/hostname", "file:///etc/hostname"):
            with self.subTest(src=src):
                self.write("Board.dc.html", BOARD.replace('src="pic.svg"', f'src="{src}"'))
                run = self.export("--no-png", "--only", "Board")
                self.assertEqual(run.returncode, 1, src)
                self.assertIn("outside design/", run.stderr)

    def test_a_single_quoted_or_video_src_is_checked_too(self):
        for markup in ("<img src='missing.png' alt=''>", '<video src="missing.mp4"></video>'):
            with self.subTest(markup=markup):
                self.write("Board.dc.html", BOARD.replace('<img src="pic.svg" alt="">', markup))
                run = self.export("--no-png", "--only", "Board")
                self.assertEqual(run.returncode, 1, markup)

    def test_a_malformed_board_fails_alone_and_the_rest_export(self):
        bad_props = BOARD.replace("""data-props='{"$preview":{"width":400,"height":300}}'""", "data-props='[]'")
        self.assertNotEqual(bad_props, BOARD)
        for why, bad in (("unclosed helmet", BOARD.replace("</helmet>", "")), ("non-object props", bad_props)):
            with self.subTest(why=why):
                self.write("Board.dc.html", bad)
                run = self.export("--no-png")
                self.assertEqual(run.returncode, 1)
                self.assertNotIn("Traceback", run.stderr)
                self.assertIn("1 of 2 boards exported", run.stdout)
        self.write("Board.dc.html", BOARD)

    def test_styles_count_towards_the_page_limit(self):
        big = "." + "x" * 100_000 + "{}"
        self.write("Part.dc.html", PART.replace(".on{font-weight:700}", big + " .on{font-weight:700}"))
        self.write("Board.dc.html", BOARD.replace('<dc-import name="Part" hint-size="200px,100px"></dc-import>',
                                                  '<dc-import name="Part"></dc-import>' * 90))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("expand to more than", run.stderr)

    def test_a_title_cannot_carry_markup_into_the_page(self):
        self.write("Board.dc.html", BOARD.replace("<title>Board</title>", "<title>x</TITLE><script>window.injected=1</script><title>y</title>"))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 0, run.stderr)
        page = (self.out / "Board.html").read_text()
        self.assertNotIn("window.injected", page)
        self.assertIn("<title>x</title>", page)
        self.write("Board.dc.html", BOARD.replace("<title>Board</title>", "<title>a <b>&amp; c</title>"))
        self.assertEqual(self.export("--no-png", "--only", "Board").returncode, 0)
        self.assertIn("<title>a &lt;b&gt;&amp; c</title>", (self.out / "Board.html").read_text())

    def test_a_style_holding_markup_is_refused(self):
        self.write("Part.dc.html", PART.replace(".on{font-weight:700}", ".on{font-weight:700}</STYLE><script>x()</script><style>"))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("a style holds markup", run.stderr)

    def test_executable_markup_and_remote_styles_are_refused(self):
        for bad in ("<script>fetch('http://127.0.0.1:9/')</script>", '<p onclick="x()">x</p>', '<a href="javascript:x()">x</a>',
                    '<iframe src="pic.svg"></iframe>', '<svg/onload="document.body.dataset.injected=1"></svg>',
                    '<img/src="pic.svg"/onerror=x()>', '<a href="jav&#x09;ascript:x()">x</a>', '<iframe srcdoc="x"></iframe>',
                    '<SCRIPT>x()</SCRIPT>', '<math><a xlink:href="javascript:x()">x</a></math>'):
            with self.subTest(markup=bad):
                self.write("Board.dc.html", BOARD.replace("<p>Board text</p>", bad))
                run = self.export("--no-png", "--only", "Board")
                self.assertEqual(run.returncode, 1, bad)
                self.assertIn("executable markup", run.stderr)
        self.write("Board.dc.html", BOARD)
        self.write("Part.dc.html", PART.replace(".on{font-weight:700}", "@import url(x.css); .on{font-weight:700}"))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("a style loads a network resource or another stylesheet", run.stderr)

    def test_a_network_resource_is_refused_but_code_shown_as_text_is_not(self):
        self.write("Board.dc.html", BOARD.replace('<img src="pic.svg" alt="">', '<img src="https://example.com/x.png" alt="">'))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("loads a network resource", run.stderr)
        self.write("Board.dc.html", BOARD.replace("<p>Board text</p>", '<pre>&lt;img src="https://example.com/x.png"&gt;</pre>'))
        run = self.export("--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('&lt;img src="https://example.com/x.png"&gt;', (self.out / "Board.html").read_text())

    def test_progress_is_reported_per_board(self):
        run = self.export("--no-png")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("[1/2] Board ... ok", run.stdout)
        self.assertIn("[2/2] Part ... ok", run.stdout)
        self.assertRegex(run.stdout, r"2 of 2 boards exported in [\d.]+ s")

    def test_the_fingerprint_follows_every_rendering_input(self):
        spec = importlib.util.spec_from_file_location("export_mockups", TOOL)
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
        base = tool.fingerprint("Board", self.src, (400, 300))
        self.assertNotEqual(base, tool.fingerprint("Board", self.src, (400, 301)))
        for name, text in (("ui.css", "body{color:#000}"), ("Part.dc.html", PART.replace("One", "Uno")), ("pic.svg", SVG.replace("181519", "000000"))):
            with self.subTest(changed=name):
                old = (self.src / name).read_text()
                self.write(name, text)
                tool._file_hash.cache_clear()
                self.assertNotEqual(base, tool.fingerprint("Board", self.src, (400, 300)))
                self.write(name, old)
                tool._file_hash.cache_clear()


@unittest.skipUnless(chromium(), "needs headless Chromium")
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

    def test_a_partial_run_keeps_the_other_boards_and_records_fingerprints(self):
        self.assertEqual(self.export("--audit").returncode, 0)
        run = self.export("--audit", "--only", "Part")
        self.assertEqual(run.returncode, 0, run.stderr)
        audit = json.loads((self.out / "audit.json").read_text())
        manifest = json.loads((self.png / "manifest.json").read_text())
        self.assertEqual(sorted(audit), ["Board", "Part"])
        self.assertEqual(sorted(manifest), ["Board", "Part"])
        self.assertEqual(audit["Board"]["fingerprint"], manifest["Board"])

    def test_form_values_placeholders_and_input_borders_are_audited(self):
        self.write("Board.dc.html", BOARD.replace("<p>Board text</p>", '<input value="typed" placeholder="hint" style="color: #FFFFFF; border: 1px solid #FFFFFF"><p>Board text</p>'))
        run = self.export("--audit", "--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 0, run.stderr)
        pairs = json.loads((self.out / "audit.json").read_text())["Board"]["pairs"]
        found = {(p["kind"], p["fg"], p["sample"]) for p in pairs}
        self.assertIn(("text", "rgb(255, 255, 255)", "typed"), found)
        self.assertIn(("boundary", "rgb(255, 255, 255)", "input border"), found)
        self.assertTrue(any(p["kind"] == "text" and p["sample"] == "hint" for p in pairs))

    def test_a_board_cannot_forge_its_audit(self):
        forged = '<pre id="mockup-audit" style="display:none">{"fonts":{},"images":[],"pairs":[]}</pre>'
        self.write("Board.dc.html", BOARD.replace("<p>Board text</p>", forged + "<p>Board text</p>"))
        run = self.export("--audit", "--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 0, run.stderr)
        audit = json.loads((self.out / "audit.json").read_text())["Board"]
        self.assertEqual(audit["fonts"], {"Exo 2": True})
        self.assertTrue(audit["pairs"])

    def test_the_page_policy_stops_any_script_the_checks_miss(self):
        self.assertEqual(self.export("--no-png", "--only", "Board").returncode, 0)
        page_path = self.out / "Board.html"
        page = page_path.read_text()
        self.assertIn('http-equiv="Content-Security-Policy"', page)
        # Plant what a missed check would let through, after export, and render it.
        page_path.write_text(page.replace("<p>Board text</p>", '<p>Board text</p><img src="none.png" onerror="document.body.dataset.x=1">'
                                          "<script>document.body.dataset.y=1</script>"))
        run = subprocess.run([chromium(), "--headless", "--virtual-time-budget=2000", "--dump-dom", page_path.resolve().as_uri()],
                             capture_output=True, text=True, timeout=120)
        self.assertIn("Board text", run.stdout)
        self.assertNotIn('data-x="1"', run.stdout)
        self.assertNotIn('data-y="1"', run.stdout)

    def test_opacity_fades_the_audited_colour_and_disabled_controls_are_exempt(self):
        self.write("Board.dc.html", BOARD.replace("<p>Board text</p>", '<p style="opacity: 0.25">Faded</p><button disabled>Off</button><p>Board text</p>'))
        run = self.export("--audit", "--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 0, run.stderr)
        pairs = {p["sample"]: p for p in json.loads((self.out / "audit.json").read_text())["Board"]["pairs"]}
        self.assertNotEqual(pairs["Faded"]["fg"], "rgb(24, 21, 25)", "a quarter-opacity ink is not ink")
        self.assertTrue(pairs["Off"]["inactive"] and pairs["Off"]["illustration"])

    def test_text_in_a_font_that_is_no_token_is_refused(self):
        self.write("Board.dc.html", BOARD.replace("<p>Board text</p>", '<p style="font-family: Nope, serif">Odd</p>'))
        run = self.export("--audit", "--no-png", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertIn("text in a font that is no token: Nope", run.stderr)

    def test_a_board_failing_its_audit_gets_no_fresh_png(self):
        self.assertEqual(self.export("--audit", "--only", "Board").returncode, 0)
        old = (self.png / "Board.png").read_bytes()
        self.write("pic.svg", "not an image")
        run = self.export("--audit", "--only", "Board")
        self.assertEqual(run.returncode, 1)
        self.assertEqual((self.png / "Board.png").read_bytes(), old)
        self.assertNotIn("Board", json.loads((self.png / "manifest.json").read_text()))

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

    def test_an_unreadable_board_leaves_the_previous_import_whole(self):
        (self.canvas / "Board.dc.html").write_text('<img src="/_blob/0123456789abcdef0123456789abcdef">')
        self.assertEqual(self.run_tool("import", str(self.canvas), "--source", str(self.dest)).returncode, 0)
        before = {p.name: p.read_bytes() for p in self.dest.iterdir()}
        (self.canvas / "Board.dc.html").write_text("changed")
        (self.canvas / "ui.css").chmod(0)
        try:
            run = self.run_tool("import", str(self.canvas), "--source", str(self.dest))
        finally:
            (self.canvas / "ui.css").chmod(0o644)
        self.assertEqual(run.returncode, 1)
        self.assertIn("nothing was imported", run.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in self.dest.iterdir()}, before)
        self.assertEqual([p.name for p in self.dest.parent.iterdir() if p.name.startswith(".")], [])

    def test_an_import_killed_mid_swap_is_finished_by_the_next_one(self):
        (self.canvas / "Board.dc.html").write_text("board")
        self.assertEqual(self.run_tool("import", str(self.canvas), "--source", str(self.dest)).returncode, 0)
        os.replace(self.dest, self.dest.parent / ".source.old")      # killed after moving source/ aside
        (self.dest.parent / ".source.new.abc").mkdir()                # and before installing the staged copy
        run = self.run_tool("import", str(self.canvas), "--source", str(self.dest))
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("restored", run.stderr)
        self.assertEqual((self.dest / "Board.dc.html").read_text(), "board")
        self.assertEqual(sorted(p.name for p in self.dest.parent.iterdir()), ["source"])

    def test_the_approved_record_covers_the_stylesheet_and_sizes(self):
        (self.canvas / "Board.dc.html").write_text("board")
        self.assertEqual(self.run_tool("import", str(self.canvas), "--source", str(self.dest), "--approve", "2026-10-26").returncode, 0)
        approved = json.loads((self.dest.parent / "approved.json").read_text())
        self.assertEqual(approved["ui_css_sha256"], hashlib.sha256(b"body{}").hexdigest())
        self.assertEqual((approved["boards"]["Board"]["w"], approved["boards"]["Board"]["h"]), (400, 300))

    def test_an_oversized_canvas_is_refused_before_it_is_read(self):
        (self.canvas / "Board.dc.html").write_bytes(b"x" * 2_000_001)
        run = self.run_tool("import", str(self.canvas), "--source", str(self.dest))
        self.assertEqual(run.returncode, 1)
        self.assertIn("nothing was read", run.stderr)
        many = {f"B{i}.dc.html": {"w": 10, "h": 10} for i in range(501)}
        (self.canvas / "canvas.json").write_text(json.dumps({"boards": many}))
        run = self.run_tool("import", str(self.canvas), "--source", str(self.dest))
        self.assertEqual(run.returncode, 1)
        self.assertIn("more than the 500 an import takes", run.stderr)

    def test_an_unmapped_canvas_asset_stops_the_import(self):
        (self.canvas / "Board.dc.html").write_text('<img src="/_blob/ffffffffffffffffffffffffffffffff">')
        run = self.run_tool("import", str(self.canvas), "--source", str(self.dest))
        self.assertEqual(run.returncode, 1)
        self.assertIn("no entry in assets.json", run.stderr)
        self.assertFalse((self.dest / "Board.dc.html").exists())


@unittest.skipUnless(chromium(), "needs headless Chromium")
class Diff(Fixture):
    def setUp(self):
        super().setUp()
        self.approved_src = self.root / "approved" / "source"
        self.approved_src.mkdir(parents=True)
        self.diff_out = self.root / "diff"
        self.tokens = self.root / "colors.json"
        self.tokens.write_text(json.dumps({"roles": {"ink": "body text"}}))
        self.todo = self.root / "todo" / "07-app"
        self.todo.mkdir(parents=True)
        (self.todo / "TODO-01-fixture.md").write_text(
            "# TODO-01\n\n## 1. Fixture\n\n**Fidelity:** boards `Board`, values from `ui.css`\n")
        (self.root / "SPEC.md").write_text(
            "| # | Route | Page | Purpose | Owner |\n| - | - | - | - | - |\n"
            "| S1 | `/` | Home | x | D07 T06 §2 |\n| S2 | `/p` | Part page | x | D07 T98 §7 |\n")
        (self.root / "approved" / "coverage.json").write_text(json.dumps(
            {"S1": {"items": [{"board": "Board"}]}, "S2": {"items": [{"board": "Part"}]}}))
        ui = ":root{--ink:#181519}\nbody{color:#181519;font-family:'Exo 2',sans-serif} button,input,select,textarea{font-family:inherit}"
        for name in ("Part.dc.html", "Board.dc.html", "pic.svg"):
            shutil.copy2(self.src / name, self.approved_src / name)
        (self.approved_src / "ui.css").write_text(ui)
        shutil.copy2(self.src / "canvas.json", self.approved_src / "canvas.json")
        run = self.run_tool("export", "--source", str(self.approved_src), "--out", str(self.out),
                            "--png", str(self.png), "--asset-root", str(self.approved_src))
        self.assertEqual(run.returncode, 0, run.stderr)
        canvas = json.loads((self.approved_src / "canvas.json").read_text())
        boards = {}
        for fname, rec in canvas["boards"].items():
            data = (self.approved_src / fname).read_bytes()
            boards[fname[:-8]] = {"title": rec.get("title", ""), "w": rec["w"], "h": rec["h"],
                                  "sha256": hashlib.sha256(data).hexdigest()}
        approved = {"approved": "2026-10-26",
                    "ui_css_sha256": hashlib.sha256((self.approved_src / "ui.css").read_bytes()).hexdigest(),
                    "boards": boards}
        (self.root / "approved" / "approved.json").write_text(json.dumps(approved))
        self.candidate = self.root / "candidate"
        shutil.copytree(self.approved_src, self.candidate)

    def diff(self, *extra):
        return self.run_tool("diff", str(self.candidate), "--source", str(self.approved_src), "--png", str(self.png),
                             "--out", str(self.diff_out), "--tokens", str(self.tokens), "--todo", str(self.root / "todo"),
                             "--spec", str(self.root / "SPEC.md"),
                             "--asset-root", str(self.candidate), *extra)

    def summary(self):
        return (self.diff_out / "summary.md").read_text()

    def test_unchanged_canvas_lists_nothing(self):
        run = self.diff()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("(none)", self.summary())
        self.assertEqual([p.name for p in self.diff_out.iterdir()], ["summary.md"])

    def test_a_changed_part_lists_every_importer(self):
        (self.candidate / "Part.dc.html").write_text(PART.replace("One", "Uno"))
        run = self.diff()
        self.assertEqual(run.returncode, 0, run.stderr)
        text = self.summary()
        self.assertIn("| Board |", text)
        self.assertIn("D07 T01 §1", text)
        self.assertTrue((self.diff_out / "Board.before.png").exists())
        self.assertTrue((self.diff_out / "Board.after.png").exists())
        self.assertTrue((self.diff_out / "Board.diff.png").exists())
        from PIL import Image
        before = Image.open(self.diff_out / "Board.before.png").convert("RGB")
        after = Image.open(self.diff_out / "Board.after.png").convert("RGB")
        diff = Image.open(self.diff_out / "Board.diff.png").convert("RGB")
        changed = sum(1 for a, b in zip(before.getdata(), after.getdata()) if a != b)
        share = f"{changed / (before.width * before.height) * 100:.1f}%"
        self.assertIn(share, text)
        self.assertGreater(changed, 0)
        magenta = [p for p in diff.getdata() if p == (255, 0, 255)]
        self.assertEqual(len(magenta), changed)

    def test_a_token_change_affects_every_board_and_is_named(self):
        (self.candidate / "ui.css").write_text(
            ":root{--ink:#000000}\nbody{color:#000000;font-family:'Exo 2',sans-serif} button,input,select,textarea{font-family:inherit}")
        run = self.diff()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("Tokens changed: ink (#181519 -> #000000)", self.summary())
        self.assertIn("| Board |", self.summary())
        self.assertIn("| Part |", self.summary())

    def test_new_removed_and_resized_boards(self):
        (self.candidate / "Extra.dc.html").write_text(BOARD.replace("<title>Board</title>", "<title>Extra</title>"))
        canvas = json.loads((self.candidate / "canvas.json").read_text())
        canvas["boards"]["Extra.dc.html"] = {"w": 400, "h": 300, "title": "Extra"}
        del canvas["boards"]["Part.dc.html"]
        canvas["boards"]["Board.dc.html"] = {"w": 401, "h": 300, "title": "Board"}
        (self.candidate / "canvas.json").write_text(json.dumps(canvas))
        run = self.diff()
        self.assertEqual(run.returncode, 0, run.stderr)
        text = self.summary()
        self.assertIn("new board", text)
        self.assertIn("removed board", text)
        self.assertTrue((self.diff_out / "Extra.after.png").exists())
        self.assertTrue((self.diff_out / "Part.before.png").exists())

    def test_an_artwork_only_change_is_detected(self):
        (self.candidate / "pic.svg").write_text(SVG.replace("181519", "FF0000"))
        run = self.diff()
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("| Board |", self.summary())
        self.assertIn("board or artwork changed", self.summary())

    def test_unchanged_pixels_are_dimmed_in_the_diff_image(self):
        (self.candidate / "Part.dc.html").write_text(PART.replace("One", "Uno"))
        self.assertEqual(self.diff().returncode, 0)
        from PIL import Image
        after = Image.open(self.diff_out / "Board.after.png").convert("RGB")
        diff = Image.open(self.diff_out / "Board.diff.png").convert("RGB")
        # bottom-right corner is unchanged board background in both renders
        self.assertEqual(diff.getpixel((399, 299)), tuple(c // 2 for c in after.getpixel((399, 299))))

    def test_a_missing_baseline_png_is_refused(self):
        (self.png / "Board.png").unlink()
        run = self.diff()
        self.assertEqual(run.returncode, 1)
        self.assertIn("approved baseline", run.stderr)

    def test_a_rerun_with_no_changes_removes_old_images(self):
        (self.candidate / "Part.dc.html").write_text(PART.replace("One", "Uno"))
        self.assertEqual(self.diff().returncode, 0)
        self.assertTrue((self.diff_out / "Board.diff.png").exists())
        shutil.copy2(self.approved_src / "Part.dc.html", self.candidate / "Part.dc.html")
        self.assertEqual(self.diff().returncode, 0)
        self.assertEqual([p.name for p in self.diff_out.iterdir()], ["summary.md"])

    def test_failure_after_one_board_renders_keeps_the_previous_diff(self):
        (self.candidate / "Part.dc.html").write_text(PART.replace("One", "Uno"))
        self.assertEqual(self.diff().returncode, 0)
        before_summary = self.summary()
        before_files = sorted(p.name for p in self.diff_out.iterdir())
        (self.candidate / "Extra.dc.html").write_text(BOARD.replace('name="Part" active="two"', 'name="Missing"'))
        canvas = json.loads((self.candidate / "canvas.json").read_text())
        canvas["boards"]["Extra.dc.html"] = {"w": 400, "h": 300, "title": "Extra"}
        (self.candidate / "canvas.json").write_text(json.dumps(canvas))
        run = self.diff()
        self.assertEqual(run.returncode, 1)
        self.assertEqual(self.summary(), before_summary)
        self.assertEqual(sorted(p.name for p in self.diff_out.iterdir()), before_files)

    def test_a_raw_blob_candidate_is_rewritten_through_assets_json(self):
        (self.candidate / "Board.dc.html").write_text(
            BOARD.replace('src="pic.svg"', 'src="/_blob/0123456789abcdef0123456789abcdef"').replace("Board text", "Blob text"))
        (self.candidate / "assets.json").write_text(json.dumps({"0123456789abcdef0123456789abcdef": "pic.svg"}))
        run = self.diff("--asset-root", str(self.root))
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("| Board |", self.summary())

    def test_publication_never_deletes_the_candidate(self):
        trap = self.diff_out.parent / f".{self.diff_out.name}.old"
        shutil.copytree(self.candidate, trap)
        run = self.run_tool("diff", str(trap), "--source", str(self.approved_src), "--png", str(self.png),
                            "--out", str(self.diff_out), "--tokens", str(self.tokens), "--todo", str(self.root / "todo"),
                            "--asset-root", str(trap))
        self.assertEqual(run.returncode, 1)
        self.assertIn("overlaps candidate", run.stderr)
        self.assertTrue((trap / "Board.dc.html").exists())

    def test_out_inside_design_is_refused_and_shadow_is_cleaned(self):
        run = self.run_tool("diff", str(self.candidate), "--source", str(self.approved_src), "--png", str(self.png),
                            "--out", str(REPO / "design/fonts"), "--tokens", str(self.tokens),
                            "--todo", str(self.root / "todo"), "--asset-root", str(self.candidate))
        self.assertEqual(run.returncode, 1)
        self.assertIn("overlaps", run.stderr)
        (self.candidate / "Board.dc.html").write_text(
            BOARD.replace('src="pic.svg"', 'src="/_blob/0123456789abcdef0123456789abcdef"'))
        (self.candidate / "assets.json").write_text(json.dumps({"0123456789abcdef0123456789abcdef": "pic.svg"}))
        self.assertEqual(self.diff("--asset-root", str(self.root)).returncode, 0)
        self.assertEqual([p.name for p in self.root.iterdir() if p.name.startswith(".candidate-")], [])

    def test_candidate_blob_mapping_uses_candidate_artwork(self):
        (self.candidate / "Board.dc.html").write_text(
            BOARD.replace('src="pic.svg"', 'src="/_blob/0123456789abcdef0123456789abcdef"').replace("Board text", "Blob text"))
        (self.candidate / "pic.svg").write_text(SVG.replace("181519", "FF0000"))
        (self.candidate / "assets.json").write_text(json.dumps({"0123456789abcdef0123456789abcdef": "pic.svg"}))
        run = self.diff("--asset-root", str(self.root))
        self.assertEqual(run.returncode, 0, run.stderr)
        from PIL import Image
        after = Image.open(self.diff_out / "Board.after.png").convert("RGB")
        self.assertIn((255, 0, 0), list(after.getdata()))

    def test_out_equal_to_asset_root_is_refused(self):
        run = self.run_tool("diff", str(self.candidate), "--source", str(self.approved_src), "--png", str(self.png),
                            "--out", str(self.candidate), "--tokens", str(self.tokens),
                            "--todo", str(self.root / "todo"), "--asset-root", str(self.candidate))
        self.assertEqual(run.returncode, 1)
        self.assertIn("overlaps", run.stderr)

    def test_indirect_ownership_through_coverage_and_spec(self):
        (self.candidate / "Part.dc.html").write_text(PART.replace("One", "Uno"))
        self.assertEqual(self.diff().returncode, 0)
        self.assertIn("D07 T98 §7", self.summary())

    def test_an_unchanged_raw_canvas_lists_nothing(self):
        (self.candidate / "Board.dc.html").write_text(
            BOARD.replace('src="pic.svg"', 'src="/_blob/0123456789abcdef0123456789abcdef"'))
        (self.candidate / "assets.json").write_text(json.dumps({"0123456789abcdef0123456789abcdef": "pic.svg"}))
        run = self.diff("--asset-root", str(self.root))
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("(none)", self.summary())

    def test_the_candidate_fingerprint_follows_stylesheet_and_size(self):
        self.assertEqual(self.diff().returncode, 0)
        first = [l for l in self.summary().splitlines() if "Candidate fingerprint" in l][0]
        (self.candidate / "ui.css").write_text(
            ":root{--ink:#000000}\nbody{color:#000000;font-family:'Exo 2',sans-serif} button,input,select,textarea{font-family:inherit}")
        self.assertEqual(self.diff().returncode, 0)
        second = [l for l in self.summary().splitlines() if "Candidate fingerprint" in l][0]
        self.assertNotEqual(first, second)

    def test_a_resized_board_reports_its_union_share(self):
        canvas = json.loads((self.candidate / "canvas.json").read_text())
        canvas["boards"]["Board.dc.html"] = {"w": 401, "h": 300, "title": "Board"}
        (self.candidate / "canvas.json").write_text(json.dumps(canvas))
        self.assertEqual(self.diff().returncode, 0)
        from PIL import Image
        before = Image.open(self.diff_out / "Board.before.png").convert("RGB")
        after = Image.open(self.diff_out / "Board.after.png").convert("RGB")
        ow, oh = min(before.width, after.width), min(before.height, after.height)
        total = before.width * before.height + after.width * after.height - ow * oh
        bp, ap = before.load(), after.load()
        same = sum(1 for y in range(oh) for x in range(ow) if bp[x, y] == ap[x, y])
        share = f"{(total - same) / total * 100:.1f}%"
        self.assertIn(share, self.summary())

    def test_an_interrupted_publication_is_recovered_on_the_next_run(self):
        self.assertEqual(self.diff().returncode, 0)
        backup = self.diff_out.parent / f".{self.diff_out.name}.old"
        shutil.rmtree(self.diff_out)
        backup.mkdir()
        (backup / "summary.md").write_text("previous summary\n")
        (backup / "Board.before.png").write_bytes(b"previous image")
        (self.candidate / "Board.dc.html").write_text(BOARD.replace('name="Part" active="two"', 'name="Missing"'))
        run = self.diff()
        self.assertEqual(run.returncode, 1)
        self.assertEqual((self.diff_out / "summary.md").read_text(), "previous summary\n")
        self.assertEqual((self.diff_out / "Board.before.png").read_bytes(), b"previous image")

    def test_a_stale_baseline_is_refused(self):
        (self.approved_src / "Board.dc.html").write_text(BOARD.replace("Board text", "Tampered"))
        run = self.diff()
        self.assertEqual(run.returncode, 1)
        self.assertIn("approved baseline", run.stderr)

    def test_a_failed_diff_keeps_the_previous_one(self):
        (self.candidate / "Part.dc.html").write_text(PART.replace("One", "Uno"))
        self.assertEqual(self.diff().returncode, 0)
        before = self.summary()
        (self.candidate / "Board.dc.html").write_text(BOARD.replace('name="Part" active="two"', 'name="Missing"'))
        run = self.diff()
        self.assertEqual(run.returncode, 1)
        self.assertEqual(self.summary(), before)


if __name__ == "__main__":
    unittest.main()
