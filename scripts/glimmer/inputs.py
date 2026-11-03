"""A source's inputs bound before conversion, and its export accounted for (D03 T04 §18).

`<store>/raw/<source>/INPUTS.json` (the manifest) names every input file with our SHA-256 and either the digest its
publisher gives (SHA-256, or MD5 where that is all it gives) or the immutable version it was pinned to (a Kaggle
dataset version, a Git commit). A converter verifies the manifest before it reads anything: a file missing from it,
changed since, or with neither a published digest nor a pin never reaches conversion.

`<store>/raw/<source>/EXPORT.json` (the export receipt) accounts for every item the converter met, by outcome:
exported, sampled out, or rejected with its reason; the totals reconcile with the items met, and it names the
manifest's digest, the rows file's SHA-256 and the converter's own SHA-256, so an import can be tied to the exact
inputs and code that made its rows.

`Limits` bounds what a converter may read (archive entries, bytes expanded, bytes retained, one allocation, unmatched
parts held, seconds); a converter stopped by one raises before its rows file is replaced, so the earlier output stays
whole.
"""
import hashlib
import json
import re
import os
import platform
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
    # Read back whole (completion review G11): what the next step trusts is what is on the disk.
    with path.open(encoding="utf-8") as source:
        if json.load(source) != json.loads(json.dumps(value)):
            raise Refused(f"{path.name} did not read back as written")


def digest_of(value):
    """A manifest's identity: the SHA-256 of its canonical JSON."""
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


HUGGING_FACE_PIN = re.compile(r"huggingface: [\w.-]+/[\w.-]+, ([0-9a-f]{40})")
GITHUB_PIN = re.compile(r"github: [\w.-]+/[\w.-]+, (?:commit )?([0-9a-f]{40})")
# Names that move: a pin on one of them is no pin.
MOVING = {"main", "master", "head", "latest", "dev", "develop", "trunk", "default", "current", "stable", "nightly"}


def check_pin(name, pinned):
    """A pin names an immutable version, the digest-or-pin rule's other half (a file with no published digest is admitted
    on its pin and our SHA-256 taken at first download, D03 T04 §27 finding 4). A Hugging Face or GitHub pin must name
    the release's commit id (40 hex digits; for Hugging Face the `sha` of `https://huggingface.co/api/datasets/<owner>/
    <name>`), and no pin may name a version that moves (`main`, `latest` and the like) (D03 T04 §28, from §18's final
    review)."""
    if not pinned:
        return
    version = pinned.rsplit(",", 1)[-1].strip().lower() if "," in pinned else ""
    if version in MOVING or version.removeprefix("version ").strip() in MOVING:
        raise Refused(f"{name}: a pin names a version that does not move, not {version!r} ({pinned!r})")
    if pinned.startswith("huggingface:") and not HUGGING_FACE_PIN.fullmatch(pinned):
        raise Refused(f"{name}: a Hugging Face pin names a commit id, not a branch ({pinned!r})")
    if pinned.startswith("github:") and not GITHUB_PIN.fullmatch(pinned):
        raise Refused(f"{name}: a GitHub pin names a commit id, not a branch or tag ({pinned!r})")


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
        check_pin(entry["name"], pinned)
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
        check_pin(name, entry.get("pinned"))
        target = folder / name
        if not target.is_file():
            raise Refused(f"{name}: listed in the manifest but missing")
        if target.stat().st_size != entry["bytes"] or file_digest(target) != entry["sha256"]:
            raise Refused(f"{name}: changed since the manifest was written")
    return manifest, digest_of(manifest)


