"""README.md branding: the banner is a sound 1280x640 PNG, the <picture> shows the right logo in each colour scheme, and the live social preview is the banner.

The local checks use the standard library only, like the rest of tests/scripts. The LIVE_CHECKS test compares pixels and needs Pillow (pip install -r design/tools/requirements.txt).
The README and its images arrive in pull requests, so every read and every inflate is bounded and every path stays inside the repository."""
import ast
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
import zlib

REPO = pathlib.Path(__file__).resolve().parents[2]
BANNER = "design/brand/web/github-banner.png"
LIGHT = "design/brand/logo-svg/isitlegit-logo.svg"
DARK = "design/brand/logo-svg/isitlegit-logo-on-dark.svg"
SVG = "{http://www.w3.org/2000/svg}"
MAX_PNG, MAX_TEXT, MAX_RAW = 16 << 20, 1 << 20, 64 << 20

# PNG colour type: (channels, allowed bit depths), from the PNG specification, section 11.2.2.
COLOUR = {0: (1, {1, 2, 4, 8, 16}), 2: (3, {8, 16}), 3: (1, {1, 2, 4, 8}), 4: (2, {8, 16}), 6: (4, {8, 16})}
# Adam7 passes: (first column, column step, first row, row step).
ADAM7 = ((0, 8, 0, 8), (4, 8, 0, 8), (0, 4, 4, 8), (2, 4, 0, 4), (0, 2, 2, 4), (1, 2, 0, 2), (0, 1, 1, 2))


def brand_colours():
    """INK, WHITE and ORANGE as design/tools/build-brand.py, which draws the logos, defines them."""
    tree = ast.parse((REPO / "design/tools/build-brand.py").read_text(encoding="utf-8"))
    found = {t.id: n.value.value for n in tree.body if isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant)
             for t in n.targets if isinstance(t, ast.Name)}
    return found["INK"].upper(), found["WHITE"].upper(), found["ORANGE"].upper()


def read_capped(path, cap):
    with open(path, "rb") as f:
        data = f.read(cap + 1)
    if len(data) > cap:
        raise ValueError(f"is over {cap} bytes")
    return data


