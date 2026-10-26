#!/usr/bin/env python3
"""Import the approved design canvas and export its boards as standalone pages and PNG references.

The design canvas stores each board as a `.dc.html` file: page markup inside `<x-dc>`, styles in `<helmet>`,
shared parts pulled in with `<dc-import name="Part" prop="value">`, and part templates filled with
`{{path}}` values from the part's `renderVals()`. Build agents need the boards without the canvas runtime,
so this tool:

- `import <canvas project folder>`: copies `canvas.json`, `ui.css` and every board into
  `design/mockups/source/`, rewriting canvas asset links (`/_blob/<id>`) to `design/brand/` files through
  `design/mockups/source/assets.json`. An unmapped asset stops the import.
- `export`: writes each board as a standalone page under `build/mockups/` (parts inlined, local Exo fonts,
  no network) and renders `design/mockups/png/<Board>.png` at the board's size with headless Chromium.
  `--audit` also records every text element's colour, background, size and weight, and whether every
  image and both fonts loaded, into `build/mockups/audit.json`.

Exit codes: 0 done, 1 a board or asset problem, 2 a tool problem (no Node, no Chromium, bad arguments).
"""
import argparse
import glob
import hashlib
import html
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "design/mockups/source"
PNG = ROOT / "design/mockups/png"
OUT = ROOT / "build/mockups"
FONTS = pathlib.Path(os.environ.get("MOCKUP_FONTS", ROOT / "design/fonts"))
FONT_FILES = {"Exo": "Exo[wght].ttf", "Exo 2": "Exo2[wght].ttf"}

IMPORT_RE = re.compile(r"<dc-import\s+([^>]*?)\s*>\s*</dc-import>", re.S)
ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')
TEMPLATE_RE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")
BLOB_RE = re.compile(r"/_blob/([0-9a-f]{32})")
SRC_RE = re.compile(r'\bsrc="([^"]+)"')


class BoardError(Exception):
    """A board, asset or render problem the operator must fix in the source."""


class ToolError(Exception):
    """The environment cannot run the export (Node or Chromium missing, bad input)."""


def atomic_write(path, data):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def parse_board(path):
    """Split a board file into its helmet, body, logic script and prop schema."""
    text = pathlib.Path(path).read_text(encoding="utf-8")
    try:
        inner = text.split("<x-dc>", 1)[1].split("</x-dc>", 1)[0]
    except IndexError:
        raise BoardError(f"{pathlib.Path(path).name}: no <x-dc> block")
    helmet = ""
    if "<helmet>" in inner:
        helmet, inner = inner.split("<helmet>", 1)[1].split("</helmet>", 1)
    m = re.search(r"<script type=\"text/x-dc\" data-dc-script data-props='([^']*)'>(.*?)</script>", text, re.S)
    if not m:
        raise BoardError(f"{pathlib.Path(path).name}: no data-dc-script block")
    props = json.loads(html.unescape(m.group(1)))
    title = re.search(r"<title>(.*?)</title>", text, re.S)
    return {"helmet": helmet, "body": inner.strip(), "script": m.group(2), "props": props,
            "title": title.group(1).strip() if title else pathlib.Path(path).stem}


def render_vals(board, props, name):
    """Run the board's Component.renderVals() in Node with the given props."""
    node = shutil.which("node")
    if not node:
        raise ToolError("node is not installed; it runs the parts' renderVals()")
    program = ("class DCLogic { constructor(props) { this.props = props; } }\n" + board["script"] +
               "\nconst props = JSON.parse(process.argv[1]);\n"
               "process.stdout.write(JSON.stringify(new Component(props).renderVals() ?? {}));\n")
    run = subprocess.run([node, "-e", program, json.dumps(props)], capture_output=True, text=True, timeout=30)
    if run.returncode != 0:
        raise BoardError(f"{name}: renderVals failed: {run.stderr.strip().splitlines()[-1] if run.stderr.strip() else run.returncode}")
    return json.loads(run.stdout or "{}")


