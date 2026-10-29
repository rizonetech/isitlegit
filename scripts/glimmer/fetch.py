"""One dataset file, downloaded so an interruption resumes and nothing unverified is accepted (D03 T04 §16).

    python3 <repo>/scripts/glimmer/fetch.py --url URL --dest SOURCE/NAME (--sha256 HEX | --md5 HEX | --unpublished)
        [--max-bytes N] [--timeout 30] [--attempts 3]

Run from the store's `raw/` folder, as the collection brief's collector runs. The bytes go to
`SOURCE/.partial/NAME`, with `NAME.state.json` beside them (the URL, the expected digest and the first answer's
validator, written temp-then-rename), and move to `SOURCE/NAME` by an atomic rename only once the whole file's
digest matches the published one. A file already in place whose digest matches is reported `present` and not
fetched again, so a rerun of a multi-file source reuses what it finished. `--unpublished` is for a dataset that
publishes no digest: the SHA-256 is computed and reported, and the result says `verified: false`.

A resume asks for the rest with `Range` and `If-Range` (a strong ETag, else Last-Modified), and appends a `206` only
when its `Content-Range` starts where the partial ends, its total is the one first seen, and its encoding has not
changed (RFC 9110 sections 13.1.5 and 14). Anything else starts the file again, once. A `416` is success only when
the partial is already whole and its digest matches. At most 5 redirects, `https` (or `http` on the same host),
never to a private, loopback or link-local address. Disconnects, timeouts, `429` and `5xx` are tried again inside
this run, `--attempts` times in all, the partial kept; the collector makes no retries of its own. One JSON line is
printed (`status`, `bytes`, `fetched`, `sha256`, `verified`, `resumed`, `reason`); the exit is 0 only for a file
in place.
"""

import argparse
import errno
import hashlib
import ipaddress
import json
import os
import shutil
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CHUNK = 64 * 1024
MAX_REDIRECTS = 5
FREE_MARGIN = 64 * 1024 * 1024


