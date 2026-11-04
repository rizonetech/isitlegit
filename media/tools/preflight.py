#!/usr/bin/env python3
"""Check the tools a render needs before it starts: python3 tools/preflight.py.

Every render ends in tools/master.py, which needs numpy, and the collectors need Python 3.11 or newer. A render takes
minutes to hours, so a missing dependency is reported here, before the first frame, with the command that installs it,
instead of after the render as a ModuleNotFoundError. Exits 0 when everything is present, 2 with one line per missing
piece otherwise.
"""

import importlib.util
import sys

MODULES = {"numpy": "python3 -m pip install --user numpy (or: sudo apt install python3-numpy)"}


def missing(version=sys.version_info, find=importlib.util.find_spec) -> list[str]:
    """One line per missing piece, each naming how to install it."""
    out = []
    if tuple(version[:2]) < (3, 11):
        out.append(f"Python 3.11 or newer is needed, not {version[0]}.{version[1]}")
    for name, how in MODULES.items():
        if find(name) is None:
            out.append(f"the Python module {name} is missing: {how}")
    return out


def main() -> int:
    problems = missing()
    for line in problems:
        print(f"preflight: {line}", file=sys.stderr)
    return 2 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
