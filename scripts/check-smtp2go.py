#!/usr/bin/env python3
"""Prove SMTP2GO sending is set up as D99 T01 §4 records it, without sending mail or printing the key.

    python3 scripts/check-smtp2go.py

Reads "IsItLegit SMTP2GO" from Conclave through conclave-op (60 seconds at most) and checks, the key only in the
`X-Smtp2go-Api-Key` header:

1. the key has SMTP2GO's shape (`api-` and 32 characters) and reads its account's sending stats (HTTP 200), so it is
   filled in and live;
2. SMTP2GO refuses it the account endpoints a narrowed key must not reach (`domain/view`, `users/smtp/view`:
   `ENDPOINT_PERMISSION_DENIED`), so it is restricted to sending, read back from the key itself;
3. the DKIM (`s1027207._domainkey`) and return-path (`em1027207`) CNAMEs resolve to SMTP2GO from public DNS.

The sender limit, isitlegit.co.za only, is enforced twice and checked elsewhere: SMTP2GO refuses unverified sender
domains (probe 2026-10-29, recorded in §4), and `sendMail` refuses any other sender (`test/mail/smtp2go.test.ts`).
Exit 0 when all hold, 1 with the reason when one does not, 2 when the vault, SMTP2GO or DNS could not be reached.
Stdlib only; needs `dig`.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

ITEM = "op://Conclave/IsItLegit SMTP2GO/credential"
API = "https://api.smtp2go.com/v3/"
KEY_SHAPE = re.compile(r"api-[0-9A-Za-z]{32}")
DENIED = "E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED"
CNAMES = {"em1027207.isitlegit.co.za": "return.smtp2go.net.", "s1027207._domainkey.isitlegit.co.za": "dkim.smtp2go.net."}
SECONDS = 30


class Unreachable(Exception):
    """The vault, SMTP2GO or DNS could not be reached: no judgement."""


def read_key():
    reader = os.path.expanduser("~/.local/bin/conclave-op")
    try:
        done = subprocess.run([reader, "read", ITEM], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise Unreachable("the vault did not answer within 60 s") from None
    except OSError as exc:
        raise Unreachable(f"conclave-op could not run ({exc.strerror})") from None
    if done.returncode != 0:
        raise Unreachable("the vault refused the read; check the item exists and the service account token is loaded")
    return done.stdout.strip()


def post(key, endpoint):
    """(HTTP status, the answer's data object) for a read-only SMTP2GO call."""
    request = urllib.request.Request(API + endpoint, data=b"{}", headers={
        "X-Smtp2go-Api-Key": key, "Content-Type": "application/json", "accept": "application/json"})
    try:
        try:
            with urllib.request.urlopen(request, timeout=SECONDS) as response:
                status, raw = response.status, response.read(1024 * 1024)
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read(1024 * 1024)
        body = json.loads(raw)
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
        raise Unreachable(f"SMTP2GO could not be read ({type(exc).__name__})") from None
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise Unreachable(f"SMTP2GO's HTTP {status} answer has no data object")
    return status, data


def cname(name):
    try:
        done = subprocess.run(["dig", "@1.1.1.1", "+short", "+time=5", "+tries=2", "CNAME", name],
                              capture_output=True, text=True, timeout=SECONDS)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Unreachable(f"dig could not run ({type(exc).__name__})") from None
    if done.returncode != 0:
        raise Unreachable(f"dig exited {done.returncode} for {name}")
    return done.stdout.strip()


def check(read=read_key, call=post, lookup=cname):
    """(exit code, line)."""
    try:
        key = read()
        if not KEY_SHAPE.fullmatch(key):
            return 1, "check-smtp2go: the vault item does not hold an SMTP2GO key (api-...); paste the key again"
        status, data = call(key, "stats/email_summary")
        if status != 200 or "cycle_max" not in data:
            return 1, f"check-smtp2go: the key could not read its stats (HTTP {status}); it is invalid or revoked"
        for endpoint in ("domain/view", "users/smtp/view"):
            status, data = call(key, endpoint)
            if data.get("error_code") != DENIED:
                return 1, (f"check-smtp2go: SMTP2GO did not refuse {endpoint} (HTTP {status}); narrow the key to "
                           "sending only")
        for name, target in CNAMES.items():
            found = lookup(name)
            if found != target:
                return 1, f"check-smtp2go: {name} resolves to {found or 'nothing'}, not {target}"
    except Unreachable as exc:
        return 2, f"check-smtp2go: {exc}; nothing was judged"
    return 0, "check-smtp2go: the key is live and narrowed to sending, and SMTP2GO's DKIM and return-path records resolve"


if __name__ == "__main__":
    code, line = check()
    print(line)
    sys.exit(code)