def passes(w, h, interlace):
    """(columns, rows) of each non-empty pass the image data holds."""
    if not interlace:
        return [(w, h)]
    dims = [(-(-(w - c0) // cs), -(-(h - r0) // rs)) for c0, cs, r0, rs in ADAM7]
    return [(c, r) for c, r in dims if c > 0 and r > 0]


def png_size(data):
    """(width, height) of a structurally sound PNG: IHDR first and legal, every chunk CRC holding, PLTE where a palette needs it,
    nothing after IEND, and image data inflating to exactly its filtered rows with a known filter on each. ValueError otherwise.
    It does not unfilter the pixels: a filtered row of any byte values is a legal image."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("no PNG signature")
    pos, kinds, idat, ihdr = 8, [], [], None
    while True:
        if pos + 12 > len(data):
            raise ValueError(f"chunk header cut at byte {pos}")
        n = int.from_bytes(data[pos:pos + 4], "big")
        kind, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + n]
        if pos + 12 + n > len(data):
            raise ValueError(f"{kind!r} chunk cut short")
        if zlib.crc32(kind + body) != int.from_bytes(data[pos + 8 + n:pos + 12 + n], "big"):
            raise ValueError(f"{kind!r} chunk fails its CRC")
        kinds.append(kind)
        if kind == b"IHDR":
            ihdr = body
        elif kind == b"IDAT":
            idat.append(body)
        pos += 12 + n
        if kind == b"IEND":
            break
    if pos != len(data):
        raise ValueError(f"{len(data) - pos} bytes after IEND")
    if kinds[0] != b"IHDR" or kinds.count(b"IHDR") != 1 or len(ihdr) != 13:
        raise ValueError("IHDR is not the first chunk, is repeated or is not 13 bytes")
    w, h = int.from_bytes(ihdr[:4], "big"), int.from_bytes(ihdr[4:8], "big")
    depth, colour, method, filtering, interlace = ihdr[8:13]
    if colour not in COLOUR or depth not in COLOUR[colour][1] or method or filtering or interlace > 1 or not w or not h:
        raise ValueError(f"illegal IHDR: {w}x{h}, depth {depth}, colour {colour}, methods {method}/{filtering}, interlace {interlace}")
    if colour == 3 and b"PLTE" not in kinds:
        raise ValueError("a palette image has no PLTE")
    rows = [(r, (c * COLOUR[colour][0] * depth + 7) // 8) for c, r in passes(w, h, interlace)]
    expected = sum(r * (b + 1) for r, b in rows)
    if expected > MAX_RAW:
        raise ValueError(f"{w}x{h} needs {expected} bytes of image data, over {MAX_RAW}")
    d = zlib.decompressobj()
    raw = d.decompress(b"".join(idat), expected + 1)
    if len(raw) != expected or not d.eof:
        raise ValueError(f"image data inflates to {'more than ' if len(raw) > expected or not d.eof else ''}{len(raw)} bytes, {expected} expected")
    at = 0
    for r, b in rows:
        for _ in range(r):
            if raw[at] > 4:
                raise ValueError(f"a row has the unknown filter {raw[at]}")
            at += b + 1
    return w, h


class Picture(html.parser.HTMLParser):
    """The first <picture>: the <source> elements before its <img>, in order, and the <img>."""

    def __init__(self):
        super().__init__()
        self.inside, self.done, self.sources, self.img = False, False, [], None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "picture" and not self.done:
            self.inside = True
        elif self.inside and tag == "source" and self.img is None:
            self.sources.append(((a.get("media") or "").replace(" ", "").lower(), a.get("srcset")))
        elif self.inside and tag == "img" and self.img is None:
            self.img = a

    def handle_endtag(self, tag):
        if tag == "picture" and self.inside:
            self.inside, self.done = False, True

    def shows(self, scheme):
        """What a browser shows in this colour scheme: the first matching <source>, else the <img>."""
        for media, srcset in self.sources:
            if media in ("", f"(prefers-color-scheme:{scheme})"):
                return srcset
        return (self.img or {}).get("src")


def paints(svg):
    return {v.upper() for e in svg.iter() for k in ("fill", "stroke") if (v := e.get(k)) and v != "none"}


def brand_errors(root):
    """Every reason the README branding under root is wrong; empty when it is right."""
    errors = []
    try:
        size = png_size(read_capped(root / BANNER, MAX_PNG))
        if size != (1280, 640):
            errors.append(f"banner is {size[0]}x{size[1]}, not 1280x640")
    except (OSError, ValueError, zlib.error) as e:
        errors.append(f"banner does not decode: {e}")
    p = Picture()
    try:
        p.feed(read_capped(root / "README.md", MAX_TEXT).decode("utf-8"))
    except (OSError, ValueError) as e:
        return errors + [f"README.md does not read: {e}"]
    for media, _ in p.sources:
        if media not in ("", "(prefers-color-scheme:dark)", "(prefers-color-scheme:light)"):
            errors.append(f"README <source> media {media} is not a colour scheme")
    for scheme, path in (("dark", DARK), ("light", LIGHT)):
        if p.shows(scheme) != path:
            errors.append(f"README shows {p.shows(scheme)} in the {scheme} scheme, not {path}")
    if not p.img or p.img.get("src") != LIGHT or p.img.get("alt") != "IsItLegit":
        errors.append(f"README <img> fallback is {p.img}, not {LIGHT} with alt IsItLegit")
    ink, white, orange = brand_colours()
    want = {LIGHT: {ink, orange}, DARK: {white, orange}}
    base = root.resolve()
    for path in sorted({s for _, s in p.sources} | {(p.img or {}).get("src")} - {None}):
        target = (root / path).resolve()
        if pathlib.PurePosixPath(path).is_absolute() or not target.is_relative_to(base):
            errors.append(f"README names {path}, which is outside the repository")
            continue
        try:
            svg = ET.fromstring(read_capped(target, MAX_TEXT))
        except (OSError, ValueError, ET.ParseError) as e:
            errors.append(f"{path} does not parse: {e}")
            continue
        if svg.tag != f"{SVG}svg":
            errors.append(f"{path} root is {svg.tag}, not an SVG-namespace <svg>")
        if path in want and paints(svg) != want[path]:
            errors.append(f"{path} paints {sorted(paints(svg))}, not {sorted(want[path])}")
    return errors


class Repository(unittest.TestCase):
    def test_the_branding_is_right(self):
        self.assertEqual(brand_errors(REPO), [])


def chunk(kind, body):
    return len(body).to_bytes(4, "big") + kind + body + zlib.crc32(kind + body).to_bytes(4, "big")


def png(w, h, raw, colour=2, interlace=0, ihdr=None):
    head = ihdr if ihdr is not None else w.to_bytes(4, "big") + h.to_bytes(4, "big") + bytes([8, colour, 0, 0, interlace])
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


class PngChecks(unittest.TestCase):
    def test_an_interlaced_banner_is_accepted(self):
        # 2,458,800 bytes: the seven Adam7 passes of 1280x640 RGB8, counted by hand from the specification's pass table.
        self.assertEqual(png_size(png(1280, 640, bytes(2458800), interlace=1)), (1280, 640))

    def test_a_zlib_bomb_stops_at_the_expected_size(self):
        with self.assertRaisesRegex(ValueError, "inflates to more than"):
            png_size(png(1280, 640, bytes(40 << 20)))

    def test_a_short_ihdr_is_refused_not_raised(self):
        with self.assertRaisesRegex(ValueError, "not 13 bytes"):
            png_size(png(0, 0, b"", ihdr=b"\0\0\x05\0\0\0\x02\x80"))

    def test_an_illegal_depth_a_missing_palette_and_trailing_bytes_are_refused(self):
        with self.assertRaisesRegex(ValueError, "illegal IHDR"):
            png_size(png(1, 1, bytes(2), ihdr=(1).to_bytes(4, "big") * 2 + bytes([4, 2, 0, 0, 0])))
        with self.assertRaisesRegex(ValueError, "no PLTE"):
            png_size(png(1, 1, bytes(2), colour=3))
        with self.assertRaisesRegex(ValueError, "after IEND"):
            png_size(png(1, 1, bytes(4)) + b"x")

    def test_an_unknown_row_filter_is_refused(self):
        with self.assertRaisesRegex(ValueError, "unknown filter 9"):
            png_size(png(1, 1, bytes([9, 0, 0, 0])))


class Defects(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        for rel in ("README.md", BANNER, LIGHT, DARK):
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(REPO / rel, self.root / rel)

    def tearDown(self):
        self.tmp.cleanup()

    def readme(self, old, new):
        r = self.root / "README.md"
        text = r.read_text(encoding="utf-8")
        self.assertIn(old, text)
        r.write_text(text.replace(old, new, 1), encoding="utf-8")

    def test_a_banner_cut_after_its_header_is_caught(self):
        b = self.root / BANNER
        b.write_bytes(b.read_bytes()[:200])
        self.assertTrue(any(e.startswith("banner does not decode") for e in brand_errors(self.root)), brand_errors(self.root))

    def test_a_banner_with_a_corrupt_pixel_byte_is_caught(self):
        b = self.root / BANNER
        data = bytearray(b.read_bytes())
        data[data.index(b"IDAT") + 40] ^= 0xFF
        b.write_bytes(bytes(data))
        self.assertTrue(any(e.startswith("banner does not decode") for e in brand_errors(self.root)), brand_errors(self.root))

    def test_swapped_theme_sources_are_caught(self):
        self.readme("(prefers-color-scheme: dark)", "(prefers-color-scheme: tmp)")
        self.readme("(prefers-color-scheme: light)", "(prefers-color-scheme: dark)")
        self.readme("(prefers-color-scheme: tmp)", "(prefers-color-scheme: light)")
        self.assertIn(f"README shows {LIGHT} in the dark scheme, not {DARK}", brand_errors(self.root))

    def test_an_img_before_its_sources_is_caught(self):
        r = self.root / "README.md"
        text = r.read_text(encoding="utf-8")
        img = text[text.index("  <img alt"):text.index("\n", text.index("  <img alt")) + 1]
        r.write_text(text.replace(img, "").replace("<picture>\n", "<picture>\n" + img, 1), encoding="utf-8")
        self.assertIn(f"README shows {LIGHT} in the dark scheme, not {DARK}", brand_errors(self.root))

    def test_an_earlier_dark_source_wins_as_a_browser_picks_it(self):
        self.readme("<picture>\n", f'<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="{LIGHT}">\n')
        self.assertIn(f"README shows {LIGHT} in the dark scheme, not {DARK}", brand_errors(self.root))

    def test_swapped_logo_files_are_caught(self):
        light, dark = (self.root / LIGHT).read_bytes(), (self.root / DARK).read_bytes()
        (self.root / LIGHT).write_bytes(dark)
        (self.root / DARK).write_bytes(light)
        self.assertTrue(any(e.startswith(f"{DARK} paints") for e in brand_errors(self.root)), brand_errors(self.root))

    def test_a_logo_without_the_svg_namespace_is_caught(self):
        d = self.root / DARK
        d.write_text(d.read_text(encoding="utf-8").replace(' xmlns="http://www.w3.org/2000/svg"', "", 1), encoding="utf-8")
        self.assertIn(f"{DARK} root is svg, not an SVG-namespace <svg>", brand_errors(self.root))

    def test_a_path_outside_the_repository_is_refused_unread(self):
        self.readme(f'srcset="{DARK}"', 'srcset="/dev/zero"')
        self.readme(f'srcset="{LIGHT}"', 'srcset="../../../../etc/passwd"')
        errors = brand_errors(self.root)
        self.assertIn("README names /dev/zero, which is outside the repository", errors)
        self.assertIn("README names ../../../../etc/passwd, which is outside the repository", errors)

    def test_a_missing_or_undecodable_readme_is_reported_not_raised(self):
        (self.root / "README.md").write_bytes(b"<picture>\xff\xfe</picture>")
        self.assertTrue(any(e.startswith("README.md does not read") for e in brand_errors(self.root)))
        (self.root / "README.md").unlink()
        self.assertTrue(any(e.startswith("README.md does not read") for e in brand_errors(self.root)))

    def test_a_missing_logo_is_caught(self):
        (self.root / DARK).unlink()
        self.assertTrue(any(e.startswith(f"{DARK} does not parse") for e in brand_errors(self.root)))


@unittest.skipUnless(os.environ.get("LIVE_CHECKS") == "1", "set LIVE_CHECKS=1 to read the live social preview from GitHub")
class LiveSocialPreview(unittest.TestCase):
    def test_the_served_social_image_is_the_banner(self):
        from PIL import Image, ImageChops
        name = subprocess.run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd=REPO,
                              capture_output=True, text=True, timeout=60, check=True).stdout.strip()
        owner, repo = name.split("/")
        q = f'{{repository(owner:"{owner}",name:"{repo}"){{usesCustomOpenGraphImage openGraphImageUrl}}}}'
        out = subprocess.run(["gh", "api", "graphql", "-f", f"query={q}"], capture_output=True, text=True, timeout=60, check=True)
        found = json.loads(out.stdout)["data"]["repository"]
        self.assertTrue(found["usesCustomOpenGraphImage"])
        with urllib.request.urlopen(found["openGraphImageUrl"], timeout=60) as r:
            data = r.read(MAX_PNG + 1)
        self.assertLessEqual(len(data), MAX_PNG)
        served = Image.open(io.BytesIO(data))
        with Image.open(REPO / BANNER) as im:
            banner = im.convert("RGB")
        self.assertEqual(served.size, banner.size)
        # Re-encoding noise stays within a few levels; a different banner differs by far more somewhere.
        worst = max(hi for _, hi in ImageChops.difference(served.convert("RGB"), banner).getextrema())
        self.assertLessEqual(worst, 8, f"{name}'s social preview differs from the banner by up to {worst} levels")


if __name__ == "__main__":
    unittest.main()
