"""One dataset file, downloaded so an interruption resumes and nothing unverified is accepted (D03 T04 §16).

    python3 <repo>/scripts/glimmer/fetch.py --url URL --dest SOURCE/NAME (--sha256 HEX | --md5 HEX)
        [--source-limit BYTES] [--min-free BYTES] [--timeout 30] [--attempts 3] [--min-rate BYTES_PER_SECOND]

Run from the store's `raw/` folder, as the collection brief's collector runs. The bytes go to
`SOURCE/.partial/NAME`, with `NAME.state.json` beside them (the URL, the published digest and the first answer's
validator, written temp-then-rename and synced), and move to `SOURCE/NAME` by an atomic rename only once the whole
file's digest matches the published one (SHA-256, or the MD5 a dataset such as a Zenodo record publishes instead). A
file already in place whose digest matches is reported `present` and not fetched again, so a rerun of a multi-file
source reuses what it finished. A dataset that publishes no digest is not fetched: the collector records it.

A resume asks for the rest with `Range` and `If-Range` (a strong ETag, or a Last-Modified date when the server sent no
ETag at all), and appends a `206` only when its `Content-Range` starts where the partial ends, ends inside the total
first seen, matches the body's length and its `Content-Length`, carries the same validator and encoding; a valid
shorter range is progress, and the next range is asked for (RFC 9110 sections 13.1.5 and 14). Anything else starts
the file again. A `416` is success only when the partial is already whole and its digest matches.

Each connection goes to the address this script resolved and checked (public unless `--allow-loopback`, for the
tests' local server), at most 5 redirects, `https` (or `http` on the same host). Restarts, disconnects, timeouts,
`429` and `5xx` all spend one budget of `--attempts` tries; `Retry-After` is honoured up to 60 seconds and other waits
double from 1 second; a transfer slower than `--min-rate` over 60 seconds is cut and counted as a failure. Before and
during a transfer the source folder (every file in it, partials included) stays under `--source-limit` and the disk
keeps `--min-free` free. Progress goes to standard error; one JSON line goes to standard output (`status`, `bytes`,
`fetched`, `sha256`, `resumed`, `reason`). The exit is 0 only for a file in place.
"""

import argparse
import errno
import hashlib
import http.client
import ipaddress
import json
import math
import os
import re
import shutil
import socket
import ssl
import sys
import time
import urllib.parse
from pathlib import Path

CHUNK = 64 * 1024
MAX_REDIRECTS = 5
RATE_WINDOW = 60.0


class Refused(Exception):
    """The fetch stops: `refused: ...` (it must not go on) or `incomplete: ...` (a rerun may finish it)."""


class _Retry(Exception):
    """A failure the attempt budget covers; `wait` is a server's Retry-After, when it gave one."""

    def __init__(self, reason: str, wait: float | None = None):
        super().__init__(reason)
        self.wait = wait


