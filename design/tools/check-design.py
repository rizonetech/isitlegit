#!/usr/bin/env python3
"""Check that the approved designs, their coverage matrix, design/SPEC.md and the tokens agree.

- inventory: every board in design/mockups/approved.json is in source/canvas.json, on disk with its approved
  hash, free of canvas asset links, with every src resolving and a PNG in design/mockups/png/.
- coverage: every design/SPEC.md section 0 row has a design/mockups/coverage.json entry naming each state the
  row lists plus loading, empty and error; each item is shown on a board (evidence text present), marked
  not applicable with a reason, or deferred to a TODO section that resolves.
- spec: every approved board is linked from design/SPEC.md as PNG and source, every linked file exists, and
  each row's section names every item of its coverage entry.
- tokens: design/tokens/*.json are complete; every pair passes WCAG 2.2 in both themes; every text pair the
  boards render (build/mockups/audit.json) is a listed token pair; rendered sizes and board spacings sit on
  the token scales; ui.css agrees with the tokens.

Exit 0 when clean, 1 with one line per problem.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
THRESHOLD = {"text": 4.5, "large-text": 3.0, "graphic": 3.0}
UNIVERSAL = ("loading", "empty", "error")


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
    approved = load(root, "design/mockups/approved.json")["boards"]
    canvas = load(root, "design/mockups/source/canvas.json")["boards"]
    for name, rec in approved.items():
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
        for src in re.findall(r'<(?:img|source)\b[^>]*\bsrc="([^"]+)"', text):
            if not re.match(r"^(data:|https?:|#)", src) and not (path.parent / src).resolve().is_file():
                errors.append(f"inventory: {name} links {src}, which does not exist")
        if not (root / f"design/mockups/png/{name}.png").is_file():
            errors.append(f"inventory: {name} has no PNG in design/mockups/png")
    for board in canvas:
        if board[:-len(".dc.html")] not in approved:
            errors.append(f"inventory: {board} is in canvas.json but was never approved")
    return errors


def section0_rows(root):
    """Row id to its content cell text, from the section 0 tables of design/SPEC.md."""
    rows = {}
    text = (pathlib.Path(root) / "design/SPEC.md").read_text(encoding="utf-8")
    part = text.split("## 0. Page inventory", 1)[1].split("\n## 1.", 1)[0]
    for line in part.splitlines():
        m = re.match(r"^\|\s*([STAMXEN]\d+)\s*\|(.*)\|\s*$", line)
        if m:
            rows[m.group(1)] = m.group(2)
    return rows


def named_states(cell):
    """The states a section 0 row lists after 'states:', in the row's own words."""
    m = re.search(r"states:\s*([^;|]+)", cell)
    if not m:
        return []
    return [s.strip().rstrip(".") for s in m.group(1).split(",") if s.strip()]


def resolver(ref, _cache={}):
    if ref not in _cache:
        run = subprocess.run([sys.executable, str(ROOT / "scripts/todo-graph.py"), "resolve", ref],
                             capture_output=True, text=True, cwd=ROOT)
        _cache[ref] = run.returncode in (0, 3, 4)
    return _cache[ref]


def check_coverage(root, resolve=resolver):
    root = pathlib.Path(root)
    errors = []
    coverage = load(root, "design/mockups/coverage.json")
    approved = load(root, "design/mockups/approved.json")["boards"]
    for row, cell in section0_rows(root).items():
        entry = coverage.get(row)
        if not entry:
            errors.append(f"coverage: section 0 row {row} has no entry")
            continue
        names = {i.get("name", "").strip().lower() for i in entry.get("items", [])}
        for state in list(UNIVERSAL) + named_states(cell):
            if state.lower() not in names:
                errors.append(f"coverage: {row} does not account for the state '{state}'")
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
    for link in sorted(set(re.findall(r"\]\((mockups/[^)]+)\)", spec))):
        if not (root / "design" / link).is_file():
            errors.append(f"spec: {link} does not exist")
    sections = re.split(r"\n(?=### )", spec.split("\n## 1.", 1)[-1])
    by_row = {}
    for sec in sections:
        m = re.match(r"### ([STAMXEN]\d+) ", sec)
        if m:
            by_row[m.group(1)] = sec
    for row, entry in coverage.items():
        sec = by_row.get(row)
        if sec is None:
            errors.append(f"spec: row {row} has no section")
            continue
        listed = {m.strip().lower() for m in re.findall(r"^- ([^:\n]+):", sec, re.M)}
        for item in entry.get("items", []):
            if item.get("name", "").strip().lower() not in listed:
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
        light = themes["light"]
        listed = {}
        for p in colors["pairs"]:
            if p["use"] != "graphic":
                listed.setdefault((light[p["fg"]].upper(), light[p["bg"]].upper()), []).append(p["use"])
        scale = typo["scale"]
        for board, data in sorted(audit.items()):
            for t in data["pairs"]:
                if t["illustration"]:
                    continue
                key = (css_hex(t["fg"]), css_hex(t["bg"]))
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
    for var, token in (("--radius", space["radius"]["card"]), ("--radius-lg", space["radius"]["card-large"])):
        m = re.search(rf"{var}: (\d+)px", css)
        if not m or int(m.group(1)) != token:
            errors.append(f"tokens: ui.css {var} disagrees with spacing.json ({token} px)")
    for var, value in themes["light"].items():
        m = re.search(rf"--{re.escape(var)}: (#[0-9A-Fa-f]{{6}});", css)
        if m and m.group(1).upper() != value.upper():
            errors.append(f"tokens: ui.css --{var} is {m.group(1)}, the light token is {value}")
    steps = space["scale"]
    for path in sorted((root / "design/mockups/source").glob("*.dc.html")):
        text = path.read_text(encoding="utf-8")
        for decl in re.findall(r"(?:gap|padding|margin)(?:-[a-z]+)?:\s*([0-9px\s]+?)(?:;|\"|')", text):
            for value in re.findall(r"(\d+)px", decl):
                v = int(value)
                if v and min(abs(v - s) for s in steps) > 2:
                    errors.append(f"tokens: {path.name[:-len('.dc.html')]} uses {v} px spacing, more than 2 px from the spacing scale")
    return errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--audit", default=str(ROOT / "build/mockups/audit.json"),
                    help="audit written by export-mockups.py export --audit")
    args = ap.parse_args(argv)
    audit_path = pathlib.Path(args.audit)
    errors = check_inventory(ROOT) + check_coverage(ROOT) + check_spec(ROOT)
    if not audit_path.is_file():
        errors.append(f"tokens: no audit at {audit_path}; run design/tools/export-mockups.py export --audit")
        errors += check_tokens(ROOT)
    else:
        errors += check_tokens(ROOT, json.loads(audit_path.read_text(encoding="utf-8")))
    for e in errors:
        print(f"check-design: {e}", file=sys.stderr)
    print(f"check-design: {len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
