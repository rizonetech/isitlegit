#!/usr/bin/env python3
"""The Loupe 1.1 sources as JSONL rows for scripts/glimmer/import-new.ts (D03 T04 §44).

    python3 -I scripts/glimmer/new_rows.py <ows|phishingeval-ji|phishdecloaker>

Reads `<store>/raw/<source>/` as downloaded (each file verified against its Zenodo MD5 in `download.jsonl`,
bound as `INPUTS.json` on the first run) and writes `rows.jsonl`, `EXPORT.json` and `ITEMS.jsonl` beside it, in
PhreshPhish's row shape: `{sha256: <item id>, url, html, label: phish|benign, target, screenshot?}`. Archives are
read entry by entry in memory, never extracted, and nothing is rendered here. Brand (`target`) is a grouping
hint only: the importer stores it with label source `grouping-only`, never as trusted truth (D03 T04 §45).

Source shapes, as inspected on 2026-11-01:
- `ows`: `malicious_OWS_URL_HTML_DS.jsonl`, one JSON object a page with its HTML. Only `sublabel: Phishing`
  (26,213 of 40,000) becomes a lure row; Malware, Defacement, Spam and Risky are rejected, not relabelled.
- `phishingeval-ji`: `phishing4190.zip` (APWG pages, an HTML and PNG pair a page, all phishing),
  `crawl_benign.zip` (110 brands' real login pages: `login.html`, `login.png` and the page's URL in a `.txt`),
  `archive100.zip` (archived real brand pages, HTML and screenshot a timestamp, all benign) and
  `expand277.zip` (phishing screenshots a brand folder, with the brand's page HTML in the folder's `.txt`).
- `phishdecloaker`: `phishing-kits-dataset.zip` only: each kit's largest static HTML file as one lure page.
  Its ablation and landscape sets are screenshot sets with detection boxes and no page label, so no row is
  made from them; they wait for teacher labelling, and the kits' PHP is never run.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inputs as inputs_module
from inputs import Limits, Receipt, build, verify
from staging import remove_dead_staging

MAX_ENTRY = 20 * 1024 * 1024
LICENCE = "CC BY 4.0"


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def decode(data):
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    match = re.search(rb"<meta[^>]+charset\s*=\s*[\"']?\s*([\w.:-]+)", data[:1024], re.IGNORECASE)
    if match:
        try:
            return data.decode(match.group(1).decode("ascii"), errors="replace")
        except LookupError:
            pass
    return data.decode("utf-8", errors="replace")


def item_id(*parts):
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part if isinstance(part, bytes) else part.encode("utf-8"))
        digest.update(b"\0")
    return digest.hexdigest()


def ensure_inputs(folder, names):
    """Bind the downloaded files as INPUTS.json from download.jsonl's publisher MD5s, once; then verify."""
    if not (folder / "INPUTS.json").is_file():
        wanted = {}
        for line in (folder / "download.jsonl").read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            wanted[Path(entry["dest"]).name] = entry["md5"]
        files = [
            {"name": name, "published": {"kind": "md5", "value": wanted[name]}, "pinned": None}
            for name in names
            if name in wanted
        ]
        missing = [name for name in names if name not in wanted]
        if missing:
            raise inputs_module.Refused(f"download.jsonl does not name {missing}")
        build(folder, files, LICENCE)
    return verify(folder, names)


class Rows:
    def __init__(self, folder, receipt, limits):
        self.folder = folder
        self.receipt = receipt
        self.limits = limits
        self.temporary = folder / f".rows.jsonl.{os.getpid()}.tmp"
        self.sink = self.temporary.open("w", encoding="utf-8")

    def add(self, item, url, html, label, target=None, screenshot=None):
        self.limits.check_deadline()
        self.limits.count_entry()
        row = {"sha256": item, "url": url, "html": html, "label": label, "target": target}
        if screenshot is not None:
            row["screenshot"] = base64.b64encode(screenshot).decode("ascii")
        self.sink.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.receipt.export(item)

    def reject(self, item, reason):
        self.receipt.reject(reason, item)

    def close(self):
        self.sink.close()
        os.replace(self.temporary, self.folder / "rows.jsonl")


def read_entry(archive, info, limits):
    if info.is_dir() or info.file_size > MAX_ENTRY:
        return None
    limits.count_entry(info.file_size)
    return archive.read(info)


