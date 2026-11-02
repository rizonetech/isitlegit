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
  `--audit` also records every text element's (and form value's and placeholder's) colour, background, size
  and weight, every input's border against its surroundings, and whether every image and font loaded, into
  `build/mockups/audit.json`.

Every board's PNG and audit entry carry a fingerprint of its rendering inputs (the board, the parts it
imports, ui.css, its size, the fonts and this tool), so design/tools/check-design.py refuses a stale or
partial PNG set or audit. Canvas input is treated as untrusted: board names must be plain file names,
part scripts run in headless Chromium's renderer sandbox, executable markup is refused, and every page renders
offline (all requests, loopback included, go to a dead proxy). An import is staged and swapped in whole; an export replaces each PNG only after it renders and
records it in png/manifest.json, so an interrupted run is detected and finished by running it again.

Exit codes: 0 done, 1 a board, asset or input problem, 2 a tool problem (no Chromium, bad arguments).
"""
import argparse
import glob
import functools
import hashlib
import html
import html.parser
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "design/mockups/source"
PNG = ROOT / "design/mockups/png"
OUT = ROOT / "build/mockups"
FONTS = pathlib.Path(os.environ.get("MOCKUP_FONTS", ROOT / "design/fonts"))
FONT_FILES = {"Exo": "Exo[wght].ttf", "Exo 2": "Exo2[wght].ttf"}
MONO_FAMILIES = ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"]  # the system mono stack (tokens)

IMPORT_RE = re.compile(r"<dc-import\s+([^>]*?)\s*>\s*</dc-import>", re.S)
ATTR_RE = re.compile(r'([\w-]+)="([^"]*)"')
TEMPLATE_RE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")
BLOB_RE = re.compile(r"/_blob/([0-9a-f]{32})")
SRC_RE = re.compile(r"""(<[a-z][a-z0-9-]*\b[^<>]*?\bsrc\s*=\s*(["']))(.*?)(\2)""", re.I | re.S)
ASSET_ROOT = ROOT / "design"  # every image a board shows lives under design/ (design/brand in practice)
EXECUTABLE_TAGS = {"script", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link", "applet",
                   "portal", "noscript", "template"}
URL_ATTRIBUTES = {"href", "src", "xlink:href", "action", "formaction", "data", "poster", "background", "srcset"}


class _Executable(html.parser.HTMLParser):
    """Finds markup a browser would execute: script-bearing tags, event-handler attributes (however the attribute is
    separated: a space or a slash), srcdoc, and javascript: or vbscript: URLs. Parsing, not pattern matching."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() in EXECUTABLE_TAGS:
            self.found.append(f"<{tag}>")
        for key, value in attrs:
            key = (key or "").lower()
            if key.startswith("on") or key == "srcdoc":
                self.found.append(f"{key}= on <{tag}>")
            elif key in URL_ATTRIBUTES and re.match(r"^\s*(java|vb)script:", re.sub(r"[\x00-\x20]", "", value or ""), re.I):
                self.found.append(f"{key}=javascript: on <{tag}>")

    handle_startendtag = handle_starttag


def executable_markup(body):
    parser = _Executable()
    parser.feed(body)
    parser.close()
    return parser.found
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*\.dc\.html$")
NETWORK_RE = re.compile(r"""<(?:img|script|iframe|source|video|audio|embed|object|link)\b[^<>]*\b(?:src|href|data)\s*=\s*["']?(?:https?:)?//|url\(\s*["']?(?:https?:)?//""", re.I)


class BoardError(Exception):
    """A board, asset or render problem the operator must fix in the source."""


class ToolError(Exception):
    """The environment cannot run the export (Chromium missing, bad input)."""


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


def read_canvas(folder):
    """Load and validate a canvas.json: plain board file names and positive integer sizes only."""
    path = pathlib.Path(folder) / "canvas.json"
    try:
        canvas = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        raise BoardError(f"{path} is not a readable canvas.json: {e}")
    boards = canvas.get("boards") if isinstance(canvas, dict) else None
    if not isinstance(boards, dict) or not boards:
        raise BoardError(f"{path} has no boards")
    for name, b in boards.items():
        if not NAME_RE.match(name):
            raise BoardError(f"{path}: board name {name!r} is not a plain .dc.html file name")
        if not isinstance(b, dict) or not all(isinstance(b.get(k), int) and 0 < b[k] <= 20000 for k in ("w", "h")):
            raise BoardError(f"{path}: board {name} needs integer w and h between 1 and 20000")
    return canvas


def parse_board(path):
    """Split a board file into its helmet, body, logic script and prop schema."""
    text = pathlib.Path(path).read_text(encoding="utf-8")
    try:
        inner = text.split("<x-dc>", 1)[1].split("</x-dc>", 1)[0]
    except IndexError:
        raise BoardError(f"{pathlib.Path(path).name}: no <x-dc> block")
    helmet = ""
    if "<helmet>" in inner:
        parts = inner.split("<helmet>", 1)[1].split("</helmet>", 1)
        if len(parts) != 2:
            raise BoardError(f"{pathlib.Path(path).name}: <helmet> is not closed")
        helmet, inner = parts
    m = re.search(r"<script type=\"text/x-dc\" data-dc-script data-props='([^']*)'>(.*?)</script>", text, re.S)
    if not m:
        raise BoardError(f"{pathlib.Path(path).name}: no data-dc-script block")
    try:
        props = json.loads(html.unescape(m.group(1)))
    except json.JSONDecodeError:
        raise BoardError(f"{pathlib.Path(path).name}: data-props is not JSON")
    if not isinstance(props, dict):
        raise BoardError(f"{pathlib.Path(path).name}: data-props is not an object")
    title = re.search(r"<title>(.*?)</title>", text, re.S | re.I)
    return {"helmet": helmet, "body": inner.strip(), "script": m.group(2), "props": props,
            "title": title.group(1).strip() if title else pathlib.Path(path).stem}


RENDER_VALS_PAGE = """<!doctype html><meta charset="utf-8"><body><script>
class DCLogic { constructor(props) { this.props = props; } }
try {
  const Component = new Function('DCLogic', CODE + '\\nreturn Component;')(DCLogic);
  document.body.setAttribute('data-out', JSON.stringify(new Component(PROPS).renderVals() ?? {}));
} catch (e) { document.body.setAttribute('data-err', String(e).slice(0, 200)); }
</script></body>
"""
_VALS = {}


def render_vals(board, props, name):
    """Run a part's Component.renderVals() with the given props inside headless Chromium.

    Canvas scripts are untrusted, and Node's vm module is not a security boundary, so they run in Chromium's
    renderer sandbox: offline (every request, loopback included, goes to a dead proxy), from a throwaway profile,
    with a scrubbed environment. Results are cached per script and props for the run."""
    key = (hashlib.sha256(board["script"].encode()).hexdigest(), json.dumps(props, sort_keys=True))
    if key in _VALS:
        return _VALS[key]
    chrome = find_chromium()
    script_json = lambda v: json.dumps(v).replace("</", "<\\/")
    page = RENDER_VALS_PAGE.replace("CODE", script_json(board["script"])).replace("PROPS", script_json(props))
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "vals.html"
        path.write_text(page, encoding="utf-8")
        run = chromium([chrome, "--headless", "--virtual-time-budget=2000", "--dump-dom", path.as_uri()], tmp)
    out = re.search(r'<body data-out="([^"]*)"', run.stdout)
    if run.returncode != 0 or not out:
        err = re.search(r'data-err="([^"]*)"', run.stdout)
        raise BoardError(f"{name}: renderVals failed: {html.unescape(err.group(1)) if err else 'no result'}")
    try:
        _VALS[key] = json.loads(html.unescape(out.group(1)))
    except json.JSONDecodeError:
        raise BoardError(f"{name}: renderVals returned something that is not JSON")
    return _VALS[key]


def fill_template(body, vals, name):
    def lookup(m):
        value = vals
        for key in m.group(1).split("."):
            if not isinstance(value, dict) or key not in value:
                raise BoardError(f"{name}: template value {{{{{m.group(1)}}}}} has no renderVals entry")
            value = value[key]
        return html.escape(str(value), quote=True)
    return TEMPLATE_RE.sub(lookup, body)


# Limits on what one board may expand to, checked before anything is expanded: imports multiply (a part imported
# many times by parts imported many times), so a depth limit alone does not bound the output.
MAX_BOARD_BYTES = 2_000_000
MAX_IMPORTS = 200
MAX_PAGE_BYTES = 8_000_000
MAX_IMPORT_BOARDS = 500
MAX_IMPORT_BYTES = 64_000_000


def resolve(name, source, attrs=None, depth=0, styles=None, budget=None):
    """Return a board's body with its imports inlined and its template filled; collect part styles."""
    budget = budget if budget is not None else {"imports": 0, "bytes": 0}
    if depth > 8:
        raise BoardError(f"{name}: imports nest deeper than 8 levels")
    budget["imports"] += 1
    if budget["imports"] > MAX_IMPORTS:
        raise BoardError(f"{name}: a board expands to more than {MAX_IMPORTS} imported parts")
    path = pathlib.Path(source) / f"{name}.dc.html"
    if not path.exists():
        raise BoardError(f"import of {name} has no board {path.name}")
    if path.stat().st_size > MAX_BOARD_BYTES:
        raise BoardError(f"{name}: the board file is larger than {MAX_BOARD_BYTES} bytes")
    board = parse_board(path)
    styles = styles if styles is not None else []
    own_styles = re.findall(r"<style>(.*?)</style>", board["helmet"], re.S)
    styles.extend(own_styles)
    budget["bytes"] += sum(len(x) for x in own_styles)
    props = {k: v.get("default") for k, v in board["props"].items() if not k.startswith("$") and isinstance(v, dict)}
    props.update(attrs or {})
    body = board["body"]
    if TEMPLATE_RE.search(body):
        body = fill_template(body, render_vals(board, props, name), name)
    if depth == 0:
        budget["bytes"] += len(body)
    if budget["bytes"] > MAX_PAGE_BYTES:
        raise BoardError(f"{name}: the page and its styles expand to more than {MAX_PAGE_BYTES} bytes")

    def inline(m):
        a = dict(ATTR_RE.findall(m.group(1)))
        part = a.pop("name", None)
        if not part:
            raise BoardError(f"{name}: a dc-import has no name")
        if not NAME_RE.match(f"{part}.dc.html"):
            raise BoardError(f"{name}: import name {part!r} is not a plain board name")
        a.pop("hint-size", None)
        expanded = resolve(part, source, a, depth + 1, styles, budget)[0]
        budget["bytes"] += len(expanded)
        if budget["bytes"] > MAX_PAGE_BYTES:
            raise BoardError(f"{name}: imports expand to more than {MAX_PAGE_BYTES} bytes")
        return expanded

    body = IMPORT_RE.sub(inline, body)
    if "<dc-import" in body:
        raise BoardError(f"{name}: an import was left unresolved")
    if TEMPLATE_RE.search(body):
        raise BoardError(f"{name}: a template value was left in the output")
    return body, styles, board


def check_assets(name, body, source, asset_root=ASSET_ROOT):
    """Every src must resolve to an existing file; canvas asset links must be gone."""
    if BLOB_RE.search(body):
        raise BoardError(f"{name}: a canvas asset link (/_blob/) remains")
    found = executable_markup(body)
    if found:
        raise BoardError(f"{name}: contains executable markup ({', '.join(sorted(set(found))[:3])})")
    if NETWORK_RE.search(body):
        raise BoardError(f"{name}: loads a network resource; boards render offline")
    for _, _, src, _ in SRC_RE.findall(body):
        if re.match(r"^(data:|#)", src):
            continue
        target = (pathlib.Path(source) / urllib.parse.unquote(src)).resolve()
        if src.startswith(("/", "\\")) or re.match(r"^[a-z]+:", src, re.I) or not target.is_relative_to(asset_root.resolve()):
            raise BoardError(f"{name}: asset {src} is outside design/; boards show only design files")
        if not target.is_file():
            raise BoardError(f"{name}: asset {src} does not exist")


AUDIT_JS = r"""
<script nonce="NONCE">
window.addEventListener('load', async () => {
  await document.fonts.ready;
  const used = new Set(), unknown = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    if (el.closest('[data-illustration]') || ['SCRIPT', 'STYLE'].includes(el.tagName) || getComputedStyle(el).display === 'none') continue;
    const fam = getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/["']/g, '');
    if (FAMILIES.includes(fam)) used.add(fam);
    else if (!MONO.includes(fam)) unknown.add(fam);
  }
  const fonts = {};
  for (const fam of used) fonts[fam] = [...document.fonts].some(f => f.family.replace(/["']/g, '') === fam && f.status === 'loaded');
  const images = [...document.images].map(i => ({src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0}));
  const rgba = c => { const m = (c.match(/[\d.]+/g) || ['0', '0', '0', '0']).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
  const over = ([r, g, b, a], base) => [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
  const css = c => `rgb(${c.map(Math.round).join(', ')})`;
  // Element opacity (its own and every ancestor's) fades text towards what is behind it, so it joins the colour's alpha.
  const fade = ([r, g, b, a], el) => { let o = 1; for (let n = el; n; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return [r, g, b, a * o]; };
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
    // An inactive control is exempt from contrast (WCAG 2.2, 1.4.3 and 1.4.11), so it is recorded but not checked.
    const inactive = !!el.closest(':disabled, [aria-disabled="true"]');
    const bg = bgOf(el), fg = css(over(fade(rgba(cs.color), el), bg));
    const key = [fg, css(bg), cs.fontSize, cs.fontWeight, illustration].join('|');
    pairs[key] = pairs[key] || {kind: 'text', fg, bg: css(bg), size: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10), illustration: illustration || inactive, inactive, sample: t.textContent.trim().slice(0, 40)};
  }
  // Form text (values and placeholders are not text nodes) and the boundaries that identify a control.
  const add = (kind, fgColour, el, size, weight, sample) => {
    const illustration = !!el.closest('[data-illustration]');
    const bg = kind === 'boundary' ? bgOf(el.parentElement || el) : bgOf(el), fg = css(over(fade(rgba(fgColour), el), bg));
    const key = [kind, fg, css(bg), size, weight, illustration].join('|');
    pairs[key] = pairs[key] || {kind, fg, bg: css(bg), size, weight, illustration, sample};
  };
  for (const el of document.querySelectorAll('input, textarea, select')) {
    const cs = getComputedStyle(el);
    if (el.type === 'hidden' || cs.display === 'none') continue;
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10);
    if (el.value && !['checkbox', 'radio'].includes(el.type)) add('text', cs.color, el, size, weight, el.value.slice(0, 40));
    if (el.placeholder) add('text', getComputedStyle(el, '::placeholder').color, el, size, weight, el.placeholder.slice(0, 40));
    if (!['checkbox', 'radio'].includes(el.type) && parseFloat(cs.borderTopWidth) > 0)
      add('boundary', cs.borderTopColor, el, size, weight, `${el.tagName.toLowerCase()} border`);
  }
  const pre = document.createElement('pre');
  pre.id = 'mockup-audit-NONCE';
  pre.style.display = 'none';
  pre.textContent = JSON.stringify({fonts, unknownFonts: [...unknown], images, pairs: Object.values(pairs)});
  document.body.appendChild(pre);
});
</script>
"""


def standalone(name, source, out, audit, nonce="", asset_root=ASSET_ROOT):
    body, styles, board = resolve(name, source)
    check_assets(name, body, source, asset_root)
    for style in styles:
        if "<" in style:
            raise BoardError(f"{name}: a style holds markup, which could close the style element")
        if NETWORK_RE.search(style) or re.search(r"@import|expression\(", style, re.I):
            raise BoardError(f"{name}: a style loads a network resource or another stylesheet")
    rel = os.path.relpath(pathlib.Path(source).resolve(), pathlib.Path(out).resolve())

    def relink(m):
        url = m.group(3)
        if re.match(r"^(data:|#)", url):
            return m.group(0)
        return f"{m.group(1)}{rel}/{url}{m.group(4)}"

    body = SRC_RE.sub(relink, body)
    body = re.sub(r'href="([\w-]+)\.dc\.html"', r'href="\1.html"', body)
    fonts_rel = os.path.relpath(FONTS.resolve(), pathlib.Path(out).resolve())
    faces = "".join(
        f"@font-face{{font-family:'{fam}';src:url('{fonts_rel}/{urllib.parse.quote(f)}') format('truetype');"
        f"font-weight:100 900;font-display:block}}" for fam, f in FONT_FILES.items())
    # The audit writes its result under a random id the board cannot know, so board content cannot pose as it.
    script = (AUDIT_JS.replace("FAMILIES", json.dumps(list(FONT_FILES))).replace("MONO", json.dumps(MONO_FAMILIES))
              .replace("NONCE", nonce)) if audit else ""
    # Defence in depth: whatever the markup checks miss, the page runs no script but the audit's own (by nonce) and
    # loads nothing but local files.
    scripts = f"'nonce-{nonce}'" if audit and nonce else "'none'"
    csp = (f"default-src 'none'; script-src {scripts}; style-src 'unsafe-inline' file:; img-src file: data:; "
           f"font-src file: data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'")
    page = (f"<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            f"<meta http-equiv=\"Content-Security-Policy\" content=\"{csp}\">\n<title>{html.escape(html.unescape(board['title']))}</title>\n"
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


# Every request (loopback included) goes to a proxy nothing listens on, so a page cannot reach any network.
OFFLINE = ["--proxy-server=127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--disable-background-networking",
           "--no-pings", "--no-first-run"]


def chromium(args, workdir=None):
    """Run Chromium offline, in its sandbox, from a throwaway profile, with only PATH in its environment."""
    try:
        with tempfile.TemporaryDirectory() as profile:
            env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": profile}
            return subprocess.run(args[:1] + OFFLINE + [f"--user-data-dir={profile}"] + args[1:], capture_output=True,
                                  text=True, timeout=120, env=env, cwd=workdir or profile)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise BoardError(f"Chromium did not run: {e}")


def render_png(chrome, page_path, png_path, w, h):
    """Screenshot into a temporary file and replace the PNG only after Chromium succeeds."""
    png_path = pathlib.Path(png_path)
    png_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=png_path.parent, prefix=f".{png_path.name}.", suffix=".png")
    os.close(fd)
    try:
        run = chromium([chrome, "--headless", "--hide-scrollbars", "--force-device-scale-factor=1",
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


def audit_page(chrome, page_path, w, h, name, nonce):
    run = chromium([chrome, "--headless", f"--window-size={w},{h}", "--virtual-time-budget=4000",
                    "--dump-dom", pathlib.Path(page_path).resolve().as_uri()])
    found = re.findall(rf'<pre id="mockup-audit-{re.escape(nonce)}"[^>]*>(.*?)</pre>', run.stdout, re.S)
    if run.returncode != 0 or len(found) != 1:
        raise BoardError(f"{name}: the audit did not run")
    data = json.loads(html.unescape(found[0]))
    if data.get("unknownFonts"):
        raise BoardError(f"{name}: text in a font that is no token: {', '.join(data['unknownFonts'])}")
    missing = [f for f, ok in data["fonts"].items() if not ok]
    if missing:
        raise BoardError(f"{name}: font not loaded: {', '.join(missing)}")
    broken = [i["src"] for i in data["images"] if not i["ok"]]
    if broken:
        raise BoardError(f"{name}: image not loaded: {', '.join(broken)}")
    return data


def board_inputs(name, source, seen=None):
    """The board files a board renders from: itself and every part it imports, recursively."""
    seen = seen if seen is not None else []
    if name in seen:
        return seen
    seen.append(name)
    path = pathlib.Path(source) / f"{name}.dc.html"
    if path.is_file():
        for attrs in IMPORT_RE.findall(path.read_text(encoding="utf-8")):
            part = dict(ATTR_RE.findall(attrs)).get("name")
            if part and NAME_RE.match(f"{part}.dc.html"):
                board_inputs(part, source, seen)
    return seen


@functools.lru_cache(maxsize=None)
def _file_hash(path):
    p = pathlib.Path(path)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else "missing"


def fingerprint(name, source, size):
    """A digest of everything a board's PNG and audit depend on."""
    source = pathlib.Path(source)
    h = hashlib.sha256()
    for part in sorted(board_inputs(name, source)):
        path = source / f"{part}.dc.html"
        h.update(f"{part}:{_file_hash(str(path))}\n".encode())
        text = path.read_text(encoding="utf-8") if path.is_file() else ""
        for src in sorted({m[2] for m in SRC_RE.findall(text)} | set(re.findall(r"url\(\s*['\"]?([^'\")]+)", text))):
            if not re.match(r"^(data:|#|https?:|//)", src):
                asset = (source / urllib.parse.unquote(src)).resolve()
                h.update(f"asset {src}:{_file_hash(str(asset))}\n".encode())
    h.update(f"ui.css:{_file_hash(str(source / 'ui.css'))}\nsize:{size[0]}x{size[1]}\n".encode())
    for f in sorted(FONT_FILES.values()):
        h.update(f"{f}:{_file_hash(str(FONTS / f))}\n".encode())
    h.update(f"tool:{_file_hash(str(pathlib.Path(__file__).resolve()))}\n".encode())
    return h.hexdigest()


def load_json_or(path, default):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except (OSError, json.JSONDecodeError) as e:
        raise BoardError(f"{path} is unreadable ({e}); delete it and export again")


def cmd_export(args):
    source, out, png = pathlib.Path(args.source), pathlib.Path(args.out), pathlib.Path(args.png)
    boards = read_canvas(source)["boards"]
    names = [f[:-len(".dc.html")] for f in boards]
    if args.only:
        unknown = set(args.only) - set(names)
        if unknown:
            raise ToolError(f"not boards: {', '.join(sorted(unknown))}")
        names = [n for n in names if n in args.only]
    chrome = None if args.no_png and not args.audit else find_chromium()
    # A partial run (--only, or a board that fails) keeps the other boards' entries: the audit and the PNG
    # manifest are merged, and each entry's fingerprint says whether it still matches its inputs.
    audit = load_json_or(out / "audit.json", {}) if args.audit else {}
    manifest = load_json_or(png / "manifest.json", {}) if not args.no_png else {}
    errors, started = 0, time.monotonic()
    for i, name in enumerate(names, 1):
        b, t0 = boards[f"{name}.dc.html"], time.monotonic()
        print(f"[{i}/{len(names)}] {name} ...", end="", flush=True)
        try:
            fp = fingerprint(name, source, (b["w"], b["h"]))
            nonce = secrets.token_hex(16)
            page, _ = standalone(name, source, out, args.audit, nonce, pathlib.Path(args.asset_root))
            page_path = out / f"{name}.html"
            atomic_write(page_path, page)
            # The audit first: a board whose fonts or images fail gets neither a fresh PNG nor a manifest entry.
            if args.audit:
                data = audit_page(chrome, page_path, b["w"], b["h"], name, nonce)
                data["fingerprint"] = fp
            if not args.no_png:
                render_png(chrome, page_path, png / f"{name}.png", b["w"], b["h"])
                manifest[name] = fp
                atomic_write(png / "manifest.json", json.dumps(manifest, indent=1, sort_keys=True) + "\n")
            if args.audit:
                audit[name] = data
                atomic_write(out / "audit.json", json.dumps(audit, indent=1, sort_keys=True) + "\n")
            print(f" ok {time.monotonic() - t0:.2f} s", flush=True)
        except (BoardError, OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, AttributeError, TypeError) as e:
            errors += 1
            audit.pop(name, None)
            if manifest.pop(name, None) is not None:
                atomic_write(png / "manifest.json", json.dumps(manifest, indent=1, sort_keys=True) + "\n")
            print(" failed", flush=True)
            print(f"export-mockups: {e}", file=sys.stderr, flush=True)
    took = time.monotonic() - started
    print(f"export-mockups: {len(names) - errors} of {len(names)} boards exported in {took:.1f} s"
          f" ({took / max(len(names), 1):.2f} s a board)")
    return 1 if errors else 0


def recover_import(dest):
    """Finish what an import killed mid-swap left behind: put back a source folder that was moved aside but not
    replaced, and remove staging and backup folders no import still needs."""
    backup = dest.parent / f".{dest.name}.old"
    if not dest.exists() and backup.is_dir():
        os.replace(backup, dest)
        print(f"export-mockups: restored {dest} from an interrupted import", file=sys.stderr)
    for stale in [backup, *dest.parent.glob(f".{dest.name}.new.*")]:
        if stale.is_dir():
            shutil.rmtree(stale, ignore_errors=True)


def cmd_import(args):
    src, dest = pathlib.Path(args.canvas), pathlib.Path(args.source)
    recover_import(dest)
    assets = load_json_or(dest / "assets.json", None)
    if not isinstance(assets, dict):
        raise BoardError(f"{dest / 'assets.json'} is missing; it maps canvas asset ids to design/brand files")
    canvas = read_canvas(src)
    errors, files = [], {}
    names = list(canvas["boards"]) + ["ui.css"]
    if len(names) > MAX_IMPORT_BOARDS:
        raise BoardError(f"{src}: {len(names) - 1} boards, more than the {MAX_IMPORT_BOARDS} an import takes")
    sizes = {f: (src / f).stat().st_size for f in names if (src / f).is_file()}
    big = [f for f, n in sizes.items() if n > MAX_BOARD_BYTES]
    if big or sum(sizes.values()) > MAX_IMPORT_BYTES:
        raise BoardError(f"{src}: {', '.join(big) or 'the canvas'} is larger than an import takes "
                         f"({MAX_BOARD_BYTES} bytes a file, {MAX_IMPORT_BYTES} in all); nothing was read")
    for f in names:
        p = src / f
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as e:
            errors.append(f"{f}: cannot be read from {src} ({e.__class__.__name__})")
            continue
        for blob in sorted(set(BLOB_RE.findall(text))):
            if blob not in assets:
                errors.append(f"{f}: canvas asset {blob} has no entry in assets.json")
        files[f] = BLOB_RE.sub(lambda m: assets.get(m.group(1), m.group(0)), text)
    if errors:
        for e in errors:
            print(f"export-mockups: {e}", file=sys.stderr)
        print("export-mockups: nothing was imported", file=sys.stderr)
        return 1
    # Stage the whole new source folder beside the old one and swap them, so an interruption leaves
    # either the old folder or the new one, never a mix.
    dest.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(dir=dest.parent, prefix=f".{dest.name}.new."))
    backup = dest.parent / f".{dest.name}.old"
    try:
        shutil.copy2(dest / "assets.json", staging / "assets.json")
        for f, text in files.items():
            atomic_write(staging / f, text)
        atomic_write(staging / "canvas.json", json.dumps(canvas, indent=1) + "\n")
        if backup.exists():
            shutil.rmtree(backup)
        if dest.exists():
            os.replace(dest, backup)
        os.replace(staging, dest)
    except BaseException:
        if not dest.exists() and backup.exists():
            os.replace(backup, dest)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    shutil.rmtree(backup, ignore_errors=True)
    if args.approve:
        approved = {"approved": args.approve, "source": args.canvas_url,
                    "ui_css_sha256": hashlib.sha256(files["ui.css"].encode("utf-8")).hexdigest(),
                    "boards": {f[:-len(".dc.html")]: {"title": b.get("title", ""), "w": b["w"], "h": b["h"],
                                                       "sha256": hashlib.sha256(files[f].encode("utf-8")).hexdigest()}
                               for f, b in canvas["boards"].items()}}
        atomic_write(dest.parent / "approved.json", json.dumps(approved, indent=1) + "\n")
    print(f"export-mockups: imported {len(files) - 1} boards into {dest}")
    return 0


def _sha256_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def _root_vars(css_text):
    out = {}
    for block in re.findall(r":root\s*\{(.*?)\}", css_text, re.S):
        for name, value in re.findall(r"--([\w-]+)\s*:\s*([^;}]+)", block):
            out[name] = " ".join(value.split())
    return out


def _canonical_board(path):
    text = pathlib.Path(path).read_text(encoding="utf-8")
    return SRC_RE.sub(lambda m: f"{m.group(1)}ASSET{m.group(4)}", text)


def _board_assets(name, source):
    """Asset paths a board references, as fingerprint counts them."""
    found = set()
    for part in board_inputs(name, source):
        path = pathlib.Path(source) / f"{part}.dc.html"
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for src in {m[2] for m in SRC_RE.findall(text)} | set(re.findall(r"url\(\s*['\"]?([^'\")]+)", text)):
            if not re.match(r"^(data:|#|https?:|//)", src):
                found.add(src)
    return found


def _fidelity_owners(todo_root, board_names):
    """Map board name to the TODO section refs whose Fidelity line names it."""
    owners = {name: [] for name in board_names}
    todo_root = pathlib.Path(todo_root)
    if not todo_root.is_dir():
        return owners
    for path in sorted(todo_root.rglob("TODO-*.md")):
        m = re.match(r"(\d+)-", path.parent.name)
        f = re.match(r"TODO-(\d+)-", path.name)
        if not m or not f:
            continue
        section = None
        for line in path.read_text(encoding="utf-8").splitlines():
            h = re.match(r"## (\d+)\. ", line)
            if h:
                section = int(h.group(1))
            if line.startswith("**Fidelity:**") and section:
                for token in re.findall(r"`([^`]+)`", line):
                    for name in board_names:
                        if token == name and f"D{m.group(1)} T{f.group(1)} §{section}" not in owners[name]:
                            owners[name].append(f"D{m.group(1)} T{f.group(1)} §{section}")
    return owners


_SHADOWS = []


def cmd_diff(args):
    try:
        return _cmd_diff_impl(args)
    finally:
        for s in _SHADOWS:
            shutil.rmtree(s, ignore_errors=True)
        _SHADOWS.clear()


def _cmd_diff_impl(args):
    from PIL import Image

    candidate, source = pathlib.Path(args.canvas), pathlib.Path(args.source)
    png_dir, out = pathlib.Path(args.png), pathlib.Path(args.out)
    # Recover a publication interrupted between moving the old diff aside and installing the new one.
    backup_early = out.parent / f".{out.name}.old"
    inputs = [("--source", source), ("--png", png_dir), ("candidate", candidate),
              ("--tokens", pathlib.Path(args.tokens)), ("--todo", pathlib.Path(args.todo)),
              ("fonts", FONTS), ("design", ROOT / "design"), ("tool", pathlib.Path(__file__).parent)]
    for label, other in inputs:
        for pub in (out, backup_early):
            o, x = pub.resolve(), pathlib.Path(other).resolve()
            if o == x or o in x.parents or x in o.parents:
                raise BoardError(f"publication path {pub} overlaps {label} {other}; the diff never replaces its inputs")
    for pub in (out, backup_early):
        o, x = pub.resolve(), pathlib.Path(args.asset_root).resolve()
        if o == x or o in x.parents:
            raise BoardError(f"publication path {pub} overlaps --asset-root {args.asset_root}; "
                             "the diff never replaces its inputs")
    if not out.exists() and backup_early.is_dir() and (backup_early / "summary.md").is_file():
        os.replace(backup_early, out)
    approved_path = source.parent / "approved.json"
    approved = load_json_or(approved_path, None)
    if not isinstance(approved, dict) or not isinstance(approved.get("boards"), dict):
        raise BoardError(f"{approved_path} is missing or unreadable; approve a canvas first (import --approve)")
    if not candidate.is_dir():
        raise BoardError(f"{candidate} is not a canvas folder")
    # Verify the approved baseline still is the approved baseline.
    manifest = load_json_or(png_dir / "manifest.json", {})
    if not isinstance(manifest, dict):
        raise BoardError(f"{png_dir / 'manifest.json'} is not a manifest object; recover with a fresh export")
    approved_canvas = read_canvas(source)
    for name, rec in approved["boards"].items():
        if not isinstance(rec, dict):
            raise BoardError(f"approved baseline: {name} record in approved.json is malformed; "
                             "recover with import --approve or a fresh export")
        board_file = source / f"{name}.dc.html"
        if not board_file.is_file():
            raise BoardError(f"approved baseline: {name}.dc.html is missing from {source}; "
                             "recover with import --approve or a fresh export")
        if _sha256_file(board_file) != rec.get("sha256"):
            raise BoardError(f"approved baseline: {name}.dc.html no longer matches approved.json; "
                             "recover with import --approve or a fresh export")
        size = approved_canvas["boards"].get(f"{name}.dc.html", {})
        if (size.get("w"), size.get("h")) != (rec.get("w"), rec.get("h")):
            raise BoardError(f"approved baseline: {name} size no longer matches approved.json; "
                             "recover with import --approve or a fresh export")
        before = png_dir / f"{name}.png"
        if not before.is_file() or manifest.get(name) != fingerprint(name, source, (rec["w"], rec["h"])):
            raise BoardError(f"approved baseline: {name}.png is missing or stale; recover with a fresh export")
        try:
            before_size = png_size(before)
        except BoardError:
            raise BoardError(f"approved baseline: {name}.png is corrupt; recover with a fresh export")
        if before_size != (rec["w"], rec["h"]):
            raise BoardError(f"approved baseline: {name}.png is corrupt; recover with a fresh export")
        try:
            from PIL import Image
            with Image.open(before) as im:
                im.load()
        except Exception:
            raise BoardError(f"approved baseline: {name}.png is corrupt; recover with a fresh export")
    if _sha256_file(source / "ui.css") != approved.get("ui_css_sha256"):
        raise BoardError("approved baseline: ui.css no longer matches approved.json; "
                         "recover with import --approve or a fresh export")
    render_candidate = candidate
    if not (candidate / "ui.css").is_file():
        raise BoardError(f"{candidate}/ui.css is missing; a candidate canvas needs its stylesheet")
    # A raw canvas folder carries /_blob/ asset links: rewrite them through assets.json into a shadow copy.
    blob_files = [f for f in candidate.glob("*.dc.html") if BLOB_RE.search(f.read_text(encoding="utf-8"))]
    if blob_files:
        assets = load_json_or(candidate / "assets.json", None)
        assets_base = candidate
        if not isinstance(assets, dict):
            assets = load_json_or(source / "assets.json", None)
            assets_base = source
        if not isinstance(assets, dict):
            raise BoardError("candidate uses /_blob/ asset links but no assets.json maps them; import the canvas first")
        shadow = pathlib.Path(tempfile.mkdtemp(dir=candidate.parent, prefix=".candidate-"))
        _SHADOWS.append(shadow)
        shutil.copytree(candidate, shadow, dirs_exist_ok=True)
        for f in shadow.glob("*.dc.html"):
            text = f.read_text(encoding="utf-8")
            if not BLOB_RE.search(text):
                continue
            missing = [b for b in set(BLOB_RE.findall(text)) if b not in assets]
            if missing:
                raise BoardError(f"candidate asset {missing[0]} has no entry in assets.json")
            def _mapped(m):
                target = (assets_base / assets[m.group(1)]).resolve()
                return os.path.relpath(target, shadow)
            f.write_text(BLOB_RE.sub(_mapped, text), encoding="utf-8")
        render_candidate = shadow
    cand_canvas = read_canvas(candidate)
    cand_names = [f[:-len(".dc.html")] for f in cand_canvas["boards"]]
    approved_names = list(approved["boards"])
    changed, removed, new = set(), set(), set()
    for name in approved_names:
        if name not in cand_names:
            removed.add(name)
            continue
        rec = approved["boards"][name]
        cand_file = candidate / f"{name}.dc.html"
        cand_size = cand_canvas["boards"][f"{name}.dc.html"]
        approved_file = source / f"{name}.dc.html"
        if hashlib.sha256(_canonical_board(cand_file).encode()).hexdigest() != \
                hashlib.sha256(_canonical_board(approved_file).encode()).hexdigest() or \
                (cand_size["w"], cand_size["h"]) != (rec["w"], rec["h"]):
            changed.add(name)
            continue
        base_assets = _board_assets(name, source)
        cand_assets = _board_assets(name, candidate)
        for src in base_assets | cand_assets:
            base_p, cand_p = source / urllib.parse.unquote(src), candidate / urllib.parse.unquote(src)
            base_h = _file_hash(str(base_p)) if base_p.is_file() else "missing"
            cand_h = _file_hash(str(cand_p)) if cand_p.is_file() else "missing"
            if base_h != cand_h:
                changed.add(name)
                break
    for name in cand_names:
        if name not in approved_names:
            new.add(name)
    ui_changed = _sha256_file(candidate / "ui.css") != approved.get("ui_css_sha256") if (candidate / "ui.css").is_file() else True
    seeds = changed | removed
    affected = set(changed) | set(new)
    for name in cand_names:
        if seeds & set(board_inputs(name, candidate)):
            affected.add(name)
    if ui_changed:
        affected |= set(cand_names)
    # Tokens whose values changed (candidate ui.css :root vars naming a colours role).
    try:
        roles = set(json.loads(pathlib.Path(args.tokens).read_text(encoding="utf-8")).get("roles", {}))
    except (OSError, json.JSONDecodeError) as e:
        raise BoardError(f"{args.tokens} is unreadable ({e}); token changes cannot be reported")
    cand_vars = _root_vars((candidate / "ui.css").read_text(encoding="utf-8")) if (candidate / "ui.css").is_file() else {}
    base_vars = _root_vars((source / "ui.css").read_text(encoding="utf-8"))
    tokens = sorted(n for n in set(cand_vars) | set(base_vars) if cand_vars.get(n) != base_vars.get(n) and n in roles)
    owners = _fidelity_owners(args.todo, sorted(set(cand_names) | set(approved_names)))
    try:
        spec_text = pathlib.Path(args.spec).read_text(encoding="utf-8")
        spec_owner = dict(re.findall(r"^\| (\w+) \|.*\| (D\d+ T\d+ §\d+) \|$", spec_text, re.M))
    except OSError:
        spec_owner = {}
    try:
        cov_all = json.loads((source.parent / "coverage.json").read_text(encoding="utf-8"))
        for key, entry in cov_all.items():
            ref = spec_owner.get(key)
            if not ref:
                continue
            for item in entry.get("items", []):
                b = item.get("board")
                if b and ref not in owners.get(b, []):
                    owners.setdefault(b, []).append(ref)
    except (OSError, json.JSONDecodeError, AttributeError):
        pass
    # Render into staging; publish whole only on success.
    out.parent.mkdir(parents=True, exist_ok=True)
    staging = pathlib.Path(tempfile.mkdtemp(dir=out.parent, prefix=f".{out.name}.new."))
    pages = staging / ".pages"
    pages.mkdir()
    rows = []
    try:
        chrome = find_chromium() if affected - removed else None
        for name in sorted(affected | removed):
            if name in removed:
                shutil.copy2(png_dir / f"{name}.png", staging / f"{name}.before.png")
                rows.append((name, "removed board"))
                continue
            nonce = secrets.token_hex(16)
            page, board = standalone(name, render_candidate, pages, True, nonce, pathlib.Path(args.asset_root))
            page_path = pages / f"{name}.html"
            atomic_write(page_path, page)
            after_path = staging / f"{name}.after.png"
            size = cand_canvas["boards"][f"{name}.dc.html"]
            try:
                audit_page(chrome, page_path, size["w"], size["h"], name, nonce)
                render_png(chrome, page_path, after_path, size["w"], size["h"])
            except BoardError as e:
                raise BoardError(f"{name}: rendering the candidate failed: {e}")
            if name in new:
                rows.append((name, "new board"))
                continue
            before_path = staging / f"{name}.before.png"
            shutil.copy2(png_dir / f"{name}.png", before_path)
            before_im = Image.open(before_path).convert("RGB")
            after_im = Image.open(after_path).convert("RGB")
            w, h = max(before_im.width, after_im.width), max(before_im.height, after_im.height)
            diff_im = Image.new("RGB", (w, h), (255, 0, 255))
            bp, ap, dp = before_im.load(), after_im.load(), diff_im.load()
            overlap_w, overlap_h = min(before_im.width, after_im.width), min(before_im.height, after_im.height)
            total = before_im.width * before_im.height + after_im.width * after_im.height - overlap_w * overlap_h
            diff_count = total - overlap_w * overlap_h
            for y in range(overlap_h):
                for x in range(overlap_w):
                    if bp[x, y] == ap[x, y]:
                        r, g, b = ap[x, y]
                        dp[x, y] = (r // 2, g // 2, b // 2)
                    else:
                        diff_count += 1
            diff_im.crop((0, 0, w, h)).save(staging / f"{name}.diff.png")
            rows.append((name, f"{diff_count / total * 100:.1f}%"))
        token_text = ", ".join(f"{n} ({base_vars.get(n, 'none')} -> {cand_vars.get(n, 'none')})" for n in tokens)
        cand_fp = hashlib.sha256()
        for fname in sorted(cand_canvas["boards"]):
            rec_c = cand_canvas["boards"][fname]
            cand_fp.update(f"{fname}:{hashlib.sha256(_canonical_board(candidate / fname).encode()).hexdigest()}"
                           f":{rec_c['w']}x{rec_c['h']}\n".encode())
            for src in sorted(_board_assets(fname[:-8], candidate)):
                cand_fp.update(f"asset {src}:{_file_hash(str(candidate / urllib.parse.unquote(src)))}\n".encode())
        cand_fp.update(f"ui.css:{_file_hash(str(candidate / 'ui.css'))}\n".encode())
        lines = ["# Design change comparison", "",
                 f"Approved: {approved.get('approved', 'unknown')} | Candidate fingerprint: {cand_fp.hexdigest()[:16]}", "",
                 f"Tokens changed: {token_text if token_text else 'none'}", "",
                 "| Board | Changed | Cause | Images | Sections |", "| ----- | ------- | ----- | ------ | -------- |"]
        if not rows:
            lines.append("| (none) | | | | |")
        for name, share in sorted(rows):
            secs = owners.get(name) or []
            label = ", ".join(secs) if secs else "owner unresolved"
            if name in removed:
                cause, images = "removed", f"[before]({name}.before.png)"
            elif name in new:
                cause, images = "new board", f"[after]({name}.after.png)"
            elif ui_changed and name not in changed:
                cause = "stylesheet"
                images = f"[before]({name}.before.png) [after]({name}.after.png) [diff]({name}.diff.png)"
            elif name in changed:
                cause = "board or artwork changed"
                images = f"[before]({name}.before.png) [after]({name}.after.png) [diff]({name}.diff.png)"
            else:
                cause = "imports a changed part"
                images = f"[before]({name}.before.png) [after]({name}.after.png) [diff]({name}.diff.png)"
            lines.append(f"| {name} | {share} | {cause} | {images} | {label} |")
        atomic_write(staging / "summary.md", "\n".join(lines) + "\n")
        shutil.rmtree(pages)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    backup = out.parent / f".{out.name}.old"
    if backup.exists() and (backup / "summary.md").is_file():
        shutil.rmtree(backup)
    moved = False
    if out.exists():
        os.replace(out, backup)
        moved = True
    os.replace(staging, out)
    if moved:
        shutil.rmtree(backup, ignore_errors=True)
    print(f"export-mockups: {len(rows)} affected board(s); summary in {out / 'summary.md'}")
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
    ex.add_argument("--asset-root", default=str(ASSET_ROOT), help="the folder every board image must sit in (design/)")
    df = sub.add_parser("diff", help="compare a candidate canvas folder with the approved boards")
    df.add_argument("canvas", help="candidate folder holding canvas.json, ui.css and the boards")
    df.add_argument("--source", default=str(SOURCE))
    df.add_argument("--png", default=str(PNG))
    df.add_argument("--out", default=str(ROOT / "build/mockups/diff"))
    df.add_argument("--tokens", default=str(ROOT / "design/tokens/colors.json"))
    df.add_argument("--todo", default=str(ROOT / "todo"))
    df.add_argument("--spec", default=str(ROOT / "design/SPEC.md"))
    df.add_argument("--asset-root", default=str(ASSET_ROOT), help="the folder every board image must sit in (design/)")
    args = ap.parse_args(argv)
    try:
        return {"import": cmd_import, "export": cmd_export, "diff": cmd_diff}[args.cmd](args)
    except ToolError as e:
        print(f"export-mockups: {e}", file=sys.stderr)
        return 2
    except (BoardError, OSError) as e:
        print(f"export-mockups: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("export-mockups: interrupted; run the same command again to finish", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
