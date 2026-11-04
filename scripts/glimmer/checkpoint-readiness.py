#!/usr/bin/env python3
"""Read-only checkpoint discovery. Never export, deploy, infer, or stop training.

Exit 0: candidate available, not evaluation/rollout permission. Exit 1: confirmed
absence or evidence refusal. Exit 2: discovery unavailable or invocation failure.
Live listing requires --live and the Fireworks SDK environment; fixtures use an
explicit --provider-list snapshot. No automatic retries or provider mutations.
"""
import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
TOKEN = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\Z")
HEX = re.compile(r"[0-9a-f]{64}\Z")
OP = str(Path.home() / ".local/bin/conclave-op")


class Refused(Exception):
    def __init__(self, state, retry="correct_evidence", exit_code=1, retry_after_seconds=None):
        self.state, self.retry, self.exit_code = state, retry, exit_code
        self.retry_after_seconds = retry_after_seconds


def sha(data):
    return hashlib.sha256(data).hexdigest()


def integer(x):
    return type(x) is int and x >= 0


def strict(data):
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                raise ValueError()
            result[k] = v
        return result
    def bad(_):
        raise ValueError()
    return json.loads(data, object_pairs_hook=pairs, parse_constant=bad)


class Snapshot:
    def __init__(self):
        self.paths, self.hashes = {}, {}

    def read(self, path, role, binary=False):
        path = Path(path)
        try:
            before = path.stat()
            if not binary and before.st_size > 16 * 1024 * 1024:
                raise Refused("oversized_evidence")
            digest = hashlib.sha256()
            chunks = []
            with path.open("rb") as f:
                while chunk := f.read(1024 * 1024):
                    digest.update(chunk)
                    if not binary:
                        chunks.append(chunk)
                        if sum(map(len, chunks)) > 16 * 1024 * 1024:
                            raise Refused("oversized_evidence")
            after = path.stat()
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if identity(before) != identity(after):
                raise Refused("concurrent_change", "new_observation")
            self.paths[role] = (path, identity(after))
            self.hashes[role] = digest.hexdigest()
            if binary:
                return digest.hexdigest()
            value = strict(b"".join(chunks))
            if not isinstance(value, dict):
                raise Refused("malformed_evidence")
            return value
        except (OSError, ValueError, RecursionError):
            raise Refused("missing_or_malformed_evidence") from None

    def stable(self):
        for path, before in self.paths.values():
            try:
                s = path.stat()
                after = (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                if before != after:
                    raise Refused("concurrent_change", "new_observation")
            except OSError:
                raise Refused("concurrent_change", "new_observation") from None


def history_of(saved):
    history = saved.get("sessions") or [{**{k: saved.get(k) for k in ("session", "run", "account")}, "checkpoints_before": []}]
    if not isinstance(history, list) or not history:
        raise Refused("invalid_session_history")
    seen = set()
    for row in history:
        if not isinstance(row, dict) or any(not isinstance(row.get(k), str) or not TOKEN.fullmatch(row[k]) for k in ("session", "run", "account")):
            raise Refused("invalid_session_history")
        resource = f"accounts/{row['account']}/trainingSessions/{row['session']}"
        before = row.get("checkpoints_before")
        if resource in seen or not isinstance(before, list) or not all(isinstance(x, str) and re.fullmatch(r"step-\d+", x) for x in before):
            raise Refused("invalid_session_history")
        seen.add(resource)
    if any(saved.get(k) != history[-1][k] for k in ("session", "run", "account")):
        raise Refused("invalid_session_history")
    return history


def credential():
    try:
        rows = strict(subprocess.check_output([OP, "item", "list", "--vault", "Conclave", "--format=json"], stderr=subprocess.PIPE, timeout=45))
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            raise ValueError()
        matches = [r for r in rows if r.get("title") == "IsItLegit Fireworks Owner"]
        if len(matches) != 1 or not isinstance(matches[0].get("id"), str):
            raise ValueError()
        value = subprocess.check_output([OP, "read", f"op://Conclave/{matches[0]['id']}/credential"], stderr=subprocess.PIPE, timeout=45, text=True).strip()
        if not value:
            raise ValueError()
        return value
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        raise Refused("credentials_unavailable", "restore_vault_access", 2) from None


def retry_after(response):
    value = response.headers.get("Retry-After")
    if not isinstance(value, str):
        return None
    try:
        if re.fullmatch(r"\d{1,12}", value):
            return int(value)
        at = parsedate_to_datetime(value)
        if at.tzinfo is None:
            return None
        return max(0, int((at - datetime.now(timezone.utc)).total_seconds()) + 1)
    except (ValueError, TypeError, OverflowError):
        return None


def provider_page(response):
    if response.status_code in (401, 403):
        raise Refused("permission_denied", "restore_provider_access", 2)
    if response.status_code == 429 or response.status_code >= 500:
        # Caller reports no automatic retry; the lane applies durable soft backoff.
        raise Refused("provider_transient", "honor_retry_after_and_lane_backoff", 2, retry_after(response))
    if response.status_code != 200:
        raise Refused("provider_request_refused", "correct_request", 2)
    try:
        body = response.json()
        keys = [k for k in ("trainingSessionCheckpoints", "training_session_checkpoints", "checkpoints") if k in body]
        if not isinstance(body, dict) or len(keys) != 1 or not isinstance(body[keys[0]], list):
            raise ValueError()
        token = body.get("nextPageToken", body.get("next_page_token", ""))
        if not isinstance(token, str):
            raise ValueError()
        return body[keys[0]], token
    except (ValueError, TypeError, KeyError):
        raise Refused("malformed_provider_response", "inspect_provider_contract", 2) from None


def live_listing(resources):
    try:
        from fireworks.training.sdk import FireworksClient
        client = FireworksClient(api_key=credential())
        result = {}
        for resource in resources:
            rows, token, seen = [], "", set()
            for _ in range(100):
                query = {"pageSize": "200"}
                if token:
                    query["pageToken"] = token
                # Use the SDK transport without its short automatic retry loop.
                response = client._sync_client.get("https://api.fireworks.ai/v1/" + resource + "/checkpoints?" + urlencode(query), headers=client._headers(), timeout=30)
                page, token = provider_page(response)
                rows.extend(page)
                if not token:
                    break
                if token in seen:
                    raise Refused("malformed_provider_response", "inspect_provider_contract", 2)
                seen.add(token)
            else:
                raise Refused("provider_pagination_limit", "inspect_provider_contract", 2)
            result[resource] = rows
        return result
    except Refused:
        raise
    except Exception as error:
        state = "provider_timeout" if "Timeout" in type(error).__name__ else "provider_unavailable"
        raise Refused(state, "honor_retry_after_and_lane_backoff", 2) from None


def inspect(run, trainer_input, audit_path, listing):
    run = Path(run).resolve()
    snapshot = Snapshot()
    saved = snapshot.read(run / "serverless.json", "sessions")
    history = history_of(saved)
    checkpoints = snapshot.read(run / "cookbook/dataloader.json", "checkpoints").get("checkpoints")
    selection = snapshot.read(run / "selection.json", "selection")
    audit = snapshot.read(audit_path, "audit")
    actual_input = snapshot.read(trainer_input, "trainer_input", binary=True)
    lines = selection.get("lines")
    version = audit.get("version")
    if not integer(lines) or lines == 0 or not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+", version):
        raise Refused("invalid_input_binding")
    if selection.get("file_sha") != actual_input or selection.get("dataset_sha") != actual_input or audit.get("run") != str(run) or audit.get("trainer_input_matches_selection") is not True:
        raise Refused("invalid_input_binding")
    files = audit.get("files")
    if not isinstance(files, dict) or any(not isinstance(files.get(k), dict) or files[k].get("sha256") != actual_input for k in ("trainer-input", version + "/train.jsonl")) or files[version + "/train.jsonl"].get("lines") != lines:
        raise Refused("invalid_input_binding")
    if not isinstance(files.get("selection"), dict) or files["selection"].get("sha256") != snapshot.hashes["selection"]:
        raise Refused("invalid_input_binding")
    if audit.get("schema_version") != 1 or audit.get("status") not in ("verified", "incomplete", "conflicting", "failed") or not isinstance(audit.get("issues"), list):
        raise Refused("invalid_audit")
    if not isinstance(checkpoints, dict):
        raise Refused("invalid_local_checkpoints")
    for name, row in checkpoints.items():
        match = re.fullmatch(r"step-(\d+)", name)
        if not match or not isinstance(row, dict) or not integer(row.get("step")) or row["step"] != int(match[1]) or not integer(row.get("data_consumed")) or not 0 < row["data_consumed"] <= lines:
            raise Refused("invalid_local_checkpoints")
    resources = [f"accounts/{h['account']}/trainingSessions/{h['session']}" for h in history]
    listings = listing(resources)
    if not isinstance(listings, dict) or set(listings) != set(resources):
        raise Refused("malformed_provider_response", "inspect_provider_contract", 2)
    snapshot.hashes["provider_listing"] = sha(json.dumps(listings, sort_keys=True, allow_nan=False).encode())
    candidates, seen = [], set()
    for resource, owner in zip(resources, history):
        rows = listings[resource]
        if not isinstance(rows, list):
            raise Refused("malformed_provider_response", "inspect_provider_contract", 2)
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("name"), str) or type(row.get("promotable")) is not bool:
                raise Refused("malformed_provider_response", "inspect_provider_contract", 2)
            match = re.fullmatch(re.escape(resource + "/checkpoints/" + owner["run"]) + r"-step-(\d+)(?:-([a-zA-Z0-9_-]+))?", row["name"])
            if not match or row["name"] in seen:
                raise Refused("ambiguous_or_foreign_checkpoint")
            seen.add(row["name"])
            if not row["promotable"]:
                continue
            local_name = "step-" + match[1]
            local = checkpoints.get(local_name)
            expected_owner = [h for h in history if local_name not in h["checkpoints_before"]]
            if local is None or not expected_owner or expected_owner[-1] != owner:
                raise Refused("checkpoint_ownership_unproven")
            candidates.append({"name": row["name"], "session": resource, "run": owner["run"], "step": local["step"], "examples_consumed": local["data_consumed"], "promotable": True})
    candidates.sort(key=lambda c: c["step"], reverse=True)
    if len(candidates) > 1 and candidates[0]["step"] == candidates[1]["step"]:
        raise Refused("ambiguous_checkpoint")
    snapshot.stable()
    return {"schema_version": 1, "at": datetime.now(timezone.utc).isoformat(), "status": "available" if candidates else "confirmed_absent", "candidate": candidates[0] if candidates else None, "run": str(run), "version": version, "total_examples": lines, "input_sha256": actual_input, "sources": snapshot.hashes, "audit_status": audit["status"], "audit_blockers": audit["issues"], "comparison_evidence_ready": audit.get("comparison_ready") is True and audit["status"] == "verified" and not audit["issues"], "paid_comparison_ready": False, "next_action": "coordinate_verified_population_and_test_authorization_with_eval", "rollout_authorized": False}


