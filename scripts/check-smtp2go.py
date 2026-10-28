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

What it cannot prove: the key's complete permission set and its permitted sender domains are saved settings that only
an account-level key can read (SMTP2GO's `apikey/view` answers 404 to this one), so they are the operator's read-back
(D99 T01 §11). The product's own boundary is `sendMail`, which refuses any sender outside isitlegit.co.za
(`test/mail/smtp2go.test.ts`); SMTP2GO itself refuses only unverified sender domains (probe 2026-10-29, §4).

Each stage is announced before it runs and its result printed as it completes. Exit 0 when all hold, 1 with the reason
and the next action when one does not, 2 when the vault, SMTP2GO or DNS could not be reached or answered a quota
(429) or server (5xx) error, which says nothing about the key. Stdlib only; needs `dig`.
"""
import http.client
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
    """(HTTP status, the answer's data object) for a read-only SMTP2GO call; Unreachable on a transport failure, a
    quota or server error, or an answer that is not a whole JSON object with a data object."""
    request = urllib.request.Request(API + endpoint, data=b"{}", headers={
        "X-Smtp2go-Api-Key": key, "Content-Type": "application/json", "accept": "application/json"})
    try:
        try:
            with urllib.request.urlopen(request, timeout=SECONDS) as response:
                status, raw = response.status, response.read(1024 * 1024)
        except urllib.error.HTTPError as exc:
            status, raw = exc.code, exc.read(1024 * 1024)
    except (urllib.error.URLError, OSError, TimeoutError, http.client.HTTPException) as exc:
        raise Unreachable(f"SMTP2GO could not be reached ({type(exc).__name__})") from None
    if status == 429 or status >= 500:
        raise Unreachable(f"SMTP2GO answered HTTP {status} for {endpoint} (quota or its own error)")
    try:
        body = json.loads(raw)
    except ValueError:
        raise Unreachable(f"SMTP2GO's HTTP {status} answer for {endpoint} could not be read whole") from None
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        raise Unreachable(f"SMTP2GO's HTTP {status} answer for {endpoint} has no data object")
    return status, data


def cname(name):
    """The CNAME target, or "" when the name has none; Unreachable when the lookup itself failed (dig's exit, or a
    resolver status other than NOERROR or NXDOMAIN), so a failed lookup is never read as a missing record."""
    try:
        done = subprocess.run(["dig", "@1.1.1.1", "+time=5", "+tries=2", "+noall", "+comments", "+answer", "CNAME", name],
                              capture_output=True, text=True, timeout=SECONDS)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Unreachable(f"dig could not run ({type(exc).__name__})") from None
    status = re.search(r"status: ([A-Z]+)", done.stdout)
    if done.returncode != 0 or not status or status[1] not in ("NOERROR", "NXDOMAIN"):
        raise Unreachable(f"the DNS lookup of {name} failed ({status[1] if status else f'dig exit {done.returncode}'})")
    for line in done.stdout.splitlines():
        parts = line.split()
        if not line.startswith(";") and len(parts) == 5 and parts[3] == "CNAME":
            return parts[4]
    return ""


def check(read=read_key, call=post, lookup=cname, say=print):
    """(exit code, last line); each stage is announced through `say` before it runs and its result after."""
    try:
        say("check-smtp2go: reading the key from the vault (up to 60 s)")
        key = read()
        if not KEY_SHAPE.fullmatch(key):
            return 1, "check-smtp2go: the vault item does not hold an SMTP2GO key (api-...); paste the key again"
        say("check-smtp2go: reading the key's sending stats")
        status, data = call(key, "stats/email_summary")
        if status != 200 or "cycle_max" not in data:
            return 1, (f"check-smtp2go: the key could not read its stats (HTTP {status}); it is invalid or revoked: "
                       "create a sending key and store it in the vault")
        say("check-smtp2go: the key is live")
        for endpoint in ("domain/view", "users/smtp/view"):
            say(f"check-smtp2go: asking for {endpoint}, which a sending key must be refused")
            status, data = call(key, endpoint)
            if data.get("error_code") != DENIED:
                return 1, (f"check-smtp2go: SMTP2GO did not refuse {endpoint} (HTTP {status}); narrow the key to "
                           "sending only in SMTP2GO's API keys page")
            say(f"check-smtp2go: {endpoint} refused")
        for name, target in CNAMES.items():
            say(f"check-smtp2go: looking up {name}")
            found = lookup(name)
            if found != target:
                return 1, (f"check-smtp2go: {name} resolves to {found or 'nothing'}, not {target}; restore the record "
                           "SMTP2GO's Sender Domains page gives")
            say(f"check-smtp2go: {name} -> {found}")
    except Unreachable as exc:
        return 2, f"check-smtp2go: {exc}; nothing was judged, run it again in a few minutes"
    return 0, "check-smtp2go: the key is live and narrowed to sending, and SMTP2GO's DKIM and return-path records resolve"


if __name__ == "__main__":
    code, line = check(say=lambda text: print(text, flush=True))
    print(line)
    sys.exit(code)
