#!/usr/bin/env python3
"""Prove SMTP2GO sending is set up as D99 T01 §4 records it, without sending mail or printing the key.

    python3 scripts/check-smtp2go.py

Reads "IsItLegit SMTP2GO" from Conclave through conclave-op (60 seconds at most) and checks, the key only in the
`X-Smtp2go-Api-Key` header:

1. the key has SMTP2GO's shape (`api-` followed by 32 characters, 36 in all) and reads its account's sending stats
   (HTTP 200), so it is live;
2. it may send: an empty `email/send` request is answered `NON_VALIDATING_IN_PAYLOAD`, a payload error SMTP2GO gives
   only past its permission check (it answers `ENDPOINT_PERMISSION_DENIED` first, as for the account endpoints below),
   so no mail is sent and the send permission is proven;
3. it searches activity as the reconciler does (`src/mail/reconcile.ts`: a dated window, a limit), answered with an
   events list, so an uncertain send can be settled;
4. SMTP2GO refuses it three account endpoints a sending key must not reach (`domain/view`, `users/smtp/view`,
   `api_keys/view`: `ENDPOINT_PERMISSION_DENIED`), read back from the key itself;
5. the DKIM (`s1027207._domainkey`) and return-path (`em1027207`) CNAMEs resolve to SMTP2GO from public DNS.

What it cannot prove: the key's complete permission set and its permitted sender domains are saved settings that only
a key allowed `api_keys/view` can read (SMTP2GO refuses this one that endpoint), so they are the operator's read-back
(D99 T01 §11). Redirects are refused, so the key's header never follows one to another host. The product's own boundary is `sendMail`, which refuses any sender outside isitlegit.co.za
(`test/mail/smtp2go.test.ts`); SMTP2GO itself refuses only unverified sender domains (probe 2026-10-29, §4).

Each stage is announced before it runs and its result printed as it completes. Exit 0 when all hold, 1 with the reason
and the next action when one does not, 2 when the vault, SMTP2GO or DNS could not be reached or answered a quota
(429) or server (5xx) error, which says nothing about the key. Stdlib only; needs `dig`.
"""
import concurrent.futures
import datetime
import http.client
import json
import os
import re
import subprocess
import sys
import time
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


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect: the key's header must never follow one to another host or scheme."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"redirect refused ({code})", headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


def read_by(stream, deadline, limit=1024 * 1024):
    """At most `limit` bytes, refused once the whole call passes its deadline (not only a stalled read)."""
    parts, size = [], 0
    while size < limit:
        if time.monotonic() > deadline:
            raise TimeoutError(f"the answer took longer than {SECONDS} s")
        chunk = stream.read(min(65536, limit - size))
        if not chunk:
            break
        parts.append(chunk)
        size += len(chunk)
    return b"".join(parts)


def _post(key, endpoint, body=b"{}", opener=OPENER):
    """(HTTP status, the answer's data object) for a read-only SMTP2GO call; Unreachable on a transport failure, a
    quota or server error, or an answer that is not a whole JSON object with a data object."""
    deadline = time.monotonic() + SECONDS
    request = urllib.request.Request(API + endpoint, data=body, headers={
        "X-Smtp2go-Api-Key": key, "Content-Type": "application/json", "accept": "application/json"})
    try:
        try:
            with opener.open(request, timeout=SECONDS) as response:
                status, raw = response.status, read_by(response, deadline)
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise Unreachable(f"SMTP2GO answered a redirect ({exc.code}), refused so the key stays with it") from None
            status, raw = exc.code, read_by(exc, deadline)
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

def post(key, endpoint, body=b"{}", opener=OPENER):
    """(HTTP status, the answer's data object) for a read-only SMTP2GO call.
    The whole call runs on a worker thread under one deadline (SECONDS): a read that blocks while bytes trickle in
    cannot hold it past that, since the wait is on the thread, not on the socket."""
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    try:
        return pool.submit(_post, key, endpoint, body, opener).result(timeout=SECONDS)
    except concurrent.futures.TimeoutError:
        raise Unreachable(f"the answer took longer than {SECONDS} s") from None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)



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


NOT_VALID = "E_ApiResponseCodes.NON_VALIDATING_IN_PAYLOAD"


def check(read=read_key, call=None, lookup=cname, say=print):
    """(exit code, last line); each stage is announced through `say` before it runs and its result after."""
    call = call or (lambda key, endpoint, body=b"{}": post(key, endpoint, body))
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
        say("check-smtp2go: the key is live; asking email/send with an empty request (no mail is sent)")
        status, data = call(key, "email/send")
        if data.get("error_code") != NOT_VALID:
            return 1, (f"check-smtp2go: email/send did not answer a payload error (HTTP {status}, "
                       f"{data.get('error_code')}); grant the key the send permission")
        say("check-smtp2go: the key may send")
        now = datetime.datetime.now(datetime.UTC)
        window = json.dumps({"start_date": (now - datetime.timedelta(hours=1)).isoformat(), "end_date": now.isoformat(),
                             "limit": 1}).encode()
        say("check-smtp2go: searching activity as the reconciler does")
        status, data = call(key, "activity/search", window)
        if status != 200 or not isinstance(data.get("events"), list):
            return 1, (f"check-smtp2go: the key cannot search activity (HTTP {status}); grant it activity search, which "
                       "settles uncertain sends (src/mail/reconcile.ts)")
        say("check-smtp2go: activity search allowed")
        for endpoint in ("domain/view", "users/smtp/view", "api_keys/view"):
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
    return 0, ("check-smtp2go: the key is live, may send and search activity, and was refused the three probed account "
               "endpoints; SMTP2GO's DKIM and return-path records resolve (its full permission set and senders: D99 T01 §11)")


if __name__ == "__main__":
    try:
        code, line = check(say=lambda text: print(text, flush=True))
    except KeyboardInterrupt:
        code, line = 2, "check-smtp2go: interrupted; nothing was judged"
    print(line)
    sys.exit(code)