class Limits:
    """What one conversion may read. Each `count_*`, `charge_*` and `check_*` raises `Refused` past its bound.

    `expanded` bounds the bytes decompressed in all; `retained` bounds the bytes a converter holds at once (indexes,
    workbook row tables, unmatched capture parts); `allocation` bounds one buffer built in one step (a whole file
    read, one archive member, one Parquet row group). The expanded bound alone lets a converter hold everything it
    expanded, so the retained and allocation bounds keep it inside the host's 17 GB."""

    def __init__(self, entries=2_000_000, expanded=200 * 10**9, pending=50_000, seconds=6 * 3600, clock=time.monotonic,
                 retained=4 * 10**9, allocation=10**9):
        self.max_entries, self.max_expanded, self.max_pending, self.max_seconds = entries, expanded, pending, seconds
        self.max_retained, self.max_allocation = retained, allocation
        self.clock = clock
        self.started = clock()
        self.entries = 0
        self.expanded = 0
        self.retained = 0

    def check_deadline(self):
        """Called inside every loop: the conversion's one deadline, started when the `Limits` was made."""
        if self.clock() - self.started > self.max_seconds:
            raise Refused(f"the conversion passed {self.max_seconds} seconds")

    def count_entry(self, size=0):
        self.entries += 1
        self.expanded += max(0, size)
        if self.entries > self.max_entries:
            raise Refused(f"more than {self.max_entries} archive entries")
        if self.expanded > self.max_expanded:
            raise Refused(f"more than {self.max_expanded} bytes expanded")
        self.check_deadline()

    def count_expanded(self, size):
        """Bytes decompressed that are not an archive entry (a Parquet row group, a nested workbook's part)."""
        self.expanded += max(0, size)
        if self.expanded > self.max_expanded:
            raise Refused(f"more than {self.max_expanded} bytes expanded")
        self.check_deadline()

    def check_allocation(self, size, what="a buffer"):
        """Before building one buffer of `size` bytes (a file read whole, one member, one row group)."""
        if size > self.max_allocation:
            raise Refused(f"{what} of {size} bytes passes the {self.max_allocation} byte allocation limit")

    def charge_retained(self, size):
        """Bytes a converter now holds (an index entry, a workbook row, an unmatched capture part)."""
        self.retained += max(0, size)
        if self.retained > self.max_retained:
            raise Refused(f"more than {self.max_retained} bytes retained at once")

    def release_retained(self, size):
        self.retained = max(0, self.retained - max(0, size))

    def new_pass(self):
        """A second pass over the same input: the counts start again, the deadline and what is retained do not."""
        self.entries = 0
        self.expanded = 0

    def count_pending(self, held):
        if held > self.max_pending:
            raise Refused(f"more than {self.max_pending} unmatched parts held at once")


ITEMS = "ITEMS.jsonl"
INVENTORY_ITEMS = "ITEMS.inventory.jsonl"
# What one held ledger/inventory entry costs beyond its text (dict/list slots and string headers).
HELD_LEDGER_ENTRY = 200