def fill_template(body, vals, name):
    def lookup(m):
        value = vals
        for key in m.group(1).split("."):
            if not isinstance(value, dict) or key not in value:
                raise BoardError(f"{name}: template value {{{{{m.group(1)}}}}} has no renderVals entry")
            value = value[key]
        return html.escape(str(value), quote=True)
    return TEMPLATE_RE.sub(lookup, body)


def resolve(name, source, attrs=None, depth=0, styles=None):
    """Return a board's body with its imports inlined and its template filled; collect part styles."""
    if depth > 8:
        raise BoardError(f"{name}: imports nest deeper than 8 levels")
    path = pathlib.Path(source) / f"{name}.dc.html"
    if not path.exists():
        raise BoardError(f"import of {name} has no board {path.name}")
    board = parse_board(path)
    styles = styles if styles is not None else []
    styles.extend(re.findall(r"<style>(.*?)</style>", board["helmet"], re.S))
    props = {k: v.get("default") for k, v in board["props"].items() if not k.startswith("$") and isinstance(v, dict)}
    props.update(attrs or {})
    body = board["body"]
    if TEMPLATE_RE.search(body):
        body = fill_template(body, render_vals(board, props, name), name)

    def inline(m):
        a = dict(ATTR_RE.findall(m.group(1)))
        part = a.pop("name", None)
        if not part:
            raise BoardError(f"{name}: a dc-import has no name")
        a.pop("hint-size", None)
        return resolve(part, source, a, depth + 1, styles)[0]

    body = IMPORT_RE.sub(inline, body)
    if "<dc-import" in body:
        raise BoardError(f"{name}: an import was left unresolved")
    if TEMPLATE_RE.search(body):
        raise BoardError(f"{name}: a template value was left in the output")
    return body, styles, board


def check_assets(name, body, source):
    """Every src must resolve to an existing file; canvas asset links must be gone."""
    if BLOB_RE.search(body):
        raise BoardError(f"{name}: a canvas asset link (/_blob/) remains")
    for src in SRC_RE.findall(body):
        if re.match(r"^(data:|https?:|#)", src):
            continue
        target = (pathlib.Path(source) / urllib.parse.unquote(src)).resolve()
        if not target.is_file():
            raise BoardError(f"{name}: asset {src} does not exist")


AUDIT_JS = r"""
<script>
window.addEventListener('load', async () => {
  await document.fonts.ready;
  const used = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const fam = getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/["']/g, '');
    if (FAMILIES.includes(fam)) used.add(fam);
  }
  const fonts = {};
  for (const fam of used) fonts[fam] = [...document.fonts].some(f => f.family.replace(/["']/g, '') === fam && f.status === 'loaded');
  const images = [...document.images].map(i => ({src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0}));
  const rgba = c => { const m = (c.match(/[\d.]+/g) || ['0', '0', '0', '0']).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
  const over = ([r, g, b, a], base) => [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
  const css = c => `rgb(${c.map(Math.round).join(', ')})`;
  const bgOf = el => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] === 0) continue;
      layers.push(c);
      if (c[3] >= 1) break;
    }
    return layers.reduceRight((base, layer) => over(layer, base), [255, 255, 255]);
  };
  const pairs = {};
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement, cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    const illustration = !!el.closest('[data-illustration]');
    const bg = bgOf(el), fg = css(over(rgba(cs.color), bg));
    const key = [fg, css(bg), cs.fontSize, cs.fontWeight, illustration].join('|');
    pairs[key] = pairs[key] || {fg, bg: css(bg), size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), illustration, sample: t.textContent.trim().slice(0, 40)};
  }
  const pre = document.createElement('pre');
  pre.id = 'mockup-audit';
  pre.style.display = 'none';
  pre.textContent = JSON.stringify({fonts, images, pairs: Object.values(pairs)});
  document.body.appendChild(pre);
});
</script>
"""


