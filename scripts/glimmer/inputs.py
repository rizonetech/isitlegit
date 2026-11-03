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
import io
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


def stage_json(path, value):
    """Written whole to a temporary file, flushed, fsynced and read back before any published file is replaced."""
    path = Path(path)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    expected = json.loads(json.dumps(value))
    try:
        buf = io.StringIO()
        json.dump(value, buf, indent=1, sort_keys=True)
        buf.write("\n")
        payload = buf.getvalue().encode("utf-8")
        with temporary.open("wb", buffering=0) as sink:
            offset = 0
            while offset < len(payload):
                offset += sink.write(payload[offset:])
            os.fsync(sink.fileno())
        with temporary.open(encoding="utf-8") as source:
            if json.load(source) != expected:
                raise Refused(f"{path.name} did not read back as staged")
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return temporary, path


def write_json(path, value):
    """Written whole or not at all: a temporary file flushed, then renamed into place, and the folder flushed."""
    temporary, path = stage_json(path, value)
    try:
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


def _utf8_len(text):
    if text.isascii():
        return len(text)
    total = 0
    for ch in text:
        code = ord(ch)
        total += 1 if code < 0x80 else (2 if code < 0x800 else (3 if code < 0x10000 else 4))
    return total


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
        text = item if isinstance(item, str) else str(item)
        self._charge(HELD_LEDGER_ENTRY + _utf8_len(text))
        self.inventory.append(text)

    def _named(self, item, outcome, reason=None):
        if item is not None:
            text = item if isinstance(item, str) else str(item)
            reason_text = (reason if isinstance(reason, str) else str(reason)) if reason else ""
            extra = _utf8_len(reason_text) if reason_text else 0
            self._charge(HELD_LEDGER_ENTRY + _utf8_len(text) + len(outcome) + extra)
            self.items.append({"item": text, "outcome": outcome, **({"reason": reason_text} if reason_text else {})})

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
        if reason not in self.rejected:
            reason_text = reason if isinstance(reason, str) else str(reason)
            self._charge(HELD_LEDGER_ENTRY + _utf8_len(reason_text))
        self.rejected[reason] = self.rejected.get(reason, 0) + 1
        self._named(item, "rejected", reason)

    def _serialized_record_bytes(self, record, base_bytes, label):
        """Exact UTF-8 byte length of `json.dumps(record) + '\\n'`, checked against allocation limits before any
        string or buffer is constructed."""
        size = 3  # '{', '}', and trailing '\n'
        for idx, (key, value) in enumerate(record.items()):
            if idx > 0:
                size += 2  # ', '
            size += 2  # ': '
            for text in (str(key), str(value)):
                size += 2  # surrounding quotes
                for ch in text:
                    code = ord(ch)
                    if ch in ('"', "\\", "\b", "\f", "\n", "\r", "\t"):
                        size += 2
                    elif code < 0x20 or (0x7F <= code <= 0xFFFF):
                        size += 6
                    elif code > 0xFFFF:
                        size += 12
                    else:
                        size += 1
                    if self.limits is not None:
                        self.limits.check_allocation(base_bytes + size, label)
        if self.limits is not None:
            self.limits.check_allocation(base_bytes + size, label)
        return size

    def _stage_jsonl_streamed(self, path, records_fn, label, check_space=None):
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        expected_total = 0
        if check_space is not None:
            for record in records_fn():
                if self.limits is not None:
                    self.limits.check_deadline()
                expected_total += self._serialized_record_bytes(record, expected_total, f"{label} serialization")
            check_space(max(1, expected_total))
        total_bytes = 0
        try:
            with open(temporary, "wb", buffering=0) as handle:
                for record in records_fn():
                    if self.limits is not None:
                        self.limits.check_deadline()
                    line_len = self._serialized_record_bytes(record, total_bytes, f"{label} serialization")
                    held_line = HELD_LEDGER_ENTRY + line_len * 2
                    raw = b""
                    try:
                        if self.limits is not None:
                            self.limits.charge_retained(held_line)
                        raw = (json.dumps(record) + "\n").encode("utf-8")
                        if check_space is not None:
                            check_space(max(len(raw), expected_total - total_bytes))
                        total_bytes += len(raw)
                        offset = 0
                        while offset < len(raw):
                            offset += handle.write(raw[offset:])
                    finally:
                        raw = b""
                        if self.limits is not None:
                            self.limits.release_retained(held_line)
                os.fsync(handle.fileno())
            read_total = 0
            with open(temporary, "rb") as handle:
                for record in records_fn():
                    if self.limits is not None:
                        self.limits.check_deadline()
                    exp_len = self._serialized_record_bytes(record, read_total, f"{label} read-back")
                    held_read = HELD_LEDGER_ENTRY + exp_len * 3
                    expected = b""
                    actual = b""
                    try:
                        if self.limits is not None:
                            self.limits.charge_retained(held_read)
                        expected = (json.dumps(record) + "\n").encode("utf-8")
                        actual = handle.read(exp_len)
                        read_total += len(actual)
                        if actual != expected:
                            raise Refused(f"{path} did not read back as written")
                    finally:
                        expected = b""
                        actual = b""
                        if self.limits is not None:
                            self.limits.release_retained(held_read)
                extra = handle.read(1)
                if extra:
                    raise Refused(f"{path} did not read back as written")
            return temporary
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

    def stage_items(self, folder, inputs_digest, rows_digest, inventory=None, check_space=None, extra_reserve=0):
        """Reconciles, writes and reads back the item and inventory ledgers into temporary files without replacing
        existing published files yet."""
        if self.limits is not None:
            self.limits.check_deadline()
        if len(self.items) != self.met:
            raise Refused(f"the item ledger names {len(self.items)} of {self.met} items")
        inv_source = inventory if inventory is not None else self.inventory
        keep_external_inv = inventory is not None
        recon_scratch = 0
        inv_retained = 0
        seen_ids = set()
        seen_inv = set()
        external_inv_list = []
        staged = []
        try:
            try:
                for entry in self.items:
                    if self.limits is not None:
                        self.limits.check_deadline()
                    item_id = entry["item"]
                    cost = HELD_LEDGER_ENTRY + _utf8_len(item_id)
                    recon_scratch += cost
                    if self.limits is not None:
                        self.limits.charge_retained(cost)
                    if item_id in seen_ids:
                        raise Refused("the item ledger names an item twice")
                    seen_ids.add(item_id)
                if inv_source:
                    for raw_item in inv_source:
                        if self.limits is not None:
                            self.limits.check_deadline()
                        item_id = raw_item if isinstance(raw_item, str) else str(raw_item)
                        cost = HELD_LEDGER_ENTRY + _utf8_len(item_id)
                        recon_scratch += cost
                        if self.limits is not None:
                            self.limits.charge_retained(cost)
                        if item_id in seen_inv:
                            raise Refused("the input inventory names an item twice")
                        seen_inv.add(item_id)
                        if keep_external_inv:
                            inv_retained += cost
                            if self.limits is not None:
                                self.limits.charge_retained(cost)
                            external_inv_list.append(item_id)
                    inv_count = len(external_inv_list) if keep_external_inv else len(self.inventory)
                    if seen_inv != seen_ids or inv_count != len(self.items):
                        raise Refused(
                            f"the item ledger ({len(self.items)} items) does not match the input inventory ({inv_count} items)"
                        )
            finally:
                seen_ids.clear()
                seen_inv.clear()
                del seen_ids
                del seen_inv
                if self.limits is not None and recon_scratch:
                    self.limits.release_retained(recon_scratch)
            path = Path(folder) / ITEMS

            def iter_items():
                yield {"inputs": inputs_digest, "rows": rows_digest}
                for entry in self.items:
                    yield entry

            inv_items = external_inv_list if keep_external_inv else self.inventory

            def iter_inventory():
                yield {"inputs": inputs_digest}
                for item_id in inv_items:
                    yield {"item": item_id}

            inv_expected = 0
            if check_space is not None and inv_items:
                items_probe = 0
                for record in iter_items():
                    if self.limits is not None:
                        self.limits.check_deadline()
                    items_probe += self._serialized_record_bytes(record, items_probe, f"{ITEMS} serialization")
                for record in iter_inventory():
                    if self.limits is not None:
                        self.limits.check_deadline()
                    inv_expected += self._serialized_record_bytes(record, inv_expected, f"{INVENTORY_ITEMS} serialization")

            items_check = (
                (lambda n: check_space(n + inv_expected + max(0, int(extra_reserve))))
                if check_space is not None
                else None
            )
            staged.append((self._stage_jsonl_streamed(path, iter_items, ITEMS, check_space=items_check), path))
            if inv_items:
                inv_path = Path(folder) / INVENTORY_ITEMS
                inv_check = (
                    (lambda n: check_space(n + max(0, int(extra_reserve))))
                    if check_space is not None
                    else None
                )
                staged.append(
                    (self._stage_jsonl_streamed(inv_path, iter_inventory, INVENTORY_ITEMS, check_space=inv_check), inv_path)
                )
            return staged
        except BaseException:
            for tmp, _ in staged:
                tmp.unlink(missing_ok=True)
            raise
        finally:
            external_inv_list.clear()
            del external_inv_list
            if self.limits is not None and inv_retained:
                self.limits.release_retained(inv_retained)

    def write_items(self, folder, inputs_digest, rows_digest, inventory=None):
        """The item ledger, written whole (temp then rename) once every item met is named exactly once; bound to the
        inputs and rows it describes. Refused while any item is unnamed or named twice, or disagrees with an
        independently enumerated input inventory, so a partial ledger never stands in for the whole."""
        staged = self.stage_items(folder, inputs_digest, rows_digest, inventory=inventory)
        try:
            for tmp, dst in staged:
                os.replace(tmp, dst)
        finally:
            for tmp, _ in staged:
                tmp.unlink(missing_ok=True)
        return Path(folder) / ITEMS

    def _build_receipt(self, rows, converter, inputs_digest, parameters=None, rows_digest=None):
        rejected = sum(self.rejected.values())
        if self.exported + self.sampled_out + rejected != self.met:
            raise Refused(f"the export accounts for {self.exported + self.sampled_out + rejected} of {self.met} items")
        return {
            "met": self.met,
            "exported": self.exported,
            "sampled_out": self.sampled_out,
            "rejected": dict(sorted(self.rejected.items())),
            "rows_sha256": rows_digest if rows_digest is not None else file_digest(rows),
            "converter_sha256": file_digest(converter),
            "inputs": inputs_digest,
            "recipe": {
                "parameters": dict(sorted((parameters or {}).items())),
                "helper_sha256": file_digest(__file__),
                "python": platform.python_version(),
            },
        }

    def publish(
        self,
        folder,
        staged_rows,
        out_rows,
        converter,
        inputs_digest,
        parameters=None,
        inventory=None,
        check_space=None,
    ):
        """Validates and stages the complete generation (rows, item ledger, inventory ledger and export receipt) before
        replacing any published file, preserving backups of the previous generation across the replacement sequence so
        any failure or interruption leaves a recoverable generation intact."""
        folder = Path(folder)
        staged_rows, out_rows = Path(staged_rows), Path(out_rows)
        rejected = sum(self.rejected.values())
        if self.exported + self.sampled_out + rejected != self.met:
            raise Refused(f"the export accounts for {self.exported + self.sampled_out + rejected} of {self.met} items")
        rows_digest = file_digest(staged_rows)
        receipt = self._build_receipt(out_rows, converter, inputs_digest, parameters=parameters, rows_digest=rows_digest)
        export_bytes = len((json.dumps(receipt, indent=1, sort_keys=True) + "\n").encode("utf-8"))
        staged_ledgers = self.stage_items(
            folder,
            inputs_digest,
            rows_digest,
            inventory=inventory,
            check_space=check_space,
            extra_reserve=export_bytes,
        )
        try:
            if check_space is not None:
                check_space(export_bytes)
            staged_export = stage_json(folder / EXPORT, receipt)
        except BaseException:
            for tmp, _ in staged_ledgers:
                tmp.unlink(missing_ok=True)
            raise
        replacements = [(staged_rows, out_rows), *staged_ledgers, staged_export]
        backups = []
        try:
            for _, dst in replacements:
                if dst.is_file():
                    backup = dst.with_name(f".prev.{dst.name}.{os.getpid()}.tmp")
                    backup.unlink(missing_ok=True)
                    os.link(dst, backup)
                    backups.append((backup, dst))
            for tmp, dst in replacements:
                os.replace(tmp, dst)
            dir_fd = os.open(folder, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except BaseException:
            for backup, dst in reversed(backups):
                if backup.is_file():
                    try:
                        os.rename(backup, dst)
                    except OSError:
                        pass
            raise
        finally:
            for tmp, _ in replacements:
                tmp.unlink(missing_ok=True)
            for backup, _ in backups:
                backup.unlink(missing_ok=True)
        return receipt

    def write(self, folder, rows, converter, inputs_digest, parameters=None, rows_digest=None):
        """Writes EXPORT.json beside the rows, once its totals reconcile; returns it. `parameters` are the run's own
        (the sample cap and seed), recorded with this module's digest and the interpreter, so the receipt names the whole
        recipe that made the rows (completion review E1)."""
        receipt = self._build_receipt(rows, converter, inputs_digest, parameters=parameters, rows_digest=rows_digest)
        write_json(Path(folder) / EXPORT, receipt)
        return receipt
