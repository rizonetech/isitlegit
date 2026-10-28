#!/usr/bin/env python3
"""A downloaded HTML dataset as JSONL rows for scripts/glimmer/import-rows.ts (D03 T04 §18).

    ~/.venvs/fireworks/bin/python -I scripts/glimmer/dataset_rows.py <source> [--max 15000] [--seed 20261028]

Sources: compphish, ariyadasa-2021, kempf-html, look-for-mallory. Reads `<store>/raw/<source>/` as Astra downloaded it
(Claude re-checked each file's SHA-256 against COLLECTED.md first) and writes `rows.jsonl` beside it, temp-then-rename,
in PhreshPhish's row shape: `{sha256: <item id>, url, html, label: phish|benign, target: null}`. Archives are read
entry by entry in memory, never extracted, and an entry over 20 MB is skipped. A source larger than `--max` rows is
sampled with the seed: Loupe's training set is bounded by time, not by how many pages exist.
"""
import argparse
import io
import json
import os
import random
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from staging import remove_dead_staging

MAX_ENTRY = 20 * 1024 * 1024
SQL_ROW = re.compile(r"\((\d+),\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)',\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\)")


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def decode(data):
    """HTML bytes in the encoding the page declares, as a browser's prescan reads it, else UTF-8."""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    match = re.search(rb"<meta[^>]+charset\s*=\s*[\"']?\s*([\w.:-]+)", data[:1024], re.IGNORECASE)
    if match:
        try:
            return data.decode(match.group(1).decode("ascii"), errors="replace")
        except LookupError:
            pass  # a label Python does not know: UTF-8, the web's default
    return data.decode("utf-8", errors="replace")


def read_entry(archive, info):
    if info.is_dir() or info.file_size > MAX_ENTRY:
        return None
    return decode(archive.read(info))


def compphish(folder):
    import openpyxl

    sheet = openpyxl.load_workbook(folder / "Mapping_File.xlsx", read_only=True).worksheets[0]
    labels = {}
    for serial, url, label in sheet.iter_rows(min_row=2, values_only=True):
        if serial is not None and label in (0, 1):
            labels[str(int(serial))] = (url, "phish" if label == 1 else "benign")
    # Left open: its entries are read after the listing, when the rows are written.
    archive = zipfile.ZipFile(folder / "All_HTML.zip")
    for info in archive.infolist():
        serial = Path(info.filename).stem
        if serial in labels:
            yield f"compphish-{serial}", labels[serial], lambda a=archive, i=info: read_entry(a, i)


def ariyadasa(folder):
    rows = {}
    for match in SQL_ROW.finditer((folder / "index.sql").read_text(encoding="utf-8", errors="replace")):
        _, url, website, result, _ = match.groups()
        rows[website.replace("\\'", "'")] = (url.replace("\\'", "'"), "phish" if result == "1" else "benign")
    for part in sorted(folder.glob("dataset_part_*.zip")):
        archive = zipfile.ZipFile(part)
        for info in archive.infolist():
            name = Path(info.filename).name
            if name in rows:
                yield f"ariyadasa-{Path(name).stem}", rows[name], lambda a=archive, i=info: read_entry(a, i)


def kempf(folder):
    archive = zipfile.ZipFile(folder / "kempf-html.zip")
    for info in archive.infolist():
        parts = Path(info.filename).parts
        if len(parts) == 3 and parts[1] in ("Phish", "NotPhish") and parts[2].endswith(".html"):
            label = "phish" if parts[1] == "Phish" else "benign"
            yield f"kempf-{parts[0]}-{Path(parts[2]).stem}", (None, label), lambda a=archive, i=info: read_entry(a, i)


def mallory(folder):
    import openpyxl

    archive = zipfile.ZipFile(folder / "look-for-mallory.zip")
    pages = openpyxl.load_workbook(io.BytesIO(archive.read("html.xlsx")), read_only=True).worksheets[0]
    urls = openpyxl.load_workbook(io.BytesIO(archive.read("urls.xlsx")), read_only=True).worksheets[0]
    for number, ((category, html), (url_category, url)) in enumerate(
            zip(pages.iter_rows(min_row=2, values_only=True), urls.iter_rows(min_row=2, values_only=True)), 1):
        if category not in ("spam", "ham") or not html:
            continue
        # A URL row is trusted only when its category matches the page's; otherwise the page has no host.
        same = url_category == category and isinstance(url, str)
        yield f"mallory-{number}", (url if same else None, "phish" if category == "spam" else "benign"), (
            lambda h=html: str(h))


READERS = {"compphish": compphish, "ariyadasa-2021": ariyadasa, "kempf-html": kempf, "look-for-mallory": mallory}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", choices=sorted(READERS))
    parser.add_argument("--max", type=int, default=15_000)
    parser.add_argument("--seed", type=int, default=20261028)
    args = parser.parse_args(argv)
    folder = store_dir() / "raw" / args.source
    items = list(READERS[args.source](folder))
    if len(items) > args.max:
        items = random.Random(args.seed).sample(items, args.max)
    remove_dead_staging(folder)
    out = folder / "rows.jsonl"
    temporary = out.with_name(f".rows.jsonl.{os.getpid()}.tmp")
    written = skipped = 0
    try:
        with temporary.open("w", encoding="utf-8") as sink:
            for item_id, (url, label), read in items:
                html = read()
                if html is None:
                    skipped += 1
                    continue
                sink.write(json.dumps({"sha256": item_id, "url": url, "html": html, "label": label, "target": None},
                                      ensure_ascii=False) + "\n")
                written += 1
        os.replace(temporary, out)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    print(f"dataset-rows: {args.source}: {written} rows ({skipped} skipped) into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
