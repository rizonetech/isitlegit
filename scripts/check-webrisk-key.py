#!/usr/bin/env python3
"""Prove the Google Web Risk key in the vault works and is restricted to Web Risk, without printing it (D99 T01 §6).

    python3 scripts/check-webrisk-key.py

Reads "IsItLegit Web Risk" from Conclave through conclave-op (60 seconds at most), checks it has the shape of a Google
API key (`AIza` and 35 more characters), then makes three free calls (30 seconds each), the key in the
`x-goog-api-key` header only, never in a URL, an argument or the output:

1. Web Risk `uris.search` on Google's own test phishing page must answer HTTP 200 naming `SOCIAL_ENGINEERING`;
2. the same lookup of https://www.google.com/ must answer HTTP 200 with no threat;
3. seven other Google APIs must each refuse the key (HTTP 403, `API_KEY_SERVICE_BLOCKED` or `SERVICE_DISABLED`), at
   least one with `API_KEY_SERVICE_BLOCKED`, the reason Google gives when a key's API restrictions exclude that API.

Step 3 shows the key is restricted and refused by every common Google API probed; it cannot read the exact allowed-
service list, which needs the API Keys API and a Google Cloud credential this repository does not hold (D99 T01 §10).

Exit 0 when all hold; 1 with the reason when one does not; 2 when nothing could be judged: the vault or Google could
not be reached, or Google answered a quota (429) or server (5xx) error at any step, which is Google's state, not the
key's (https://docs.cloud.google.com/web-risk/docs/status-codes). Only
`uris.search` is called, never `threatLists.computeDiff` or `hashes.search`, which would bill every lookup. Stdlib only.
"""
import http.client
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
# Free reads on other Google APIs, each of which an exactly-restricted key must be refused.
OTHER_APIS = [
    "https://generativelanguage.googleapis.com/v1beta/models",
    "https://www.googleapis.com/youtube/v3/videos?part=id&id=x",
    "https://safebrowsing.googleapis.com/v4/threatLists",
    "https://kgsearch.googleapis.com/v1/entities:search?query=x",
    "https://www.googleapis.com/books/v1/volumes?q=isitlegit",
    "https://translation.googleapis.com/language/translate/v2/languages",
    "https://vision.googleapis.com/v1/operations",
]
REFUSED = {"API_KEY_SERVICE_BLOCKED", "SERVICE_DISABLED"}
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
        # The headers came but the body may not: a connection that stalls or closes mid-body is Google unreachable,
        # never a judgement on the key.
        try:
            raw = exc.read(1024 * 1024)
        except (OSError, TimeoutError, http.client.HTTPException) as cut:
            raise Unreachable(f"Google's HTTP {exc.code} answer was cut off ({type(cut).__name__})") from None
        try:
            return exc.code, json.loads(raw or b"{}")
        except ValueError:
            return exc.code, {}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise Unreachable(f"Google could not be reached ({type(exc).__name__})") from None


def reasons(body):
    details = (body.get("error") or {}).get("details") or []
    return {d.get("reason") for d in details if isinstance(d, dict) and d.get("reason")}


def busy(status):
    """Google's own state, not the key's: a quota or a server error."""
    return status == 429 or status >= 500


def check(read=read_key, get=call):
    """(exit code, line)."""
    try:
        key = read()
        if not KEY_SHAPE.fullmatch(key):
            return 1, "check-webrisk-key: the vault item does not hold a Google API key (AIza...); paste the key again"
        for page, expect_threat in ((TEST_LURE, True), (CLEAN, False)):
            status, body = get(key, SEARCH + urllib.parse.quote(page, safe=""))
            if busy(status):
                return 2, (f"check-webrisk-key: Web Risk answered HTTP {status} for {page} (quota or Google's error); "
                           "nothing was judged, run it again in a few minutes")
            if status != 200:
                return 1, (f"check-webrisk-key: Web Risk answered HTTP {status}; the key is invalid, revoked, or the "
                           "Web Risk API is off in its project")
            flagged = "SOCIAL_ENGINEERING" in ((body.get("threat") or {}).get("threatTypes") or [])
            if expect_threat and not flagged:
                return 1, "check-webrisk-key: Google's test phishing page was not flagged SOCIAL_ENGINEERING"
            if not expect_threat and body.get("threat"):
                return 1, "check-webrisk-key: https://www.google.com/ was flagged; the lookup is unreliable"
        blocked = 0
        for url in OTHER_APIS:
            status, body = get(key, url)
            host = urllib.parse.urlsplit(url).hostname
            if busy(status):
                return 2, (f"check-webrisk-key: {host} answered HTTP {status} (quota or Google's error); nothing was "
                           "judged, run it again in a few minutes")
            why = reasons(body)
            if status != 403 or not why & REFUSED:
                return 1, (f"check-webrisk-key: {host} accepted the key (HTTP {status}); restrict the key to the Web "
                           "Risk API only")
            blocked += "API_KEY_SERVICE_BLOCKED" in why
        if not blocked:
            return 1, "check-webrisk-key: no API answered API_KEY_SERVICE_BLOCKED; the key has no API restriction"
    except Unreachable as exc:
        return 2, f"check-webrisk-key: {exc}; nothing was judged"
    return 0, (f"check-webrisk-key: the test lure flagged SOCIAL_ENGINEERING, the clean page clean, and all "
               f"{len(OTHER_APIS)} other Google APIs refused the key ({blocked} by its API restriction): working and "
               "restricted")


if __name__ == "__main__":
    code, line = check()
    print(line)
    sys.exit(code)
