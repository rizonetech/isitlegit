#!/usr/bin/env python3
"""Build the IsItLegit brand files in design/brand/ from the approved design.

    python3 design/tools/build-brand.py        (needs design/tools/requirements.txt and rsvg-convert)

The operator approved the brand on 2026-10-26: direction A (a question mark whose dot is an orange tick, wordmark
"IsIt" in ink and "Legit" in orange, Exo 800) drawn in the A3 "engineered" construction chosen at 21:46 SAST (one
constant-width stroke at Exo 800's stem weight, flat cuts, mitred corners, a squared tick), direction C's round seal
reading PROTECTED as the badge, C's app icon and favicons with the same squared tick, and "the dot becomes the answer"
motion frames. Every piece of text is converted to outlines from the
vendored Exo fonts (design/fonts/, SIL OFL 1.1), shaped with HarfBuzz so kerning matches the font, so the files render
the same everywhere without the fonts installed. PNGs and favicon.ico are rendered from the SVGs with rsvg-convert.
Every file is written to a temporary file and then moved into place.
"""
import io
import math
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
FONTS = ROOT / "design/fonts"
OUT = ROOT / "design/brand"

INK = "#181519"
ORANGE = "#FF4A14"
ORANGE_TEXT = "#CC2E00"
LIGHT = "#F1F1F2"
WHITE = "#FFFFFF"
SAFE = "#0E7C5B"
SUSPICIOUS = "#B26A00"
MALICIOUS = "#C8102E"
# design/tokens/colors.json `muted` (light): the Not verified badge is grey, never red (D05 T02 §7, board Badges).
MUTED = "#4D4953"

# The mark on a 200 by 200 grid, A3 construction. Exo 800's stem is 0.173 em, so at the logo size (72 px text, mark
# at half scale) a 24-unit stroke matches the letters. The hook's centreline is a 34-unit circle round (100, 68) from
# its leftmost point clockwise to 45 degrees below horizontal, then a 45-degree neck into a vertical stem; outer and
# inner radii are 46 and 22, all ends cut flat. The tick's corner sits on the stem's axis (x 100) like the dot of a
# question mark, clear of the stem (moved up and right at the operator's request, 21:53 SAST). Ink spans x 54 to 147
# and y 22 to 187.
STROKE = 24
HOOK = "M66 68A34 34 0 1 1 124.04 92.04L100 116.08V130"
TICK = "M82 152L100 170L138 132"
FLAT = 'stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="4"'


class Face:
    """One weight of a vendored variable font: HarfBuzz for shaping, fontTools for outlines."""

    def __init__(self, file, weight):
        instance = instantiateVariableFont(TTFont(FONTS / file), {"wght": weight})
        buffer = io.BytesIO()
        instance.save(buffer)
        data = buffer.getvalue()
        self.tt = TTFont(io.BytesIO(data))
        self.glyphs = self.tt.getGlyphSet()
        self.order = self.tt.getGlyphOrder()
        self.upm = self.tt["head"].unitsPerEm
        self.hb_font = hb.Font(hb.Face(data))

    def shape(self, text):
        buffer = hb.Buffer()
        buffer.add_str(text)
        buffer.guess_segment_properties()
        hb.shape(self.hb_font, buffer, {"kern": True, "liga": False})
        return [(self.order[info.codepoint], pos.x_advance, pos.x_offset, pos.y_offset)
                for info, pos in zip(buffer.glyph_infos, buffer.glyph_positions)]

    def width(self, text, size, tracking=0.0):
        shaped = self.shape(text)
        return sum(adv for _, adv, _, _ in shaped) * size / self.upm + tracking * (len(shaped) - 1)

    def outline(self, name, scale, x, y):
        pen = SVGPathPen(self.glyphs)
        self.glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, y)))
        return pen.getCommands()

    def runs(self, parts, x, y, size, tracking=0.0, anchor="start"):
        """SVG paths for consecutive coloured runs of one line, shaped as a whole so kerning crosses the runs."""
        text = "".join(part for part, _ in parts)
        shaped = self.shape(text)
        if len(shaped) != len(text):
            raise ValueError(f"text did not shape one glyph per character: {text!r}")
        scale = size / self.upm
        total = self.width(text, size, tracking)
        x -= {"start": 0, "middle": total / 2, "end": total}[anchor]
        out, index = [], 0
        for part, colour in parts:
            commands = []
            for name, adv, x_off, y_off in shaped[index:index + len(part)]:
                commands.append(self.outline(name, scale, x + x_off * scale, y - y_off * scale))
                x += adv * scale + tracking
            index += len(part)
            out.append(f'<path fill="{colour}" d="{" ".join(c for c in commands if c)}"/>')
        return "".join(out)

    def on_circle(self, text, cx, cy, radius, size, colour, start_deg=-90.0):
        """Text set clockwise round a circle, letter spacing stretched so the string closes the circle exactly."""
        shaped = self.shape(text)
        scale = size / self.upm
        advances = [adv * scale for _, adv, _, _ in shaped]
        circumference = 2 * math.pi * radius
        extra = (circumference - sum(advances)) / len(advances)
        if extra < 0:
            raise ValueError(f"{text!r} is too long for a circle of radius {radius} at size {size}")
        out, travelled = [], 0.0
        for (name, _, _, _), adv in zip(shaped, advances):
            centre = travelled + adv / 2
            angle = start_deg + math.degrees(centre / radius) + 90
            commands = self.outline(name, scale, -adv / 2, -radius)
            if commands:
                out.append(f'<path fill="{colour}" transform="translate({cx:.2f} {cy:.2f}) rotate({angle:.3f})" '
                           f'd="{commands}"/>')
            travelled += adv + extra
        return "".join(out)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, suffix=path.suffix)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    os.replace(temporary, path)


