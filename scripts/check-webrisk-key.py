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
key's (https://docs.cloud.google.com/web-risk/docs/status-codes). The only Web Risk method called is `uris.search`,
never `threatLists.computeDiff` or `hashes.search`, which would bill every lookup; the seven other APIs are read-only GETs
the key is expected to be refused. Redirects are refused, so the key's header never follows one to another host, and
each call has a 30 second deadline for its whole answer. Stdlib only.
"""
import http.client
import json
import os
import re
import subprocess
import sys
import time
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
REFUSED = {"API_KEY_SERVICE_BLOCKED", "SERVICE_DISABLED",
           # The older error shape some Google APIs still send (error.errors[].reason).
           "accessNotConfigured", "keyInvalid", "forbidden", "ipRefererBlocked"}
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


# Any failure to receive a whole answer, on a success or an error status alike: the connection, the TLS, the HTTP
# framing (a cut chunk, a short body) or the timeout.
TRANSPORT = (urllib.error.URLError, OSError, TimeoutError, http.client.HTTPException)
LIMIT = 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect: the key's header must never follow one to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"redirect to another URL refused ({code})", headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


def read_by(stream, deadline):
    """At most LIMIT + 1 bytes of a body, refused once the whole call passes its deadline."""
    parts, size = [], 0
    while size <= LIMIT:
        if time.monotonic() > deadline:
            raise TimeoutError(f"the answer took longer than {HTTP_SECONDS} s")
        chunk = stream.read(min(65536, LIMIT + 1 - size))
        if not chunk:
            break
        parts.append(chunk)
        size += len(chunk)
    return b"".join(parts)


def call(key, url, opener=OPENER):
    """(HTTP status, JSON object) for a GET with the key in its header. Only a whole answer that reads as a JSON object
    counts; anything else is Google unreachable, so a cut-off answer is never taken for a judgement on the key."""
    request = urllib.request.Request(url, headers={"x-goog-api-key": key, "user-agent": "isitlegit-check-webrisk/1.0"})
    deadline = time.monotonic() + HTTP_SECONDS
    try:
        try:
            with opener.open(request, timeout=HTTP_SECONDS) as response:
                status, headers, raw = response.status, response.headers, read_by(response, deadline)
        except urllib.error.HTTPError as exc:
            if 300 <= exc.code < 400:
                raise Unreachable(f"Google answered a redirect ({exc.code}), refused so the key stays with Google") from None
            status, headers, raw = exc.code, exc.headers, read_by(exc, deadline)
    except TRANSPORT as exc:
        raise Unreachable(f"Google could not be reached or its answer was cut off ({type(exc).__name__})") from None
    # Whole means: some body (Google always sends one; a clean lookup is the two bytes `{}`), no shorter than its
    # Content-Length, within the read limit, and JSON. An empty or short read is a dropped connection, never `{}`.
    declared = headers.get("Content-Length") if headers is not None else None
    if not raw or len(raw) > LIMIT or (declared is not None and declared.isdigit() and len(raw) != int(declared)):
        raise Unreachable(f"Google's HTTP {status} answer was not received whole ({len(raw)} bytes)")
    try:
        body = json.loads(raw)
    except ValueError:
        raise Unreachable(f"Google's HTTP {status} answer could not be read whole") from None
    if not isinstance(body, dict):
        raise Unreachable(f"Google's HTTP {status} answer is not a JSON object")
    return status, body


def reasons(body):
    """The refusal reasons in an error answer, in either shape Google sends: error.details[].reason, or the older
    error.errors[].reason. A wrong shape is unreadable, not a refusal."""
    error = body.get("error", {})
    if not isinstance(error, dict):
        raise Unreachable("Google's error answer has no error object")
    found = set()
    for field in ("details", "errors"):
        items = error.get(field) or []
        if not isinstance(items, list):
            raise Unreachable(f"Google's error answer has a malformed {field} list")
        found |= {i["reason"] for i in items if isinstance(i, dict) and isinstance(i.get("reason"), str)}
    return found


def threat_types(body):
    """The threat types of a uris.search answer: absent for a clean page, else a list of names; any other shape is
    unreadable, never a match by substring."""
    threat = body.get("threat")
    if threat is None:
        return []
    types = threat.get("threatTypes") if isinstance(threat, dict) else None
    if not isinstance(types, list) or not all(isinstance(t, str) for t in types):
        raise Unreachable("Web Risk's answer has a malformed threat")
    return types


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
            types = threat_types(body)
            if expect_threat and "SOCIAL_ENGINEERING" not in types:
                return 1, "check-webrisk-key: Google's test phishing page was not flagged SOCIAL_ENGINEERING"
            if not expect_threat and types:
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
