#!/usr/bin/env python3
"""Check that the approved designs, their coverage matrix, design/SPEC.md and the tokens agree.

- inventory: every board in design/mockups/approved.json is in source/canvas.json at its approved size, on
  disk with its approved hash, free of canvas asset links, with every image resolving; ui.css matches its
  approved hash; every board has a PNG whose manifest fingerprint matches its current inputs.
- coverage: every design/SPEC.md section 0 row has a design/mockups/coverage.json entry naming each state the
  row lists plus loading, empty and error; each item is shown on a board (evidence text present), marked
  not applicable with a reason, or deferred to a TODO section that resolves.
- spec: every approved board is linked from design/SPEC.md as PNG and source, every linked file exists, each
  row's section names every item of its coverage entry, and every colour the SPEC quotes is a token value.
- tokens: design/tokens/*.json are complete; every pair passes WCAG 2.2 in both themes; every text pair the
  boards render is a listed token pair (the audit must cover every approved board at its current inputs); rendered sizes and board spacings sit on
  the token scales; ui.css agrees with the tokens.

With no --audit, the check renders its own audit of every board first (export-mockups.py export --audit
--no-png into a temporary folder), so one command proves everything. Exit 0 when clean, 1 with one line per
problem, 2 when the audit cannot be rendered.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
THRESHOLD = {"text": 4.5, "large-text": 3.0, "graphic": 3.0}
UNIVERSAL = ("loading", "empty", "error")
EXPORT = ROOT / "design/tools/export-mockups.py"


def export_module():
    spec = importlib.util.spec_from_file_location("export_mockups", EXPORT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load(root, rel):
    return json.loads((pathlib.Path(root) / rel).read_text(encoding="utf-8"))


def luminance(hexcolour):
    h = hexcolour.lstrip("#")[:6]
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    c = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def css_hex(value):
    nums = [int(float(x)) for x in re.findall(r"[\d.]+", value)[:3]]
    return "#%02X%02X%02X" % tuple(nums)


def is_large(size, weight):
    return size >= 24 or (size >= 18.66 and weight >= 700)


def check_inventory(root):
    root = pathlib.Path(root)
    errors = []
    record = load(root, "design/mockups/approved.json")
    approved = record["boards"]
    canvas = load(root, "design/mockups/source/canvas.json")["boards"]
    css = root / "design/mockups/source/ui.css"
    if not css.is_file() or hashlib.sha256(css.read_bytes()).hexdigest() != record.get("ui_css_sha256"):
        errors.append("inventory: ui.css differs from the approved version")
    manifest_path = root / "design/mockups/png/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.is_file() else {}
    export = export_module()
    for name, rec in approved.items():
        b = canvas.get(f"{name}.dc.html")
        if b and (b.get("w"), b.get("h")) != (rec.get("w"), rec.get("h")):
            errors.append(f"inventory: {name} is {b.get('w')}x{b.get('h')} in canvas.json, approved at {rec.get('w')}x{rec.get('h')}")
        path = root / f"design/mockups/source/{name}.dc.html"
        if f"{name}.dc.html" not in canvas:
            errors.append(f"inventory: approved board {name} is missing from canvas.json")
        if not path.is_file():
            errors.append(f"inventory: approved board {name} is missing from design/mockups/source")
            continue
        text = path.read_text(encoding="utf-8")
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != rec["sha256"]:
            errors.append(f"inventory: {name} differs from the approved version")
        if "/_blob/" in text:
            errors.append(f"inventory: {name} still links a canvas asset")
        for tag, _, src, _ in export.SRC_RE.findall(text):
            # The canvas runtime's own <script src> in the head is not a board asset; every other src is.
            if re.match(r"^(data:|#)", src) or tag.lower().startswith("<script"):
                continue
            target = (path.parent / src).resolve()
            if re.match(r"^([a-z]+:|/|\\)", src, re.I) or not target.is_relative_to((root / "design").resolve()):
                errors.append(f"inventory: {name} links {src}, which is outside design/")
            elif not target.is_file():
                errors.append(f"inventory: {name} links {src}, which does not exist")
        png = root / f"design/mockups/png/{name}.png"
        if not png.is_file():
            errors.append(f"inventory: {name} has no PNG in design/mockups/png")
        elif png_size(png) != (rec.get("w"), rec.get("h")):
            errors.append(f"inventory: the PNG of {name} is {png_size(png)}, not its approved {rec.get('w')}x{rec.get('h')}")
        elif b and manifest.get(name) != export.fingerprint(name, root / "design/mockups/source", (b["w"], b["h"])):
            errors.append(f"inventory: the PNG of {name} is stale; run design/tools/export-mockups.py export")
    for board in canvas:
        if board[:-len(".dc.html")] not in approved:
            errors.append(f"inventory: {board} is in canvas.json but was never approved")
    return errors


def png_size(path):
    """A PNG's width and height from its header, or None when the file is not a whole PNG."""
    data = pathlib.Path(path).read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR" or not data.endswith(b"IEND\xaeB`\x82"):
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def section0_rows(root):
    """Row id to its required-content text, from the section 0 tables of design/SPEC.md.

    Page tables give it in the "Purpose and key content" column, the email table in the "Message" column.
    """
    rows = {}
    text = (pathlib.Path(root) / "design/SPEC.md").read_text(encoding="utf-8")
    part = text.split("## 0. Page inventory", 1)[1].split("\n## 1.", 1)[0]
    column = None
    for line in part.splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if cells and cells[0] == "#":
            column = next((i for i, c in enumerate(cells) if c in ("Purpose and key content", "Message")), None)
            continue
        if re.match(r"^[STAMXEN]\d+$", cells[0]) and column is not None:
            rows[cells[0]] = cells[column]
    return rows


def split_top(text, seps=",;"):
    """Split on separators outside parentheses."""
    parts, depth, cur = [], 0, ""
    for ch in text:
        depth += (ch == "(") - (ch == ")")
        if ch in seps and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def norm(item):
    """Compare names without parentheticals, code marks, a label before a colon, or a leading article."""
    item = re.sub(r"\([^)]*\)", "", item).replace("`", "").strip().rstrip(".").lower()
    item = item.split(": ", 1)[-1]
    item = re.sub(r"^(the|a|an|with|and)\s+", "", item)
    return re.sub(r"\s+", " ", item).strip()


