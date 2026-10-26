#!/usr/bin/env python3
"""Check that the index holds nothing that must not be published, before a push to the public repository.

    python3 scripts/check-publication.py

Exit 0: clean. Exit 1: something private is staged or tracked (each finding is printed). Exit 2: the check could
not run, for example because the client list is missing, unreadable or empty, so a clean result would mean nothing.

Checks, all against the index (what a commit and push would publish), never the working tree:
- the client list `samples/client-names.txt` (git-ignored) exists and names at least one client;
- no tracked file's content or path contains a listed name, in any case, binary-marked mail fixtures included;
- no tracked file outside the test folders names a private checkout path (a home folder, a Windows user or GitHub
  checkout folder, or the WSL mount of one);
- `samples/` tracks exactly its `.gitignore` and `README.md`, and nothing under `sources/`, `competitors/` or
  `.remember/` is tracked.
Stdlib only.
"""
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAMES = ROOT / "samples/client-names.txt"
PRIVATE_PATH = r"/home/[a-z]|[A-Z]:\\(GitHub|Users)\\[A-Za-z]|/mnt/[a-z]/(GitHub|Users)/[A-Za-z]"
SAMPLES_ALLOWED = ["samples/.gitignore", "samples/README.md"]
NEVER_TRACKED = ("sources/", "competitors/", ".remember/")


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, errors="replace")


def client_names():
    """The listed names without blank lines, or None with the reason the list cannot be used."""
    try:
        text = NAMES.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None, f"{NAMES.relative_to(ROOT)} is missing: create it (one client name, domain or address per line)"
    except OSError as error:
        return None, f"{NAMES.relative_to(ROOT)} cannot be read: {error.strerror}"
    names = [line.strip() for line in text.splitlines() if line.strip()]
    if not names:
        return None, f"{NAMES.relative_to(ROOT)} lists no names, so a clean scan would prove nothing"
    return names, None


def main():
    names, problem = client_names()
    if problem:
        print(f"check-publication: {problem}", file=sys.stderr)
        return 2
    findings = []
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as patterns:
        patterns.write("\n".join(names) + "\n")
    try:
        # -a reads binary-marked files (mail fixtures are `binary` in .gitattributes) as text.
        content = git("grep", "--cached", "-n", "-a", "-i", "-F", "-f", patterns.name)
    finally:
        pathlib.Path(patterns.name).unlink()
    if content.returncode not in (0, 1):
        print(f"check-publication: git grep failed: {content.stderr.strip()}", file=sys.stderr)
        return 2
    findings += [f"client name in content: {line[:200]}" for line in content.stdout.splitlines()]
    # -z: one NUL after each path and no quoting, so a non-ASCII name (`Café`) is compared as written, not escaped.
    tracked = git("ls-files", "-z")
    if tracked.returncode:
        print(f"check-publication: git ls-files failed: {tracked.stderr.strip()}", file=sys.stderr)
        return 2
    paths = [p for p in tracked.stdout.split("\0") if p]
    lowered = [name.lower() for name in names]
    findings += [f"client name in path: {p}" for p in paths if any(name in p.lower() for name in lowered)]
    private = git("grep", "--cached", "-n", "-E", PRIVATE_PATH, "--", ".", ":!tests/", ":!scripts/tests/")
    if private.returncode not in (0, 1):
        print(f"check-publication: git grep failed: {private.stderr.strip()}", file=sys.stderr)
        return 2
    findings += [f"private path: {line[:200]}" for line in private.stdout.splitlines()]
    samples = sorted(p for p in paths if p.startswith("samples/"))
    if samples != SAMPLES_ALLOWED:
        findings.append(f"samples/ must track exactly {SAMPLES_ALLOWED}, tracks {samples}")
    findings += [f"must stay local: {p}" for p in paths if p.startswith(NEVER_TRACKED)]
    for finding in findings:
        print(finding)
    if findings:
        print(f"check-publication: {len(findings)} finding(s); nothing above may be published", file=sys.stderr)
        return 1
    print(f"check-publication: clean ({len(paths)} tracked files, {len(names)} client names)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
