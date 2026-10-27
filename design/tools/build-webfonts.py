#!/usr/bin/env python3
"""Build the self-hosted web fonts for the app (D07 T01 §5).

    python3 design/tools/build-webfonts.py [--fonts <dir>] [--out <dir>] [--css <file>]

Converts the vendored variable fonts (design/fonts/, SIL OFL 1.1) to WOFF2 in public/static/fonts/, named
`<family>.<first 12 hex of the SHA-256 of the source TTF and the converter pins>.woff2`, and writes src/web/styles/fonts.css with their @font-face
rules, plus an "<family> Fallback" face over Arial (or the metric-compatible Liberation Sans or Arimo) scaled to the same
space, so running text keeps its layout when the web font swaps in (measured for mixed-case prose at desktop and
phone width; upper-case and tabular-figure roles are not matched separately). The fallback metrics are computed with fonttools when a font converts and kept in
design/fonts/fallback-metrics.json. The name follows the source font and the pinned fonttools and brotli, so a family whose current file already exists is skipped without importing
fonttools: `pnpm build:assets` runs this on every build, and only a changed source font needs
design/tools/requirements.txt (fonttools with brotli). Older font files stay until scripts/hash-asset.ts, the last
step of `pnpm build:assets`, has written src/web/assets.ts naming the new set, so a build that fails part way leaves the
previous set whole. Every file is written to a temporary file and then moved into place.
"""
import argparse
import hashlib
import json
import os
import pathlib
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parents[2]
# Source file, served name, CSS family (the families typography.json names), and the weight it is mostly set at, which
# the fallback is matched to: Exo sets the headings (700 to 900, mostly 800), Exo 2 the body text (400).
FAMILIES = (("Exo[wght].ttf", "exo", "Exo", 800), ("Exo2[wght].ttf", "exo2", "Exo 2", 400))
WEIGHTS = "100 900"  # the variable fonts' weight axis
# The fallback shown while a web font loads: Arial, or the metric-compatible Liberation Sans or Arimo, scaled and shifted
# so text takes the same space before and after the swap (no layout shift).
FALLBACK_SOURCES = 'local("Arial"), local("Liberation Sans"), local("Arimo")'
# Arial's advance widths (units per em 2048) for the space and a to z, and English letter frequencies (space included)
# to weight them: the average width a line of running text has.
ARIAL_UPM = 2048
ARIAL_WIDTHS = dict(zip(" abcdefghijklmnopqrstuvwxyz", (569, 1139, 1139, 1024, 1139, 1139, 569, 1139, 1139, 455, 455, 1024,
                                                         455, 1706, 1139, 1139, 1139, 1139, 682, 1024, 569, 1139, 1024, 1479,
                                                         1024, 1024, 1024)))
FREQUENCIES = dict(zip(" abcdefghijklmnopqrstuvwxyz", (0.18, 0.0670, 0.0122, 0.0228, 0.0349, 0.1042, 0.0183, 0.0166, 0.0499,
                                                       0.0572, 0.0012, 0.0063, 0.0330, 0.0198, 0.0553, 0.0616, 0.0158, 0.0008,
                                                       0.0491, 0.0519, 0.0743, 0.0226, 0.0080, 0.0194, 0.0012, 0.0162,
                                                       0.0006)))
OVERRIDES = ("size-adjust", "ascent-override", "descent-override", "line-gap-override")
METRICS = "fallback-metrics.json"  # beside the fonts, so an unchanged rebuild needs no fonttools


def converter_pins(requirements=REPO / "design/tools/requirements.txt"):
    """The pinned converter versions (`fonttools==`, `brotli==` lines): part of each fingerprint, so upgrading the
    converter renames, and so rebuilds, every font rather than shipping new bytes under a year-cached URL."""
    lines = requirements.read_text(encoding="utf-8").splitlines()
    return "\n".join(sorted(l.split("#")[0].strip() for l in lines if l.startswith(("fonttools==", "brotli=="))))


def fingerprint(path, pins=None):
    digest = hashlib.sha256(path.read_bytes())
    digest.update((converter_pins() if pins is None else pins).encode("utf-8"))
    return digest.hexdigest()[:12]


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, suffix=path.suffix + ".tmp")
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        os.chmod(temporary, 0o644)  # served and committed files, not mkstemp's private 0600
        os.replace(temporary, path)
    except BaseException:
        pathlib.Path(temporary).unlink(missing_ok=True)
        raise


def convert(source, target):
    """WOFF2 of `source` into `target`, through a temporary file (fonttools with brotli)."""
    from fontTools.ttLib import TTFont  # only when a font actually changed

    # recalcTimestamp=False keeps the source head.modified, so the same inputs give the same bytes.
    font = TTFont(source, recalcTimestamp=False)
    font.flavor = "woff2"
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=target.parent, suffix=".woff2.tmp")
    os.close(fd)
    try:
        font.save(temporary)
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
    except BaseException:
        pathlib.Path(temporary).unlink(missing_ok=True)
        raise


