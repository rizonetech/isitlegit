"""README.md branding: the banner decodes in full, the <picture> shows the right logo in each colour scheme, and the live social preview is the banner."""
import html.parser
import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
import urllib.request
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops, ImageStat

REPO = pathlib.Path(__file__).resolve().parents[2]
BANNER = "design/brand/web/github-banner.png"
LIGHT = "design/brand/logo-svg/isitlegit-logo.svg"
DARK = "design/brand/logo-svg/isitlegit-logo-on-dark.svg"


class Picture(html.parser.HTMLParser):
    """Collects the first <picture>: its <source> media to srcset, and its <img>."""

    def __init__(self):
        super().__init__()
        self.depth, self.done, self.sources, self.img = 0, False, {}, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "picture" and not self.done:
            self.depth += 1
        elif self.depth and tag == "source":
            self.sources[(a.get("media") or "").replace(" ", "")] = a.get("srcset")
        elif self.depth and tag == "img":
            self.img = a

    def handle_endtag(self, tag):
        if tag == "picture" and self.depth:
            self.depth, self.done = 0, True


def brand_errors(root):
    """Every reason the README branding under root is wrong; empty when it is right."""
    errors = []
    try:
        with Image.open(root / BANNER) as im:
            im.load()
            if im.size != (1280, 640):
                errors.append(f"banner is {im.size[0]}x{im.size[1]}, not 1280x640")
    except (OSError, SyntaxError) as e:
        errors.append(f"banner does not decode: {e}")
    p = Picture()
    p.feed((root / "README.md").read_text(encoding="utf-8"))
    want = {"(prefers-color-scheme:dark)": DARK, "(prefers-color-scheme:light)": LIGHT}
    for media, path in want.items():
        if p.sources.get(media) != path:
            errors.append(f"README {media} shows {p.sources.get(media)}, not {path}")
    if not p.img or p.img.get("src") != LIGHT or p.img.get("alt") != "IsItLegit":
        errors.append(f"README <img> fallback is {p.img}, not {LIGHT} with alt IsItLegit")
    for path in sorted({*p.sources.values(), (p.img or {}).get("src")} - {None}):
        try:
            if not ET.parse(root / path).getroot().tag.endswith("svg"):
                errors.append(f"{path} is not an SVG")
        except (OSError, ET.ParseError) as e:
            errors.append(f"{path} does not parse: {e}")
    return errors


class Repository(unittest.TestCase):
    def test_the_branding_is_right(self):
        self.assertEqual(brand_errors(REPO), [])


class Defects(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        for rel in ("README.md", BANNER, LIGHT, DARK):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(REPO / rel, self.root / rel)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_banner_cut_after_its_header_is_caught(self):
        b = self.root / BANNER
        b.write_bytes(b.read_bytes()[:200])
        self.assertTrue(any(e.startswith("banner does not decode") for e in brand_errors(self.root)), brand_errors(self.root))

    def test_swapped_theme_sources_are_caught(self):
        r = self.root / "README.md"
        text = r.read_text(encoding="utf-8")
        r.write_text(text.replace("(prefers-color-scheme: dark)", "(prefers-color-scheme: tmp)").replace(
            "(prefers-color-scheme: light)", "(prefers-color-scheme: dark)").replace("(prefers-color-scheme: tmp)", "(prefers-color-scheme: light)"), encoding="utf-8")
        self.assertIn(f"README (prefers-color-scheme:dark) shows {LIGHT}, not {DARK}", brand_errors(self.root))

    def test_a_missing_logo_is_caught(self):
        (self.root / DARK).unlink()
        self.assertTrue(any(e.startswith(f"{DARK} does not parse") for e in brand_errors(self.root)))


@unittest.skipUnless(os.environ.get("LIVE_CHECKS") == "1", "set LIVE_CHECKS=1 to read the live social preview from GitHub")
class LiveSocialPreview(unittest.TestCase):
    def test_the_served_social_image_is_the_banner(self):
        q = '{repository(owner:"rizonetech",name:"isitlegit"){usesCustomOpenGraphImage openGraphImageUrl}}'
        out = subprocess.run(["gh", "api", "graphql", "-f", f"query={q}"], capture_output=True, text=True, timeout=60, check=True)
        repo = json.loads(out.stdout)["data"]["repository"]
        self.assertTrue(repo["usesCustomOpenGraphImage"])
        with urllib.request.urlopen(repo["openGraphImageUrl"], timeout=60) as r:
            served = Image.open(io.BytesIO(r.read())).convert("RGB")
        with Image.open(REPO / BANNER) as im:
            banner = im.convert("RGB")
        self.assertEqual(served.size, banner.size)
        diff = ImageStat.Stat(ImageChops.difference(served, banner)).mean
        self.assertLess(max(diff), 4, f"mean channel difference {diff}")


if __name__ == "__main__":
    unittest.main()
