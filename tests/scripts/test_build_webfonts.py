"""design/tools/build-webfonts.py: the committed WOFF2 fonts are sound and current, a rebuild of unchanged fonts needs no
fonttools and changes nothing, and a changed source font gets a new name with the old file removed.

tests/scripts runs on the standard library, so the checks that read fonts need fonttools (design/tools/requirements.txt):
they skip without it locally and are required in CI, which sets REQUIRE_FONT_TOOLS=1."""
import hashlib
import importlib.util
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "design/tools/build-webfonts.py"
HAVE_FONT_TOOLS = importlib.util.find_spec("fontTools") is not None and importlib.util.find_spec("brotli") is not None
if os.environ.get("REQUIRE_FONT_TOOLS") == "1" and not HAVE_FONT_TOOLS:
    raise RuntimeError("REQUIRE_FONT_TOOLS=1 but fonttools or brotli is missing: pip install -r design/tools/requirements.txt")
needs_font_tools = unittest.skipUnless(HAVE_FONT_TOOLS, "needs design/tools/requirements.txt (fonttools, brotli)")

_spec = importlib.util.spec_from_file_location("build_webfonts", TOOL)
webfonts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(webfonts)


def run(*args, env=None):
    return subprocess.run([sys.executable, *args], capture_output=True, text=True, env=env, timeout=300)


class Committed(unittest.TestCase):
    def test_the_css_names_the_current_fonts_and_they_exist(self):
        css = (REPO / "src/web/styles/fonts.css").read_text(encoding="utf-8")
        for source, name, family in webfonts.FAMILIES:
            served = f"{name}.{webfonts.fingerprint(REPO / 'design/fonts' / source)}.woff2"
            self.assertIn(f'font-family: "{family}";', css)
            self.assertIn(f'url("/static/fonts/{served}")', css)
            self.assertEqual((REPO / "public/static/fonts" / served).read_bytes()[:4], b"wOF2", served)
        self.assertEqual(sorted(p.name for p in (REPO / "public/static/fonts").iterdir()),
                         sorted(f"{n}.{webfonts.fingerprint(REPO / 'design/fonts' / s)}.woff2" for s, n, _ in webfonts.FAMILIES))

    @needs_font_tools
    def test_each_committed_font_holds_every_glyph_of_its_source(self):
        from fontTools.ttLib import TTFont

        for source, name, _ in webfonts.FAMILIES:
            served = REPO / "public/static/fonts" / f"{name}.{webfonts.fingerprint(REPO / 'design/fonts' / source)}.woff2"
            woff2 = TTFont(served)
            self.assertEqual(woff2.flavor, "woff2")
            self.assertEqual(woff2["maxp"].numGlyphs, TTFont(REPO / "design/fonts" / source)["maxp"].numGlyphs, name)


class Build(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.fonts, self.out, self.css = root / "fonts", root / "out", root / "fonts.css"
        shutil.copytree(REPO / "design/fonts", self.fonts)
        shutil.copytree(REPO / "public/static/fonts", self.out)

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, env=None):
        return run(str(TOOL), "--fonts", str(self.fonts), "--out", str(self.out), "--css", str(self.css), env=env)

    def test_unchanged_fonts_rebuild_without_fonttools_and_change_nothing(self):
        before = {p.name: p.read_bytes() for p in self.out.iterdir()}
        # A Python that cannot import fonttools: an empty site directory first on the path, user site packages off.
        hidden = pathlib.Path(self.tmp.name) / "hidden"
        (hidden / "fontTools").mkdir(parents=True)
        (hidden / "fontTools/__init__.py").write_text("raise ImportError('fonttools hidden by the test')\n")
        env = dict(os.environ, PYTHONPATH=str(hidden), PYTHONNOUSERSITE="1")
        result = self.build(env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in self.out.iterdir()}, before)
        self.assertIn('font-family: "Exo 2";', self.css.read_text(encoding="utf-8"))

    def test_a_changed_font_without_fonttools_is_refused_with_the_fix(self):
        (self.fonts / "Exo[wght].ttf").write_bytes((self.fonts / "Exo[wght].ttf").read_bytes() + b"\0")
        hidden = pathlib.Path(self.tmp.name) / "hidden"
        hidden.mkdir()
        env = dict(os.environ, PYTHONPATH=str(hidden), PYTHONNOUSERSITE="1", PYTHONSAFEPATH="1")
        result = run("-S", str(TOOL), "--fonts", str(self.fonts), "--out", str(self.out), "--css", str(self.css), env=env)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn("pip install -r design/tools/requirements.txt", result.stderr)

    def test_a_converter_upgrade_changes_every_fingerprint(self):
        source = REPO / "design/fonts/Exo[wght].ttf"
        pins = webfonts.converter_pins()
        self.assertIn("brotli==", pins)
        self.assertIn("fonttools==", pins)
        self.assertNotEqual(webfonts.fingerprint(source, pins), webfonts.fingerprint(source, pins.replace("brotli==", "brotli==9")))

    @needs_font_tools
    def test_the_same_inputs_give_the_same_bytes(self):
        for p in self.out.iterdir():
            p.unlink()
        self.assertEqual(self.build().returncode, 0)
        # Digests, not bytes: a failure then prints two short lines instead of diffing 100 KB of font data.
        first = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.out.iterdir()}
        for p in self.out.iterdir():
            p.unlink()
        self.assertEqual(self.build().returncode, 0)
        self.assertEqual({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.out.iterdir()}, first)

    @needs_font_tools
    def test_a_changed_font_gets_a_new_name_and_the_old_file_goes(self):
        old = {p.name for p in self.out.glob("exo.*.woff2")}
        # Exo 2's outlines under Exo's file name: a real, different font, so the fingerprint and the output change.
        shutil.copyfile(self.fonts / "Exo2[wght].ttf", self.fonts / "Exo[wght].ttf")
        result = self.build()
        self.assertEqual(result.returncode, 0, result.stderr)
        new = {p.name for p in self.out.glob("exo.*.woff2")}
        self.assertEqual(len(new), 1)
        self.assertFalse(new & old, "the old Exo file must be removed")
        self.assertIn(f"/static/fonts/{new.pop()}", self.css.read_text(encoding="utf-8"))
        self.assertEqual([p for p in self.out.iterdir() if p.name.endswith(".tmp")], [])


if __name__ == "__main__":
    unittest.main()
