#!/usr/bin/env python3
"""Check that the index holds nothing that must not be published, before a push to the public repository.

    python3 scripts/check-publication.py

Exit 0: clean. Exit 1: something private is staged or tracked (each finding is printed). Exit 2: the check could
not run, for example because the client list is missing, unreadable or empty, so a clean result would mean nothing.

Checks, all against the index (what a commit and push would publish), never the working tree:
- the client list `samples/client-names.txt` (git-ignored) exists and names at least one client. It is the clone's
  list, found as `scripts/hooks/pre-commit` finds it (D00 T01 §24, §25): this checkout's own, else the main
  checkout's beside the shared git directory (`git worktree add` copies no ignored file); a dangling link, no list,
  an unreadable or non-UTF-8 list and a list naming no one each stop the check with their own fix, and an unusable
  own list never falls back. A new clone needs the operator's private list at the main checkout's
  `samples/client-names.txt` before the first commit or check;
- no tracked file's content or path contains a listed name, in any case, binary-marked mail fixtures included;
- no tracked file outside the test folders names a private checkout path (a home folder, a Windows user or GitHub
  checkout folder, or the WSL mount of one);
- `samples/` tracks exactly its `.gitignore` and `README.md`, and nothing under `sources/`, `competitors/` or
  `.remember/` is tracked.
Findings name where something is, never what it says: a client's name, address or a mail header must not reach
command output or agent logs, so content findings print `path:line` and a path that itself names a client is shown
as `<path naming a client>`. Stdlib only.
"""
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
LIST = "samples/client-names.txt"
# Font and raster image files are not read as text: their bytes carry no words anyone writes a name into, and a short
# name matches them by chance. Their paths are still checked; mail fixtures and PDFs are still read as text.
NOT_TEXT = [f":(exclude,glob)**/*.{ext}" for ext in ("ttf", "otf", "woff", "woff2", "png", "jpg", "jpeg", "gif", "webp",
                                                      "ico")]
# A home folder starts a path; a web address's `/home/` follows its host or another path segment (a bank's
# `https://personal.example.co.za/home/fraud-awareness`), so `/home/` after a host or path character is not one.
PRIVATE_PATH = r"(^|[^A-Za-z0-9._~%-])/home/[a-z]|[A-Z]:\\(GitHub|Users)\\[A-Za-z]|/mnt/[a-z]/(GitHub|Users)/[A-Za-z]"
SAMPLES_ALLOWED = ["samples/.gitignore", "samples/README.md"]
NEVER_TRACKED = ("sources/", "competitors/", ".remember/")


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, errors="replace")


def list_paths():
    """This checkout's own client list and the main checkout's, beside the shared git directory (the same file when
    this is the main checkout)."""
    own = ROOT / LIST
    common = git("rev-parse", "--path-format=absolute", "--git-common-dir")
    if common.returncode != 0 or not common.stdout.strip():
        return own, own
    return own, pathlib.Path(common.stdout.strip()).parent / LIST


def q(path):
    """A path as one shell word, so a printed command still works when the path holds a space."""
    return shlex.quote(str(path))


def lookup(path):
    """`missing`, `dangling`, `present`, or the error when the path cannot be looked at: a permission error is not
    absence, so an own list behind one is refused, never passed over for the main checkout's."""
    try:
        os.lstat(path)
    except FileNotFoundError:
        return "missing"
    except OSError as error:
        return error
    try:
        os.stat(path)
    except FileNotFoundError:
        return "dangling"
    except OSError as error:
        return error
    return "present"


def read_names(path):
    """(names without blank lines, None) or (None, why they cannot be used)."""
    try:
        text = path.read_bytes().decode("utf-8")
    except OSError as error:
        return None, f"cannot be read: {error.strerror}; fix its permissions"
    except UnicodeDecodeError:
        return None, "is not UTF-8 text; save it as UTF-8, then run the check again"
    names = [line.strip() for line in text.splitlines() if line.strip()]
    if not names:
        return None, ("lists no names, so a clean scan would prove nothing; add the client names, one name, domain or "
                      "address per line, then run the check again")
    return names, None


