#!/usr/bin/env python3
"""7 Days Later's public sample as JSONL rows for scripts/glimmer/import-rows.ts (D03 T04 §18).

    ~/.venvs/fireworks/bin/python -I scripts/glimmer/sevendays_rows.py [--max 15000] [--seed 20261028]

The sample (CC BY 4.0, https://zenodo.org/records/14885725, checked against Zenodo's published MD5) crawled live
phishing URLs every 30 minutes: `<n>-<host with dots as underscores>/<YYYY-MM-DD-HH:MM>/` holds each capture's
`screenshot.jpg`, `page.html` and `status_code.txt`. A URL's first captures show the lure; later ones are often the
takedown. So each URL gives one row: its earliest capture that answered 200 with a screenshot and HTML. The archive is
streamed twice, never extracted: once for the status codes, once for the chosen captures' two files. Rows carry the
real screenshot (base64) beside the HTML, in PhreshPhish's row shape otherwise.
"""
import argparse
import base64
import json
import os
import random
import re
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from staging import remove_dead_staging

ARCHIVE = "phishing-alive-measurement_sample_zenodo.tar.gz"
MAX_FILE = 20 * 1024 * 1024
CAPTURE = re.compile(r"^(?:\./)?(\d+-([^/]+))/(\d{4}-\d{2}-\d{2}-\d{2}:\d{2})/([^/]+)$")
HOST = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$")


def store_dir():
    configured = os.environ.get("GLIMMER_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / "isitlegit-data" / "glimmer"


def host_of(folder_host):
    """The crawled host from its folder name (dots written as underscores), or None when that reading is not a host."""
    host = folder_host.replace("_", ".").lower()
    return host if HOST.match(host) else None


def decode(data):
    match = re.search(rb"<meta[^>]+charset\s*=\s*[\"']?\s*([\w.:-]+)", data[:1024], re.IGNORECASE)
    if match:
        try:
            return data.decode(match.group(1).decode("ascii"), errors="replace")
        except LookupError:
            pass  # a label Python does not know: UTF-8, the web's default, as a browser would
    return data.decode("utf-8-sig", errors="replace")


def choose(path):
    """Each URL's earliest capture that answered 200 and holds a screenshot and HTML: {url folder: capture time}."""
    status, files = {}, {}
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            match = CAPTURE.match(member.name)
            if not match or not member.isfile():
                continue
            folder, _, stamp, name = match.groups()
            key = (folder, stamp)
            if name == "status_code.txt" and member.size < 64:
                status[key] = archive.extractfile(member).read().decode("ascii", "replace").strip()
            elif name in ("screenshot.jpg", "page.html") and 0 < member.size <= MAX_FILE:
                files.setdefault(key, set()).add(name)
    earliest = {}
    for (folder, stamp), names in files.items():
        if names == {"screenshot.jpg", "page.html"} and status.get((folder, stamp)) == "200":
            if folder not in earliest or stamp < earliest[folder]:
                earliest[folder] = stamp
    return earliest


def export(path, chosen, out):
    """The chosen captures' rows, written as each capture's two files arrive."""
    pending, written = {}, 0
    temporary = out.with_name(f".rows.jsonl.{os.getpid()}.tmp")
    try:
        with tarfile.open(path, "r|gz") as archive, temporary.open("w", encoding="utf-8") as sink:
            for member in archive:
                match = CAPTURE.match(member.name)
                if not match or not member.isfile():
                    continue
                folder, folder_host, stamp, name = match.groups()
                if chosen.get(folder) != stamp or name not in ("screenshot.jpg", "page.html"):
                    continue
                parts = pending.setdefault(folder, {})
                parts[name] = archive.extractfile(member).read()
                if len(parts) == 2:
                    host = host_of(folder_host)
                    sink.write(json.dumps({
                        "sha256": f"7dl-{folder.split('-', 1)[0]}",
                        "url": f"https://{host}/" if host else None,
                        "html": decode(parts["page.html"]),
                        "screenshot": base64.b64encode(parts["screenshot.jpg"]).decode("ascii"),
                        "label": "phish",
                        "target": None,
                    }, ensure_ascii=False) + "\n")
                    written += 1
                    del pending[folder]
        os.replace(temporary, out)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return written


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--max", type=int, default=15_000)
    parser.add_argument("--seed", type=int, default=20261028)
    args = parser.parse_args(argv)
    folder = store_dir() / "raw" / "7-days-later"
    path = folder / ARCHIVE
    if not path.is_file():
        print(f"sevendays-rows: {path} is missing", file=sys.stderr)
        return 2
    earliest = choose(path)
    keys = sorted(earliest)
    if len(keys) > args.max:
        keys = sorted(random.Random(args.seed).sample(keys, args.max))
    remove_dead_staging(folder)
    written = export(path, {key: earliest[key] for key in keys}, folder / "rows.jsonl")
    print(f"sevendays-rows: {written} rows from {len(earliest)} URLs with a live capture into {folder / 'rows.jsonl'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