def svg(width, height, title, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" '
            f'viewBox="0 0 {width:.2f} {height:.2f}" role="img"><title>{title}</title>{body}</svg>\n')


def mark(hook, tick, transform=""):
    group = f'<g transform="{transform}">' if transform else "<g>"
    return (f'{group}<path d="{HOOK}" fill="none" stroke="{hook}" stroke-width="{STROKE}" {FLAT}/>'
            f'<path d="{TICK}" fill="none" stroke="{tick}" stroke-width="{STROKE}" {FLAT}/></g>')


def wordmark(exo, ink):
    """Mark plus IsIt (ink) and Legit (orange) at 72 px, on a canvas 100 px tall. The mark's ink spans x 54 to 146
    of its 200 grid, so it is shifted left to sit flush and the text starts one stroke-width after it."""
    size, height, scale, gap = 72, 100, 0.5, 16
    text_x = (146 - 54) * scale + gap
    width = text_x + exo.width("IsItLegit", size) + 2
    body = mark(ink, ORANGE, f"translate({-54 * scale} 0) scale({scale})")
    body += exo.runs([("IsIt", ink), ("Legit", ORANGE)], text_x, 75, size)
    return width, height, body


def seal(exo, centre_fill, tick_colour):
    """Direction C: orange disc, rim text PROTECTED, a tick at the centre."""
    body = f'<circle cx="100" cy="100" r="92" fill="{ORANGE}"/><circle cx="100" cy="100" r="54" fill="{centre_fill}"/>'
    body += exo.on_circle("IS IT LEGIT · PROTECTED · ", 100, 100, 66, 20, WHITE)
    body += (f'<path d="M77 100l16 16 32-34" fill="none" stroke="{tick_colour}" stroke-width="14" {FLAT}/>')
    return body


def app_icon(rounded=True):
    """Direction C's app icon: orange tile, white disc, ink tick (full bleed when not rounded, for maskable use)."""
    tile = f'<rect width="180" height="180" rx="{40 if rounded else 0}" fill="{ORANGE}"/>'
    return (tile + f'<circle cx="90" cy="90" r="{56 if rounded else 50}" fill="{WHITE}"/>'
            f'<path d="{"M64 90l18 18 34-36" if rounded else "M68 90l16 16 30-32"}" fill="none" stroke="{INK}" '
            f'stroke-width="{16 if rounded else 14}" {FLAT}/>')


