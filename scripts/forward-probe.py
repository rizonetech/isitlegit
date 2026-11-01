#!/usr/bin/env python3
"""Measure the refusal-to-alert time of D01 T02 §12 live (D01 T02 §14), without printing a secret.

    python3 scripts/forward-probe.py send --count 5 --record build/forward-probes.json
    python3 scripts/forward-probe.py read --record build/forward-probes.json

`send` sends `--count` probes from alerts@isitlegit.co.za through SMTP2GO to hello@isitlegit.co.za, each subject
carrying `ILPROBE-7Q4K9X`, which the operator's kept Exchange rule refuses after Email Routing forwards it (§9's
correction of 2026-10-31), a minute apart so each refusal is its own incident; it writes each probe's subject, send time
and SMTP2GO email id to the record (temp file, then replace).

`read` ties each probe to its own incident and alert through the Worker's records (D01 T02 §14, corrections 7 to 10), never
by time order: the probe subject's hash (`subjectKey` in `src/mail/forwarding.ts`) finds its `forward_incidents` rows
(one fixed read-only SELECT against production D1 through `wrangler d1 execute isitlegit --remote`, the local login),
`forward_notices` counts the notices on each, and the alert is the `mail_sends` row `forward-failure:<incident key>:1`
(`provider_id` = SMTP2GO's email id, confirmed in SMTP2GO's activity, which gives the send time). A probe passes only with
exactly one incident that holds all its notices and one sent alert; a second incident for its subject or a missing alert
fails the run, whatever other alerts were sent. Refusal time is the incident's `occurred_at` (its earliest notice).
It prints each probe's times and the 95th percentile (nearest rank) of refusal-to-alert, and exits 0 only when every
probe passes and the p95 is under 25 minutes, 1 when not, 2 when the vault, SMTP2GO, Cloudflare or D1 could not be read.

Secrets: the SMTP2GO key (`op://Conclave/IsItLegit SMTP2GO/credential`) is read from Conclave through conclave-op and goes
only into a request header, never argv, output or the record. Production D1 is read through the operator's local Wrangler
login, with one fixed SELECT.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_smtp2go", HERE / "check-smtp2go.py")
smtp2go = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smtp2go)

MARK = "ILPROBE-7Q4K9X"
SENDER = "IsItLegit alerts <alerts@isitlegit.co.za>"
ALIAS = "hello@isitlegit.co.za"
TARGET_MINUTES = 25
def now():
    return datetime.datetime.now(datetime.UTC)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(text):
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))


def write_record(path, record):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(record, indent=2) + "\n")
    os.replace(tmp, path)


MAX_PROBES = 10


def send(args):
    # Bounded, so a typo never mails the alias in bulk; spaced at least a minute so each refusal is its own incident.
    if not 1 <= args.count <= MAX_PROBES or args.spacing < 60:
        print(f"forward-probe: --count is 1 to {MAX_PROBES} and --spacing at least 60 seconds")
        return 2
    key = smtp2go.read_key()
    record = {"probes": []}
    stamp = now().strftime("%Y%m%dT%H%MZ")
    for n in range(1, args.count + 1):
        subject = f"{MARK} refusal-to-alert probe {n} of {args.count} {stamp} (D01 T02 section 14)"
        body = json.dumps({
            "sender": SENDER,
            "to": [ALIAS],
            "subject": subject,
            "text_body": "A probe of the forwarding alert (D01 T02 section 14). The operator's mail rule refuses it.",
        }).encode()
        status, data = smtp2go._post(key, "email/send", body)
        sent = now()
        if status != 200 or data.get("succeeded") != 1:
            print(f"forward-probe: probe {n} was not accepted (HTTP {status}, {data.get('error_code')})")
            return 1
        record["probes"].append({"n": n, "subject": subject, "sent": iso(sent), "email_id": data.get("email_id")})
        write_record(args.record, record)
        print(f"forward-probe: probe {n} sent {iso(sent)} ({data.get('email_id')})")
        if n < args.count:
            time.sleep(args.spacing)
    return 0


REPORT_PREFIX = re.compile(
    r"^\s*(?:undeliverable|undelivered mail returned to sender|delivery status notification \(failure\)|returned mail"
    r"|mail delivery failed|failure notice)\s*:\s*", re.I)


def subject_hash(subject):
    """`subjectKey` in src/mail/forwarding.ts: the subject without a report's prefix, trimmed and lower-cased."""
    return hashlib.sha256(REPORT_PREFIX.sub("", subject or "", count=1).strip().lower().encode()).hexdigest()