def client_names():
    """(names, None, the list used), or (None, the reason the list cannot be used and its fix, None), in the states
    and order `scripts/hooks/pre-commit` refuses them. An unusable own list refuses; it never falls back to the main
    checkout's. Every path printed is checked against whichever list can be read, so a checkout path that names a
    client is not printed (with no list readable there is nothing to check against)."""
    own, main_list = list_paths()
    same = own.parent.resolve() == main_list.parent.resolve()
    own_state, main_state = lookup(own), lookup(main_list)
    known = []
    for path, state in ((own, own_state), (main_list, main_state)):
        if state == "present" and not known:
            known = [name.lower() for name in (read_names(path)[0] or [])]

    def show(path):
        return "<a path naming a client>" if any(name in str(path).lower() for name in known) else q(path)

    def refuse(message):
        return None, message, None
    if isinstance(own_state, OSError):
        return refuse(f"{show(own)} cannot be looked at: {own_state.strerror}; fix the permissions of its folder (a "
                      f"list that cannot be checked is not passed over for the main checkout's)")
    if own_state == "dangling":
        if same or main_state != "present":
            return refuse(f"{LIST} is a link to a file that does not exist ('ls -l {show(own)}' shows where); put the "
                          f"operator's private list there, or replace the link with the list itself ('rm "
                          f"{show(own)}', then write the list at {show(main_list)})")
        return refuse(f"{LIST} is a link to a file that does not exist; repair it with "
                      f"'ln -sfn {show(main_list)} {show(own)}', or remove the link ('rm {show(own)}') to use the "
                      f"main checkout's list")
    if own_state == "missing":
        if isinstance(main_state, OSError):
            return refuse(f"the main checkout's client list {show(main_list)} cannot be looked at: "
                          f"{main_state.strerror}; fix the permissions of its folder")
        if main_state == "dangling":
            # The link's target is not printed: with the list unreadable, a target naming a client could not be hidden.
            return refuse(f"the main checkout's client list {show(main_list)} is a link to a file that does not exist "
                          f"('ls -l {show(main_list)}' shows where); restore the list at that target, or replace the "
                          f"link with the list itself ('rm {show(main_list)}', then write the operator's private list "
                          f"there)")
        if main_state == "missing":
            return refuse(f"no client list: {LIST} is missing in this checkout and the main checkout. Put the "
                          f"operator's private list (one client name, domain or address per line; git-ignored, never "
                          f"committed) at {show(main_list)}, then run the check again")
    names_file = own if own_state == "present" else main_list
    names, problem = read_names(names_file)
    if problem:
        return refuse(f"{show(names_file)} {problem}")
    return names, None, names_file


def grep_locations(output, shown, tracked):
    """`path:line` for each match in `git grep -z -n` output (records `path NUL line NUL text NEWLINE`), the matched
    text dropped unread, so a path containing a colon is never split in the wrong place. A record whose first field
    is not a tracked path cannot be read safely; it is reported as unreadable, never printed and never skipped."""
    locations = []
    for record in output.split("\n"):
        if not record:
            continue
        fields = record.split("\0")
        if len(fields) >= 3 and fields[0] in tracked and fields[1].isdigit():
            locations.append(f"{shown(fields[0])}:{fields[1]}")
        else:
            locations.append("<unreadable grep output: rerun after fixing the file it came from>")
    return locations


def main():
    names, problem, names_file = client_names()
    if problem:
        print(f"check-publication: {problem}", file=sys.stderr)
        return 2
    findings = []
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt", delete=False) as patterns:
        patterns.write("\n".join(names) + "\n")
    try:
        # -a reads binary-marked files (mail fixtures are `binary` in .gitattributes) as text.
        content = git("grep", "--cached", "-z", "-n", "-a", "-i", "-F", "-f", patterns.name, "--", ".", *NOT_TEXT)
    finally:
        pathlib.Path(patterns.name).unlink()
    if content.returncode not in (0, 1):
        print(f"check-publication: git grep failed: {content.stderr.strip()}", file=sys.stderr)
        return 2
    lowered = [name.lower() for name in names]

    def shown(path):
        return "<path naming a client>" if any(name in path.lower() for name in lowered) else path

    # -z: one NUL after each path and no quoting, so a non-ASCII name (`Café`) is compared as written, not escaped.
    tracked = git("ls-files", "-z")
    if tracked.returncode:
        print(f"check-publication: git ls-files failed: {tracked.stderr.strip()}", file=sys.stderr)
        return 2
    paths = [p for p in tracked.stdout.split("\0") if p]
    findings += [f"client name in content: {location}"
                 for location in grep_locations(content.stdout, shown, set(paths))]
    named = sum(1 for p in paths if shown(p) != p)
    if named:
        # The list's own path is a path too: one that names a client is not printed.
        where = q(names_file) if shown(str(names_file)) == str(names_file) else "<the client list>"
        findings.append(f"client name in {named} tracked path(s); list them locally with "
                        f"`git ls-files | grep -iFf {where}`")
    private = git("grep", "--cached", "-z", "-n", "-E", PRIVATE_PATH, "--", ".", ":!tests/", ":!scripts/tests/")
    if private.returncode not in (0, 1):
        print(f"check-publication: git grep failed: {private.stderr.strip()}", file=sys.stderr)
        return 2
    findings += [f"private path: {location}" for location in grep_locations(private.stdout, shown, set(paths))]
    samples = sorted(p for p in paths if p.startswith("samples/"))
    if samples != SAMPLES_ALLOWED:
        samples = [shown(p) for p in samples]
        findings.append(f"samples/ must track exactly {SAMPLES_ALLOWED}, tracks {samples}")
    findings += [f"must stay local: {shown(p)}" for p in paths if p.startswith(NEVER_TRACKED)]
    for finding in findings:
        print(finding)
    if findings:
        print(f"check-publication: {len(findings)} finding(s); nothing above may be published", file=sys.stderr)
        return 1
    print(f"check-publication: clean ({len(paths)} tracked files, {len(names)} client names)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
