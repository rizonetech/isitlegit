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


# First-download provenance for the pinned downloader (D03 T04 §42).
PIN_FOLDER = ".download-pins"
PIN_MODE = {"schema_version": 1, "mode": "first-download-pins"}


def pin_artifact(pinned, url):
    """Canonical identity, never merely a repository/commit shared by different files.

    Provider contracts: docs.github.com/en/rest/repos/contents and
    huggingface.co/docs/huggingface_hub/en/package_reference/file_download.
    """
    from urllib.parse import urlsplit, unquote, parse_qs
    if not isinstance(pinned, str) or not isinstance(url, str):
        raise Refused("a pin and its download URL must be strings")
    check_pin("download", pinned)
    gh, hf = GITHUB_PIN.fullmatch(pinned), HUGGING_FACE_PIN.fullmatch(pinned)
    if not gh and not hf:
        raise Refused("unsupported pin: use a GitHub or Hugging Face repository and full commit id")
    repo = pinned.split(": ", 1)[1].split(",", 1)[0]
    revision = (gh or hf).group(1)
    try:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
            raise ValueError()
        if re.search(r"%(?:2f|5c|25)", parsed.path, re.I):
            raise ValueError()
        path = unquote(parsed.path, errors="strict").strip("/")
        if any(p in ("", ".", "..") for p in path.split("/")) or "\\" in path:
            raise ValueError()
        parts = path.split("/")
        query = parse_qs(parsed.query, keep_blank_values=True)
        if query and not (hf and query == {"download": ["true"]}):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise Refused("a pinned URL must be an unambiguous HTTPS artifact URL") from None
    kind, file_path, actual_repo, actual_revision = None, None, None, None
    if hf and parsed.hostname == "huggingface.co" and len(parts) >= 6 and parts[0] == "datasets" and parts[3] == "resolve":
        actual_repo, actual_revision, kind, file_path = "/".join(parts[1:3]), parts[4], "file", "/".join(parts[5:])
    elif gh:
        host = parsed.hostname
        if host == "raw.githubusercontent.com" and len(parts) >= 4:
            actual_repo, actual_revision, kind, file_path = "/".join(parts[:2]), parts[2], "file", "/".join(parts[3:])
        elif host == "github.com" and len(parts) >= 5 and parts[2] == "raw":
            actual_repo, actual_revision, kind, file_path = "/".join(parts[:2]), parts[3], "file", "/".join(parts[4:])
        elif host == "github.com" and len(parts) == 4 and parts[2] == "archive":
            for suffix, form in ((".tar.gz", "tar.gz"), (".zip", "zip")):
                if parts[3].endswith(suffix):
                    actual_repo, actual_revision, kind = "/".join(parts[:2]), parts[3][:-len(suffix)], form
        elif host == "codeload.github.com" and len(parts) == 4 and parts[2] in ("zip", "tar.gz", "legacy.zip", "legacy.tar.gz"):
            actual_repo, actual_revision, kind = "/".join(parts[:2]), parts[3], parts[2]
        elif host == "api.github.com" and len(parts) == 5 and parts[0] == "repos" and parts[3] in ("zipball", "tarball"):
            actual_repo, actual_revision = "/".join(parts[1:3]), parts[4]
            kind = "legacy.zip" if parts[3] == "zipball" else "legacy.tar.gz"
    matches_repo = actual_repo is not None and (actual_repo.lower() == repo.lower() if gh else actual_repo == repo)
    if not matches_repo or actual_revision != revision or kind is None:
        raise Refused("the URL does not name the pinned repository, commit and supported artifact")
    return {"provider": "github" if gh else "huggingface", "repository": repo.lower() if gh else repo,
            "revision": revision, "kind": kind, "path": file_path}


