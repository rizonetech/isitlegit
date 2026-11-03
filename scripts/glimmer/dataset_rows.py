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
import inputs as inputs_module
from inputs import Limits, Receipt, verify
from staging import remove_dead_staging

MAX_ENTRY = 20 * 1024 * 1024
# What a held item costs beyond its text: the tuple, its strings' headers and the dict slot (a measured overestimate).
HELD_ITEM = 200
# A whole text file read in one step holds its bytes, the decoded text and the regex's matches at once.
TEXT_COPIES = 4
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


def charge_workbook(source, limits, what):
    """Charges a workbook (an .xlsx is itself a zip) before openpyxl opens it: every part counts as an entry with its
    declared expanded size, and no part may be one allocation over the limit. openpyxl's read-only mode streams the
    sheets but loads the shared strings whole, so a nested-sheet bomb is stopped here, not after it has expanded."""
    with zipfile.ZipFile(source) as book:
        for info in book.infolist():
            limits.count_entry(info.file_size)
            limits.check_allocation(info.file_size, f"{what}'s part {info.filename}")


def held_rows(book, limits):
    """A workbook's first sheet from row 2 as a list, each row charged to the retained bytes as it is read."""
    try:
        held = []
        for row in book.worksheets[0].iter_rows(min_row=2, values_only=True):
            limits.check_deadline()
            limits.charge_retained(HELD_ITEM + sum(len(cell) if isinstance(cell, (str, bytes)) else 16 for cell in row))
            held.append(row)
        return held
    finally:
        book.close()


# Each reader yields the items it can export and reports every other entry it met to `receipt` with its reason; `limits`
# bounds the archive entries and bytes it reads.
def compphish(folder, receipt, limits, manifest=None):
    import openpyxl

    mapping = folder / "Mapping_File.xlsx"
    charge_workbook(mapping, limits, "Mapping_File.xlsx")
    book = openpyxl.load_workbook(mapping, read_only=True)
    labels = {}
    try:
        for serial, url, label in book.worksheets[0].iter_rows(min_row=2, values_only=True):
            limits.check_deadline()
            if serial is not None and label in (0, 1):
                limits.charge_retained(HELD_ITEM + len(str(url)))
                labels[str(int(serial))] = (url, "phish" if label == 1 else "benign")
    finally:
        book.close()
    # Left open: its entries are read after the listing, when the rows are written.
    archive = zipfile.ZipFile(folder / "All_HTML.zip")
    for info in archive.infolist():
        limits.count_entry(info.file_size)
        serial = Path(info.filename).stem
        if info.is_dir():
            continue
        if serial in labels:
            item_id = f"compphish-{serial}"
            receipt.note_inventory(item_id)
            yield item_id, labels[serial], lambda a=archive, i=info: read_entry(a, i)
        else:
            item_id = f"compphish:{info.filename}"
            receipt.note_inventory(item_id)
            receipt.reject("no phishing or benign label in the mapping file", item_id)


def ariyadasa(folder, receipt, limits, manifest=None):
    rows = {}
    index = folder / "index.sql"
    size = index.stat().st_size
    limits.check_allocation(size * TEXT_COPIES, "index.sql read whole")
    limits.count_expanded(size)
    for match in SQL_ROW.finditer(index.read_text(encoding="utf-8", errors="replace")):
        limits.check_deadline()
        _, url, website, result, _ = match.groups()
        limits.charge_retained(HELD_ITEM + len(url) + len(website))
        rows[website.replace("\\'", "'")] = (url.replace("\\'", "'"), "phish" if result == "1" else "benign")
    # The parts the verified manifest lists, never a fresh look at the folder: a part copied in after verification
    # (a download still finishing) is not read (§18 final review).
    names = [entry["name"] for entry in (manifest or {}).get("files", []) if entry["name"].startswith("dataset_part_")]
    for part in sorted(folder / name for name in names):
        archive = zipfile.ZipFile(part)
        for info in archive.infolist():
            limits.count_entry(info.file_size)
            if info.is_dir():
                continue
            name = Path(info.filename).name
            if name in rows:
                item_id = f"ariyadasa-{Path(name).stem}"
                receipt.note_inventory(item_id)
                yield item_id, rows[name], lambda a=archive, i=info: read_entry(a, i)
            else:
                item_id = f"ariyadasa:{part.name}/{info.filename}"
                receipt.note_inventory(item_id)
                receipt.reject("not in the dataset's index", item_id)