def publish(path, report, store):
    path, allowed = Path(path).resolve(), Path(store).resolve() / "runs/checkpoint-readiness"
    if not path.is_relative_to(allowed) or path == allowed:
        raise Refused("invalid_receipt_destination")
    existing = path.parent
    while not existing.exists():
        existing = existing.parent
    result = subprocess.run(["git", "-C", str(existing), "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True, timeout=30)
    if result.returncode == 0 and result.stdout.strip() == "true":
        raise Refused("receipt_inside_repository")
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(report, allow_nan=False, indent=2) + "\n").encode()
    fd, temporary = tempfile.mkstemp(prefix=".readiness-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.link(temporary, path)
        # Persist every directory entry, including ancestors left by an interrupted attempt.
        for directory in [path.parent, *path.parent.parents]:
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        if path.read_bytes() != data:
            raise Refused("receipt_readback_failed")
    finally:
        Path(temporary).unlink(missing_ok=True)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--store", type=Path, default=Path(os.environ.get("GLIMMER_DATA_DIR", Path.home() / "isitlegit-data/glimmer")))
    p.add_argument("--run", type=Path, required=True)
    p.add_argument("--trainer-input", type=Path, required=True)
    p.add_argument("--audit", type=Path, required=True)
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument("--live", action="store_true")
    mode.add_argument("--provider-list", type=Path)
    p.add_argument("--receipt", type=Path)
    args = p.parse_args(argv)
    try:
        if args.live:
            listing = live_listing
        else:
            source = Snapshot()
            payload = source.read(args.provider_list, "provider_snapshot")
            listing = lambda _: payload
        report = inspect(args.run, args.trainer_input, args.audit, listing)
        report["observation"] = "live" if args.live else "supplied_snapshot"
        report["auditor_commit"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        report["auditor_sha256"] = sha(Path(__file__).read_bytes())
        if not args.live:
            source.stable()
            report["sources"].update(source.hashes)
        if args.receipt:
            publish(args.receipt, report, args.store)
        print(json.dumps(report))
        return 0 if report["candidate"] else 1
    except Refused as error:
        print(json.dumps({"status": error.state, "candidate": None, "retry": error.retry, "retry_after_seconds": error.retry_after_seconds, "paid_comparison_ready": False}))
        return error.exit_code
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        print(json.dumps({"status": "invocation_or_publication_failed", "candidate": None, "paid_comparison_ready": False}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
