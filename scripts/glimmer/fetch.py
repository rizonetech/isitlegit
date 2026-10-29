"""One dataset file, downloaded so an interruption resumes and nothing unverified is accepted (D03 T04 §16).

    python3 <repo>/scripts/glimmer/fetch.py --url URL --dest SOURCE/NAME (--sha256 HEX | --md5 HEX)
        [--source-limit BYTES] [--min-free BYTES] [--timeout 30] [--attempts 3] [--min-rate BYTES_PER_SECOND]
        [--segments 0..4] [--segment-threshold BYTES]

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
`429` and `5xx` all spend one budget of `--attempts` tries; `Retry-After` is honoured up to 60 seconds (a longer one
is cut to 60, so a run stays bounded, and the log says so) and other waits double from 1 second; a transfer slower than `--min-rate` over 60 seconds is cut and counted as a failure. Before and
during a transfer the source folder (every file in it, partials included) stays under `--source-limit` and the disk
keeps `--min-free` free. Progress goes to standard error; one JSON line goes to standard output (`status`, `bytes`,
`fetched`, `sha256`, `resumed`, `reason`). The exit is 0 only for a file in place.

A file of at least `--segment-threshold` bytes (64 MiB) whose `HEAD` gives its length, `Accept-Ranges: bytes`, no
content coding and a strong validator comes in up to four ranges at once (`--segments`: 0 automatic, 1 one stream;
D03 T04 §20, where four connections took 74 percent less time than one against a host that caps each connection).
Each range is written at its offset, its progress saved every 4 MiB after a flush, and checked as a resume is; all of
them share the attempt budget, the limits and the lock. An answer that does not fit starts the file again on one
stream, and the file is published only whole and verified, as above.
"""

import argparse
import email.utils
import errno
import fcntl
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
import threading
import time
import urllib.parse
from pathlib import Path

CHUNK = 64 * 1024
SEGMENT_THRESHOLD = 64 * 1024 * 1024
STATE_EVERY = 4 * 1024 * 1024
MAX_REDIRECTS = 5
RATE_WINDOW = 60.0


class Refused(Exception):
    """The fetch stops: `refused: ...` (it must not go on) or `incomplete: ...` (a rerun may finish it)."""


class _Misfit(Exception):
    """A segment's answer that does not fit the file (its range, length, coding or validator)."""


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


def _connect(url: str, timeout: float, allow_loopback: bool, watch=None):
    """A connection pinned to the vetted address: the name is resolved once, here, and never again by the library."""
    parts = urllib.parse.urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    address = _vetted(parts.hostname or "", port, allow_loopback)
    if parts.scheme == "https":
        context = ssl.create_default_context()

        class Pinned(http.client.HTTPSConnection):
            def connect(self):
                raw = socket.create_connection((address, port), timeout)
                if watch is not None:
                    watch.sock = raw
                self.sock = context.wrap_socket(raw, server_hostname=parts.hostname)

        return Pinned(parts.hostname, port, timeout=timeout, context=context)

    class PinnedPlain(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.create_connection((address, port), timeout)
            if watch is not None:
                watch.sock = self.sock

    return PinnedPlain(parts.hostname, port, timeout=timeout)


class _Watchdog:
    """The rate floor, held from outside the read: every window, if fewer bytes arrived than the floor asks (headers
    count as none, so a response must at least begin within one window), the connection's socket is shut, which ends
    whatever read is blocked, however the server trickles its framing or its headers."""

    def __init__(self, min_rate: float, window: float):
        self.min_rate, self.window = min_rate, window
        # The transport socket itself, kept from the moment it connects: `http.client` drops the connection's own
        # reference on a `Connection: close` response while the response goes on reading from it.
        self.sock = None
        self.bytes = 0
        self.tripped = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._watch, daemon=True)

    def __enter__(self):
        if self.min_rate > 0:
            self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()

    def _watch(self):
        seen = 0
        while not self._stop.wait(self.window):
            if self.bytes - seen < self.min_rate * self.window:
                self.tripped = True
                sock = self.sock
                if sock is not None:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass  # already closed: the read has ended either way
                return
            seen = self.bytes