def average_width(widths, upm):
    total = sum(FREQUENCIES.values())
    return sum(widths[c] * f for c, f in FREQUENCIES.items()) / total / upm


def fallback_metrics(source, weight):
    """size-adjust and the ascent, descent and line-gap overrides (percentages) that make Arial take the space this
    font takes at `weight` (fonttools; the method next/font and Capsize use)."""
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    font = instantiateVariableFont(TTFont(source, recalcTimestamp=False), {"wght": weight})
    upm = font["head"].unitsPerEm
    cmap, hmtx = font.getBestCmap(), font["hmtx"]
    widths = {c: hmtx[cmap[ord(c)]][0] for c in FREQUENCIES}
    size_adjust = average_width(widths, upm) / average_width(ARIAL_WIDTHS, ARIAL_UPM)
    os2, hhea = font["OS/2"], font["hhea"]
    typo = bool(os2.fsSelection & (1 << 7))  # USE_TYPO_METRICS
    ascent, descent, gap = ((os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap) if typo
                            else (hhea.ascent, hhea.descent, hhea.lineGap))
    pct = lambda value: round(100 * value, 2)
    return {"size-adjust": pct(size_adjust), "ascent-override": pct(ascent / upm / size_adjust),
            "descent-override": pct(abs(descent) / upm / size_adjust), "line-gap-override": pct(gap / upm / size_adjust)}


class MetricsError(ValueError):
    pass


def read_metrics(path):
    """The stored fallback metrics, each entry checked (a fingerprint and every override as a number in 0 to 500), so a
    damaged file stops the build with one line rather than writing bad CSS; an entry that fails is recomputed."""
    if not path.exists():
        return {}
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise MetricsError(f"{path.name} is not valid JSON ({e.msg}, line {e.lineno}); restore it from git or delete it "
                           "and rebuild with design/tools/requirements.txt installed") from e
    if not isinstance(stored, dict):
        raise MetricsError(f"{path.name} must hold an object of families")
    valid = {}
    for family, entry in stored.items():
        if (isinstance(entry, dict) and isinstance(entry.get("fingerprint"), str)
                and all(isinstance(entry.get(k), (int, float)) and 0 <= entry[k] <= 500 for k in OVERRIDES)):
            valid[family] = entry
    return valid


def build(fonts_dir, out_dir, css_path):
    """Builds every family; returns {served name: public URL path} and the names it converted."""
    faces, converted = [], []
    metrics_path = fonts_dir / METRICS
    # Temporary files a killed earlier run left (SIGKILL runs no cleanup) go first.
    for folder in {fonts_dir, out_dir, css_path.parent}:
        if folder.exists():
            for leftover in folder.glob("*.tmp"):
                leftover.unlink()
    stored = read_metrics(metrics_path)
    metrics = {}
    for source_name, name, family, weight in FAMILIES:
        source = fonts_dir / source_name
        print_ = fingerprint(source)
        target = out_dir / f"{name}.{print_}.woff2"
        if not target.exists():
            convert(source, target)
            converted.append(target.name)
        known = stored.get(family, {})
        metrics[family] = known if known.get("fingerprint") == print_ else {"fingerprint": print_, **fallback_metrics(source, weight)}
        faces.append((family, f"/static/fonts/{target.name}"))
    if metrics != stored:
        write_atomic(metrics_path, (json.dumps(metrics, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    css = "/* Generated by design/tools/build-webfonts.py from design/fonts/. Do not edit: run pnpm build:assets. */\n"
    for family, url in faces:
        css += (f'\n@font-face {{\n  font-family: "{family}";\n  src: url("{url}") format("woff2");\n'
                f"  font-weight: {WEIGHTS};\n  font-style: normal;\n  font-display: swap;\n}}\n")
        # A fixed order, so freshly computed and stored metrics write the same CSS.
        overrides = "".join(f"  {key}: {metrics[family][key]}%;\n" for key in OVERRIDES)
        css += f'\n@font-face {{\n  font-family: "{family} Fallback";\n  src: {FALLBACK_SOURCES};\n{overrides}}}\n'
    if not css_path.exists() or css_path.read_text(encoding="utf-8") != css:
        write_atomic(css_path, css.encode("utf-8"))
    return dict(faces), converted


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fonts", type=pathlib.Path, default=REPO / "design/fonts")
    parser.add_argument("--out", type=pathlib.Path, default=REPO / "public/static/fonts")
    parser.add_argument("--css", type=pathlib.Path, default=REPO / "src/web/styles/fonts.css")
    args = parser.parse_args(argv)
    try:
        _, converted = build(args.fonts, args.out, args.css)
    except MetricsError as e:
        print(f"build-webfonts: {e}", file=sys.stderr)
        return 1
    except ModuleNotFoundError as e:
        print(f"build-webfonts: a source font changed and converting it needs {e.name}: "
              "pip install -r design/tools/requirements.txt", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"build-webfonts: {e}", file=sys.stderr)
        return 1
    for name in converted:
        print(f"build-webfonts: wrote public/static/fonts/{name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