def standalone(name, source, out, audit):
    body, styles, board = resolve(name, source)
    check_assets(name, body, source)
    rel = os.path.relpath(pathlib.Path(source).resolve(), pathlib.Path(out).resolve())

    def relink(m):
        attr, url = m.group(1), m.group(2)
        if re.match(r"^(data:|https?:|#|/)", url) or url.endswith(".dc.html"):
            return m.group(0)
        return f'{attr}="{rel}/{url}"'

    body = re.sub(r'\b(src)="([^"]+)"', relink, body)
    body = re.sub(r'href="([\w-]+)\.dc\.html"', r'href="\1.html"', body)
    fonts_rel = os.path.relpath(FONTS.resolve(), pathlib.Path(out).resolve())
    faces = "".join(
        f"@font-face{{font-family:'{fam}';src:url('{fonts_rel}/{urllib.parse.quote(f)}') format('truetype');"
        f"font-weight:100 900;font-display:block}}" for fam, f in FONT_FILES.items())
    script = AUDIT_JS.replace("FAMILIES", json.dumps(list(FONT_FILES))) if audit else ""
    page = (f"<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>{board['title']}</title>\n"
            f"<style>{faces}</style>\n<link rel=\"stylesheet\" href=\"{rel}/ui.css\">\n"
            + "".join(f"<style>{s}</style>\n" for s in styles) +
            f"</head>\n<body>\n{body}\n{script}</body>\n</html>\n")
    return page, board


def find_chromium():
    env = os.environ.get("MOCKUP_CHROMIUM")
    if env:
        return env
    found = sorted(glob.glob(os.path.expanduser(
        "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")))
    if found:
        return found[-1]
    for name in ("chromium", "chromium-browser", "google-chrome"):
        if shutil.which(name):
            return shutil.which(name)
    raise ToolError("no headless Chromium found; set MOCKUP_CHROMIUM")


def chromium(args):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise BoardError(f"Chromium did not run: {e}")


