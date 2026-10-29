"""A source's inputs bound before conversion, and its export accounted for (D03 T04 §18).

`<store>/raw/<source>/INPUTS.json` (the manifest) names every input file with our SHA-256 and either the digest its
publisher gives (SHA-256, or MD5 where that is all it gives) or the immutable version it was pinned to (a Kaggle
dataset version, a Git commit). A converter verifies the manifest before it reads anything: a file missing from it,
changed since, or with neither a published digest nor a pin never reaches conversion.

`<store>/raw/<source>/EXPORT.json` (the export receipt) accounts for every item the converter met, by outcome:
exported, sampled out, or rejected with its reason; the totals reconcile with the items met, and it names the
manifest's digest, the rows file's SHA-256 and the converter's own SHA-256, so an import can be tied to the exact
inputs and code that made its rows.

`Limits` bounds what a converter may read (archive entries, bytes expanded, unmatched parts held, seconds); a
converter stopped by one raises before its rows file is replaced, so the earlier output stays whole.
"""
import hashlib
import json
import os
import time
from pathlib import Path

INPUTS = "INPUTS.json"
EXPORT = "EXPORT.json"


class Refused(Exception):
    """An input that may not be converted, or a limit passed: the converter stops, its earlier output untouched."""


def file_digest(path, kind="sha256"):
    digest = hashlib.new(kind)
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    """Written whole or not at all: a temporary file flushed, then renamed into place, and the folder flushed."""
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as sink:
            json.dump(value, sink, indent=1, sort_keys=True)
            sink.write("\n")
            sink.flush()
            os.fsync(sink.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    folder = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)


def digest_of(value):
    """A manifest's identity: the SHA-256 of its canonical JSON."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def build(folder, files, licence):
    """Write the manifest for `files` (each `{"name", "published": {"kind": "sha256"|"md5", "value"} | None,
    "pinned": str | None}`) in `folder`, checking every published digest against the file as it is now. Returns the
    manifest."""
    folder = Path(folder)
    listed = []
    for entry in sorted(files, key=lambda e: e["name"]):
        path = folder / entry["name"]
        if not path.is_file():
            raise Refused(f"{entry['name']}: not in {folder}")
        published, pinned = entry.get("published"), entry.get("pinned")
        if not published and not pinned:
            raise Refused(f"{entry['name']}: no published digest and no pinned version")
        if published:
            if published.get("kind") not in ("sha256", "md5"):
                raise Refused(f"{entry['name']}: a published digest must be SHA-256 or MD5")
            if file_digest(path, published["kind"]) != published["value"].lower():
                raise Refused(f"{entry['name']}: does not match its published {published['kind']}")
        listed.append({
            "name": entry["name"],
            "sha256": file_digest(path),
            "bytes": path.stat().st_size,
            "published": published,
            "pinned": pinned,
        })
    manifest = {"files": listed, "licence": licence}
    write_json(folder / INPUTS, manifest)
    return manifest


def verify(folder, names):
    """The manifest, once every file it lists is present and unchanged and every name in `names` (the files the
    converter is about to read) is in it. Returns `(manifest, digest)`; raises `Refused` otherwise."""
    folder = Path(folder)
    path = folder / INPUTS
    if not path.is_file():
        raise Refused(f"no {INPUTS} in {folder}: build the manifest first")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    listed = {entry["name"]: entry for entry in manifest.get("files", [])}
    for name in names:
        if name not in listed:
            raise Refused(f"{name}: not in the manifest")
    for name, entry in listed.items():
        if not entry.get("published") and not entry.get("pinned"):
            raise Refused(f"{name}: no published digest and no pinned version")
        target = folder / name
        if not target.is_file():
            raise Refused(f"{name}: listed in the manifest but missing")
        if target.stat().st_size != entry["bytes"] or file_digest(target) != entry["sha256"]:
            raise Refused(f"{name}: changed since the manifest was written")
    return manifest, digest_of(manifest)


class Limits:
    """What one conversion may read. Each `count_*` raises `Refused` past its bound."""

    def __init__(self, entries=2_000_000, expanded=200 * 10**9, pending=50_000, seconds=6 * 3600, clock=time.monotonic):
        self.max_entries, self.max_expanded, self.max_pending, self.max_seconds = entries, expanded, pending, seconds
        self.clock = clock
        self.started = clock()
        self.entries = 0
        self.expanded = 0

    def count_entry(self, size=0):
        self.entries += 1
        self.expanded += max(0, size)
        if self.entries > self.max_entries:
            raise Refused(f"more than {self.max_entries} archive entries")
        if self.expanded > self.max_expanded:
            raise Refused(f"more than {self.max_expanded} bytes expanded")
        if self.clock() - self.started > self.max_seconds:
            raise Refused(f"the conversion passed {self.max_seconds} seconds")

    def count_pending(self, held):
        if held > self.max_pending:
            raise Refused(f"more than {self.max_pending} unmatched parts held at once")


class Receipt:
    """Every item a converter met, by stable id and outcome."""

    def __init__(self):
        self.met = 0
        self.exported = 0
        self.sampled_out = 0
        self.rejected = {}

    def export(self):
        self.met += 1
        self.exported += 1

    def sample_out(self):
        self.met += 1
        self.sampled_out += 1

    def reject(self, reason):
        self.met += 1
        self.rejected[reason] = self.rejected.get(reason, 0) + 1

    def write(self, folder, rows, converter, inputs_digest):
        """Writes EXPORT.json beside the rows, once its totals reconcile; returns it."""
        rejected = sum(self.rejected.values())
        if self.exported + self.sampled_out + rejected != self.met:
            raise Refused(f"the export accounts for {self.exported + self.sampled_out + rejected} of {self.met} items")
        receipt = {
            "met": self.met,
            "exported": self.exported,
            "sampled_out": self.sampled_out,
            "rejected": dict(sorted(self.rejected.items())),
            "rows_sha256": file_digest(rows),
            "converter_sha256": file_digest(converter),
            "inputs": inputs_digest,
        }
        write_json(Path(folder) / EXPORT, receipt)
        return receipt