def required_items(cell):
    """The controls and content a row names, then the states and variants it lists."""
    head = re.split(r"(?:^|;)\s*(?:states|variants):", cell)[0]
    items = [i for i in split_top(head) if not re.match(r"^(states|variants):", i)]
    for kind in ("states", "variants"):
        m = re.search(rf"{kind}:\s*([^;]+)", cell)
        if m:
            items += split_top(m.group(1), ",")
    return items


def named_states(cell):
    """The states a section 0 row lists after 'states:', in the row's own words."""
    m = re.search(r"states:\s*([^;|]+)", cell)
    if not m:
        return []
    return [s.strip().rstrip(".") for s in split_top(m.group(1), ",")]


def resolver(ref, _graph=[]):
    """Whether a deferral's target is a section of the plan, read exactly as `todo-graph.py resolve` reads it (its
    `extract_ref`: a DNN TNN §N reference, a pasted row or a `<path> §N` pair; exit 0, 3 or 4 meant it exists). The plan
    is built once, in this process: a `resolve` subprocess per deferral rebuilt and validated the whole plan each time,
    83 s of the project script tests for one coverage check (2026-10-31). A plan that does not build resolves nothing,
    as the refused `resolve` did."""
    if not _graph:
        sys.path.insert(0, str(ROOT / "scripts/lib"))
        import todo_graph
        try:
            _graph.append((todo_graph, todo_graph.graph(ROOT)))
        except todo_graph.Refused:
            _graph.append((todo_graph, None))
    module, rows = _graph[0]
    return rows is not None and module.extract_ref(ref, rows)[1] not in (1, 2)