def render_png(chrome, page_path, png_path, w, h):
    """Screenshot into a temporary file and replace the PNG only after Chromium succeeds."""
    png_path = pathlib.Path(png_path)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=png_path.parent, prefix=f".{png_path.name}.", suffix=".png")
    os.close(fd)
    try:
        run = chromium([chrome, "--headless", "--no-sandbox", "--hide-scrollbars", "--force-device-scale-factor=1",
                        f"--window-size={w},{h}", "--virtual-time-budget=4000", f"--screenshot={tmp}",
                        pathlib.Path(page_path).resolve().as_uri()])
        if run.returncode != 0 or os.path.getsize(tmp) == 0:
            raise BoardError(f"{png_path.stem}: Chromium failed ({run.returncode})")
        size = png_size(tmp)
        if size != (w, h):
            raise BoardError(f"{png_path.stem}: PNG is {size[0]}x{size[1]}, board is {w}x{h}")
        os.chmod(tmp, 0o644)
        os.replace(tmp, png_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise BoardError(f"{pathlib.Path(path).name}: not a PNG")
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def audit_page(chrome, page_path, w, h, name):
    run = chromium([chrome, "--headless", "--no-sandbox", f"--window-size={w},{h}", "--virtual-time-budget=4000",
                    "--dump-dom", pathlib.Path(page_path).resolve().as_uri()])
    m = re.search(r'<pre id="mockup-audit"[^>]*>(.*?)</pre>', run.stdout, re.S)
    if run.returncode != 0 or not m:
        raise BoardError(f"{name}: the audit did not run")
    data = json.loads(html.unescape(m.group(1)))
    missing = [f for f, ok in data["fonts"].items() if not ok]
    if missing:
        raise BoardError(f"{name}: font not loaded: {', '.join(missing)}")
    broken = [i["src"] for i in data["images"] if not i["ok"]]
    if broken:
        raise BoardError(f"{name}: image not loaded: {', '.join(broken)}")
    return data


def cmd_export(args):
    source, out, png = pathlib.Path(args.source), pathlib.Path(args.out), pathlib.Path(args.png)
    canvas = json.loads((source / "canvas.json").read_text(encoding="utf-8"))
    boards = canvas["boards"]
    names = [f[:-len(".dc.html")] for f in boards]
    if args.only:
        unknown = set(args.only) - set(names)
        if unknown:
            raise ToolError(f"not boards: {', '.join(sorted(unknown))}")
        names = [n for n in names if n in args.only]
    chrome = None if args.no_png and not args.audit else find_chromium()
    audit = {}
    errors = []
    for name in names:
        b = boards[f"{name}.dc.html"]
        try:
            page, _ = standalone(name, source, out, args.audit)
            page_path = out / f"{name}.html"
            atomic_write(page_path, page)
            if not args.no_png:
                render_png(chrome, page_path, png / f"{name}.png", b["w"], b["h"])
            if args.audit:
                audit[name] = audit_page(chrome, page_path, b["w"], b["h"], name)
        except BoardError as e:
            errors.append(str(e))
    if args.audit:
        atomic_write(out / "audit.json", json.dumps(audit, indent=1, sort_keys=True) + "\n")
    for e in errors:
        print(f"export-mockups: {e}", file=sys.stderr)
    print(f"export-mockups: {len(names) - len(errors)} of {len(names)} boards exported")
    return 1 if errors else 0


def cmd_import(args):
    src, dest = pathlib.Path(args.canvas), pathlib.Path(args.source)
    assets = json.loads((dest / "assets.json").read_text(encoding="utf-8"))
    canvas = json.loads((src / "canvas.json").read_text(encoding="utf-8"))
    errors, files = [], {}
    for f in list(canvas["boards"]) + ["ui.css"]:
        p = src / f
        if not p.is_file():
            errors.append(f"{f}: listed in canvas.json but not in {src}")
            continue
        text = p.read_text(encoding="utf-8")
        for blob in sorted(set(BLOB_RE.findall(text))):
            if blob not in assets:
                errors.append(f"{f}: canvas asset {blob} has no entry in assets.json")
        files[f] = BLOB_RE.sub(lambda m: assets.get(m.group(1), m.group(0)), text)
    if errors:
        for e in errors:
            print(f"export-mockups: {e}", file=sys.stderr)
        return 1
    for f, text in files.items():
        atomic_write(dest / f, text)
    atomic_write(dest / "canvas.json", json.dumps(canvas, indent=1) + "\n")
    if args.approve:
        approved = {"approved": args.approve, "source": args.canvas_url, "boards": {
            f[:-len(".dc.html")]: {"title": b["title"], "sha256": hashlib.sha256(files[f].encode("utf-8")).hexdigest()}
            for f, b in canvas["boards"].items()}}
        atomic_write(dest.parent / "approved.json", json.dumps(approved, indent=1) + "\n")
    print(f"export-mockups: imported {len(files) - 1} boards into {dest}")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    im = sub.add_parser("import", help="copy a canvas project folder into design/mockups/source")
    im.add_argument("canvas", help="folder holding canvas.json, ui.css and the boards")
    im.add_argument("--source", default=str(SOURCE))
    im.add_argument("--approve", metavar="YYYY-MM-DD", help="record the approved inventory with this date")
    im.add_argument("--canvas-url", default="", help="the canvas the operator approved")
    ex = sub.add_parser("export", help="write standalone pages and PNG references")
    ex.add_argument("--source", default=str(SOURCE))
    ex.add_argument("--out", default=str(OUT))
    ex.add_argument("--png", default=str(PNG))
    ex.add_argument("--no-png", action="store_true")
    ex.add_argument("--audit", action="store_true")
    ex.add_argument("--only", nargs="+", metavar="BOARD")
    args = ap.parse_args(argv)
    try:
        return cmd_import(args) if args.cmd == "import" else cmd_export(args)
    except ToolError as e:
        print(f"export-mockups: {e}", file=sys.stderr)
        return 2
    except BoardError as e:
        print(f"export-mockups: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
