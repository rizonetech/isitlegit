"""An environment checked against its requirements file (D03 T04 §19, round 1 finding 2): the entity pass
(`entities.py`, `requirements-entities.txt`) and the OCR engine (`ocr_text.py`, `requirements-ocr.txt`) each refuse to
start in a venv whose installed packages are not the versions their file pins, so an upgraded environment never runs
under the audit of the old one. The files are part of the redaction's key (`redactionKey()` in import-samples.ts), so
a changed pin remakes every sample page. Each script loads it by path, since `python -I` puts no script directory on
the path."""
import importlib.metadata
import re
from pathlib import Path

# `name==version`, or a wheel pinned by URL (`name @ https://.../name-version-py3-none-any.whl#sha256=...`).
PINNED = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)$")
WHEEL = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*) @ \S+/([A-Za-z0-9_.]+?)-([^-/]+)-[^/]*\.whl(?:#\S*)?$")


def pins(requirements):
    """Each pinned distribution in `requirements` (a path) and its version, in file order; any other line refuses."""
    found = []
    for raw in Path(requirements).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        pinned = PINNED.match(line) or WHEEL.match(line)
        if not pinned:
            raise ValueError(f"{Path(requirements).name} holds a line that pins no version")
        found.append((pinned.group(1), pinned.group(pinned.lastindex)))
    return found


def installed(name):
    """The installed version of distribution `name`, or None when it is not installed."""
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def mismatch(requirements, version=installed):
    """Why this environment is not the one `requirements` pins (the first package that differs, by name and versions;
    never anything else), or None when every pinned package is installed at its pinned version."""
    file = Path(requirements).name
    for name, pinned in pins(requirements):
        have = version(name)
        if have != pinned:
            state = "is not installed" if have is None else f"is {have}"
            return f"the environment does not match {file} ({name} {state}, pinned {pinned})"
    return None

