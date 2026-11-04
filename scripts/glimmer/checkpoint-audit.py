#!/usr/bin/env python3
"""Audit existing checkpoint inputs without repairing or replacing their evidence.

python3 scripts/glimmer/checkpoint-audit.py --version 1.1 --previous 1.0 \
  --trainer-input /external/train.jsonl --run /external/runs/loupe-1.1
Optional --receipt must be a new path under the store's runs/audits directory.
Exit 0 means the requested checks verified; 1 means evidence blocks verification;
2 means invocation or receipt publication failed. No provider calls are made.
"""
import argparse
import base64
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import re
import subprocess
import tempfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
# The §45 contract requires 100 own-page negatives; current builder code uses 50.
# Audit the contract, never silently lower it to match the interrupted build.
HARD_FLOORS = {"unseen-brand": 100, "own-page": 100, "small-site": 100, "news-or-fan": 50}
LURE_TYPES = {"none", "credential", "payment", "fake_shop", "impersonation"}
HEX = re.compile(r"[0-9a-f]{64}\Z")
VERSION = re.compile(r"[0-9]+\.[0-9]+\Z")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    def invalid(_):
        raise ValueError("nonfinite JSON number")
    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def integer(value):
    return type(value) is int and value >= 0


def obj(value):
    return value if isinstance(value, dict) else {}


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


class Reader:
    def __init__(self):
        self.issues = []
        self.files = {}
        self.identities = {}
        self.issue_index = {}

    def issue(self, code, role, kind="conflicting", line=None):
        # Counts and roles only: never echo malformed rows or private page content.
        item = {"code": code, "artifact": role, "kind": kind}
        if line is not None:
            item["line"] = line
        key = (code, role, kind)
        if key not in self.issue_index:
            self.issue_index[key] = item
            self.issues.append(item)
        else:
            existing = self.issue_index[key]
            existing["occurrences"] = existing.get("occurrences", 1) + 1

    def fingerprint(self, path):
        s = path.stat()
        return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)

    def begin(self, path, role):
        try:
            self.identities[role] = (path, self.fingerprint(path))
            return True
        except OSError:
            self.issue("missing_file", role, "incomplete")
            return False

    def finish(self, path, role, digest, count=None):
        self.files[role] = {"sha256": digest}
        if count is not None:
            self.files[role]["lines"] = count
        try:
            if self.fingerprint(path) != self.identities[role][1]:
                self.issue("changed_during_audit", role)
        except OSError:
            self.issue("changed_during_audit", role)

    def object(self, path, role):
        if not self.begin(path, role):
            return None
        try:
            data = path.read_bytes()
            self.finish(path, role, sha(data))
            result = strict_json(data)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (OSError, ValueError, UnicodeError):
            self.issue("invalid_json_object", role)
            return None

    def rows(self, path, role):
        if not self.begin(path, role):
            return
        digest = hashlib.sha256()
        count = 0
        try:
            with path.open("rb") as handle:
                for count, line in enumerate(handle, 1):
                    digest.update(line)
                    if not line.endswith(b"\n"):
                        self.issue("unterminated_line", role, line=count)
                    try:
                        row = strict_json(line)
                        if not isinstance(row, dict):
                            self.issue("not_object", role, line=count)
                            row = None
                    except (ValueError, UnicodeError):
                        self.issue("invalid_json", role, line=count)
                        row = None
                    yield row
        except OSError:
            self.issue("unreadable_file", role)
        self.finish(path, role, digest.hexdigest(), count)

    def bytes_digest(self, path, role):
        if not self.begin(path, role):
            return None
        digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    digest.update(chunk)
            self.finish(path, role, digest.hexdigest())
            return digest.hexdigest()
        except OSError:
            self.issue("unreadable_file", role)
            return None

    def stable(self):
        for role, (path, identity) in self.identities.items():
            try:
                if self.fingerprint(path) != identity:
                    self.issue("changed_during_audit", role)
            except OSError:
                self.issue("changed_during_audit", role)