def _request(url: str, headers: dict, timeout: float, allow_loopback: bool, watch: _Watchdog | None = None,
             method: str = "GET"):
    """The final response after at most 5 redirects, each hop checked, with the URL it came from."""
    previous = None
    for _ in range(MAX_REDIRECTS + 1):
        try:
            parts = urllib.parse.urlsplit(url)
            parts.port  # noqa: B018 (a malformed port raises here, before anything connects)
        except ValueError as error:
            raise Refused(f"refused: a malformed URL ({error})") from error
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise Refused(f"refused: {parts.scheme or 'no'} scheme")
        if parts.scheme == "http" and previous is not None and urllib.parse.urlsplit(previous).hostname != parts.hostname:
            raise Refused("refused: a redirect to plain http on another host")
        connection = _connect(url, timeout, allow_loopback, watch)
        path = parts.path or "/"
        if parts.query:
            path += f"?{parts.query}"
        try:
            connection.request(method, path, headers={"User-Agent": "isitlegit-fetch/2", "Accept-Encoding": "identity", **headers})
            response = connection.getresponse()
        except http.client.InvalidURL as error:
            connection.close()
            raise Refused(f"refused: a malformed URL ({error})") from error
        except (OSError, http.client.HTTPException) as error:
            connection.close()
            raise _Retry(f"the request failed ({error.__class__.__name__})") from error
        if response.status in (301, 302, 303, 307, 308) and response.getheader("Location"):
            # A redirect's body is never read: it could be endless, and only its Location matters.
            previous, url = url, urllib.parse.urljoin(url, response.getheader("Location"))
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


def _when(value: str | None):
    """An HTTP date, aware: the obsolete asctime form carries no zone and is GMT by definition (RFC 9110 5.6.7)."""
    from datetime import timezone

    try:
        when = email.utils.parsedate_to_datetime(value) if value else None
    except (TypeError, ValueError):
        return None
    return when.replace(tzinfo=timezone.utc) if when is not None and when.tzinfo is None else when


def _validator(headers) -> str | None:
    """What `If-Range` may carry: a strong ETag; with no ETag at all, a Last-Modified date only when it is strong, at
    least 60 seconds before the response's own Date (RFC 9110 sections 8.8.2.2 and 13.1.5)."""
    etag = headers.get("ETag")
    if etag is not None:
        return etag if _STRONG_ETAG.match(etag) else None
    modified, sent = _when(headers.get("Last-Modified")), _when(headers.get("Date"))
    if modified is None or sent is None or (sent - modified).total_seconds() < 60:
        return None
    return headers.get("Last-Modified")


def _same_representation(headers, stored: str | None) -> bool:
    """A resumed answer is the same file as the stored one: the stored ETag exactly (an absent, weak or changed one is
    not), or, for a stored date, no ETag and the same Last-Modified."""
    etag = headers.get("ETag")
    if stored is None:
        return False
    # The 206 must name the representation it continues (RFC 9110 14.4 and 13.1.5): one that omits it, or names a
    # weak or a different one, is not appended.
    if stored.startswith('"'):
        return etag == stored
    return etag is None and headers.get("Last-Modified") == stored


