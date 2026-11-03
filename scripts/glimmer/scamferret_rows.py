#!/usr/bin/env python3
"""ScamFerret's artifact archive as JSONL rows for scripts/glimmer/import-scamferret.ts (D03 T04 §28).

    python3 -I scripts/glimmer/scamferret_rows.py

The archive (GPL-3.0, https://github.com/ScamFerret/artifact, commit 8cf8dc6, pinned to that commit in `INPUTS.json`)
holds `<root>/dataset/<class>/<category>/toppage_html/<host>.html.gz`, 200 a category, and
`<root>/dataset/<class>/<category>/sample_screenshot/<host>.png` for 20 of them. Each page gives one row in
PhreshPhish's row shape: `{sha256: <class folder>/<category>/<file>, url, html, label: phish|benign, target: null,
category, screenshot}`, the id being the one the importer has always stored the page under. The archive is streamed, never
extracted: once for the names of the screenshots, once for the pages, a page that has a screenshot held until its
picture arrives. Nothing is rendered here, and every read is charged to `inputs.Limits`.
"""
import base64
import json
import os
import re
import sys
import tarfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import inputs as inputs_module
from inputs import Limits, Receipt, verify
from staging import remove_dead_staging

COMMIT = "8cf8dc631edafe584141e2f95f0c0f51855fb7bc"
ARCHIVE = f"artifact-{COMMIT}.tar.gz"
INPUT_FILES = [ARCHIVE]
MAX_HTML = 20 * 1024 * 1024
MAX_SCREENSHOT = 20 * 1024 * 1024
# What one held name costs beyond its text: the dict slot and the tuple (a measured overestimate).
HELD_ENTRY = 250
# A row holds the page's compressed bytes, its decoded text and the base64 screenshot at once.
ROW_COPIES = 4
CLASSES = {"scam_websites": "phish", "legitimate_websites": "benign"}
MEMBER = re.compile(
    r"^(?:\./)?[^/]+/dataset/(scam_websites|legitimate_websites)/([^/]+)/(toppage_html|sample_screenshot)/([^/]+)$")


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def decode(data):
    """HTML bytes as `decodeHtml` in scripts/glimmer/source-pages.ts reads them: a byte order mark, then a `<meta
    charset>` in the first 1,024 bytes, then UTF-8 when the bytes are UTF-8, else Windows-1252."""
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", errors="replace")
    if data.startswith(b"\xff\xfe"):
        return data[2:].decode("utf-16-le", errors="replace")
    if data.startswith(b"\xfe\xff"):
        return data[2:].decode("utf-16-be", errors="replace")
    match = re.search(rb"<meta[^>]+charset\s*=\s*[\"']?\s*([\w.:-]+)", data[:1024], re.IGNORECASE)
    if match:
        try:
            return data.decode(match.group(1).decode("ascii"), errors="replace")
        except LookupError:
            pass  # a label Python does not know: UTF-8, the web's default
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def gunzip(data, limit):
    """The bytes of a gzip member, or None when it expands past `limit` (bounded as it is decompressed)."""
    inflater = zlib.decompressobj(zlib.MAX_WBITS | 16)
    try:
        out = inflater.decompress(data, limit + 1)
    except zlib.error:
        return None
    return out if len(out) <= limit and not inflater.unconsumed_tail else None


def parse(name):
    """`(class folder, category, kind, file)` of an archive member, or None when it is not one of the dataset's."""
    match = MEMBER.match(name)
    return match.groups() if match else None


def screenshots(path, limits, found=None):
    """First pass: the screenshots the archive holds, as `{(class, category, host): size}`. Only names are held."""
    found = {} if found is None else found
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            limits.count_entry(member.size if member.isfile() else 0)
            parts = parse(member.name)
            if not parts or not member.isfile() or parts[2] != "sample_screenshot" or not parts[3].endswith(".png"):
                continue
            key = (parts[0], parts[1], parts[3][:-len(".png")])
            if key not in found:
                limits.charge_retained(HELD_ENTRY + sum(len(part) for part in key))
            found[key] = member.size
    return found


