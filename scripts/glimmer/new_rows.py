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
import shutil
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inputs as inputs_module
from inputs import Limits, Receipt, build, verify
from staging import remove_dead_staging

MAX_ENTRY = 20 * 1024 * 1024
LICENCE = "CC BY 4.0"
MIN_FREE_BYTES = 300 * 1000 * 1000 * 1000

NEW_SOURCE_POLICY = {
    "van-dooremaal-ares-2021": {
        "default_max": 30000,
        "seed": 20261101,
        "max_sampled_out": 95938,
        "min_exported": {"phish": 14999, "benign": 14993},
    },
    "putra": {
        "default_max": None,
        "seed": 20261101,
        "max_sampled_out": 0,
        "min_exported": {"phish": 1994, "benign": 500},
    },
    "ows": {
        "default_max": None,
        "seed": 20261101,
        "max_sampled_out": 0,
        "min_exported": {"phish": 25189, "benign": 0},
    },
    "phishdecloaker": {
        "default_max": None,
        "seed": 20261101,
        "max_sampled_out": 0,
        "min_exported": {"phish": 60, "benign": 0},
    },
    "phishingeval-ji": {
        "default_max": None,
        "seed": 20261101,
        "max_sampled_out": 0,
        "min_exported": {"phish": 7202, "benign": 2610},
    },
}


def check_free_space(folder, min_free=MIN_FREE_BYTES, usage_fn=shutil.disk_usage):
    if not min_free or min_free <= 0:
        return 0
    free = int(usage_fn(folder).free)
    if free < min_free:
        raise inputs_module.Refused(
            f"only {free} bytes free under {folder}; at least {min_free} bytes must stay free"
        )
    return free