def favicon(small=False):
    """Direction C's favicon on a 32 grid; at 16 px the white disc goes and the tick turns white."""
    if small:
        return (f'<circle cx="16" cy="16" r="16" fill="{ORANGE}"/><path d="M8.5 16l4.5 4.5 9.5-10" fill="none" '
                f'stroke="{WHITE}" stroke-width="4.4" {FLAT}/>')
    return (f'<circle cx="16" cy="16" r="16" fill="{ORANGE}"/><circle cx="16" cy="16" r="9.5" fill="{WHITE}"/>'
            f'<path d="M11.6 16l3 3 5.8-6.2" fill="none" stroke="{INK}" stroke-width="2.8" {FLAT}/>')


def badge(exo):
    """The pill badge for email signatures and websites: mini seal plus PROTECTED BY IS IT LEGIT."""
    size, tracking = 16, 1.3
    text_width = exo.width("PROTECTED BY IS IT LEGIT", size, tracking)
    width, height = 10 + 36 + 10 + text_width + 18, 56
    body = (f'<rect x="1" y="1" width="{width - 2:.2f}" height="{height - 2}" rx="27" fill="{WHITE}" '
            f'stroke="{INK}" stroke-width="2"/>')
    body += f'<g transform="translate(10 10) scale({36 / 32})">{favicon()}</g>'
    body += exo.runs([("PROTECTED BY IS IT LEGIT", INK)], 56, 34, size, tracking)
    return width, height, body


def badge_not_verified(exo, exo_bold, exo2, canvas_width):
    """The Not verified badge (D05 T02 §7, board Badges): the same pill in muted grey, a question mark where the seal
    sits, NOT VERIFIED with "by IsItLegit" beneath; grey, never red, since a lapsed business is not accused."""
    title, byline = 16, 11
    text_width = max(exo_bold.width("NOT VERIFIED", title, 1.3), exo2.width("by IsItLegit", byline))
    width, height = 10 + 36 + 10 + text_width + 18, 56
    body = (f'<rect x="1" y="1" width="{width - 2:.2f}" height="{height - 2}" rx="27" fill="{WHITE}" '
            f'stroke="{MUTED}" stroke-width="2"/>')
    body += exo.runs([("?", MUTED)], 28, 41, 34, anchor="middle")
    # Drawn on the Protected badge's canvas, the space to the right left clear, so a signature's fixed width and height
    # fit whichever variant the live badge serves without stretching it.
    width = max(width, canvas_width)
    body += exo_bold.runs([("NOT VERIFIED", MUTED)], 56, 29, title, 1.3)
    body += exo2.runs([("by IsItLegit", MUTED)], 56, 44, byline)
    return width, height, body


def github_banner(exo, exo2):
    body = f'<rect width="1280" height="640" fill="{LIGHT}"/><rect y="600" width="1280" height="40" fill="{ORANGE}"/>'
    body += mark(INK, ORANGE, "translate(120 190) scale(0.9)")
    body += exo.runs([("IsIt", INK), ("Legit", ORANGE)], 278, 330, 120)
    body += exo2[500].runs([("Forward a suspicious email. Get a verdict with the evidence.", INK)], 282, 400, 32)
    body += exo2[600].runs([("isitlegit.co.za · by Rizonetech", ORANGE_TEXT)], 282, 460, 24)
    return body


def social_card(exo, exo2):
    body = f'<rect width="1200" height="630" fill="{INK}"/>'
    body += exo.runs([("Is it legit?", WHITE)], 90, 250, 84)
    body += exo.runs([("Ask before you pay.", ORANGE)], 90, 350, 84)
    body += exo2[500].runs([("Phishing, invoice-fraud and impersonation checks for small businesses.", LIGHT)],
                           94, 430, 30)
    body += mark(WHITE, ORANGE, "translate(90 480) scale(0.42)")
    body += exo.runs([("IsIt", WHITE), ("Legit", ORANGE)], 180, 548, 40)
    body += exo2[600].runs([("isitlegit.co.za", LIGHT)], 1110, 548, 26, anchor="end")
    return body