def kempf(folder, receipt, limits, manifest=None):
    archive = zipfile.ZipFile(folder / "kempf-html.zip")
    for info in archive.infolist():
        limits.count_entry(info.file_size)
        if info.is_dir():
            continue
        parts = Path(info.filename).parts
        if len(parts) == 3 and parts[1] in ("Phish", "NotPhish") and parts[2].endswith(".html"):
            label = "phish" if parts[1] == "Phish" else "benign"
            item_id = f"kempf-{parts[0]}-{Path(parts[2]).stem}"
            receipt.note_inventory(item_id)
            yield item_id, (None, label), lambda a=archive, i=info: read_entry(a, i)
        else:
            item_id = f"kempf:{info.filename}"
            receipt.note_inventory(item_id)
            receipt.reject("not a labelled HTML page in the archive's layout", item_id)


def mallory(folder, receipt, limits, manifest=None):
    import openpyxl

    archive = zipfile.ZipFile(folder / "look-for-mallory.zip")
    sheets = []
    for name in ("html.xlsx", "urls.xlsx"):
        size = archive.getinfo(name).file_size
        limits.count_entry(size)
        limits.check_allocation(size, name)
        data = io.BytesIO(archive.read(name))
        charge_workbook(data, limits, name)
        limits.charge_retained(size)  # the nested workbook's bytes are held while its rows are read
        try:
            sheets.append(held_rows(openpyxl.load_workbook(data, read_only=True), limits))
        finally:
            limits.release_retained(size)
            data.close()
    pages, urls = sheets
    # The two sheets are paired row by row (they share no key): sheets of different lengths cannot be paired at all.
    if len(pages) != len(urls):
        raise inputs_module.Refused(f"html.xlsx has {len(pages)} rows and urls.xlsx {len(urls)}: they cannot be paired")
    for number, ((category, html), (url_category, url)) in enumerate(zip(pages, urls), 1):
        limits.check_deadline()
        item_id = f"mallory-{number}"
        receipt.note_inventory(item_id)
        if category not in ("spam", "ham") or not html:
            receipt.reject("not a spam or ham row with a page", item_id)
            continue
        # A URL row is trusted only when its category matches the page's; otherwise the page has no host.
        same = url_category == category and isinstance(url, str)
        yield item_id, (url if same else None, "phish" if category == "spam" else "benign"), (
            lambda h=html: str(h))


READERS = {"compphish": compphish, "ariyadasa-2021": ariyadasa, "kempf-html": kempf, "look-for-mallory": mallory}
# The files each source's reader reads, bound in its manifest.
INPUT_FILES = {
    "compphish": lambda folder: ["All_HTML.zip", "Mapping_File.xlsx"],
    "ariyadasa-2021": lambda folder: ["index.sql", *sorted(p.name for p in folder.glob("dataset_part_*.zip"))],
    "kempf-html": lambda folder: ["kempf-html.zip"],
    "look-for-mallory": lambda folder: ["look-for-mallory.zip"],
}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", choices=sorted(READERS))
    parser.add_argument("--max", type=int, default=15_000)
    parser.add_argument("--seed", type=int, default=20261028)
    args = parser.parse_args(argv)
    folder = store_dir() / "raw" / args.source
    receipt, limits = Receipt(), Limits()
    out = folder / "rows.jsonl"
    temporary = out.with_name(f".rows.jsonl.{os.getpid()}.tmp")
    try:
        # Only inputs bound in the manifest, unchanged since, are read.
        manifest, inputs_digest = verify(folder, INPUT_FILES[args.source](folder))
        items = []
        for item in READERS[args.source](folder, receipt, limits, manifest):
            limits.check_deadline()
            limits.charge_retained(HELD_ITEM + len(item[0]))  # every item stays held until the rows are written
            items.append(item)
        chosen = items
        if len(items) > args.max:
            chosen = random.Random(args.seed).sample(items, args.max)
            kept = {item[0] for item in chosen}
            for item in items:
                if item[0] not in kept:
                    receipt.sample_out(item[0])
        remove_dead_staging(folder)
        with temporary.open("w", encoding="utf-8") as sink:
            for item_id, (url, label), read in chosen:
                html = read()
                if html is None:
                    receipt.reject(f"over {MAX_ENTRY} bytes", item_id)
                    continue
                sink.write(json.dumps({"sha256": item_id, "url": url, "html": html, "label": label, "target": None},
                                      ensure_ascii=False) + "\n")
                receipt.export(item_id)
        os.replace(temporary, out)
    except inputs_module.Refused as error:
        temporary.unlink(missing_ok=True)
        print(f"dataset-rows: {args.source}: refused ({error})", file=sys.stderr)
        return 1
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    exported = receipt.write(folder, out, Path(__file__), inputs_digest,
                             {"source": args.source, "max": args.max, "seed": args.seed})
    # Every item met, named, in the item ledger beside the receipt (§28 G3).
    receipt.write_items(folder, inputs_digest, exported["rows_sha256"])
    rejected = sum(receipt.rejected.values())
    print(f"dataset-rows: {args.source}: {receipt.exported} rows ({rejected} rejected, {receipt.sampled_out} sampled out) into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