def paired(reader, directory, part, role):
    ids, labels = set(), {}
    absent = object()
    lines = reader.rows(directory / f"{part}.jsonl", role + ".jsonl")
    metas = reader.rows(directory / f"{part}.meta.jsonl", role + ".meta.jsonl")
    for number, (line, meta) in enumerate(itertools.zip_longest(lines, metas, fillvalue=absent), 1):
        if line is absent or meta is absent:
            reader.issue("metadata_count_mismatch", role)
        if not isinstance(meta, dict):
            continue
        page_id = meta.get("id")
        if not isinstance(page_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}-[0-9a-f]{16}", page_id):
            reader.issue("invalid_id", role, line=number)
            continue
        if page_id in ids:
            reader.issue("duplicate_id", role, line=number)
        ids.add(page_id)
        label = meta.get("lure_type")
        if not isinstance(label, str) or label not in LURE_TYPES:
            reader.issue("invalid_label", role, line=number)
        else:
            labels[label] = labels.get(label, 0) + 1
        if not isinstance(line, dict):
            continue
        try:
            messages = line["messages"]
            if [m["role"] for m in messages] != ["system", "user", "assistant"]:
                raise ValueError()
            content = messages[1]["content"]
            pictures = [p["image_url"]["url"] for p in content if p["type"] == "image_url"]
            texts = [p["text"] for p in content if p["type"] == "text"]
            if len(pictures) != 1 or len(texts) != 1 or not pictures[0].startswith("data:image/jpeg;base64,"):
                raise ValueError()
            image = base64.b64decode(pictures[0].split(",", 1)[1], validate=True)
            if sha(image) != meta.get("screenshot"):
                reader.issue("screenshot_mismatch", role, line=number)
            nonce = sha(page_id.encode())[:32]
            if nonce not in texts[0]:
                reader.issue("nonce_mismatch", role, line=number)
            answer = strict_json(messages[2]["content"])
            if not isinstance(answer, dict) or answer.get("lure_type") != label or type(answer.get("lure")) is not bool or answer["lure"] != (label != "none"):
                reader.issue("answer_label_mismatch", role, line=number)
            # Recover the original page identity only from the version's immutable archive.
            archive = directory / "pages" / page_id
            if not archive.is_dir():
                reader.issue("missing_page_archive", role, "incomplete")
            else:
                image_path, text_path = archive / "screenshot.jpg", archive / "text.txt"
                archived_image = reader.bytes_digest(image_path, role + f"/archive-image-{number}")
                if archived_image != sha(image):
                    reader.issue("archive_image_mismatch", role, line=number)
                if reader.begin(text_path, role + f"/archive-text-{number}"):
                    original_text = text_path.read_bytes()
                    reader.finish(text_path, role + f"/archive-text-{number}", sha(original_text))
                    expected = str(meta.get("source")) + "-" + sha(image + b"\0" + original_text)[:16]
                    if expected != page_id:
                        reader.issue("archive_identity_mismatch", role, line=number)
        except (KeyError, IndexError, TypeError, ValueError, OSError):
            reader.issue("invalid_serialized_example", role, line=number)
    return ids, labels


def balance_proof(reader, balance, counts, role):
    if not isinstance(balance, dict):
        reader.issue("missing_split_balance", role, "incomplete")
        return
    if balance.get("status") != "MET" or balance.get("met") is not True:
        reader.issue("split_balance_unmet", role, "failed")
    tolerance = balance.get("tolerance")
    if not finite(tolerance) or not 0 <= tolerance <= 0.05:
        reader.issue("invalid_balance_tolerance", role)
        return
    rows = {"lure": balance.get("lure"), **{k: obj(balance.get("byLureType")).get(k) for k in LURE_TYPES}}
    for name, row in rows.items():
        if not isinstance(row, dict):
            reader.issue("missing_balance_row", role + "/" + name, "incomplete")
            continue
        gaps = []
        for side, key in (("train", "train"), ("evaluation", "eval")):
            labels = counts[key]
            total = sum(labels.values())
            lures = total - labels.get("none", 0)
            expected = lures if name == "lure" else labels.get(name, 0)
            denominator = total if name in ("lure", "none") else lures
            share = expected / denominator if denominator else 0
            target = row.get(side + "Target")
            gap = row.get(side + "Gap")
            if row.get(side + "Count") != expected or row.get(side + "Denominator") != denominator or not finite(row.get(side)) or abs(row[side] - share) > 1e-10 or not finite(target) or not 0 <= target <= 1 or not finite(gap) or abs(gap - abs(share - target)) > 1e-10:
                reader.issue("balance_count_mismatch", role + "/" + name)
                continue
            gaps.append(gap)
        if len(gaps) == 2 and (max(gaps) > tolerance or row.get("met") is not True):
            reader.issue("split_balance_unmet", role + "/" + name, "failed")