def check_coverage(root, resolve=resolver):
    root = pathlib.Path(root)
    errors = []
    coverage = load(root, "design/mockups/coverage.json")
    approved = load(root, "design/mockups/approved.json")["boards"]
    for part in sorted(set(re.findall(r"^### (P\d+) ", (root / "design/SPEC.md").read_text(encoding="utf-8"), re.M))):
        if part not in coverage:
            errors.append(f"coverage: shared part {part} has no entry")
    for row, entry in coverage.items():
        if not re.fullmatch(r"P\d+", row):
            continue
        for item in entry.get("items", []):
            if "board" in item and item["board"] in approved:
                text = (root / f"design/mockups/source/{item['board']}.dc.html").read_text(encoding="utf-8")
                if not item.get("evidence") or item["evidence"] not in text:
                    errors.append(f"coverage: {row} '{item.get('name')}' evidence is not on {item['board']}")
            elif "board" in item:
                errors.append(f"coverage: {row} '{item.get('name')}' names board {item['board']}, which is not approved")
    for row, cell in section0_rows(root).items():
        entry = coverage.get(row)
        if not entry:
            errors.append(f"coverage: section 0 row {row} has no entry")
            continue
        names = {norm(i.get("name", "")) for i in entry.get("items", [])}
        for state in list(UNIVERSAL) + named_states(cell):
            if norm(state) not in names:
                errors.append(f"coverage: {row} does not account for the state '{state}'")
        for need in required_items(cell):
            if norm(need) not in names and need not in named_states(cell):
                errors.append(f"coverage: {row} does not account for '{need}'")
        for item in entry.get("items", []):
            label = f"{row} '{item.get('name')}'"
            if "board" in item:
                board = item["board"]
                if board not in approved:
                    errors.append(f"coverage: {label} names board {board}, which is not approved")
                    continue
                text = (root / f"design/mockups/source/{board}.dc.html").read_text(encoding="utf-8")
                if not item.get("evidence") or item["evidence"] not in text:
                    errors.append(f"coverage: {label} evidence is not on {board}")
            elif "not_applicable" in item:
                if not item["not_applicable"].strip():
                    errors.append(f"coverage: {label} is not applicable without a reason")
            elif "deferred" in item:
                if not item.get("reason", "").strip():
                    errors.append(f"coverage: {label} is deferred without a reason")
                if not resolve(item["deferred"]):
                    errors.append(f"coverage: {label} defers to {item['deferred']}, which does not resolve")
            else:
                errors.append(f"coverage: {label} is neither shown, not applicable nor deferred")
    return errors


def check_spec(root):
    root = pathlib.Path(root)
    errors = []
    spec = (root / "design/SPEC.md").read_text(encoding="utf-8")
    approved = load(root, "design/mockups/approved.json")["boards"]
    coverage = load(root, "design/mockups/coverage.json")
    for name in approved:
        for link in (f"mockups/png/{name}.png", f"mockups/source/{name}.dc.html"):
            if f"]({link})" not in spec:
                errors.append(f"spec: {link} is not linked from design/SPEC.md")
    tokens = {v.upper() for theme in load(root, "design/tokens/colors.json")["themes"].values() for v in theme.values()}
    for colour in sorted(set(re.findall(r"#[0-9A-Fa-f]{6}\b", spec))):
        if colour.upper() not in tokens:
            errors.append(f"spec: design/SPEC.md quotes {colour}, which is no token value")
    for link in sorted(set(re.findall(r"\]\((mockups/[^)]+)\)", spec))):
        if not (root / "design" / link).is_file():
            errors.append(f"spec: {link} does not exist")
    sections = re.split(r"\n(?=### )", spec.split("\n## 1.", 1)[-1])
    by_row = {}
    for sec in sections:
        m = re.match(r"### ([STAMXENP]\d+) ", sec)
        if m:
            by_row[m.group(1)] = sec
    for row, entry in coverage.items():
        sec = by_row.get(row)
        if sec is None:
            errors.append(f"spec: row {row} has no section")
            continue
        listed = {norm(m) for m in re.findall(r"^- ([^:\n]+):", sec, re.M)}
        for item in entry.get("items", []):
            if norm(item.get("name", "")) not in listed:
                errors.append(f"spec: {row} does not list '{item.get('name')}'")
    return errors


