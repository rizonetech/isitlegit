#!/usr/bin/env python3
"""Local mirror of Meta's developer documentation, for fast lookups while building.

    python3 scripts/meta-docs.py sync              fetch every page listed in https://dev.meta.ai/llms.txt
    python3 scripts/meta-docs.py find <term> ...   pages and lines that contain every term, case-insensitive
    python3 scripts/meta-docs.py show <page>       print one mirrored page (path relative to the mirror)

The mirror lives in sources/meta-api/docs/, which is git-ignored: the pages are Meta's, not ours to republish.
index.json records each page's URL, title, summary, headings, SHA-256 and fetch time, so a later sync shows what
changed. Stdlib only.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIRROR = ROOT / "sources/meta-api/docs"
INDEX_URL = "https://dev.meta.ai/llms.txt"
LINK = re.compile(r"^- \[(?P<title>[^\]]+)\]\((?P<url>https://dev\.meta\.ai/[^)]+\.md)\)(?::\s*(?P<summary>.*))?$")


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "isitlegit-meta-docs/1"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    os.replace(tmp, path)


def parse_index(text):
    """Every documentation page llms.txt links to, in order, without duplicates."""
    pages, seen = [], set()
    for line in text.splitlines():
        match = LINK.match(line.strip())
        if match and match["url"] not in seen:
            seen.add(match["url"])
            pages.append({"title": match["title"], "url": match["url"], "summary": (match["summary"] or "").strip()})
    return pages


def local_path(url):
    """https://dev.meta.ai/docs/muse-code/auth.md becomes docs/muse-code/auth.md under the mirror."""
    rel = url.removeprefix("https://dev.meta.ai/")
    if not rel or ".." in pathlib.PurePosixPath(rel).parts:
        raise ValueError(f"refusing an unexpected page URL: {url}")
    return rel


def headings(text):
    return [line.lstrip("#").strip() for line in text.splitlines() if re.match(r"^#{1,4} ", line)]


def sync():
    index_text = fetch(INDEX_URL)
    pages = parse_index(index_text)
    if not pages:
        print("meta-docs: llms.txt listed no pages; the mirror was left as it was", file=sys.stderr)
        return 1
    old = {}
    if (MIRROR / "index.json").exists():
        old = {p["url"]: p for p in json.loads((MIRROR / "index.json").read_text(encoding="utf-8"))["pages"]}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    records, failed, changed = [], [], 0
    for page in pages:
        rel = local_path(page["url"])
        try:
            body = fetch(page["url"])
        except OSError as error:
            failed.append(f"{page['url']}: {error}")
            if page["url"] in old:
                records.append(old[page["url"]])  # keep the last good copy, marked by its old fetch time
            continue
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        if old.get(page["url"], {}).get("sha256") != digest:
            changed += 1
        write_atomic(MIRROR / rel, body)
        records.append({**page, "path": rel, "headings": headings(body), "sha256": digest, "fetched": now})
    write_atomic(MIRROR / "llms.txt", index_text)
    write_atomic(MIRROR / "index.json", json.dumps({"source": INDEX_URL, "synced": now, "pages": records}, indent=1) + "\n")
    print(f"meta-docs: {len(records)} pages mirrored, {changed} new or changed, {len(failed)} failed")
    for line in failed:
        print(f"  failed: {line}", file=sys.stderr)
    return 1 if failed else 0


def find(terms):
    index_file = MIRROR / "index.json"
    if not index_file.exists():
        print("meta-docs: no mirror yet; run `python3 scripts/meta-docs.py sync`", file=sys.stderr)
        return 2
    needles = [term.lower() for term in terms]
    hits = 0
    for page in json.loads(index_file.read_text(encoding="utf-8"))["pages"]:
        lines = (MIRROR / page["path"]).read_text(encoding="utf-8").splitlines()
        if not all(any(n in line.lower() for line in lines) for n in needles):
            continue
        section = ""
        for number, line in enumerate(lines, 1):
            if line.startswith("#"):
                section = line.lstrip("#").strip()
            if any(n in line.lower() for n in needles):
                print(f"{page['path']}:{number} [{section or page['title']}] {line.strip()[:160]}")
                hits += 1
    print(f"meta-docs: {hits} matching lines", file=sys.stderr)
    return 0 if hits else 1


def show(page):
    path = (MIRROR / page).resolve()
    if MIRROR.resolve() not in path.parents or not path.is_file():
        print(f"meta-docs: no mirrored page {page}", file=sys.stderr)
        return 2
    sys.stdout.write(path.read_text(encoding="utf-8"))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sync")
    find_parser = commands.add_parser("find")
    find_parser.add_argument("terms", nargs="+")
    show_parser = commands.add_parser("show")
    show_parser.add_argument("page")
    args = parser.parse_args(argv)
    if args.command == "sync":
        return sync()
    if args.command == "find":
        return find(args.terms)
    return show(args.page)


if __name__ == "__main__":
    sys.exit(main())
