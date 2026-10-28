#!/usr/bin/env python3
"""Prove the Meta Model API key in the vault still works, without spending or printing it (D99 T01 §1).

    python3 scripts/check-meta-key.py

Reads "IsItLegit Meta Model API" from Conclave through conclave-op (60 seconds at most), checks it has the shape Meta
gives its keys (`LLM_<numeric id>_<secret>`, sources/meta-api/docs/docs/authentication.md), and lists the models with it
(`GET https://api.meta.ai/v1/models`, which costs nothing; 30 seconds at most). Passes, exit 0, only when the list
answers HTTP 200 and names `muse-spark-1.3`, printing the status and the model count. A placeholder, a revoked or
mistyped key, a stalled vault or network, each exits 1 with the reason. The key never reaches the output, an
argument or a log: it goes to the request's header only. Stdlib only.
"""
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

ITEM = "op://Conclave/IsItLegit Meta Model API/credential"
MODELS_URL = "https://api.meta.ai/v1/models"
KEY_SHAPE = re.compile(r"LLM_\d+_\S{8,}")
VAULT_SECONDS = 60
HTTP_SECONDS = 30


def read_key():
    """The key from the vault, or raise with a reason that never holds it."""
    reader = os.path.expanduser("~/.local/bin/conclave-op")
    try:
        done = subprocess.run([reader, "read", ITEM], capture_output=True, text=True, timeout=VAULT_SECONDS)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"the vault did not answer within {VAULT_SECONDS} s; check conclave-op can reach 1Password")
    except OSError as exc:
        raise RuntimeError(f"conclave-op could not run ({exc.strerror})")
    if done.returncode != 0:
        raise RuntimeError("the vault refused the read; check the item exists and the service account token is loaded")
    return done.stdout.strip()


def list_models(key):
    """(status, model ids) from Meta's model list."""
    request = urllib.request.Request(MODELS_URL, headers={"authorization": f"Bearer {key}", "user-agent": "isitlegit-check-meta-key/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=HTTP_SECONDS) as response:
            body = json.loads(response.read(4 * 1024 * 1024))
            return response.status, [m.get("id") for m in body.get("data", []) if isinstance(m, dict)]
    except urllib.error.HTTPError as exc:
        return exc.code, []


def check(read=read_key, models=list_models):
    """(passed, the line to print)."""
    try:
        key = read()
    except RuntimeError as exc:
        return False, f"check-meta-key: {exc}"
    if not KEY_SHAPE.fullmatch(key):
        return False, "check-meta-key: the vault item does not hold a Meta key (LLM_<id>_<secret>); paste the key again"
    try:
        status, ids = models(key)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        reason = type(exc).__name__
        return False, f"check-meta-key: Meta's model list could not be read ({reason}); try again"
    if status != 200:
        return False, f"check-meta-key: Meta answered HTTP {status}; the key is revoked, mistyped or for another team"
    if "muse-spark-1.3" not in ids:
        return False, f"check-meta-key: HTTP 200, but muse-spark-1.3 is not among the {len(ids)} models listed"
    return True, f"check-meta-key: HTTP 200, {len(ids)} models listed, muse-spark-1.3 among them; key shape ok"


if __name__ == "__main__":
    passed, line = check()
    print(line)
    sys.exit(0 if passed else 1)