def check_tokens(root, audit=None):
    root = pathlib.Path(root)
    errors = []
    colors = load(root, "design/tokens/colors.json")
    typo = load(root, "design/tokens/typography.json")
    space = load(root, "design/tokens/spacing.json")
    themes = colors["themes"]
    names = set(colors["roles"])
    for theme, values in themes.items():
        if set(values) != names:
            errors.append(f"tokens: the {theme} theme does not define exactly the named roles")
    for p in colors["pairs"]:
        for theme in ("light", "dark"):
            fg, bg = themes[theme].get(p["fg"]), themes[theme].get(p["bg"])
            if not fg or not bg:
                errors.append(f"tokens: pair {p['fg']} on {p['bg']} names an unknown token")
                break
            ratio = contrast(fg, bg)
            if ratio < THRESHOLD[p["use"]]:
                errors.append(f"tokens: {p['fg']} on {p['bg']} is {ratio:.2f}:1 in the {theme} theme, below {THRESHOLD[p['use']]}")
            if abs(ratio - p.get(theme, 0)) > 0.01:
                errors.append(f"tokens: {p['fg']} on {p['bg']} records {p.get(theme)} for the {theme} theme, computed {ratio:.2f}")
    if audit is not None:
        approved = load(root, "design/mockups/approved.json")["boards"]
        canvas = load(root, "design/mockups/source/canvas.json")["boards"]
        export = export_module()
        for name in approved:
            b = canvas.get(f"{name}.dc.html")
            if name not in audit:
                errors.append(f"tokens: the audit has no entry for {name}")
            elif b and audit[name].get("fingerprint") != export.fingerprint(name, root / "design/mockups/source", (b["w"], b["h"])):
                errors.append(f"tokens: the audit of {name} is stale")
        light = themes["light"]
        listed, boundaries = {}, set()
        for p in colors["pairs"]:
            pair = (light[p["fg"]].upper(), light[p["bg"]].upper())
            if p["use"] == "graphic":
                boundaries.add(pair)
            else:
                listed.setdefault(pair, []).append(p["use"])
        scale = typo["scale"]
        for board, data in sorted(audit.items()):
            for t in data["pairs"]:
                if t["illustration"]:
                    continue
                key = (css_hex(t["fg"]), css_hex(t["bg"]))
                if t.get("kind") == "boundary":
                    if key not in boundaries:
                        errors.append(f"tokens: {board} draws a control boundary {key[0]} on {key[1]}, which is no graphic token pair")
                    continue
                uses = listed.get(key)
                if not uses:
                    errors.append(f"tokens: {board} renders {key[0]} on {key[1]} ('{t['sample']}'), which is no token pair")
                elif "text" not in uses and not is_large(t["size"], t["weight"]):
                    errors.append(f"tokens: {board} renders {key[0]} on {key[1]} at {t['size']} px, listed for large text only")
                if min(abs(t["size"] - s) for s in scale) > 2:
                    errors.append(f"tokens: {board} renders {t['size']} px text, more than 2 px from the type scale")
    css = (root / "design/mockups/source/ui.css").read_text(encoding="utf-8")
    roles = typo["roles"]
    rules = {"h1": r"\nh1 \{[^}]*font-size: (\d+)px", "h2": r"\nh2 \{[^}]*font-size: (\d+)px", "h3": r"\nh3 \{[^}]*font-size: (\d+)px",
             "h4": r"\nh4 \{[^}]*font-size: (\d+)px", "body": r"\nbody \{[^}]*font-size: (\d+)px", "small": r"\n\.small \{[^}]*font-size: (\d+)px",
             "tiny": r"\n\.tiny \{[^}]*font-size: (\d+)px", "eyebrow": r"\n\.eyebrow \{[^}]*font-size: (\d+)px", "mono": r"\n\.mono \{[^}]*font-size: (\d+)px",
             "label": r"\n\.label \{[^}]*font-size: (\d+)px", "button": r"\n\.btn \{[^}]*font-size: (\d+)px", "button-small": r"\n\.btn-sm \{[^}]*font-size: (\d+)px",
             "pill": r"\n\.pill \{[^}]*font-size: (\d+)px", "table": r"\n\.table \{[^}]*font-size: (\d+)px", "table-header": r"\n\.table th \{[^}]*font-size: (\d+)px"}
    for role, pattern in rules.items():
        if role not in roles:
            errors.append(f"tokens: typography role {role} is missing")
            continue
        m = re.search(pattern, css)
        if not m:
            errors.append(f"tokens: ui.css has no font size for {role}")
        elif int(m.group(1)) != roles[role]["size"]:
            errors.append(f"tokens: ui.css sets {role} to {m.group(1)} px, the token says {roles[role]['size']} px")
        elif roles[role]["size"] not in typo["scale"]:
            errors.append(f"tokens: role {role} size {roles[role]['size']} is not on the type scale")
    values = {v.upper() for theme in (themes["light"],) for v in theme.values()}
    for colour in sorted(set(c.upper() for c in re.findall(r"#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b", css))):
        if colour not in values:
            errors.append(f"tokens: ui.css uses {colour}, which is no token value")
    for band in ("safe", "sus", "mal", "partial"):
        if not re.search(rf"\.band-{band} \{{[^}}]*background: var\(--{band}-band\)", css):
            errors.append(f"tokens: .band-{band} must fill with --{band}-band, the role its dark value is checked under")
    for role in ("display", "h1", "h2", "h3", "h4", "body", "small", "tiny", "label", "button", "button-small", "pill",
                 "table", "table-header", "eyebrow", "mono", "figure"):
        if role not in roles:
            errors.append(f"tokens: typography role {role} is missing")
    for role in ("h1", "h2", "h3", "h4"):
        m = re.search(rf"\n{role} \{{[^}}]*font-weight: (\d+)", css)
        if role in roles and (not m or int(m.group(1)) != roles[role]["weight"]):
            errors.append(f"tokens: ui.css {role} weight disagrees with typography.json")
    for selector, key, token in ((r"\.btn", "height", space["control-height"]["default"]),
                                 (r"\.btn-sm", "height", space["control-height"]["small"]),
                                 (r"\.input", "height", space["control-height"]["default"]),
                                 (r"\.btn", "border-radius", space["radius"]["control"]),
                                 (r"\.btn-sm", "border-radius", space["radius"]["control-small"]),
                                 (r"\.input", "border-radius", space["radius"]["control"]),
                                 (r"\.pill", "border-radius", space["radius"]["pill"])):
        m = re.search(rf"\n{selector} \{{[^}}]*?\b{key}: (\d+)px", css)
        if not m or int(m.group(1)) != token:
            errors.append(f"tokens: ui.css {selector.lstrip(chr(92))} {key} disagrees with spacing.json ({token} px)")
    m = re.search(r"--shadow: ([^;]+);", css)
    if not m or m.group(1).strip() != space["shadow"]["card"]:
        errors.append("tokens: ui.css --shadow disagrees with spacing.json")
    for var, token in (("--radius", space["radius"]["card"]), ("--radius-lg", space["radius"]["card-large"])):
        m = re.search(rf"{var}: (\d+)px", css)
        if not m or int(m.group(1)) != token:
            errors.append(f"tokens: ui.css {var} disagrees with spacing.json ({token} px)")
    for var, value in themes["light"].items():
        m = re.search(rf"--{re.escape(var)}: (#[0-9A-Fa-f]{{6}});", css)
        if m and m.group(1).upper() != value.upper():
            errors.append(f"tokens: ui.css --{var} is {m.group(1)}, the light token is {value}")
    steps = space["scale"]
    for path in sorted((root / "design/mockups/source").glob("*.dc.html")) + [root / "design/mockups/source/ui.css"]:
        text = path.read_text(encoding="utf-8")
        for decl in re.findall(r"(?:gap|padding|margin)(?:-[a-z]+)?:\s*([0-9px\s()calc+*/-]+?)(?:;|\"|'|\})", text):
            for value in re.findall(r"(\d+)px", decl):
                v = int(value)
                if v and min(abs(v - s) for s in steps) > 2:
                    errors.append(f"tokens: {path.name.removesuffix('.dc.html')} uses {v} px spacing, more than 2 px from the spacing scale")
    return errors


def render_audit(out):
    """Render the audit of every board; boards whose audit failed are missing from it, so check_tokens names them."""
    run = subprocess.run([sys.executable, str(EXPORT), "export", "--audit", "--no-png", "--out", str(out)],
                         capture_output=True, text=True, timeout=1200)
    if run.returncode == 2:
        raise SystemExit(f"check-design: cannot render the audit: {run.stderr.strip()}")
    for line in run.stderr.strip().splitlines():
        print(line, file=sys.stderr)
    path = pathlib.Path(out) / "audit.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--audit", help="use this audit (from export-mockups.py export --audit) instead of rendering one")
    args = ap.parse_args(argv)
    errors = check_inventory(ROOT) + check_coverage(ROOT) + check_spec(ROOT)
    if args.audit:
        audit = json.loads(pathlib.Path(args.audit).read_text(encoding="utf-8"))
    else:
        try:
            with tempfile.TemporaryDirectory() as out:
                audit = render_audit(out)
        except SystemExit as e:
            print(e, file=sys.stderr)
            return 2
    errors += check_tokens(ROOT, audit)
    for e in errors:
        print(f"check-design: {e}", file=sys.stderr)
    print(f"check-design: {len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
