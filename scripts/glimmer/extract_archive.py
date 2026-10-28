#!/usr/bin/env python3
"""Unpack a downloaded dataset archive for Loupe's converters (D03 T04 §5).

    python3 scripts/glimmer/extract_archive.py <archive> <destination> [--import-json <raw/<source>/IMPORT.json>]

Astra downloads archives but never unpacks them (its brief); this does, with Python's own zipfile and tarfile and every
entry checked before anything is written: an absolute path, a `..` that climbs out, a link (symbolic or hard), a device
or any other special entry refuses the whole archive, and so does an expanded size over 5 GB (counted from the entries'
declared sizes first, and again from the bytes actually written, so a lying header cannot pass). The archive is unpacked
into a fresh temporary folder beside the destination and renamed into place only when every entry is written, so a
failure (a full disk included) leaves no destination folder, and with --import-json the source's IMPORT.json reads
`incomplete` with the reason. The destination must not exist yet.
"""
import argparse
import json
import os
import shutil
import sys
import tarfile
import zipfile
import zlib
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
from staging import remove_dead_staging

LIMIT_BYTES = 5 * 1024**3
CHUNK = 1024 * 1024


class Refused(Exception):
    pass


def safe_name(name):
    """The entry's path inside the archive, or a refusal when it is absolute or climbs out."""
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or (name[:2].endswith(":")) or any(part == ".." for part in path.parts):
        raise Refused(f"entry {name!r} would land outside the destination")
    parts = [part for part in path.parts if part not in ("", ".")]
    if not parts:
        raise Refused(f"entry {name!r} has no name")
    return Path(*parts)


def zip_entries(archive):
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            mode = (info.external_attr >> 16) & 0o170000
            if mode and mode not in (0o100000, 0o040000):
                raise Refused(f"entry {info.filename!r} is a link or a special file")
            yield info.filename, info.is_dir(), info.file_size, (lambda i=info, z=zf: z.open(i))


def tar_entries(archive):
    with tarfile.open(archive) as tf:
        for member in tf:
            if member.issym() or member.islnk() or not (member.isfile() or member.isdir()):
                raise Refused(f"entry {member.name!r} is a link or a special file")
            yield member.name, member.isdir(), member.size, (lambda m=member, t=tf: t.extractfile(m))


def entries(archive):
    if zipfile.is_zipfile(archive):
        return zip_entries(archive)
    if tarfile.is_tarfile(archive):
        return tar_entries(archive)
    raise Refused(f"{archive} is neither a zip nor a tar archive")


def wanted(name, only):
    """Whether an entry lies under one of the `only` prefixes (every entry when none is given)."""
    if not only:
        return True
    path = PurePosixPath(name.replace("\\", "/")).as_posix()
    return any(path == prefix.rstrip("/") or path.startswith(prefix.rstrip("/") + "/") for prefix in only)


def plan(archive, limit, only=()):
    """Every entry checked, and the declared total held to the limit, before one byte is written. Every entry is
    checked even when only some are wanted: an archive with a hostile entry anywhere is refused whole."""
    total = 0
    for name, _is_dir, size, _open in entries(archive):
        safe_name(name)
        if not wanted(name, only):
            continue
        total += max(size, 0)
        if total > limit:
            raise Refused(f"the archive expands past {limit} bytes")


def extract(archive, destination, limit=LIMIT_BYTES, only=()):
    destination = Path(destination)
    if destination.exists():
        raise Refused(f"{destination} exists already; remove it or choose another")
    plan(archive, limit, only)
    destination.parent.mkdir(parents=True, exist_ok=True)
    remove_dead_staging(destination.parent)
    temporary = destination.parent / f".{destination.name}.extracting-{os.getpid()}"
    shutil.rmtree(temporary, ignore_errors=True)
    temporary.mkdir()
    written = 0
    try:
        for name, is_dir, _size, opener in entries(archive):
            if not wanted(name, only):
                continue
            target = temporary / safe_name(name)
            if is_dir:
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with opener() as source, open(target, "wb") as sink:
                while chunk := source.read(CHUNK):
                    written += len(chunk)
                    if written > limit:
                        raise Refused(f"the archive expands past {limit} bytes")
                    sink.write(chunk)
        os.replace(temporary, destination)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return written


def record_incomplete(path, archive, reason):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"status": "incomplete", "archive": str(archive), "reason": reason,
              "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Unpack a dataset archive with every entry checked (D03 T04 §5).")
    parser.add_argument("archive")
    parser.add_argument("destination")
    parser.add_argument("--import-json", help="the source's IMPORT.json, marked incomplete on any failure")
    parser.add_argument("--only", action="append", default=[],
                        help="unpack only entries under this path inside the archive (repeatable)")
    args = parser.parse_args(argv)
    try:
        written = extract(args.archive, args.destination, only=tuple(args.only))
    # A corrupt deflate stream (zlib.error) or an encrypted zip entry (RuntimeError) is a damaged download too: it ends as
    # an incomplete import with its reason, never as a traceback that leaves an earlier record standing.
    except (Refused, OSError, zipfile.BadZipFile, tarfile.TarError, EOFError, zlib.error, RuntimeError) as error:
        reason = str(error) if isinstance(error, Refused) else f"{type(error).__name__}: {error}"
        if args.import_json:
            record_incomplete(args.import_json, args.archive, reason)
        print(f"extract-archive: refused: {reason}", file=sys.stderr)
        return 2 if isinstance(error, Refused) else 1
    print(f"extract-archive: {written} bytes into {args.destination}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