class Refused(Exception):
    """A fetch that must not go on: the exit is non-zero and the partial is kept unless the reason says otherwise."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _public(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if address.is_private or address.is_loopback or address.is_link_local or address.is_reserved or address.is_multicast:
            return False
    return True


def _check_url(url: str, previous: str | None, allow_loopback: bool) -> None:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise Refused(f"refused: {parts.scheme or 'no'} scheme")
    if parts.scheme == "http" and previous is not None and urllib.parse.urlsplit(previous).hostname != parts.hostname:
        raise Refused("refused: a redirect to plain http on another host")
    if allow_loopback and parts.hostname in ("127.0.0.1", "localhost"):
        return
    if not _public(parts.hostname):
        raise Refused("refused: a non-public address")


def _open(url: str, headers: dict, timeout: float, allow_loopback: bool):
    opener = urllib.request.build_opener(_NoRedirect)
    previous = None
    for _ in range(MAX_REDIRECTS + 1):
        _check_url(url, previous, allow_loopback)
        request = urllib.request.Request(url, headers={"User-Agent": "isitlegit-fetch/1", **headers})
        try:
            return opener.open(request, timeout=timeout), url
        except urllib.error.HTTPError as error:
            if error.code in (301, 302, 303, 307, 308) and error.headers.get("Location"):
                previous, url = url, urllib.parse.urljoin(url, error.headers["Location"])
                error.close()
                continue
            return error, url
    raise Refused(f"refused: more than {MAX_REDIRECTS} redirects")


def _digest(path: Path, kind: str) -> str:
    hash_ = hashlib.new(kind)
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hash_.update(block)
    return hash_.hexdigest()


def _write_json(path: Path, value: dict) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    os.replace(temporary, path)


def _validator(headers) -> str | None:
    etag = headers.get("ETag")
    if etag and not etag.startswith("W/"):
        return etag
    return headers.get("Last-Modified")


def _content_range(value: str | None):
    """`bytes a-b/total` as (a, b, total); None for anything else."""
    if not value or not value.startswith("bytes "):
        return None
    span, _, total = value[6:].partition("/")
    first, _, last = span.partition("-")
    try:
        return int(first), int(last), int(total)
    except ValueError:
        return None


def fetch(url: str, dest: str, expected: tuple[str, str] | None, *, max_bytes: int = 5 * 1024**3, timeout: float = 30.0,
          attempts: int = 3, allow_loopback: bool = False, writer=None) -> dict:
    """The file at `dest`, fetched or found in place. `expected` is (`sha256` or `md5`, hex), or None for a dataset
    that publishes no digest. Raises `Refused`; the CLI turns that into a result line and a non-zero exit."""
    target = Path(dest)
    root = Path.cwd().resolve()
    if target.is_absolute() or ".." in target.parts or len(target.parts) != 2:
        raise Refused("refused: --dest must be SOURCE/NAME under the current folder")
    if not str((root / target).resolve()).startswith(str(root)):
        raise Refused("refused: --dest leaves the current folder")
    kind, want = expected if expected else ("sha256", None)
    partial_dir = target.parent / ".partial"
    partial = partial_dir / target.name
    state_file = partial_dir / f"{target.name}.state.json"

    def result(status, **extra):
        size = target.stat().st_size if target.exists() else partial.stat().st_size if partial.exists() else 0
        return {"status": status, "bytes": size, "verified": want is not None, **extra}

    # Already in place and whole: a rerun reuses it.
    if target.exists():
        found = _digest(target, kind)
        if want is None or found == want:
            return result("present", sha256=_digest(target, "sha256"), fetched=0, resumed=False)
        raise Refused(f"refused: {target} is in place but its {kind} differs")

    partial_dir.mkdir(parents=True, exist_ok=True)
    state = {}
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
    if state.get("url") != url or state.get("expected") != [kind, want]:
        state = {}
        partial.unlink(missing_ok=True)

    fetched = 0
    resumed = False
    restarts = 0
    tries = 0
    write = writer or (lambda handle, block: handle.write(block))
    while True:
        have = partial.stat().st_size if partial.exists() else 0
        free = shutil.disk_usage(partial_dir).free
        remaining = (state.get("total") or 0) - have
        if free < max(remaining, 0) + FREE_MARGIN:
            raise Refused("incomplete: not enough free disk space; the partial file is kept")
        headers = {"Accept-Encoding": "identity"}
        if have and state.get("validator"):
            headers["Range"] = f"bytes={have}-"
            headers["If-Range"] = state["validator"]
        elif have:
            # No validator to resume against: the file starts again.
            partial.unlink()
            have = 0
        tries += 1
        try:
            response, final_url = _open(url, headers, timeout, allow_loopback)
            with response:
                code = response.status if hasattr(response, "status") else response.getcode()
                if code == 416:
                    unsatisfied = response.headers.get("Content-Range") or ""
                    total = int(unsatisfied[8:]) if unsatisfied.startswith("bytes */") and unsatisfied[8:].isdigit() else -1
                    if have and total == have:
                        break  # whole already: verified below
                    partial.unlink(missing_ok=True)
                    state = {}
                    restarts += 1
                    if restarts > 1:
                        raise Refused("refused: the server's ranges do not match the file")
                    continue
                if code in (429,) or code >= 500:
                    raise urllib.error.URLError(f"HTTP {code}")
                if code not in (200, 206):
                    raise Refused(f"refused: HTTP {code}")
                encoding = response.headers.get("Content-Encoding", "identity")
                if code == 206:
                    span = _content_range(response.headers.get("Content-Range"))
                    ok = (
                        span is not None
                        and span[0] == have
                        and (state.get("total") in (None, span[2]))
                        and encoding == state.get("encoding", encoding)
                    )
                    if not ok:
                        partial.unlink(missing_ok=True)
                        state = {}
                        restarts += 1
                        if restarts > 1:
                            raise Refused("refused: the server's ranges do not match the file")
                        continue
                    expected_body = span[1] - span[0] + 1
                    mode = "ab"
                    resumed = True
                    state["total"] = span[2]
                else:
                    length = response.headers.get("Content-Length")
                    expected_body = int(length) if length and length.isdigit() else None
                    mode = "wb"
                    have = 0
                    state = {"url": url, "expected": [kind, want], "validator": _validator(response.headers),
                             "encoding": encoding, "total": expected_body, "final_url": final_url}
                _write_json(state_file, state)
                got = 0
                with partial.open(mode) as handle:
                    while True:
                        block = response.read(CHUNK)
                        if not block:
                            break
                        got += len(block)
                        if have + got > max_bytes:
                            raise Refused(f"refused: over {max_bytes} bytes")
                        write(handle, block)
                    handle.flush()
                    os.fsync(handle.fileno())
                fetched += got
                if expected_body is not None and got != expected_body:
                    raise urllib.error.URLError(f"the body ended at {got} of {expected_body} bytes")
                if state.get("total") is not None and partial.stat().st_size != state["total"]:
                    raise urllib.error.URLError("the file is not whole yet")
                break
        except OSError as error:
            if isinstance(error, (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError)) or \
                    getattr(error, "errno", None) in (errno.ECONNRESET, errno.EPIPE):
                if tries >= attempts:
                    raise Refused(f"incomplete: {attempts} attempts failed ({str(error)[:80]}); the partial file is kept")
                continue
            if getattr(error, "errno", None) == errno.ENOSPC:
                raise Refused("incomplete: the disk is full; the partial file is kept")
            raise
    found = _digest(partial, kind)
    if want is not None and found != want:
        partial.unlink(missing_ok=True)
        state_file.unlink(missing_ok=True)
        raise Refused(f"refused: the {kind} does not match the published one; the partial file is removed")
    sha256 = found if kind == "sha256" else _digest(partial, "sha256")
    with partial.open("rb") as handle:
        os.fsync(handle.fileno())
    os.replace(partial, target)
    fd = os.open(target.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    state_file.unlink(missing_ok=True)
    return result("fetched", sha256=sha256, fetched=fetched, resumed=resumed)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", required=True)
    parser.add_argument("--dest", required=True)
    digest = parser.add_mutually_exclusive_group(required=True)
    digest.add_argument("--sha256")
    digest.add_argument("--md5")
    digest.add_argument("--unpublished", action="store_true")
    parser.add_argument("--max-bytes", type=int, default=5 * 1024**3)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--allow-loopback", action="store_true", help="for the tests' local server only")
    args = parser.parse_args(argv)
    expected = None
    for kind, width in (("sha256", 64), ("md5", 32)):
        value = getattr(args, kind)
        if value is not None:
            if len(value) != width or any(c not in "0123456789abcdef" for c in value.lower()):
                print(json.dumps({"status": "refused", "reason": f"--{kind} is not {width} hex digits"}))
                return 2
            expected = (kind, value.lower())
    try:
        line = fetch(args.url, args.dest, expected, max_bytes=args.max_bytes, timeout=args.timeout,
                     attempts=args.attempts, allow_loopback=args.allow_loopback)
    except Refused as error:
        reason = str(error)
        print(json.dumps({"status": reason.split(":")[0], "reason": reason}))
        return 1
    print(json.dumps(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