def d1(sql):
    """Rows of one fixed read-only SELECT against production D1, through the local Wrangler login."""
    if not sql.lstrip().upper().startswith("SELECT"):
        raise smtp2go.Unreachable("only a SELECT is run against production")
    try:
        done = subprocess.run(["pnpm", "exec", "wrangler", "d1", "execute", "isitlegit", "--remote", "--json",
                               "--command", sql], capture_output=True, text=True, timeout=120, cwd=HERE.parent)
        out = json.loads(done.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise smtp2go.Unreachable("production D1 could not be read through Wrangler") from None
    if done.returncode != 0 or not out or not out[0].get("success"):
        raise smtp2go.Unreachable("production D1 answered an error")
    return out[0].get("results") or []


def records(probes):
    """(incidents with their notice counts, the alerts' mail_sends rows) for these probes, fixed SELECTs with only hex
    hashes and keys inlined."""
    hashes = ",".join(f"'{subject_hash(p['subject'])}'" for p in probes)
    incidents = d1("SELECT i.key, i.subject_hash, i.kind, i.state, i.alert, i.occurred_at, i.detected_at, "
                   "(SELECT COUNT(*) FROM forward_notices n WHERE n.incident_key = i.key) AS notices "
                   f"FROM forward_incidents i WHERE i.subject_hash IN ({hashes})")
    keys = ",".join(f"'forward-failure:{i['key']}:1'" for i in incidents if re.fullmatch(r"[0-9a-f]{64}", i["key"]))
    sends = d1("SELECT send_key, status, provider_id, updated_at FROM mail_sends "
               f"WHERE send_key IN ({keys})") if keys else []
    return incidents, sends


def activity(key, start, end):
    """SMTP2GO's activity events by email id: the earliest delivery-side event time of each."""
    window = json.dumps({"start_date": iso(start), "end_date": iso(end), "limit": 500}).encode()
    status, data = smtp2go._post(key, "activity/search", window)
    if status != 200:
        raise smtp2go.Unreachable(f"SMTP2GO's activity search answered HTTP {status}")
    found = {}
    for event in data.get("events") or []:
        if event.get("event") in ("processed", "delivered") and event.get("email_id") and event.get("date"):
            at = parse(event["date"])
            found[event["email_id"]] = min(at, found.get(event["email_id"], at))
    return found


def evaluate(probes, incidents, sends, sent_at):
    """Sets each probe's `incident`, `refused`, `alerted`, `minutes` and `problems`. A probe passes only with exactly
    one `refused` incident for its subject, a notice on it, and a `sent` alert row `forward-failure:<key>:1` whose
    provider id SMTP2GO's activity confirms; whatever else was sent meanwhile pairs with nothing."""
    by_send = {s["send_key"]: s for s in sends}
    for p in probes:
        mine = [i for i in incidents if i["subject_hash"] == subject_hash(p["subject"])]
        p.update(incident=None, refused=None, alerted=None, minutes=None, problems=[])
        if len(mine) != 1:
            p["problems"].append(f"{len(mine)} incidents for its subject, one expected")
        if not mine:
            continue
        i = mine[0]
        p["incident"] = i["key"][:8]
        p["refused"] = i["occurred_at"]
        if i["kind"] != "refused":
            p["problems"].append(f"its incident is {i['kind']}, not refused")
        if not i.get("notices"):
            p["problems"].append("no refusal notice is held on its incident")
        row = by_send.get(f"forward-failure:{i['key']}:1")
        if not row or row["status"] != "sent":
            p["problems"].append("no sent alert for its incident")
            continue
        at = sent_at.get(row["provider_id"])
        if at is None:
            p["problems"].append("SMTP2GO's activity does not confirm the alert's email id")
            continue
        p["email_id_alert"] = row["provider_id"]
        p["alerted"] = iso(at)
        if len(mine) == 1 and not p["problems"]:
            p["minutes"] = round((at - parse(i["occurred_at"])).total_seconds() / 60, 1)
    return probes


def p95(values):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def read(args):
    record = json.loads(pathlib.Path(args.record).read_text())
    probes = record["probes"]
    first = min(parse(p["sent"]) for p in probes)
    start, end = first - datetime.timedelta(minutes=1), now()
    incidents, sends = records(probes)
    sent_at = activity(smtp2go.read_key(), start, end)
    evaluate(probes, incidents, sends, sent_at)
    write_record(args.record, record)
    for p in probes:
        print(f"probe {p['n']}: sent {p['sent']}, refused {p.get('refused')}, alerted {p.get('alerted')}, "
              f"{p.get('minutes')} min, incident {p.get('incident')}, probe email {p.get('email_id')}, alert email "
              f"{p.get('email_id_alert')}{'; ' + '; '.join(p['problems']) if p['problems'] else ''}")
    minutes = [p["minutes"] for p in probes if p.get("minutes") is not None]
    print(f"probes passing: {len(minutes)} of {len(probes)}")
    if len(minutes) < len(probes):
        return 1
    worst = p95(minutes)
    print(f"p95 refusal-to-alert: {worst} min (target under {TARGET_MINUTES})")
    return 0 if worst < TARGET_MINUTES else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("send")
    s.add_argument("--count", type=int, default=5)
    s.add_argument("--spacing", type=int, default=60)
    s.add_argument("--record", required=True)
    r = sub.add_parser("read")
    r.add_argument("--record", required=True)
    args = parser.parse_args()
    try:
        return send(args) if args.command == "send" else read(args)
    except smtp2go.Unreachable as exc:
        print(f"forward-probe: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