def convert_ows(folder, receipt, limits, out):
    name = "malicious_OWS_URL_HTML_DS.jsonl"
    with (folder / name).open(encoding="utf-8") as lines:
        for line in lines:
            limits.check_deadline()
            if not line.strip():
                continue
            page = json.loads(line)
            html = page.get("html") or ""
            item = item_id("ows", page.get("url") or "", html)
            if page.get("label") != "Malicious" or page.get("sublabel") != "Phishing":
                out.reject(item, f"sublabel {page.get('sublabel') or 'unknown'} is not a phishing page")
                continue
            if not html:
                out.reject(item, "no HTML in the record")
                continue
            out.add(item, page.get("url"), html, "phish")


def convert_phishingeval(folder, receipt, limits, out):
    with zipfile.ZipFile(folder / "phishing4190.zip") as archive:
        names = {info.filename: info for info in archive.infolist()}
        for name, info in sorted(names.items()):
            if not name.endswith(".html"):
                continue
            html = read_entry(archive, info, limits)
            if html is None:
                continue
            shot_info = names.get(name[: -len(".html")] + ".png")
            shot = read_entry(archive, shot_info, limits) if shot_info else None
            out.add(item_id("phishing4190", name), None, decode(html), "phish", screenshot=shot)
    with zipfile.ZipFile(folder / "crawl_benign.zip") as archive:
        names = {info.filename: info for info in archive.infolist()}
        for name, info in sorted(names.items()):
            if not name.endswith("/login.html"):
                continue
            brand = name.split("/")[-2]
            html = read_entry(archive, info, limits)
            if html is None:
                continue
            shot_info = names.get(name[: -len("login.html")] + "login.png")
            shot = read_entry(archive, shot_info, limits) if shot_info else None
            url = None
            # The page's URL sits in `login.txt`; the `<hash>-login.txt` beside it holds detection coordinates.
            candidates = sorted(
                (n for n in names if n.startswith(name[: -len("login.html")]) and n.endswith("login.txt")),
                key=lambda n: 0 if n.endswith("/login.txt") else 1,
            )
            for candidate in candidates:
                text = read_entry(archive, names[candidate], limits)
                if text:
                    value = decode(text).strip()
                    if value.startswith("http"):
                        url = value
                        break
            out.add(item_id("crawl_benign", name), url, decode(html), "benign", target=brand, screenshot=shot)
    with zipfile.ZipFile(folder / "archive100.zip") as archive:
        names = {info.filename: info for info in archive.infolist()}
        for name, info in sorted(names.items()):
            if not name.endswith(".html"):
                continue
            brand = name.split("/")[1] if name.count("/") > 1 else None
            html = read_entry(archive, info, limits)
            if html is None:
                continue
            shot_name = next((n for n in names if n.startswith(name.rsplit("/", 1)[0] + "/") and n.endswith(".png")), None)
            shot = read_entry(archive, names[shot_name], limits) if shot_name else None
            out.add(
                item_id("archive100", name),
                f"https://{brand}/" if brand else None,
                decode(html),
                "benign",
                target=brand,
                screenshot=shot,
            )
    with zipfile.ZipFile(folder / "expand277.zip") as archive:
        names = {info.filename: info for info in archive.infolist()}
        folders = {}
        for name in names:
            parts = name.split("/")
            if len(parts) > 2:
                folders.setdefault(parts[1], []).append(name)
        for brand, entries in sorted(folders.items()):
            html = ""
            for suffix in ("login_html.txt", "homepage_html.txt"):
                candidate = next((n for n in entries if n.endswith(suffix)), None)
                if candidate:
                    data = read_entry(archive, names[candidate], limits)
                    if data:
                        html = decode(data)
                        break
            for name in sorted(entries):
                if not name.endswith(".png"):
                    continue
                shot = read_entry(archive, names[name], limits)
                if shot is None:
                    continue
                out.add(item_id("expand277", name), None, html, "phish", target=brand, screenshot=shot)


def convert_phishdecloaker(folder, receipt, limits, out):
    with zipfile.ZipFile(folder / "phishing-kits-dataset.zip") as archive:
        kits = {}
        all_kits = set()
        for info in archive.infolist():
            parts = info.filename.split("/")
            if len(parts) > 2 and not info.is_dir():
                all_kits.add(parts[1])
            if len(parts) > 2 and info.filename.endswith(".html") and not info.is_dir():
                kits.setdefault(parts[1], []).append(info)
        for kit in sorted(all_kits - set(kits)):
            out.reject(item_id("kit", kit), "the kit holds no static HTML page")
        for kit, infos in sorted(kits.items()):
            largest = max(infos, key=lambda i: i.file_size)
            data = read_entry(archive, largest, limits)
            if data is None:
                out.reject(item_id("kit", kit), "the kit's largest HTML file is over the entry limit")
                continue
            out.add(item_id("kit", kit, largest.filename), None, decode(data), "phish")