def provenance(reader, store, version, summary, ids, counts):
    role = version + "/provenance"
    freeze = summary.get("freeze")
    if not isinstance(freeze, dict) or not integer(freeze.get("pages")) or not isinstance(freeze.get("sha256"), str) or not HEX.fullmatch(freeze["sha256"]):
        reader.issue("missing_freeze", role, "incomplete")
    else:
        saved = reader.object(store / "raw" / f"FROZEN-{version}.json", version + "/freeze")
        pages = saved.get("pages") if saved else None
        if not isinstance(pages, list) or not all(isinstance(p, str) for p in pages) or len(pages) != len(set(pages)):
            reader.issue("invalid_freeze_membership", role)
        elif len(pages) != freeze["pages"] or sha("".join(p + "\n" for p in sorted(pages)).encode()) != freeze["sha256"]:
            reader.issue("freeze_digest_mismatch", role)
    held = list(reader.rows(store / "raw/dataset" / f"{version}.heldout-items.jsonl", version + "/heldout-items"))
    held_ids = [r.get("id") for r in held if isinstance(r, dict)]
    if len(held_ids) != len(set(x for x in held_ids if isinstance(x, str))) or set(x for x in held_ids if isinstance(x, str)) != ids:
        reader.issue("heldout_membership_mismatch", role)
    if not integer(summary.get("heldOut")):
        reader.issue("missing_heldout_provenance", role, "incomplete")
    ref = store / "dataset" / version / "reference"
    reference = reader.object(ref / "summary.json", version + "/reference-summary")
    if reference:
        lines = list(reader.rows(ref / "eval.meta.jsonl", version + "/reference-meta"))
        digest = reader.bytes_digest(ref / "eval.jsonl", version + "/reference-lines")
        if digest != obj(reference.get("sha256")).get("evaluation") or reference.get("pages") != len(lines):
            reader.issue("reference_mismatch", role)
        membership = obj(summary.get("reference")).get("sha256")
        if not isinstance(membership, str) or reference.get("membership") != membership:
            reader.issue("reference_membership_mismatch", role)
    if version != "1.0":
        floors = summary.get("floors")
        balance = summary.get("splitBalance")
        hard = summary.get("hardNegatives")
        if not isinstance(floors, dict):
            reader.issue("missing_floors", role, "incomplete")
        balance_proof(reader, balance, counts, role)
        if not isinstance(hard, dict) or not isinstance(hard.get("training"), dict):
            reader.issue("missing_hard_negatives", role, "incomplete")
        else:
            for kind, minimum in HARD_FLOORS.items():
                value = hard["training"].get(kind)
                if not integer(value) or value < minimum:
                    reader.issue("hard_negative_floor_unmet", role + "/" + kind, "failed")
            values = list(hard["training"].values())
            if not all(integer(v) for v in values) or sum(v for v in values if integer(v)) != sum(counts["train"].values()):
                reader.issue("hard_negative_count_mismatch", role)
            recorded = obj(floors).get("hardNegatives")
            if not isinstance(recorded, dict) or any(not integer(recorded.get(k)) or recorded[k] < n for k, n in HARD_FLOORS.items()):
                reader.issue("weakened_hard_negative_floors", role, "failed")


def dataset(reader, store, version):
    directory = store / "dataset" / version
    summary = reader.object(directory / "summary.json", version + "/summary") or {}
    if summary.get("version") != version:
        reader.issue("version_mismatch", version)
    membership, counts = {}, {}
    for part, key in (("train", "train"), ("eval", "evaluation")):
        role = version + "/" + part
        ids, labels = paired(reader, directory, part, role)
        membership[part] = ids
        counts[part] = labels
        measured = reader.files.get(role + ".jsonl", {})
        recorded = obj(summary.get("sha256")).get(key)
        if not isinstance(recorded, str) or not HEX.fullmatch(recorded) or measured.get("sha256") != recorded:
            reader.issue("summary_digest_mismatch", role)
        count = obj(summary.get(key)).get("lines")
        if not integer(count) or count != measured.get("lines"):
            reader.issue("summary_count_mismatch", role)
    if membership["train"] & membership["eval"]:
        reader.issue("training_evaluation_overlap", version)
    provenance(reader, store, version, summary, membership["eval"], counts)
    return summary, membership