def check_export_coverage(source, receipt, by_label, policy=NEW_SOURCE_POLICY):
    spec = policy.get(source)
    if not spec:
        return
    if receipt.sampled_out > spec["max_sampled_out"]:
        raise inputs_module.Refused(
            f"{source}: sampled out {receipt.sampled_out} items, over the {spec['max_sampled_out']} sampling cap"
        )
    for label, floor in spec["min_exported"].items():
        actual = int(by_label.get(label, 0))
        if actual < floor:
            raise inputs_module.Refused(
                f"{source}: exported {actual} {label} rows, below the {floor} policy floor"
            )


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
    def __init__(self, folder, receipt, limits, min_free=0, usage_fn=shutil.disk_usage):
        self.folder = folder
        self.receipt = receipt
        self.limits = limits
        self.min_free = min_free
        self.usage_fn = usage_fn
        self.by_label = {"phish": 0, "benign": 0}
        self.check_space()
        self.temporary = folder / f".rows.jsonl.{os.getpid()}.tmp"
        self.sink = self.temporary.open("w", encoding="utf-8")

    def check_space(self):
        check_free_space(self.folder, self.min_free, self.usage_fn)

    def add(self, item, url, html, label, target=None, screenshot=None):
        self.limits.check_deadline()
        self.limits.count_entry()
        self.check_space()
        row = {"sha256": item, "url": url, "html": html, "label": label, "target": target}
        if screenshot is not None:
            row["screenshot"] = base64.b64encode(screenshot).decode("ascii")
        self.sink.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.by_label[label] = self.by_label.get(label, 0) + 1
        self.receipt.export(item)

    def reject(self, item, reason):
        self.receipt.reject(reason, item)

    def close(self):
        self.check_space()
        self.sink.close()
        os.replace(self.temporary, self.folder / "rows.jsonl")

    def close_staged(self):
        self.check_space()
        self.sink.close()
        return self.temporary

    def cleanup(self):
        try:
            self.sink.close()
        except Exception:
            pass
        self.temporary.unlink(missing_ok=True)


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
            receipt.note_inventory(item)
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
            item = item_id("phishing4190", name)
            receipt.note_inventory(item)
            html = read_entry(archive, info, limits)
            if html is None:
                out.reject(item, "over the entry limit")
                continue
            shot_info = names.get(name[: -len(".html")] + ".png")
            shot = read_entry(archive, shot_info, limits) if shot_info else None
            out.add(item, None, decode(html), "phish", screenshot=shot)
    with zipfile.ZipFile(folder / "crawl_benign.zip") as archive:
        names = {info.filename: info for info in archive.infolist()}
        for name, info in sorted(names.items()):
            if not name.endswith("/login.html"):
                continue
            brand = name.split("/")[-2]
            item = item_id("crawl_benign", name)
            receipt.note_inventory(item)
            html = read_entry(archive, info, limits)
            if html is None:
                out.reject(item, "over the entry limit")
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
            out.add(item, url, decode(html), "benign", target=brand, screenshot=shot)
    with zipfile.ZipFile(folder / "archive100.zip") as archive:
        names = {info.filename: info for info in archive.infolist()}
        for name, info in sorted(names.items()):
            if not name.endswith(".html"):
                continue
            brand = name.split("/")[1] if name.count("/") > 1 else None
            item = item_id("archive100", name)
            receipt.note_inventory(item)
            html = read_entry(archive, info, limits)
            if html is None:
                out.reject(item, "over the entry limit")
                continue
            shot_name = next((n for n in names if n.startswith(name.rsplit("/", 1)[0] + "/") and n.endswith(".png")), None)
            shot = read_entry(archive, names[shot_name], limits) if shot_name else None
            out.add(
                item,
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
                item = item_id("expand277", name)
                receipt.note_inventory(item)
                shot = read_entry(archive, names[name], limits)
                if shot is None:
                    out.reject(item, "over the entry limit")
                    continue
                out.add(item, None, html, "phish", target=brand, screenshot=shot)


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
            item = item_id("kit", kit)
            receipt.note_inventory(item)
            out.reject(item, "the kit holds no static HTML page")
        for kit, infos in sorted(kits.items()):
            largest = max(infos, key=lambda i: i.file_size)
            data = read_entry(archive, largest, limits)
            if data is None:
                item = item_id("kit", kit)
                receipt.note_inventory(item)
                out.reject(item, "the kit's largest HTML file is over the entry limit")
                continue
            item = item_id("kit", kit, largest.filename)
            receipt.note_inventory(item)
            out.add(item, None, decode(data), "phish")


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
                item = item_id("putra", site)
                receipt.note_inventory(item)
                html_info = names.get(f"{site}/original.html") or names.get(f"{site}/index.html")
                if html_info is None:
                    out.reject(item, "the site folder holds no page HTML")
                    continue
                html = read_entry(archive, html_info, limits)
                if html is None:
                    out.reject(item, "the site's page HTML is over the entry limit")
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
                    out.reject(item, "the zip and the CSV disagree on the label")
                    continue
                target = None
                try:
                    parsed = json.loads(brands) if brands else []
                    if isinstance(parsed, list) and parsed:
                        target = str(parsed[0])
                except json.JSONDecodeError:
                    target = None
                out.add(item, url, decode(html), label, target=target, screenshot=shot)


def convert_ares(folder, receipt, limits, out, max_per_label=None, seed=20261101):
    """Each archive holds `<root>/files/<hash>/page.html` and `screen.png` a site (24,714 benign, 100,000
    phishing), with its URL (and, for phishing, its brand) in the archive's SQLite database: benign in
    `odp_urls` keyed by `sha256`, phishing in `urls` keyed by `sha1` with a `brand` column. With
    `max_per_label`, a seeded sample of each archive's sites is exported and the rest counted sampled out:
    Loupe's training set is bounded by time, not by how many pages exist."""
    import random
    import sqlite3

    for zip_name, label, root in (
        ("benign-rawdata.zip", "benign", "benign"),
        ("phishing-rawdata.zip", "phish", "phishing"),
    ):
        with zipfile.ZipFile(folder / zip_name) as archive:
            names = {info.filename: info for info in archive.infolist()}
            sites = sorted(
                {name.split("/")[2] for name in names if name.startswith(f"{root}/files/") and name.count("/") > 2}
            )
            for site in sites:
                receipt.note_inventory(item_id("ares", site))
            if max_per_label is not None and len(sites) > max_per_label:
                kept = set(random.Random(seed).sample(sites, max_per_label))
                for site in sites:
                    if site not in kept:
                        receipt.sample_out(item_id("ares", site))
                sites = sorted(kept)
            db_name = next((n for n in names if n.endswith(".db")), None)
            urls = {}
            brands = {}
            if db_name is not None:
                db_info = names[db_name]
                limits.count_entry(db_info.file_size)
                out.check_space()
                temporary = folder / f".ares-{root}.db"
                try:
                    with temporary.open("wb") as handle:
                        handle.write(archive.read(db_info))
                    out.check_space()
                    connection = sqlite3.connect(temporary)
                    try:
                        wanted = set(sites)
                        tables = {row[0] for row in connection.execute("select name from sqlite_master where type='table'")}
                        if "odp_urls" in tables:
                            query = "select sha256, url, '' from odp_urls"
                        else:
                            query = "select sha1, url, brand from urls"
                        for sha, url, brand in connection.execute(query):
                            limits.check_deadline()
                            if sha in wanted:
                                urls[sha] = url
                                if brand:
                                    brands[sha] = brand
                    finally:
                        connection.close()
                finally:
                    temporary.unlink(missing_ok=True)
            for site in sites:
                limits.check_deadline()
                html_info = names.get(f"{root}/files/{site}/page.html")
                if html_info is None:
                    out.reject(item_id("ares", site), "the site folder holds no page HTML")
                    continue
                html = read_entry(archive, html_info, limits)
                if html is None:
                    out.reject(item_id("ares", site), "the site's page HTML is over the entry limit")
                    continue
                shot_info = names.get(f"{root}/files/{site}/screen.png")
                shot = read_entry(archive, shot_info, limits) if shot_info is not None else None
                out.add(
                    item_id("ares", site), urls.get(site), decode(html), label, target=brands.get(site), screenshot=shot
                )


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
    "van-dooremaal-ares-2021": (convert_ares, ["benign-rawdata.zip", "phishing-rawdata.zip"]),
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


def convert_source(
    source,
    folder,
    max_rows=None,
    seed=20261101,
    min_free=MIN_FREE_BYTES,
    usage_fn=shutil.disk_usage,
    policy=NEW_SOURCE_POLICY,
):
    convert, names = CONVERTERS[source]
    check_free_space(folder, min_free, usage_fn)
    _, inputs_digest = ensure_inputs(folder, names)
    remove_dead_staging(folder)
    limits = Limits()
    receipt = Receipt(limits)
    out = Rows(folder, receipt, limits, min_free=min_free, usage_fn=usage_fn)
    try:
        if source == "van-dooremaal-ares-2021":
            spec = (policy or {}).get(source) or {}
            effective_max = max_rows if max_rows is not None else spec.get("default_max")
            convert(
                folder,
                receipt,
                limits,
                out,
                max_per_label=(effective_max // 2 if effective_max else None),
                seed=seed,
            )
        else:
            convert(folder, receipt, limits, out)
        if policy is not None:
            check_export_coverage(source, receipt, out.by_label, policy=policy)
        staged = out.close_staged()
        check_free_space(folder, min_free, usage_fn)
        receipt.publish(folder, staged, folder / "rows.jsonl", Path(__file__), inputs_digest)
    except BaseException:
        out.cleanup()
        raise
    return receipt, out.by_label


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=sorted(CONVERTERS))
    parser.add_argument("--max", type=int, default=None, help="sample at most this many rows (ARES: half a label)")
    parser.add_argument("--seed", type=int, default=20261101)
    args = parser.parse_args()
    folder = store_dir() / "raw" / args.source
    try:
        receipt, _ = convert_source(args.source, folder, max_rows=args.max, seed=args.seed)
    except inputs_module.Refused as error:
        print(f"new-rows: refused ({error})", file=sys.stderr)
        return 1
    print(f"new-rows: {args.source}: {receipt.exported} rows exported, {sum(receipt.rejected.values())} rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