class Receipt:
    """Every item a converter met, by stable id and outcome. An item named when it is counted goes into the item ledger
    (`ITEMS.jsonl`, D03 T04 §28 G3): its id, its outcome and, for a rejection, the reason; an exported item's id is its
    row's, which the import then follows to its page."""

    def __init__(self, limits=None):
        self.limits = limits
        self.met = 0
        self.exported = 0
        self.sampled_out = 0
        self.rejected = {}
        self.items = []
        self.inventory = []
        self._held = 0

    def _charge(self, size):
        if self.limits is not None:
            self.limits.charge_retained(size)
            self._held += size

    def note_inventory(self, item):
        """An input item enumerated independently of outcome recording (D03 T04 §28 plan review gap 2)."""
        text = str(item)
        self._charge(HELD_LEDGER_ENTRY + len(text.encode("utf-8")))
        self.inventory.append(text)

    def _named(self, item, outcome, reason=None):
        if item is not None:
            text = str(item)
            extra = len(reason.encode("utf-8")) if reason else 0
            self._charge(HELD_LEDGER_ENTRY + len(text.encode("utf-8")) + len(outcome) + extra)
            self.items.append({"item": text, "outcome": outcome, **({"reason": reason} if reason else {})})

    def export(self, item=None):
        self.met += 1
        self.exported += 1
        self._named(item, "exported")

    def sample_out(self, item=None):
        self.met += 1
        self.sampled_out += 1
        self._named(item, "sampled-out")

    def reject(self, reason, item=None):
        self.met += 1
        self.rejected[reason] = self.rejected.get(reason, 0) + 1
        self._named(item, "rejected", reason)

    def _write_jsonl_streamed(self, path, records_fn, label):
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        total_bytes = 0
        try:
            with open(temporary, "wb") as handle:
                for record in records_fn():
                    if self.limits is not None:
                        self.limits.check_deadline()
                        est_len = sum(len(str(k)) + len(str(v)) + 6 for k, v in record.items()) + 3
                        self.limits.check_allocation(total_bytes + est_len, label)
                    raw = (json.dumps(record) + "\n").encode("utf-8")
                    line_len = len(raw)
                    total_bytes += line_len
                    if self.limits is not None:
                        self.limits.check_allocation(total_bytes, label)
                        self.limits.charge_retained(line_len)
                    try:
                        handle.write(raw)
                    finally:
                        del raw
                        if self.limits is not None:
                            self.limits.release_retained(line_len)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            read_total = 0
            with open(path, "rb") as handle:
                for record in records_fn():
                    if self.limits is not None:
                        self.limits.check_deadline()
                    expected = (json.dumps(record) + "\n").encode("utf-8")
                    exp_len = len(expected)
                    read_total += exp_len
                    if self.limits is not None:
                        self.limits.check_allocation(read_total, f"{label} read-back")
                        self.limits.charge_retained(exp_len * 2)
                    actual = b""
                    try:
                        actual = handle.read(exp_len)
                        if actual != expected:
                            raise Refused(f"{path} did not read back as written")
                    finally:
                        del expected
                        del actual
                        if self.limits is not None:
                            self.limits.release_retained(exp_len * 2)
                extra = handle.read(1)
                if extra:
                    raise Refused(f"{path} did not read back as written")
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

    def write_items(self, folder, inputs_digest, rows_digest, inventory=None):
        """The item ledger, written whole (temp then rename) once every item met is named exactly once; bound to the
        inputs and rows it describes. Refused while any item is unnamed or named twice, or disagrees with an
        independently enumerated input inventory, so a partial ledger never stands in for the whole."""
        if self.limits is not None:
            self.limits.check_deadline()
        if len(self.items) != self.met:
            raise Refused(f"the item ledger names {len(self.items)} of {self.met} items")
        inv_source = inventory if inventory is not None else self.inventory
        scratch = 0
        seen_ids = set()
        seen_inv = set()
        inv_list = []
        try:
            for entry in self.items:
                if self.limits is not None:
                    self.limits.check_deadline()
                item_id = entry["item"]
                cost = HELD_LEDGER_ENTRY + len(item_id.encode("utf-8"))
                if self.limits is not None:
                    self.limits.check_allocation(scratch + cost, "item ledger reconciliation")
                    scratch += cost
                    self.limits.charge_retained(cost)
                else:
                    scratch += cost
                if item_id in seen_ids:
                    raise Refused("the item ledger names an item twice")
                seen_ids.add(item_id)
            if inv_source:
                for raw_item in inv_source:
                    if self.limits is not None:
                        self.limits.check_deadline()
                    item_id = str(raw_item)
                    cost = HELD_LEDGER_ENTRY + len(item_id.encode("utf-8"))
                    if self.limits is not None:
                        self.limits.check_allocation(scratch + cost, "item ledger reconciliation")
                        scratch += cost
                        self.limits.charge_retained(cost)
                    else:
                        scratch += cost
                    if item_id in seen_inv:
                        raise Refused("the input inventory names an item twice")
                    seen_inv.add(item_id)
                    inv_list.append(item_id)
                if seen_inv != seen_ids or len(inv_list) != len(self.items):
                    raise Refused(
                        f"the item ledger ({len(self.items)} items) does not match the input inventory ({len(inv_list)} items)"
                    )
        finally:
            seen_ids.clear()
            seen_inv.clear()
            del seen_ids
            del seen_inv
            if self.limits is not None:
                self.limits.release_retained(scratch)
        path = Path(folder) / ITEMS
        self._write_jsonl_streamed(
            path,
            lambda: [{"inputs": inputs_digest, "rows": rows_digest}, *self.items],
            ITEMS,
        )
        if inv_list:
            inv_path = Path(folder) / INVENTORY_ITEMS
            self._write_jsonl_streamed(
                inv_path,
                lambda: [{"inputs": inputs_digest}, *({"item": item} for item in inv_list)],
                INVENTORY_ITEMS,
            )
        return path

    def write(self, folder, rows, converter, inputs_digest, parameters=None):
        """Writes EXPORT.json beside the rows, once its totals reconcile; returns it. `parameters` are the run's own
        (the sample cap and seed), recorded with this module's digest and the interpreter, so the receipt names the whole
        recipe that made the rows (completion review E1)."""
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
            "recipe": {
                "parameters": dict(sorted((parameters or {}).items())),
                "helper_sha256": file_digest(__file__),
                "python": platform.python_version(),
            },
        }
        write_json(Path(folder) / EXPORT, receipt)
        return receipt