def _retry_after(value: str | None) -> float | None:
    """A Retry-After in seconds or as an HTTP date, as seconds from now (RFC 9110 section 10.2.3)."""
    if not value:
        return None
    if value.strip().isdigit():
        return float(value.strip())
    when = _when(value)
    if when is None:
        return None
    from datetime import datetime, timezone

    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


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
          segments: int = 0, segment_threshold: int = SEGMENT_THRESHOLD,
          allow_loopback: bool = False,
          writer=None, sleep=time.sleep, log=lambda line: print(line, file=sys.stderr)) -> dict:
    """The file at `dest`, fetched or found in place. `expected` is (`sha256` or `md5`, its published hex). Raises
    `Refused`; the CLI turns that into a result line and a non-zero exit."""
    kind, want = expected
    if kind not in ("sha256", "md5") or not re.fullmatch(r"[0-9a-f]{64}" if kind == "sha256" else r"[0-9a-f]{32}", want or ""):
        raise Refused("refused: a published SHA-256 or MD5 is required")
    if (attempts < 1 or not math.isfinite(timeout) or timeout <= 0 or source_limit <= 0 or min_free < 0 or min_rate < 0
            or not 0 <= segments <= 4 or segment_threshold < 1):
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
    # One download into a source at a time: its byte limit is counted over the whole folder, so two at once could
    # pass it together.
    lock = (partial_dir / ".lock").open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise Refused("incomplete: another download into this source is running; run this one after it") from None
    try:
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

        def charge(reason: str, retry_after: float | None = None) -> float:
            """One failure counted against the one budget every stream and segment shares; the wait it earns."""
            nonlocal failures, wait
            failures += 1
            if failures >= attempts:
                raise Refused(f"incomplete: {attempts} attempts failed ({reason}); the partial file is kept")
            pause = min(retry_after, 60.0) if retry_after is not None else wait
            cut = f" (the server asked for {retry_after:.0f}; waits stop at 60)" if retry_after and retry_after > 60 else ""
            log(f"fetch: {reason}; trying again in {pause:.0f} seconds{cut} ({failures} of {attempts} attempts spent)")
            wait = min(wait * 2, 30.0)
            return pause

        def spend(reason: str, retry_after: float | None = None):
            sleep(charge(reason, retry_after))

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

        one_stream = segments == 1

        def consistent(saved: dict) -> bool:
            """A segmented state whose ranges tile the file in order, with progress inside each, over a partial file
            of the full length: anything else starts the file again."""
            total, ranges = saved.get("total"), saved.get("segments")
            if not (isinstance(total, int) and total > 0 and isinstance(ranges, list) and 1 <= len(ranges) <= 4):
                return False
            at = 0
            for item in ranges:
                if not (isinstance(item, list) and len(item) == 3 and all(isinstance(n, int) for n in item)):
                    return False
                first, last, done = item
                if first != at or last < first or not 0 <= done <= last - first + 1:
                    return False
                at = last + 1
            return at == total and partial.exists() and partial.stat().st_size == total and bool(saved.get("validator"))

        def segmented() -> bool:
            """The file in up to four ranges at once (`segments`: 0 automatic, 1 one stream), when a HEAD gives a
            length of at least `segment_threshold`, `Accept-Ranges: bytes`, no content coding and a strong validator.
            Each range is written at its offset and its progress kept in the state, so a fresh process resumes each
            where it stopped. False hands the file to the one stream: a server that does not qualify, a one-stream
            partial from an earlier run, or a segment answer that did not fit (the rest of this run goes one stream)."""
            nonlocal state, fetched, resumed, one_stream
            if one_stream or (state and "segments" not in state):
                return False
            if state.get("segments") and not consistent(state):
                partial.unlink(missing_ok=True)
                state_file.unlink(missing_ok=True)
                state = {}
            if not state.get("segments"):
                # Any failure of the HEAD, or an answer that does not qualify, leaves the file to the one stream,
                # which has its own budget and checks.
                try:
                    connection, response, _ = _request(url, {}, timeout, allow_loopback, method="HEAD")
                    try:
                        length = response.getheader("Content-Length") or ""
                        ranges = (response.getheader("Accept-Ranges") or "").strip().lower()
                        validator = _validator(response.headers)
                        encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                        ok = response.status == 200
                    finally:
                        connection.close()
                except (_Retry, OSError, http.client.HTTPException):
                    one_stream = True
                    return False
                if not (ok and length.isdigit() and ranges == "bytes" and validator and encoding == "identity"
                        and int(length) >= segment_threshold):
                    one_stream = True
                    return False
                total = int(length)
                count = segments if segments > 0 else 4
                size = -(-total // count)
                room(total)
                with partial.open("wb") as handle:
                    handle.truncate(total)
                    os.fsync(handle.fileno())
                state = {"url": url, "expected": [kind, want], "validator": validator, "encoding": "identity",
                         "total": total, "segments": [[a, min(a + size, total) - 1, 0] for a in range(0, total, size)]}
                _write_json(state_file, state)
            elif any(item[2] for item in state["segments"]):
                resumed = True
            guard = threading.Lock()
            stop = threading.Event()
            errors: list[BaseException] = []
            counted = {"since": 0, "run": 0}
            fd = os.open(partial, os.O_RDWR)

            def save():
                # The progress is read before the flush, so the state never claims a byte the flush did not cover.
                with guard:
                    claimed = {**state, "segments": [list(item) for item in state["segments"]]}
                os.fsync(fd)
                _write_json(state_file, claimed)

            def failed(reason: str, retry_after: float | None = None):
                with guard:
                    pause = charge(reason, retry_after)
                if stop.wait(pause):
                    raise Refused("incomplete: another segment failed; the partial file is kept")

            def run(item: list):
                while not stop.is_set():
                    first, last, done = item
                    if first + done > last:
                        return
                    watch = _Watchdog(min_rate, rate_window).__enter__()
                    try:
                        try:
                            connection, response, _ = _request(
                                url, {"Range": f"bytes={first + done}-{last}", "If-Range": state["validator"]}, timeout,
                                allow_loopback, watch)
                        except _Retry as error:
                            failed(str(error))
                            continue
                        try:
                            if response.status == 429 or response.status >= 500:
                                failed(f"HTTP {response.status}", _retry_after(response.getheader("Retry-After")))
                                continue
                            span = _content_range(response.getheader("Content-Range"))
                            encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                            if (response.status != 206 or span is None or span[0] != first + done or span[1] > last
                                    or span[2] != state["total"] or encoding != "identity"
                                    or not _same_representation(response.headers, state["validator"])):
                                raise _Misfit("a segment's answer does not fit the file")
                            at = first + done
                            while at <= span[1]:
                                if stop.is_set():
                                    return  # another segment ended the run: this one stops where it is
                                block = response.read1(min(CHUNK, span[1] - at + 1))
                                if not block:
                                    break
                                if shutil.disk_usage(partial_dir).free < min_free:
                                    raise Refused("incomplete: the disk fell under its free-space floor; the partial file is kept")
                                os.pwrite(fd, block, at)
                                at += len(block)
                                watch.bytes += len(block)
                                with guard:
                                    item[2] = at - first
                                    counted["since"] += len(block)
                                    counted["run"] += len(block)
                                    due = counted["since"] >= STATE_EVERY
                                    if due:
                                        counted["since"] = 0
                                if due:
                                    save()
                            if at <= span[1]:
                                # A valid shorter answer is progress; one that stopped early is a failure.
                                failed("slower than the rate floor" if watch.tripped else "a segment ended early")
                        finally:
                            connection.close()
                    except (Refused, _Misfit) as error:
                        errors.append(error)
                        stop.set()
                        return
                    except (OSError, http.client.HTTPException) as error:
                        if getattr(error, "errno", None) == errno.ENOSPC:
                            errors.append(Refused("incomplete: the disk is full; the partial file is kept"))
                            stop.set()
                            return
                        try:
                            failed("slower than the rate floor" if watch.tripped
                                   else f"a segment broke off ({error.__class__.__name__})")
                        except Refused as spent:
                            errors.append(spent)
                            stop.set()
                            return
                    finally:
                        watch.__exit__()

            try:
                threads = [threading.Thread(target=run, args=(item,), daemon=True) for item in state["segments"]]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
                try:
                    save()
                except OSError as error:
                    raise Refused(f"incomplete: the download state could not be written ({error.strerror}); the partial file is kept") from error
            finally:
                os.close(fd)
                fetched += counted["run"]
            misfit = next((error for error in errors if isinstance(error, _Misfit)), None)
            if misfit is not None:
                # The server's ranges cannot be trusted for this file: it starts again on the one stream.
                one_stream = True
                restart(str(misfit))
                return False
            if errors:
                raise next((error for error in errors if "attempts failed" in str(error) or "disk" in str(error)), errors[0])
            return all(item[0] + item[2] > item[1] for item in state["segments"])

        while True:
            if segmented():
                break
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
            watch = _Watchdog(min_rate, rate_window).__enter__()
            try:
                connection, response, final_url = _request(url, headers, timeout, allow_loopback, watch)
            except _Retry as error:
                watch.__exit__()
                spend("slower than the rate floor" if watch.tripped else str(error))
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
                    spend(f"HTTP {code}", _retry_after(response.getheader("Retry-After")))
                    continue
                if code not in (200, 206):
                    raise Refused(f"refused: HTTP {code}")
                encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                length = response.getheader("Content-Length")
                if code == 206:
                    span = _content_range(response.getheader("Content-Range"))
                    same = _same_representation(response.headers, state.get("validator")) and encoding == state.get("encoding")
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
                    # The partial this answer replaces is counted once: it is truncated before the body arrives.
                    room(max((body or 0) - have, 0))
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
                            # read1 returns what has arrived, so a trickle reaches the rate check below byte by byte.
                            block = response.read1(CHUNK)
                            if not block:
                                break
                            got += len(block)
                            fetched += len(block)
                            window_bytes += len(block)
                            watch.bytes += len(block)
                            if body is not None and got > body:
                                raise Refused("refused: the server sent more than it said")
                            if have + got > (state.get("total") or source_limit) or base + got > source_limit:
                                raise Refused(f"refused: {source} would pass its limit of {source_limit} bytes")
                            # The free-space floor, checked before every write: a file of no stated length, or another
                            # writer on the disk, can cross it after the first check.
                            if shutil.disk_usage(partial_dir).free - len(block) < min_free:
                                raise Refused("incomplete: the disk fell under its free-space floor; the partial file is kept")
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
                    spend("slower than the rate floor" if watch.tripped else f"the transfer broke off ({error.__class__.__name__})")
                    continue
                except _Retry as error:
                    spend(str(error))
                    continue
                if watch.tripped:
                    # The watchdog shut the socket: an end it caused is not the end of the file.
                    spend("slower than the rate floor")
                    continue
                if body is not None and got < body:
                    spend(f"the body ended at {got} of {body} bytes")
                    continue
                if state.get("total") is None:
                    state["total"] = have + got  # no length given: whatever arrived whole is what the digest will judge
                    _write_json(state_file, state)
                # A valid shorter range is progress, not a failure: the loop asks for the next one.
            finally:
                watch.__exit__()
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
    finally:
        lock.close()


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
    parser.add_argument("--segments", type=int, default=0, help="0: automatic (up to 4 over 64 MiB); 1: one stream")
    parser.add_argument("--segment-threshold", type=int, default=SEGMENT_THRESHOLD, help="the smallest file segmented")
    parser.add_argument("--allow-loopback", action="store_true", help="for the tests' local server only")
    args = parser.parse_args(argv)
    expected = ("sha256", (args.sha256 or "").lower()) if args.sha256 is not None else ("md5", (args.md5 or "").lower())
    try:
        line = fetch(args.url, args.dest, expected, source_limit=args.source_limit, min_free=args.min_free,
                     timeout=args.timeout, attempts=args.attempts, min_rate=args.min_rate, segments=args.segments,
                     segment_threshold=args.segment_threshold,
                     allow_loopback=args.allow_loopback)
    except Refused as error:
        reason = str(error)
        # The same fields as a success, so a caller reads one shape; `fetched` is unknown on a failure.
        print(json.dumps({"status": reason.split(":")[0], "bytes": 0, "fetched": None, "sha256": None,
                          "resumed": False, "reason": reason}))
        return 1
    print(json.dumps(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
