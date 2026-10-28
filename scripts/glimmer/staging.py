"""Staging a killed run left behind (D03 T04 §5): the extractor's `.<name>.extracting-<pid>` folders and the row
exporters' `.rows.jsonl.<pid>.tmp` files. A run removes its own on any failure it sees, but a SIGKILL (the host out of
memory) runs no cleanup, so each run first removes what a dead earlier run left, and never what a live one is writing.
"""
import os
import re
import shutil
from pathlib import Path

STAGED = re.compile(r"^\.(?:.+\.extracting-|rows\.jsonl\.)(\d+)(?:\.tmp)?$")


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # another user's live process
    return True


def remove_dead_staging(folder):
    """Remove every staging file or folder in `folder` whose writer is no longer running; return the names removed."""
    removed = []
    folder = Path(folder)
    if not folder.is_dir():
        return removed
    for entry in folder.iterdir():
        match = STAGED.match(entry.name)
        if not match or int(match.group(1)) == os.getpid() or alive(int(match.group(1))):
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry, ignore_errors=True)
        else:
            entry.unlink(missing_ok=True)
        removed.append(entry.name)
    return sorted(removed)