def _vetted(host: str, port: int, allow_loopback: bool) -> str:
    """The address a connection to `host` will use, checked: every address the name resolves to must be public."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise _Retry(f"the name did not resolve ({error})") from error
    addresses = [info[4][0].split("%")[0] for info in infos]
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if allow_loopback and ip.is_loopback:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise Refused("refused: a non-public address")
    return addresses[0]


def _connect(url: str, timeout: float, allow_loopback: bool):
    """A connection pinned to the vetted address: the name is resolved once, here, and never again by the library."""
    parts = urllib.parse.urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    address = _vetted(parts.hostname or "", port, allow_loopback)
    if parts.scheme == "https":
        context = ssl.create_default_context()

        class Pinned(http.client.HTTPSConnection):
            def connect(self):
                raw = socket.create_connection((address, port), timeout)
                self.sock = context.wrap_socket(raw, server_hostname=parts.hostname)

        return Pinned(parts.hostname, port, timeout=timeout, context=context)

    class PinnedPlain(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.create_connection((address, port), timeout)

    return PinnedPlain(parts.hostname, port, timeout=timeout)


def _request(url: str, headers: dict, timeout: float, allow_loopback: bool):
    """The final response after at most 5 redirects, each hop checked, with the URL it came from."""
    previous = None
    for _ in range(MAX_REDIRECTS + 1):
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise Refused(f"refused: {parts.scheme or 'no'} scheme")
        if parts.scheme == "http" and previous is not None and urllib.parse.urlsplit(previous).hostname != parts.hostname:
            raise Refused("refused: a redirect to plain http on another host")
        connection = _connect(url, timeout, allow_loopback)
        path = parts.path or "/"
        if parts.query:
            path += f"?{parts.query}"
        try:
            connection.request("GET", path, headers={"User-Agent": "isitlegit-fetch/2", "Accept-Encoding": "identity", **headers})
            response = connection.getresponse()
        except (OSError, http.client.HTTPException) as error:
            connection.close()
            raise _Retry(f"the request failed ({error.__class__.__name__})") from error
        if response.status in (301, 302, 303, 307, 308) and response.getheader("Location"):
            previous, url = url, urllib.parse.urljoin(url, response.getheader("Location"))
            response.read()
            connection.close()
            continue
        return connection, response, url
    raise Refused(f"refused: more than {MAX_REDIRECTS} redirects")


def _digest(path: Path, kind: str) -> str:
    hash_ = hashlib.new(kind)
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hash_.update(block)
    return hash_.hexdigest()


def _sync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _write_json(path: Path, value: dict) -> None:
    """The state, written temp-then-rename and synced; a failure is an `incomplete` outcome a rerun recovers from."""
    try:
        _write_json_now(path, value)
    except OSError as error:
        raise Refused(f"incomplete: the download's state could not be written ({error.strerror}); a rerun starts it again") from error


def _write_json_now(path: Path, value: dict) -> None:
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    _sync_dir(path.parent)


_STRONG_ETAG = re.compile(r'^"[\x21\x23-\x7e\x80-\xff]*"$')


def _validator(headers) -> str | None:
    """What `If-Range` may carry: a strong ETag; a Last-Modified date only when the server sent no ETag at all."""
    etag = headers.get("ETag")
    if etag is not None:
        return etag if _STRONG_ETAG.match(etag) else None
    return headers.get("Last-Modified")


def _content_range(value: str | None):
    """`bytes a-b/total` as (a, b, total), with 0 <= a <= b < total; None for anything else."""
    match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", value or "")
    if not match:
        return None
    first, last, total = (int(g) for g in match.groups())
    return (first, last, total) if first <= last < total else None


def _folder_bytes(folder: Path) -> int:
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file()) if folder.exists() else 0


def fetch(url: str, dest: str, expected: tuple[str, str], *, source_limit: int = 5 * 10**9, min_free: int = 10 * 10**9,
          timeout: float = 30.0, attempts: int = 3, min_rate: float = 16 * 1024, rate_window: float = RATE_WINDOW,
          allow_loopback: bool = False,
          writer=None, sleep=time.sleep, log=lambda line: print(line, file=sys.stderr)) -> dict:
    """The file at `dest`, fetched or found in place. `expected` is (`sha256` or `md5`, its published hex). Raises
    `Refused`; the CLI turns that into a result line and a non-zero exit."""
    kind, want = expected
    if kind not in ("sha256", "md5") or not re.fullmatch(r"[0-9a-f]{64}" if kind == "sha256" else r"[0-9a-f]{32}", want or ""):
        raise Refused("refused: a published SHA-256 or MD5 is required")
    if attempts < 1 or not math.isfinite(timeout) or timeout <= 0 or source_limit <= 0 or min_free < 0 or min_rate < 0:
        raise Refused("refused: --attempts, --timeout, --source-limit, --min-free and --min-rate must be positive")
    target = Path(dest)
    root = Path.cwd().resolve()
    if target.is_absolute() or ".." in target.parts or len(target.parts) != 2 or target.parts[1].startswith("."):
        raise Refused("refused: --dest must be SOURCE/NAME under the current folder")
    if not (root / target).resolve().is_relative_to(root):
        raise Refused("refused: --dest leaves the current folder")
    source = target.parent
    partial_dir = source / ".partial"
    partial = partial_dir / target.name
    state_file = partial_dir / f"{target.name}.state.json"
    fetched = 0

    def outcome(status, **extra):
        return {"status": status, "bytes": target.stat().st_size if target.exists() else 0, "fetched": fetched, **extra}

    if target.exists():
        try:
            found = _digest(target, kind)
        except OSError as error:
            raise Refused(f"incomplete: {target} could not be read ({error.strerror})") from error
        if found == want:
            return outcome("present", sha256=_digest(target, "sha256") if kind != "sha256" else found, resumed=False)
        raise Refused(f"refused: {target} is in place but its {kind} differs")

    partial_dir.mkdir(parents=True, exist_ok=True)
    state = {}
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {}
    # A partial whose state is for another URL or digest, or has no state, is not resumed: it starts again.
    if state.get("url") != url or state.get("expected") != [kind, want]:
        state = {}
        partial.unlink(missing_ok=True)

    write = writer or (lambda handle, block: handle.write(block))
    failures = 0
    wait = 1.0
    resumed = False

    def spend(reason: str, retry_after: float | None = None):
        nonlocal failures, wait
        failures += 1
        if failures >= attempts:
            raise Refused(f"incomplete: {attempts} attempts failed ({reason}); the partial file is kept")
        pause = min(retry_after, 60.0) if retry_after is not None else wait
        log(f"fetch: {reason}; trying again in {pause:.0f} seconds ({failures} of {attempts} attempts spent)")
        sleep(pause)
        wait = min(wait * 2, 30.0)

    def restart(reason: str):
        nonlocal state
        partial.unlink(missing_ok=True)
        state_file.unlink(missing_ok=True)
        state = {}
        spend(reason)

    def room(more: int):
        if _folder_bytes(source) + more > source_limit:
            raise Refused(f"refused: {source} would pass its limit of {source_limit} bytes")
        if shutil.disk_usage(partial_dir).free - more < min_free:
            raise Refused("incomplete: the disk would fall under its free-space floor; the partial file is kept")

    while True:
        have = partial.stat().st_size if partial.exists() else 0
        total = state.get("total")
        if total is not None and have == total:
            break  # whole: verified below
        room(max((total or 0) - have, 0))
        headers = {}
        if have and state.get("validator"):
            headers = {"Range": f"bytes={have}-", "If-Range": state["validator"]}
        elif have:
            restart("no validator to resume against")
            continue
        try:
            connection, response, final_url = _request(url, headers, timeout, allow_loopback)
        except _Retry as error:
            spend(str(error))
            continue
        try:
            code = response.status
            if code == 416:
                unsatisfied = response.getheader("Content-Range") or ""
                whole = re.fullmatch(r"bytes \*/(\d+)", unsatisfied)
                if have and whole and int(whole.group(1)) == have:
                    state["total"] = have
                    break
                restart("the server's range does not fit the partial file")
                continue
            if code == 429 or code >= 500:
                after = response.getheader("Retry-After")
                spend(f"HTTP {code}", float(after) if after and after.isdigit() else None)
                continue
            if code not in (200, 206):
                raise Refused(f"refused: HTTP {code}")
            encoding = response.getheader("Content-Encoding") or "identity"
            length = response.getheader("Content-Length")
            if code == 206:
                span = _content_range(response.getheader("Content-Range"))
                same = _validator(response.headers) in (None, state.get("validator")) and encoding == state.get("encoding")
                fits = (
                    span is not None
                    and span[0] == have
                    and state.get("total") in (None, span[2])
                    and (length is None or (length.isdigit() and int(length) == span[1] - span[0] + 1))
                )
                if not (same and fits):
                    restart("the server's range or validator does not match the partial file")
                    continue
                body = span[1] - span[0] + 1
                state["total"] = span[2]
                mode = "ab"
                resumed = True
            else:
                body = int(length) if length and length.isdigit() else None
                room(body or 0)
                # Truncate first, then record the new answer: old bytes never sit under the new validator.
                with partial.open("wb") as handle:
                    os.fsync(handle.fileno())
                state = {"url": url, "expected": [kind, want], "validator": _validator(response.headers),
                         "encoding": encoding, "total": body, "final_url": final_url}
                _write_json(state_file, state)
                have = 0
                mode = "ab"
                resumed = False
            got = 0
            base = _folder_bytes(source)  # what the source holds before this body, the partial's start included
            started = time.monotonic()
            window_start, window_bytes = started, 0
            last_log = started
            try:
                with partial.open(mode) as handle:
                    while True:
                        block = response.read(CHUNK)
                        if not block:
                            break
                        got += len(block)
                        fetched += len(block)
                        window_bytes += len(block)
                        if body is not None and got > body:
                            raise Refused("refused: the server sent more than it said")
                        if have + got > (state.get("total") or source_limit) or base + got > source_limit:
                            raise Refused(f"refused: {source} would pass its limit of {source_limit} bytes")
                        write(handle, block)
                        now = time.monotonic()
                        if now - window_start >= rate_window:
                            if window_bytes / (now - window_start) < min_rate:
                                raise _Retry(f"slower than {int(min_rate)} bytes a second")
                            window_start, window_bytes = now, 0
                        if now - last_log >= 5:
                            log(f"fetch: {have + got} of {state.get('total') or '?'} bytes")
                            last_log = now
                    handle.flush()
                    os.fsync(handle.fileno())
            except (OSError, http.client.HTTPException) as error:
                if getattr(error, "errno", None) == errno.ENOSPC:
                    raise Refused("incomplete: the disk is full; the partial file is kept") from error
                spend(f"the transfer broke off ({error.__class__.__name__})")
                continue
            except _Retry as error:
                spend(str(error))
                continue
            if body is not None and got < body:
                spend(f"the body ended at {got} of {body} bytes")
                continue
            if state.get("total") is None:
                state["total"] = have + got  # no length given: whatever arrived whole is what the digest will judge
                _write_json(state_file, state)
            # A valid shorter range is progress, not a failure: the loop asks for the next one.
        finally:
            connection.close()

    try:
        found = _digest(partial, kind)
    except OSError as error:
        raise Refused(f"incomplete: the partial file could not be read ({error.strerror}); it is kept") from error
    if found != want:
        partial.unlink(missing_ok=True)
        state_file.unlink(missing_ok=True)
        raise Refused(f"refused: the {kind} does not match the published one; the partial file is removed")
    sha256 = found if kind == "sha256" else _digest(partial, "sha256")
    try:
        with partial.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(partial, target)
        _sync_dir(source)
    except OSError as error:
        raise Refused(f"incomplete: the verified file could not be moved into place ({error.strerror}); a rerun moves it") from error
    try:
        state_file.unlink(missing_ok=True)
    except OSError:
        pass  # the file is in place and verified; a stale state file beside no partial is ignored by the next run
    return outcome("fetched", sha256=sha256, resumed=resumed)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", required=True)
    parser.add_argument("--dest", required=True)
    digest = parser.add_mutually_exclusive_group(required=True)
    digest.add_argument("--sha256")
    digest.add_argument("--md5")
    parser.add_argument("--source-limit", type=int, default=5 * 10**9)
    parser.add_argument("--min-free", type=int, default=10 * 10**9)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--min-rate", type=float, default=16 * 1024)
    parser.add_argument("--allow-loopback", action="store_true", help="for the tests' local server only")
    args = parser.parse_args(argv)
    expected = ("sha256", (args.sha256 or "").lower()) if args.sha256 is not None else ("md5", (args.md5 or "").lower())
    try:
        line = fetch(args.url, args.dest, expected, source_limit=args.source_limit, min_free=args.min_free,
                     timeout=args.timeout, attempts=args.attempts, min_rate=args.min_rate,
                     allow_loopback=args.allow_loopback)
    except Refused as error:
        reason = str(error)
        print(json.dumps({"status": reason.split(":")[0], "reason": reason}))
        return 1
    print(json.dumps(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