def motion_frames():
    """The dot becomes the answer: the question's square dot pulses while checking, then turns into the verdict glyph
    (a tick for safe, a bar for suspicious, a cross for malicious), drawn with the mark's flat, squared strokes."""
    hook = f'<path d="{HOOK}" fill="none" stroke="{INK}" stroke-width="{STROKE}" {FLAT}/>'
    dot = f'x="88" y="142" width="{STROKE}" height="{STROKE}"'
    frames = {
        "question": f'<rect {dot} fill="{INK}"/>',
        "checking": (f'<rect x="80" y="134" width="40" height="40" fill="{ORANGE}" fill-opacity="0.18"/>'
                     f'<rect {dot} fill="{ORANGE}"/>'),
        "deciding": f'<path d="M84 154H116" stroke="{ORANGE}" stroke-width="{STROKE}" {FLAT}/>',
        "safe": f'<path d="{TICK}" fill="none" stroke="{SAFE}" stroke-width="{STROKE}" {FLAT}/>',
        "suspicious": f'<path d="M72 154H128" stroke="{SUSPICIOUS}" stroke-width="{STROKE}" {FLAT}/>',
        "malicious": (f'<path d="M86 145L114 173M114 145L86 173" fill="none" stroke="{MALICIOUS}" '
                      f'stroke-width="{STROKE - 2}" {FLAT}/>'),
    }
    titles = {"question": "Received", "checking": "Checking", "deciding": "Deciding", "safe": "Safe",
              "suspicious": "Suspicious", "malicious": "Malicious"}
    files = {f"motion/{name}.svg": svg(200, 200, f"IsItLegit verdict: {titles[name]}", hook + glyph)
             for name, glyph in frames.items()}
    files["motion/checking-animated.svg"] = svg(200, 200, "IsItLegit is checking", (
        '<style>@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.25);opacity:.75}}'
        '.dot{transform-origin:100px 154px;animation:pulse 1.2s ease-in-out infinite}'
        '@media (prefers-reduced-motion:reduce){.dot{animation:none}}</style>'
        + hook + f'<rect class="dot" {dot} fill="{ORANGE}"/>'))
    return files


def render(svg_path, png_path, width, height):
    subprocess.run(["rsvg-convert", "-w", str(width), "-h", str(height), "-o", str(png_path), str(svg_path)],
                   check=True)