def export(path, found, out, receipt, limits, stage_only=False):
    """Second pass: one row a page, written as its parts arrive. Returns the ids written."""
    pending, written, seen, done = {}, set(), set(), set()
    temporary = out.with_name(f".rows.jsonl.{os.getpid()}.tmp")

    def write(sink, item_id, key, row):
        sink.write(json.dumps({"sha256": item_id, "url": f"https://{key[2]}/", "html": row["html"],
                               "label": CLASSES[key[0]], "target": None, "category": key[1],
                               **({"screenshot": row["screenshot"]} if "screenshot" in row else {})},
                              ensure_ascii=False) + "\n")
        written.add(item_id)
        done.add(key)
        receipt.export(item_id)

    try:
        with tarfile.open(path, "r|gz") as archive, temporary.open("w", encoding="utf-8") as sink:
            for member in archive:
                limits.count_entry(member.size if member.isfile() else 0)
                parts = parse(member.name)
                if not parts or not member.isfile():
                    continue
                folder, category, kind, file = parts
                if kind == "toppage_html" and file.endswith(".html.gz"):
                    host = file[:-len(".html.gz")]
                    key, item_id = (folder, category, host), f"{folder}/{category}/{file}"
                    if item_id in seen:  # a member the archive holds twice is one item
                        continue
                    seen.add(item_id)
                    receipt.note_inventory(item_id)
                    # Bounded before the page is read, and again as it is decompressed.
                    limits.check_allocation(member.size, item_id)
                    if member.size > MAX_HTML:
                        receipt.reject(f"over {MAX_HTML} bytes", item_id)
                        continue
                    if key in found and found[key] > MAX_SCREENSHOT:
                        receipt.reject(f"its screenshot is over {MAX_SCREENSHOT} bytes", item_id)
                        continue
                    packed = archive.extractfile(member).read()
                    limits.charge_retained(len(packed))
                    try:
                        data = gunzip(packed, MAX_HTML)
                        if data is None:
                            receipt.reject(f"not a gzip page of at most {MAX_HTML} bytes", item_id)
                            continue
                        limits.count_expanded(len(data))
                        limits.check_allocation(len(data) * ROW_COPIES, f"the row for {item_id}")
                        html = decode(data)
                    finally:
                        limits.release_retained(len(packed))
                    row = pending.setdefault(key, {})
                    row["html"], row["id"] = html, item_id
                    limits.charge_retained(len(html))
                    limits.count_pending(len(pending))
                    if key not in found:
                        write(sink, item_id, key, pending.pop(key))
                        limits.release_retained(len(html))
                    elif "screenshot" in row:
                        write(sink, item_id, key, pending.pop(key))
                        limits.release_retained(len(html) + len(row["screenshot"]))
                elif kind == "sample_screenshot" and file.endswith(".png"):
                    key = (folder, category, file[:-len(".png")])
                    unwanted = key not in found or key in done or found[key] > MAX_SCREENSHOT
                    if unwanted or "screenshot" in pending.get(key, {}):
                        continue
                    limits.check_allocation(member.size, f"{file} of {category}")
                    encoded = base64.b64encode(archive.extractfile(member).read()).decode("ascii")
                    limits.charge_retained(len(encoded))
                    row = pending.setdefault(key, {})
                    row["screenshot"] = encoded
                    limits.count_pending(len(pending))
                    if "html" in row:
                        html = row["html"]
                        write(sink, row["id"], key, pending.pop(key))
                        limits.release_retained(len(html) + len(encoded))
        if not stage_only:
            os.replace(temporary, out)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    # A page whose screenshot never arrived (named twice, or unreadable) is not written without its picture.
    for key, row in sorted(pending.items()):
        if "html" in row:
            receipt.reject("its screenshot did not arrive", row["id"])
    return written


def main(argv=None):
    folder = store_dir() / "raw" / "scamferret"
    path = folder / ARCHIVE
    if not path.is_file():
        print(f"scamferret-rows: {path} is missing", file=sys.stderr)
        return 2
    out = folder / "rows.jsonl"
    temporary = out.with_name(f".rows.jsonl.{os.getpid()}.tmp")
    limits = Limits()
    receipt = Receipt(limits)
    try:
        # Nothing is read from an archive that is not the one bound in the manifest.
        _, inputs_digest = verify(folder, INPUT_FILES)
        remove_dead_staging(folder)
        found = screenshots(path, limits)
        limits.new_pass()  # the second pass counts its own entries and bytes, but not its own clock
        written = export(path, found, out, receipt, limits, stage_only=True)
        receipt.publish(folder, temporary, out, Path(__file__), inputs_digest)  # every page met, named (§28 G3)
    except Exception as error:  # a refused input or a limit: the earlier rows file stays whole
        temporary.unlink(missing_ok=True)
        print(f"scamferret-rows: refused ({error})", file=sys.stderr)
        return 1
    rejected = sum(receipt.rejected.values())
    print(f"scamferret-rows: {len(written)} rows ({rejected} rejected) into {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
