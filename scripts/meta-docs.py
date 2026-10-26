#!/usr/bin/env python3
"""Local mirror of Meta's developer documentation and cookbooks, for fast lookups while building.

    python3 scripts/meta-docs.py sync              fetch every page in https://dev.meta.ai/llms.txt and update the cookbooks
    python3 scripts/meta-docs.py find <term> ...   lines in files that contain every term, case-insensitive
    python3 scripts/meta-docs.py show <path>       print one mirrored file (path as `find` prints it)

The mirror lives in sources/meta-api/, which is git-ignored: the pages and recipes are Meta's, not ours to republish.
docs/index.json records each page's URL, title, summary, headings, SHA-256 and fetch time, so a later sync shows
what changed. The cookbooks (meta-models/meta-model-cookbook, MIT; meta-models/meta-oss-cookbook, Apache-2.0) are
shallow git clones of their text files only, so `git -C <clone> log -1` gives the commit each lookup reads. Stdlib only.
"""
import argparse
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
MIRROR = ROOT / "sources/meta-api/docs"
COOKBOOK_DIR = ROOT / "sources/meta-api/cookbooks"
COOKBOOKS = ("meta-models/meta-model-cookbook", "meta-models/meta-oss-cookbook")
# Text files only: the model cookbook carries about 90 MB of sample media nobody needs to search.
TEXT_PATTERNS = ("*.md", "*.py", "*.ipynb", "*.ts", "*.tsx", "*.js", "*.mjs", "*.json", "*.toml", "*.yaml", "*.yml",
                 "*.txt", "*.sh", "*.env.example")
TEXT_SUFFIXES = {pattern.removeprefix("*") for pattern in TEXT_PATTERNS}
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


def sync_cookbooks():
    """Clone each cookbook once (shallow, text files only), then fast-forward it on later syncs."""
    failed = []
    for repo in COOKBOOKS:
        clone = COOKBOOK_DIR / repo.split("/")[1]
        git = ["git", "-C", str(clone)]
        if (clone / ".git").is_dir():
            steps = [git + ["pull", "-q", "--ff-only", "--depth", "1"]]
        else:
            clone.parent.mkdir(parents=True, exist_ok=True)
            steps = [["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout",
                      f"https://github.com/{repo}.git", str(clone)],
                     git + ["sparse-checkout", "set", "--no-cone", *TEXT_PATTERNS],
                     git + ["checkout", "-q"]]
        for step in steps:
            result = subprocess.run(step, capture_output=True, text=True)
            if result.returncode:
                failed.append(f"{repo}: {result.stderr.strip()[:200]}")
                break
        else:
            head = subprocess.run(git + ["log", "-1", "--format=%h %cs"], capture_output=True, text=True).stdout.strip()
            print(f"meta-docs: {repo} at {head}")
    for line in failed:
        print(f"  failed: {line}", file=sys.stderr)
    return failed


def sync():
    cookbook_failures = sync_cookbooks()
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
    return 1 if failed or cookbook_failures else 0


def searchable_files():
    """Every mirrored page, then every cookbook text file, as (path shown to the user, file)."""
    index_file = MIRROR / "index.json"
    if index_file.exists():
        for page in json.loads(index_file.read_text(encoding="utf-8"))["pages"]:
            yield f"docs/{page['path']}", MIRROR / page["path"]
    if COOKBOOK_DIR.is_dir():
        for path in sorted(COOKBOOK_DIR.rglob("*")):
            if ".git" in path.relative_to(COOKBOOK_DIR).parts or not path.is_file():
                continue
            if path.suffix in TEXT_SUFFIXES or path.name.endswith(".env.example"):
                yield f"cookbooks/{path.relative_to(COOKBOOK_DIR).as_posix()}", path


def find(terms):
    files = list(searchable_files())
    if not files:
        print("meta-docs: no mirror yet; run `python3 scripts/meta-docs.py sync`", file=sys.stderr)
        return 2
    needles = [term.lower() for term in terms]
    hits = 0
    for shown, path in files:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        if not all(any(n in line.lower() for line in lines) for n in needles):
            continue
        section = ""
        for number, line in enumerate(lines, 1):
            if line.startswith("#"):
                section = line.lstrip("#").strip()
            if any(n in line.lower() for n in needles):
                label = f" [{section}]" if section else ""
                print(f"{shown}:{number}{label} {line.strip()[:160]}")
                hits += 1
    print(f"meta-docs: {hits} matching lines", file=sys.stderr)
    return 0 if hits else 1


def show(page):
    base = MIRROR.parent.resolve()
    path = (base / page).resolve()
    if base not in path.parents or not path.is_file() or ".git" in path.relative_to(base).parts:
        print(f"meta-docs: no mirrored file {page}", file=sys.stderr)
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
