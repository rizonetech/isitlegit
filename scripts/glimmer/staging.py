"""Staging a killed run left behind (D03 T04 §5): the extractor's `.<name>.extracting-<pid>` folders and the row
exporters' `.rows.jsonl.<pid>.tmp` files. A run removes its own on any failure it sees, but a SIGKILL (the host out of
memory) runs no cleanup, so each run first removes what a dead earlier run left, and never what a live one is writing.
"""
import os
import re
import shutil
from pathlib import Path

STAGED = re.compile(
    r"^\.(?:.+\.extracting-|(?:rows\.jsonl|ITEMS\.jsonl|ITEMS\.inventory\.jsonl|EXPORT\.json)\.)(\d+)(?:\.tmp)?$"
)
BACKUP = re.compile(
    r"^\.prev\.(rows\.jsonl|ITEMS\.jsonl|ITEMS\.inventory\.jsonl|EXPORT\.json)\.(\d+)\.tmp$"
)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # another user's live process
    return True


def remove_dead_staging(folder):
    """Remove every staging file or folder in `folder` whose writer is no longer running; if a dead writer died
    mid-publication before committing EXPORT.json, restore its `.prev.<name>.<pid>.tmp` backups first."""
    removed = []
    folder = Path(folder)
    if not folder.is_dir():
        return removed
    entries = list(folder.iterdir())
    backups_by_pid = {}
    uncommitted_pids = set()
    for entry in entries:
        bmatch = BACKUP.match(entry.name)
        if bmatch:
            target_name, pid_str = bmatch.group(1), bmatch.group(2)
            pid = int(pid_str)
            if pid != os.getpid() and not alive(pid):
                backups_by_pid.setdefault(pid, []).append((entry, folder / target_name))
            continue
        smatch = STAGED.match(entry.name)
        if smatch:
            pid = int(smatch.group(1))
            if pid != os.getpid() and not alive(pid) and not entry.is_dir():
                uncommitted_pids.add(pid)
    for pid, pid_backups in backups_by_pid.items():
        if pid in uncommitted_pids or len(pid_backups) > 0:
            for backup_entry, dst in pid_backups:
                if backup_entry.is_file() and pid in uncommitted_pids:
                    os.replace(backup_entry, dst)
                else:
                    backup_entry.unlink(missing_ok=True)
                removed.append(backup_entry.name)
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