def pin_redirect(artifact, pinned, previous, target):
    """A provider-origin redirect may resolve to its own delivery host, never an unrelated mirror."""
    from urllib.parse import urlsplit
    try:
        if pin_artifact(pinned, target) == artifact:
            return
    except Refused:
        pass
    old, new = urlsplit(previous), urlsplit(target)
    # HF's resolve endpoint supplies signed delivery URLs. They may not be supplied
    # as initial URLs/mirrors, since only the resolve response binds them to a file.
    def hf_delivery(host):
        return host in ("cdn-lfs.huggingface.co", "cdn-lfs.hf.co", "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "cas-bridge.xethub.hf.co")
    if artifact["provider"] == "huggingface" and new.scheme == "https" and not new.username and not new.password and new.port in (None, 443) and not new.fragment and hf_delivery(new.hostname) and (old.hostname == "huggingface.co" or old.hostname == new.hostname):
        return
    raise Refused("a pinned download redirected outside its artifact/provider delivery route")


def _pin_directory(folder):
    folder = Path(folder).resolve()
    directory = folder / PIN_FOLDER
    if not directory.resolve().is_relative_to(folder):
        raise Refused("pin evidence leaves its source folder")
    return directory


def pin_receipt_path(folder, name):
    if not isinstance(name, str) or Path(name).name != name or name.startswith("."):
        raise Refused("a pin receipt names one source file")
    return _pin_directory(folder) / (name + ".json")


def _pin_json(path):
    try:
        if path.stat().st_size > 64 * 1024:
            raise ValueError()
        with path.open(encoding="utf-8") as f:
            value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (OSError, ValueError, RecursionError):
        raise Refused("missing or invalid first-download pin evidence") from None


def _pin_absent(path, value, check_space=None):
    import tempfile
    data = (json.dumps(value, sort_keys=True) + "\n").encode()
    if path.exists():
        if _pin_json(path) != value:
            raise Refused("first-download pin evidence conflicts; use a new destination for a new artifact")
        # A previous attempt may have linked the evidence then failed its directory sync.
        # Retry the durability boundary before allowing the caller to publish data.
        with path.open("rb") as evidence:
            os.fsync(evidence.fileno())
        for directory in (path.parent, path.parent.parent):
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        return
    if check_space:
        check_space(len(data))
    path.parent.mkdir(parents=True, exist_ok=True)
    parent_fd = os.open(path.parent.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    fd, temporary = tempfile.mkstemp(prefix=".pin-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if _pin_json(path) != value:
                raise Refused("first-download pin evidence conflicts") from None
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        if _pin_json(path) != value:
            raise Refused("first-download pin evidence did not read back")
    finally:
        Path(temporary).unlink(missing_ok=True)


def mark_pin_mode(folder, check_space=None):
    _pin_absent(_pin_directory(folder) / ".mode.json", PIN_MODE, check_space)


def read_pin_receipt(folder, name, pinned, artifact=None):
    directory = _pin_directory(folder)
    if not directory.exists():
        return None
    if _pin_json(directory / ".mode.json") != PIN_MODE:
        raise Refused("invalid pinned-download mode marker")
    path = pin_receipt_path(folder, name)
    if not path.exists():
        return None
    row = _pin_json(path)
    if row.get("schema_version") != 1 or row.get("name") != name or row.get("pinned") != pinned or not isinstance(row.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) or type(row.get("bytes")) is not int or row["bytes"] < 0 or not isinstance(row.get("artifact"), dict):
        raise Refused("first-download pin receipt identity is invalid or different")
    canonical = row["artifact"]
    try:
        provider, repo, revision, kind, file_path = (canonical[key] for key in ("provider", "repository", "revision", "kind", "path"))
        if not all(isinstance(value, str) for value in (provider, repo, revision, kind)) or (not isinstance(file_path, str) if kind == "file" else file_path is not None):
            raise ValueError()
        if provider == "github":
            url = (f"https://raw.githubusercontent.com/{repo}/{revision}/{file_path}" if kind == "file"
                   else f"https://codeload.github.com/{repo}/{kind}/{revision}")
        elif provider == "huggingface" and kind == "file":
            url = f"https://huggingface.co/datasets/{repo}/resolve/{revision}/{file_path}"
        else:
            raise ValueError()
        if pin_artifact(pinned, url) != canonical:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise Refused("invalid canonical artifact in first-download receipt") from None
    if artifact is not None and row["artifact"] != artifact:
        raise Refused("first-download pin receipt names another artifact")
    return row


def save_pin_receipt(folder, name, pinned, artifact, digest, size, check_space=None):
    mark_pin_mode(folder, check_space)
    value = {"schema_version": 1, "name": name, "pinned": pinned, "artifact": artifact, "sha256": digest, "bytes": size}
    _pin_absent(pin_receipt_path(folder, name), value, check_space)
    return read_pin_receipt(folder, name, pinned, artifact)


def _download_pin_evidence(folder, name, pinned, measured, size, required=False):
    if not required and not _pin_directory(folder).exists():
        return None  # Historical receipt-free manifests retain their original contract.
    row = read_pin_receipt(folder, name, pinned)
    if row is None or row["sha256"] != measured or row["bytes"] != size:
        raise Refused(f"{name}: missing first-download evidence or bytes changed since pinned download")
    return file_digest(pin_receipt_path(folder, name))


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
        measured, size = file_digest(path), path.stat().st_size
        pin_evidence = _download_pin_evidence(folder, entry["name"], pinned, measured, size) if not published else None
        listed.append({
            **({"download_pin": pin_evidence} if pin_evidence is not None else {}),
            "name": entry["name"],
            "sha256": measured,
            "bytes": size,
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
        if not entry.get("published"):
            evidence = _download_pin_evidence(folder, name, entry.get("pinned"), entry["sha256"], entry["bytes"], required="download_pin" in entry)
            if "download_pin" in entry and entry["download_pin"] != evidence:
                raise Refused(f"{name}: first-download pin receipt changed since manifest creation")
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
