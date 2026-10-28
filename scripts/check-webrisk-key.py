#!/usr/bin/env python3
"""Prove the Google Web Risk key in the vault works and is restricted to Web Risk, without printing it (D99 T01 §6).

    python3 scripts/check-webrisk-key.py

Reads "IsItLegit Web Risk" from Conclave through conclave-op (60 seconds at most), checks it has the shape of a Google
API key (`AIza` and 35 more characters), then makes three free calls (30 seconds each), the key in the
`x-goog-api-key` header only, never in a URL, an argument or the output:

1. Web Risk `uris.search` on Google's own test phishing page must answer HTTP 200 naming `SOCIAL_ENGINEERING`;
2. the same lookup of https://www.google.com/ must answer HTTP 200 with no threat;
3. a call to another Google API (Books) must be refused with `API_KEY_SERVICE_BLOCKED`, the reason Google gives when a
   key's API restrictions exclude that API, which proves the key is restricted rather than merely unused elsewhere.

Exit 0 when all hold; 1 with the reason when one does not; 2 when the vault or Google could not be reached. Only
`uris.search` is called, never `threatLists.computeDiff` or `hashes.search`, which would bill every lookup. Stdlib only.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ITEM = "op://Conclave/IsItLegit Web Risk/credential"
SEARCH = "https://webrisk.googleapis.com/v1/uris:search?threatTypes=SOCIAL_ENGINEERING&threatTypes=MALWARE&uri="
TEST_LURE = "http://testsafebrowsing.appspot.com/s/phishing.html"
CLEAN = "https://www.google.com/"
OTHER_API = "https://www.googleapis.com/books/v1/volumes?q=isitlegit"
KEY_SHAPE = re.compile(r"AIza[0-9A-Za-z_-]{35}")
VAULT_SECONDS = 60
HTTP_SECONDS = 30


class Unreachable(Exception):
    """The vault or Google could not be reached: no judgement on the key."""


def read_key():
    reader = os.path.expanduser("~/.local/bin/conclave-op")
    try:
        done = subprocess.run([reader, "read", ITEM], capture_output=True, text=True, timeout=VAULT_SECONDS)
    except subprocess.TimeoutExpired:
        raise Unreachable(f"the vault did not answer within {VAULT_SECONDS} s") from None
    except OSError as exc:
        raise Unreachable(f"conclave-op could not run ({exc.strerror})") from None
    if done.returncode != 0:
        raise Unreachable("the vault refused the read; check the item exists and the service account token is loaded")
    return done.stdout.strip()


def call(key, url):
    """(HTTP status, JSON body) for a GET with the key in its header."""
    request = urllib.request.Request(url, headers={"x-goog-api-key": key, "user-agent": "isitlegit-check-webrisk/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_SECONDS) as response:
            return response.status, json.loads(response.read(1024 * 1024) or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read(1024 * 1024) or b"{}")
        except ValueError:
            return exc.code, {}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise Unreachable(f"Google could not be reached ({type(exc).__name__})") from None


def reasons(body):
    details = (body.get("error") or {}).get("details") or []
    return {d.get("reason") for d in details if isinstance(d, dict) and d.get("reason")}


def check(read=read_key, get=call):
    """(exit code, line)."""
    try:
        key = read()
        if not KEY_SHAPE.fullmatch(key):
            return 1, "check-webrisk-key: the vault item does not hold a Google API key (AIza...); paste the key again"
        status, body = get(key, SEARCH + urllib.parse.quote(TEST_LURE, safe=""))
        if status != 200:
            return 1, f"check-webrisk-key: Web Risk answered HTTP {status}; the key is invalid, revoked or the API is off"
        if "SOCIAL_ENGINEERING" not in ((body.get("threat") or {}).get("threatTypes") or []):
            return 1, "check-webrisk-key: Google's test phishing page was not flagged SOCIAL_ENGINEERING"
        status, body = get(key, SEARCH + urllib.parse.quote(CLEAN, safe=""))
        if status != 200 or body.get("threat"):
            return 1, f"check-webrisk-key: the clean page answered HTTP {status} with a threat; the lookup is unreliable"
        status, body = get(key, OTHER_API)
        if status != 403 or "API_KEY_SERVICE_BLOCKED" not in reasons(body):
            return 1, (f"check-webrisk-key: another Google API answered HTTP {status} without API_KEY_SERVICE_BLOCKED; "
                       "restrict the key to the Web Risk API")
    except Unreachable as exc:
        return 2, f"check-webrisk-key: {exc}; nothing was judged"
    return 0, ("check-webrisk-key: the test lure flagged SOCIAL_ENGINEERING, the clean page clean, and another API "
               "refused the key (API_KEY_SERVICE_BLOCKED): working and restricted to Web Risk")


if __name__ == "__main__":
    code, line = check()
    print(line)
    sys.exit(code)