def convert_putra(folder, receipt, limits, out):
    import csv

    csv.field_size_limit(64 * 1024 * 1024)
    by_id = {}
    for csv_name, label in (("phishing.csv", "phish"), ("not-phishing.csv", "benign")):
        with (folder / csv_name).open(encoding="utf-8", errors="replace", newline="") as handle:
            for record in csv.DictReader(handle):
                limits.check_deadline()
                by_id[record["_id"]] = (record.get("url") or None, record.get("brands") or "", label)
    zips = [
        ("phishing_0001-0500.zip", "phish"),
        ("phishing_0501-1000.zip", "phish"),
        ("phishing_1001-1500.zip", "phish"),
        ("phishing_1501-2000.zip", "phish"),
        ("not-phishing_0001-0500.zip", "benign"),
    ]
    for zip_name, label in zips:
        with zipfile.ZipFile(folder / zip_name) as archive:
            names = {info.filename: info for info in archive.infolist()}
            sites = sorted({name.split("/")[0] for name in names if "/" in name})
            for site in sites:
                limits.check_deadline()
                html_info = names.get(f"{site}/original.html") or names.get(f"{site}/index.html")
                if html_info is None:
                    out.reject(item_id("putra", site), "the site folder holds no page HTML")
                    continue
                html = read_entry(archive, html_info, limits)
                if html is None:
                    out.reject(item_id("putra", site), "the site's page HTML is over the entry limit")
                    continue
                shot = None
                for candidate in ("screenshots/original_js_on.jpg", "screenshots/index_js_on.jpg"):
                    shot_info = names.get(f"{site}/{candidate}")
                    if shot_info is not None:
                        shot = read_entry(archive, shot_info, limits)
                        if shot is not None:
                            break
                url, brands, csv_label = by_id.get(site, (None, "", label))
                if csv_label != label:
                    out.reject(item_id("putra", site), "the zip and the CSV disagree on the label")
                    continue
                target = None
                try:
                    parsed = json.loads(brands) if brands else []
                    if isinstance(parsed, list) and parsed:
                        target = str(parsed[0])
                except json.JSONDecodeError:
                    target = None
                out.add(item_id("putra", site), url, decode(html), label, target=target, screenshot=shot)


CONVERTERS = {
    "ows": (convert_ows, ["malicious_OWS_URL_HTML_DS.jsonl", "OWS_URL_DS.csv"]),
    "phishingeval-ji": (
        convert_phishingeval,
        ["phishing4190.zip", "crawl_benign.zip", "archive100.zip", "expand277.zip", "README.md"],
    ),
    "phishdecloaker": (
        convert_phishdecloaker,
        ["ablation-dataset.zip", "phishing-kits-dataset.zip", "landscape-dataset.zip"],
    ),
    "putra": (
        convert_putra,
        [
            "phishing_0001-0500.zip",
            "phishing_0501-1000.zip",
            "phishing_1001-1500.zip",
            "phishing_1501-2000.zip",
            "not-phishing_0001-0500.zip",
            "phishing.csv",
            "not-phishing.csv",
            "brands.csv",
        ],
    ),
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=sorted(CONVERTERS))
    args = parser.parse_args()
    convert, names = CONVERTERS[args.source]
    folder = store_dir() / "raw" / args.source
    try:
        _, inputs_digest = ensure_inputs(folder, names)
    except inputs_module.Refused as error:
        print(f"new-rows: refused ({error})", file=sys.stderr)
        return 1
    remove_dead_staging(folder)
    receipt, limits = Receipt(), Limits()
    out = Rows(folder, receipt, limits)
    try:
        convert(folder, receipt, limits, out)
        out.close()
    except inputs_module.Refused as error:
        print(f"new-rows: refused ({error})", file=sys.stderr)
        return 1
    rows_digest = inputs_module.file_digest(folder / "rows.jsonl")
    receipt.write(folder, folder / "rows.jsonl", Path(__file__), inputs_digest)
    receipt.write_items(folder, inputs_digest, rows_digest)
    print(f"new-rows: {args.source}: {receipt.exported} rows exported, {sum(receipt.rejected.values())} rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