def main():
    if shutil.which("rsvg-convert") is None:
        print("build-brand: rsvg-convert is needed to render PNGs (apt install librsvg2-bin)", file=sys.stderr)
        return 2
    exo = Face("Exo[wght].ttf", 800)
    exo_bold = Face("Exo[wght].ttf", 700)
    exo2 = {500: Face("Exo2[wght].ttf", 500), 600: Face("Exo2[wght].ttf", 600)}
    files = {
        "logo-svg/isitlegit-mark.svg": svg(200, 200, "IsItLegit mark", mark(INK, ORANGE)),
        "logo-svg/isitlegit-mark-on-dark.svg": svg(200, 200, "IsItLegit mark on dark", mark(WHITE, ORANGE)),
        "logo-svg/isitlegit-seal-protected.svg": svg(200, 200, "Protected by IsItLegit seal", seal(exo, WHITE, INK)),
        "logo-svg/isitlegit-seal-protected-on-dark.svg": svg(200, 200, "Protected by IsItLegit seal on dark",
                                                             seal(exo, INK, WHITE)),
        "web/app-icon.svg": svg(180, 180, "IsItLegit app icon", app_icon()),
        "web/app-icon-maskable.svg": svg(180, 180, "IsItLegit app icon, maskable", app_icon(rounded=False)),
        "web/favicon.svg": svg(32, 32, "IsItLegit", favicon()),
        "web/favicon-small.svg": svg(32, 32, "IsItLegit", favicon(small=True)),
        "web/github-banner.svg": svg(1280, 640, "IsItLegit", github_banner(exo, exo2)),
        "web/social-card.svg": svg(1200, 630, "IsItLegit: is it legit? Ask before you pay.", social_card(exo, exo2)),
    }
    for name, ink in (("logo-svg/isitlegit-logo.svg", INK), ("logo-svg/isitlegit-logo-on-dark.svg", WHITE)):
        width, height, body = wordmark(exo, ink)
        files[name] = svg(width, height, "IsItLegit", body)
    width, height, body = badge(exo_bold)
    files["logo-svg/isitlegit-badge-protected.svg"] = svg(width, height, "Protected by IsItLegit", body)
    width, height, body = badge_not_verified(exo, exo_bold, exo2[500], badge(exo_bold)[0])
    files["logo-svg/isitlegit-badge-not-verified.svg"] = svg(width, height, "Not verified by IsItLegit", body)
    files.update(motion_frames())
    for name, text in files.items():
        write(OUT / name, text)

    # Beside the output, so each finished file is renamed into place on the same filesystem (a system temp folder can
    # be another one, where os.replace fails).
    with tempfile.TemporaryDirectory(dir=OUT, prefix=".build-") as scratch:
        scratch = pathlib.Path(scratch)
        renders = [("web/favicon-small.svg", "web/favicon-16.png", 16, 16),
                   ("web/favicon.svg", "web/favicon-32.png", 32, 32),
                   ("web/favicon.svg", "web/favicon-48.png", 48, 48),
                   ("web/app-icon.svg", "web/apple-touch-icon.png", 180, 180),
                   ("web/app-icon.svg", "web/icon-192.png", 192, 192),
                   ("web/app-icon.svg", "web/icon-512.png", 512, 512),
                   ("web/app-icon-maskable.svg", "web/icon-maskable-512.png", 512, 512),
                   ("web/github-banner.svg", "web/github-banner.png", 1280, 640),
                   ("web/social-card.svg", "web/social-card.png", 1200, 630)]
        for name in ("isitlegit-mark", "isitlegit-mark-on-dark", "isitlegit-seal-protected",
                     "isitlegit-seal-protected-on-dark"):
            for px in (256, 512, 1024):
                renders.append((f"logo-svg/{name}.svg", f"logo-png/{name}-{px}.png", px, px))
        # The live badge's served image (D05 T02 §7): 104 px tall, twice the larger of T3's two heights, so it stays sharp
        # at 52 px and 36 px alike.
        for name in ("isitlegit-badge-protected", "isitlegit-badge-not-verified"):
            source = files[f"logo-svg/{name}.svg"]
            w, h = (float(v) for v in source.split('viewBox="0 0 ', 1)[1].split('"', 1)[0].split())
            renders.append((f"logo-svg/{name}.svg", f"logo-png/{name}-104h.png", round(104 * w / h), 104))
        for name in ("isitlegit-logo", "isitlegit-logo-on-dark", "isitlegit-badge-protected", "isitlegit-badge-not-verified"):
            source = files[f"logo-svg/{name}.svg"]
            w, h = (float(v) for v in source.split('viewBox="0 0 ', 1)[1].split('"', 1)[0].split())
            for px in (480, 960, 1920):
                renders.append((f"logo-svg/{name}.svg", f"logo-png/{name}-{px}w.png", px, round(px * h / w)))
        # The reply email's images (D07 T03 §7): Gmail and Outlook do not show SVG, so the email names PNGs, drawn at
        # twice the size the email shows them (the logo 32 px tall, the verdict art 40 px) for sharp screens.
        logo_w, logo_h = (float(v) for v in files["logo-svg/isitlegit-logo.svg"].split('viewBox="0 0 ', 1)[1].split('"', 1)[0].split())
        renders.append(("logo-svg/isitlegit-logo.svg", "email/logo.png", round(64 * logo_w / logo_h), 64))
        for name in ("malicious", "suspicious", "safe", "question"):
            renders.append((f"motion/{name}.svg", f"email/{name}.png", 80, 80))
        for source, target, w, h in renders:
            (scratch / target).parent.mkdir(parents=True, exist_ok=True)
            render(OUT / source, scratch / target, w, h)
            (OUT / target).parent.mkdir(parents=True, exist_ok=True)
            os.replace(scratch / target, OUT / target)
        sizes = [Image.open(OUT / f"web/favicon-{n}.png") for n in (16, 32, 48)]
        sizes[2].save(scratch / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
                      append_images=sizes[:2])
        os.replace(scratch / "favicon.ico", OUT / "web/favicon.ico")
    print(f"build-brand: wrote {len(files)} SVG files, {len(renders)} PNG files and favicon.ico to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