def audit(store, version, previous=None, trainer_input=None, run=None):
    if not VERSION.fullmatch(version) or (previous is not None and not VERSION.fullmatch(previous)):
        raise ValueError("versions must be numeric major.minor")
    store = Path(store).resolve()
    reader = Reader()
    summary, members = dataset(reader, store, version)
    selection_matches = False
    if trainer_input is not None:
        measured = reader.bytes_digest(Path(trainer_input), "trainer-input")
        dataset_sha = reader.files.get(version + "/train.jsonl", {}).get("sha256")
        if not measured or measured != dataset_sha:
            reader.issue("trainer_input_mismatch", "trainer-input")
        selection = reader.object(Path(run) / "selection.json", "selection") if run else None
        if selection is None:
            reader.issue("missing_selection", "selection", "incomplete")
        elif selection.get("dataset_sha") != dataset_sha or selection.get("file_sha") != measured:
            reader.issue("selection_digest_mismatch", "selection")
        elif not integer(selection.get("lines")) or selection["lines"] != reader.files.get(version + "/train.jsonl", {}).get("lines"):
            reader.issue("selection_count_mismatch", "selection")
        else:
            selection_matches = True
    if previous:
        _, old = dataset(reader, store, previous)
        a = reader.files.get(version + "/eval.jsonl", {}).get("sha256")
        b = reader.files.get(previous + "/eval.jsonl", {}).get("sha256")
        if not a or a != b:
            reader.issue("different_evaluation_files", "comparison")
        if members["train"] & old["eval"] or old["train"] & members["eval"]:
            reader.issue("cross_version_training_overlap", "comparison")
    reader.stable()
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except subprocess.SubprocessError:
        commit = None
        reader.issue("unknown_auditor_commit", "auditor", "incomplete")
    kinds = {i["kind"] for i in reader.issues}
    status = next((k for k in ("conflicting", "failed", "incomplete") if k in kinds), "verified")
    return {"schema_version": 1, "at": datetime.now(timezone.utc).isoformat(), "auditor_commit": commit,
            "auditor_sha256": sha(Path(__file__).read_bytes()), "version": version, "previous": previous,
            "run": str(Path(run).resolve()) if run else None, "status": status,
            "trainer_input_matches_selection": selection_matches, "comparison_ready": bool(previous) and not reader.issues,
            "files": reader.files, "issues": reader.issues,
            "limits": ["No missing historical provenance is reconstructed.",
                       "Digest equality alone does not prove template or near-duplicate exclusion."]}


def publish_receipt(path, report, store):
    path, allowed = Path(path).resolve(), (Path(store).resolve() / "runs/audits")
    if not path.is_relative_to(allowed) or path == allowed:
        raise ValueError("receipt must be a new file under store/runs/audits")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(report, indent=2, allow_nan=False) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=".audit-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)  # Atomic absent-only publication, including concurrent writers.
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        if path.read_bytes() != data:
            raise OSError("receipt read-back mismatch")
    finally:
        Path(temporary).unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, default=Path(os.environ.get("GLIMMER_DATA_DIR", Path.home() / "isitlegit-data/glimmer")))
    parser.add_argument("--version", required=True)
    parser.add_argument("--previous")
    parser.add_argument("--trainer-input", type=Path)
    parser.add_argument("--run", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args(argv)
    try:
        report = audit(args.store, args.version, args.previous, args.trainer_input, args.run)
        if args.receipt:
            publish_receipt(args.receipt, report, args.store)
        print(json.dumps({"status": report["status"], "issues": report["issues"],
                          "comparison_ready": report["comparison_ready"]}))
        return 0 if report["status"] == "verified" else 1
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "error", "error_type": type(error).__name__}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
