"""One dataset file, downloaded so an interruption resumes and nothing unverified is accepted (D03 T04 §16).

    python3 <repo>/scripts/glimmer/fetch.py --url URL --dest SOURCE/NAME (--sha256 HEX | --md5 HEX)
        [--source-limit BYTES] [--min-free BYTES] [--timeout 30] [--attempts 3] [--min-rate BYTES_PER_SECOND]
        [--segments 0..4] [--segment-threshold BYTES] [--mirror URL ...]

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
`429` and `5xx` all spend one budget of `--attempts` tries (whichever source they come from); `Retry-After` is honoured up to 60 seconds (a longer one
is cut to 60, so a run stays bounded, and the log says so) and other waits double from 1 second; a transfer slower than `--min-rate` over 60 seconds is cut and counted as a failure. Before and
during a transfer the source folder (every file in it, partials included) stays under `--source-limit` and the disk
keeps `--min-free` free. Progress goes to standard error; one JSON line goes to standard output (`status`, `bytes`,
`fetched`, `sha256`, `resumed`, `url`, `urls`, `reason`; `urls` names every URL that supplied bytes of the file, in the
order each first supplied one, counting an earlier process's on a resume, and `url` is the first of them; both are
empty or null when the file was already in place or the run failed). The exit is 0 only for a file in place.

A file of at least `--segment-threshold` bytes (64 MiB) whose `HEAD` gives its length, `Accept-Ranges: bytes`, no
content coding and a strong validator comes in up to four ranges at once (`--segments`: 0 automatic, 1 one stream;
D03 T04 §20, where four connections took 74 percent less time than one against a host that caps each connection).
Each range is written at its offset, its progress saved every MiB after a flush, and checked as a resume is; all of
them share the attempt budget, the limits and the lock. An answer that does not fit starts the file again on one
stream, and the file is published only whole and verified, as above; its digest is read back in file order as the
leading ranges fill, so no whole-file pass follows the transfer.

`--mirror URL` (repeatable) adds URLs for the same file (D03 T04 §22). On a segmented run every live URL whose `HEAD`
gives the same length and the same strong validator as the first serves ranges together, up to four connections in all,
spread over them, so two hosts that each cap a connection give the file both hosts' bandwidth. A free connection takes
half of the slowest range's rest from the fastest source, and a source that fails, stalls or is asked to wait
(`Retry-After`) hands its unfinished ranges to the others, while a source whose file changes mid-run is dropped and
every range it wrote fetched again. A URL that gives another length or validator stays out of that mix but is kept as
the ordered fallback: when the sources in the mix are ruled out, the file starts again, whole, from the next one. On a
single stream the URLs are tried in order under the same rules: a counted failure moves on to the next, a refused route
or a refused answer rules that URL out, and a partial resumes across URLs only under the same validator. A digest
mismatch from bytes of one URL rules it out; from bytes of several, each source that agreed on the file is downloaded
whole on its own into a file of its own and checked, the one whose bytes verify is published, those whose bytes do not
are ruled out (kept in the state, so a fresh process never asks them again), and nothing is published unless the full
digest matches.
"""

import argparse
import email.utils
import functools
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
MIN_SPLIT = 2 * 1024 * 1024  # the least a range's rest must hold for a free connection to take half of it
MAX_RANGES = 64
CONNECTIONS = 4  # the most connections one fetch holds open at once, its HEADs and its transfers together
SHORT_ANSWER = 64 * 1024  # a range answer under this, when at least twice it was asked, spends an attempt (one-byte answers)
IDLE_WAIT = 0.25  # the longest an idle connection waits before looking for work again, when nothing rings it
HASH_WAIT = 0.05  # the longest the hasher waits before reading on, when nothing rings it
SPLIT_AFTER = 1.0  # a range is split only when its own pace says at least this many seconds of it are left
STATE_EVERY = 1024 * 1024  # progress saved after each MiB, by the hasher's thread: a killed run loses about that
MAX_REDIRECTS = 5
RATE_WINDOW = 60.0


class Refused(Exception):
    """The fetch stops: `refused: ...` (it must not go on) or `incomplete: ...` (a rerun may finish it)."""


class _Route(Refused):
    """A refusal of one URL's route (its address, scheme, form or redirects): another mirror may still serve the file."""


class _Misfit(Exception):
    """A segment's answer that does not fit the file (its range, length, coding or validator). `changed` is true when
    the answer names another representation (a new validator or length) and not merely a malformed one."""

    def __init__(self, message: str, changed: bool = False):
        super().__init__(message)
        self.changed = changed


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
            raise _Route("refused: a non-public address")
    return addresses[0]


@functools.lru_cache(maxsize=8)
def _tls_context(ca_file: str | None) -> ssl.SSLContext:
    """The system's authorities, with `--ca-file`'s added (never in their place): a test host's own authority, and a
    publicly trusted mirror or redirect target, both verify. Verification is always on. Made once per file and kept,
    so a file removed or replaced after the run's check cannot fail a later connection."""
    context = ssl.create_default_context()
    if ca_file is not None:
        context.load_verify_locations(cafile=ca_file)
    return context


def _connect(url: str, timeout: float, allow_loopback: bool, watch=None, ca_file: str | None = None):
    """A connection pinned to the vetted address: the name is resolved once, here, and never again by the library."""
    parts = urllib.parse.urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    address = _vetted(parts.hostname or "", port, allow_loopback)
    if parts.scheme == "https":
        context = _tls_context(ca_file)

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
             method: str = "GET", ca_file: str | None = None):
    """The final response after at most 5 redirects, each hop checked, with the URL it came from."""
    previous = None
    for _ in range(MAX_REDIRECTS + 1):
        try:
            parts = urllib.parse.urlsplit(url)
            parts.port  # noqa: B018 (a malformed port raises here, before anything connects)
        except ValueError as error:
            raise _Route(f"refused: a malformed URL ({error})") from error
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise _Route(f"refused: {parts.scheme or 'no'} scheme")
        if parts.scheme == "http" and previous is not None and urllib.parse.urlsplit(previous).hostname != parts.hostname:
            raise _Route("refused: a redirect to plain http on another host")
        connection = _connect(url, timeout, allow_loopback, watch, ca_file)
        path = parts.path or "/"
        if parts.query:
            path += f"?{parts.query}"
        try:
            connection.request(method, path, headers={"User-Agent": "isitlegit-fetch/2", "Accept-Encoding": "identity", **headers})
            response = connection.getresponse()
        except http.client.InvalidURL as error:
            connection.close()
            raise _Route(f"refused: a malformed URL ({error})") from error
        except ssl.SSLCertVerificationError as error:
            # Not a passing fault: this host's certificate does not verify, so this URL is refused (another may not).
            connection.close()
            raise _Route(f"refused: the certificate did not verify ({error.verify_message})") from error
        except (OSError, http.client.HTTPException) as error:
            connection.close()
            raise _Retry(f"the request failed ({error.__class__.__name__})") from error
        if response.status in (301, 302, 303, 307, 308) and response.getheader("Location"):
            # A redirect's body is never read: it could be endless, and only its Location matters.
            previous, url = url, urllib.parse.urljoin(url, response.getheader("Location"))
            connection.close()
            continue
        return connection, response, url
    raise _Route(f"refused: more than {MAX_REDIRECTS} redirects")


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
    if re.fullmatch(r"\d{1,19}", value.strip()):
        return float(value.strip())
    when = _when(value)
    if when is None:
        return None
    from datetime import datetime, timezone

    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def _count(value: str | None) -> int | None:
    """A byte count a header gives: at most 19 digits (any real file fits), so a hostile one cannot cost a huge parse."""
    return int(value) if value is not None and re.fullmatch(r"\d{1,19}", value) else None


def _content_range(value: str | None):
    """`bytes a-b/total` as (a, b, total), with 0 <= a <= b < total; None for anything else."""
    match = re.fullmatch(r"bytes (\d{1,19})-(\d{1,19})/(\d{1,19})", value or "")
    if not match:
        return None
    first, last, total = (int(g) for g in match.groups())
    return (first, last, total) if first <= last < total else None


def _folder_bytes(folder: Path) -> int:
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file()) if folder.exists() else 0


class _InOrderDigest:
    """The digest of a partial file, read back in file order as its leading bytes arrive (D03 T04 §22). `frontier()` is
    the end of the unbroken written run from the first byte, called with `guard` held; an invalidation (`invalidate`,
    also with `guard` held) says some of those bytes are to be replaced, and the digest starts over from the first."""

    def __init__(self, kind: str, descriptor: int, guard, frontier):
        self.kind, self.descriptor, self.guard, self.frontier = kind, descriptor, guard, frontier
        self.hash = hashlib.new(kind)
        self.at = 0
        self.failed = False
        self.gen = 0  # moves at every invalidation
        self.seen = 0  # the generation `hash` was begun in

    def invalidate(self) -> None:
        self.gen += 1

    def hash_up_to(self, end: int) -> None:
        """Reads on to `end`. An invalidation (the generation moved) starts the digest over from the first byte, and the
        frontier `end` was read from is then out of date: it may lie past bytes the invalidation cut back, which hold
        old bytes until their replacements arrive, and the replacements would then be skipped as already hashed. The
        frontier is read again, in the same step as the restart, and the read goes on to that."""
        while True:
            with self.guard:
                if self.seen != self.gen:
                    self.hash, self.at, self.seen = hashlib.new(self.kind), 0, self.gen
                    end = self.frontier()
                generation, at = self.gen, self.at
            if at >= end:
                return
            block = os.pread(self.descriptor, min(1 << 20, end - at), at)
            if not block:
                raise OSError(errno.EIO, "the partial file ended early")
            with self.guard:
                if self.gen != generation:
                    continue  # cut back while this block was read: it may be old bytes, and is dropped
                self.hash.update(block)
                self.at = at + len(block)


def fetch(url: str, dest: str, expected: tuple[str, str], *, source_limit: int = 5 * 10**9, min_free: int = 10 * 10**9,
          timeout: float = 30.0, attempts: int = 3, min_rate: float = 16 * 1024, rate_window: float = RATE_WINDOW,
          segments: int = 0, segment_threshold: int = SEGMENT_THRESHOLD, mirrors: tuple[str, ...] | list[str] = (),
          ca_file: str | None = None,
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
    if ca_file is not None:
        # Read once before anything connects: a missing, unreadable or non-PEM file is a refusal line, not a traceback.
        try:
            _tls_context(ca_file)
        except (OSError, ssl.SSLError) as error:
            raise Refused(f"refused: --ca-file {ca_file} could not be read as PEM certificates ({error})") from None
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
    streamed: dict[str, str] = {}  # the digest a segmented run computed as its ranges arrived, read back from the file

    def outcome(status, **extra):
        return {"status": status, "bytes": target.stat().st_size if target.exists() else 0, "fetched": fetched, **extra}

    def contributors() -> list[str]:
        """The URLs that supplied bytes of the file in the state, in the order each first supplied one. A segmented
        state names the source of every byte, so a URL whose bytes were all replaced is not one; one that does not (a
        one-stream partial, a state written before provenance existed) counts every URL it lists."""
        sources = state.get("sources") or []
        spans = state.get("provenance")
        if not isinstance(spans, list):
            return list(sources)
        used = {span[2] for span in spans}
        return [name for number, name in enumerate(sources) if number in used]

    if target.exists():
        try:
            found = _digest(target, kind)
        except OSError as error:
            raise Refused(f"incomplete: {target} could not be read ({error.strerror})") from error
        if found == want:
            # Not fetched this run, so no URL served it: `url` is null (the line keeps one shape).
            return outcome("present", sha256=_digest(target, "sha256") if kind != "sha256" else found, resumed=False,
                           url=None, urls=[])
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

        # The URLs not yet ruled out, in the order given: the first, then each --mirror. A counted failure moves to the
        # next; a refused route, or a file whose digest does not match, rules that URL out for the run.
        # A source a mixed-source digest failure ruled out is never asked again for this download, by this process or a
        # fresh one that finds it in the state.
        # They are kept at the top of the state, so the recovery's end, a restart of the file or a fallback to the other
        # URLs does not forget them (the recovery's own list is read too, for a state an earlier version wrote).
        excluded: list[str] = list(dict.fromkeys([*(state.get("ruled_out") or []),
                                                  *((state.get("recovery") or {}).get("ruled_out") or [])]))
        state.pop("ruled_out", None)
        if set(state) <= {"url", "expected"}:
            state = {}  # nothing but the exclusions was kept: no progress to resume
        live = [name for name in dict.fromkeys([url, *mirrors]) if name not in excluded]
        if not live:
            state_file.unlink(missing_ok=True)
            raise Refused(f"refused: the {kind} does not match the published one; the partial file is removed")
        (partial_dir / f"{target.name}.trial").unlink(missing_ok=True)  # a killed process's trial: not part of any download
        where = {"at": 0}
        # A source asked to wait (`Retry-After`): when it may be asked again. It is kept for the whole run, so the wait
        # holds across the HEADs, the segmented passes and the fallback to a single stream or a trial, not just within
        # the pass that heard it.
        cooldown: dict[str, float] = {}

        def here() -> str:
            return live[where["at"] % len(live)]

        def write_state(value: dict | None = None) -> None:
            """The state saved, with the sources ruled out for this download."""
            value = state if value is None else value
            _write_json(state_file, {**value, "ruled_out": list(excluded)} if excluded else value)

        def forget() -> None:
            """The download's state is dropped (its partial starts again); what proved a source bad is not."""
            if excluded:
                _write_json(state_file, {"url": url, "expected": [kind, want], "ruled_out": list(excluded)})
            else:
                state_file.unlink(missing_ok=True)

        def exclude(name: str) -> None:
            """`name` is ruled out for this download, in this process and in a fresh one that reads the state."""
            if name not in excluded:
                excluded.append(name)
            recovery = state.get("recovery")
            if recovery is not None and name not in recovery["ruled_out"]:
                recovery["ruled_out"].append(name)

        def rotate():
            if len(live) > 1:
                where["at"] = (where["at"] + 1) % len(live)
                log(f"fetch: trying the next URL ({where['at'] + 1} of {len(live)})")

        def drop(error: Refused, source: str | None = None) -> None:
            """The URL that failed (`source`, or the one in use) is ruled out for this run; the error itself when it
            was the last one. The URL in use stays in use when another one is ruled out."""
            gone = here() if source is None else source
            if gone not in live:
                return  # already ruled out by another range's answer
            if len(live) == 1:
                raise error
            current, index = here(), live.index(gone)
            live.remove(gone)
            where["at"] = live.index(current) if current != gone else index % len(live)
            log(f"fetch: {error}; trying the next URL ({len(live)} left)")

        def charge(reason: str, retry_after: float | None = None, progressed: bool = False, stay: bool = False,
                   source: str | None = None) -> float:
            """One failure counted against the one budget every stream, segment and source shares; the wait it earns. A
            connection cut after it delivered bytes is tried again at once: the host is answering, so waiting buys
            nothing (aria2c does the same); its wait does not grow."""
            nonlocal failures, wait
            failures += 1
            if failures >= attempts:
                raise Refused(f"incomplete: {attempts} attempts failed ({reason}); the partial file is kept")
            if progressed and retry_after is None:
                log(f"fetch: {reason} after bytes arrived; trying again now ({failures} of {attempts} attempts spent)")
                if not stay:
                    rotate()
                return 0.0
            pause = min(retry_after, 60.0) if retry_after is not None else wait
            if retry_after is not None:
                cooldown[source or here()] = time.monotonic() + pause  # only this source waits
            cut = f" (the server asked for {retry_after:.0f}; waits stop at 60)" if retry_after and retry_after > 60 else ""
            log(f"fetch: {reason}; trying again in {pause:.0f} seconds{cut} ({failures} of {attempts} attempts spent)")
            wait = min(wait * 2, 30.0)
            if not stay:
                rotate()
            return pause

        def cool(name: str) -> None:
            """Waits out what `name` was asked to wait before it is asked again."""
            remaining = cooldown.pop(name, 0.0) - time.monotonic()
            if remaining > 0:
                sleep(remaining)

        def spend(reason: str, retry_after: float | None = None, progressed: bool = False, stay: bool = False):
            name = here()  # the source that failed, before a rotation moves on
            pause = charge(reason, retry_after, progressed, stay=stay, source=name)
            if pause:
                sleep(pause)
                cooldown.pop(name, None)  # waited out here

        def restart(reason: str):
            nonlocal state
            partial.unlink(missing_ok=True)
            forget()
            state = {}
            spend(reason, stay=True)  # the URL answered, with another file: start it again there, not elsewhere

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
            if not (isinstance(total, int) and total > 0 and isinstance(ranges, list) and 1 <= len(ranges) <= MAX_RANGES):
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

        barred: set[str] = set()  # URLs taken out of the concurrent mix for the rest of this run (a malformed or changed answer)
        agreed: list[str] = []  # the URLs that agreed on the file in the latest segmented pass, in the order tried

        def probe(candidate: str) -> dict:
            """One URL's `HEAD`, sorted: `qualifies` (a length of at least `segment_threshold`, `Accept-Ranges: bytes`, no
            content coding and a strong validator), `other` (it answered, but not so), `failed` (a counted failure) or
            `route` (a refused route)."""
            watch = _Watchdog(min_rate, rate_window).__enter__()
            try:
                connection, response, _ = _request(candidate, {}, timeout, allow_loopback, watch, method="HEAD",
                                                   ca_file=ca_file)
                try:
                    status = response.status
                    length = _count(response.getheader("Content-Length"))
                    # A list of range units (RFC 9110 14.3): `bytes` among them qualifies.
                    ranges = {unit.strip().lower() for unit in (response.getheader("Accept-Ranges") or "").split(",")}
                    validator = _validator(response.headers)
                    encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                    wait_asked = _retry_after(response.getheader("Retry-After"))
                finally:
                    connection.close()
            except _Route as error:
                return {"kind": "route", "error": error}
            except (_Retry, OSError, http.client.HTTPException) as error:
                return {"kind": "failed", "wait": None,
                        "reason": "the HEAD was slower than the rate floor" if watch.tripped else f"the HEAD failed ({error})"}
            finally:
                watch.__exit__()
            if status == 429 or (status >= 500 and status != 501):
                return {"kind": "failed", "reason": f"HTTP {status} to the HEAD", "wait": wait_asked}
            qualifies = (status == 200 and length is not None and "bytes" in ranges and validator and encoding == "identity"
                         and length >= segment_threshold)
            return {"kind": "qualifies" if qualifies else "other", "total": length, "validator": validator,
                    "no_head": status == 501}

        def choose(resuming: bool, limit: int = CONNECTIONS):
            """The URLs that serve ranges together: every live URL whose `HEAD` gives the same length and the same strong
            validator as the first to answer (on a resume, as the saved ranges). One that answers otherwise stays in
            `live` for the ordered fallback and is kept out of the mix. Returns (URLs, length, validator), or the status
            that hands the run back to its caller."""
            nonlocal state, one_stream, agreed
            order = live[where["at"]:] + live[:where["at"]]
            # A source still waiting out a Retry-After is not asked: the others are, and it stays live as a fallback.
            # When every one is waiting, the soonest to be free is waited for.
            now = time.monotonic()
            if all(cooldown.get(name, 0.0) > now for name in order):
                cool(min(order, key=lambda name: cooldown.get(name, 0.0)))
            now = time.monotonic()
            order = [name for name in order if cooldown.get(name, 0.0) <= now]
            if resuming and len(order) == 1:
                agreed = list(order)  # one URL: the ranges check themselves against the saved validator, as they always did
                return agreed, state["total"], state["validator"]
            results: dict[str, dict] = {}

            def ask(name: str):
                try:
                    results[name] = probe(name)
                except Exception as error:  # a probe that raised is a failed HEAD, not a lost thread
                    results[name] = {"kind": "failed", "reason": f"the HEAD failed ({error.__class__.__name__})", "wait": None}

            if len(order) == 1:
                ask(order[0])
            else:
                # No more HEADs at once than the run may hold connections: the transfers have not begun, so these are
                # all of the run's connections, and a fifth source waits for a place.
                places = threading.BoundedSemaphore(min(limit, CONNECTIONS))

                def ask_in_turn(name: str):
                    with places:
                        ask(name)

                threads = [threading.Thread(target=ask_in_turn, args=(name,), daemon=True) for name in order]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
            pauses = []
            for name in order:
                if results[name]["kind"] == "route":
                    drop(results[name]["error"], name)
                elif results[name]["kind"] == "failed":
                    pauses.append(charge(results[name]["reason"], results[name]["wait"], stay=True, source=name))
            answered = [name for name in order if name in live and name not in barred
                        and results[name]["kind"] in ("qualifies", "other")]
            if not answered:
                if pauses:
                    if max(pauses):
                        sleep(max(pauses))
                        for name in order:
                            cooldown.pop(name, None)  # waited out here
                    return "again"
                one_stream = True
                return "one-stream"
            qualifying = [name for name in answered if results[name]["kind"] == "qualifies"]
            if resuming:
                reference = (state["total"], state["validator"])
            else:
                head = results[answered[0]]
                if head["kind"] != "qualifies":
                    one_stream = True  # the first to answer does not do ranges (or HEAD): its GET serves the file whole
                    return "one-stream"
                reference = (head["total"], head["validator"])
            agreed = [name for name in qualifying if (results[name]["total"], results[name]["validator"]) == reference]
            for name in qualifying:
                if name not in agreed:
                    log(f"fetch: {name} gives another length or validator; it stays in the fallback, not in the mix")
            if not agreed:
                if not qualifying:
                    return [answered[0]], *reference  # nothing qualifies: the saved ranges ask for themselves, under If-Range
                # The saved ranges belong to a file no live URL gives now: the first to answer starts it again.
                log("fetch: no URL gives the file the saved ranges belong to; starting again from the next one")
                partial.unlink(missing_ok=True)
                forget()
                state = {}
                return "again"
            return agreed, *reference

        def segmented() -> str:
            """The file in up to four ranges at once (`segments`: 0 automatic, 1 one stream), spread over every live URL
            that agrees on it (one `HEAD` each: the same length, `Accept-Ranges: bytes`, no content coding and the same
            strong validator), at most four connections in all. Each range is written at its offset and its progress and
            the source of each byte kept in the state, so a fresh process resumes each where it stopped. "done" when every
            range is whole; "one-stream" hands the file to the one stream (a server that does not qualify, or a
            one-stream partial from an earlier run); "again" asks the loop to come back (every source of the mix gone, a
            partial no URL gives now, or a failed HEAD)."""
            nonlocal state, fetched, resumed, one_stream, agreed
            if state.get("segments") and not consistent(state):
                # Ranges that do not tile the file, or a partial of the wrong length: start again, whatever this run
                # asks (a one-stream run would otherwise read the sparse partial's full length as a whole file).
                partial.unlink(missing_ok=True)
                forget()
                state = {}
            resuming = bool(state.get("segments"))
            if not resuming and (one_stream or state):
                return "one-stream"
            count = segments if segments > 0 else 4
            chosen = choose(resuming, count)
            if isinstance(chosen, str):
                return chosen
            sources_agreeing, total, validator = chosen
            if not resuming:
                size = -(-total // count)
                room(total)
                try:
                    with partial.open("wb") as handle:
                        handle.truncate(total)
                        os.fsync(handle.fileno())
                except OSError as error:
                    raise Refused(f"incomplete: the partial file could not be made ({error.strerror})") from error
                state = {"url": url, "expected": [kind, want], "validator": validator, "encoding": "identity",
                         "total": total, "segments": [[a, min(a + size, total) - 1, 0] for a in range(0, total, size)],
                         "sources": [], "provenance": []}
                write_state()
            else:
                room(0)  # the partial already holds its full length: the source and disk must still allow it now
                resumed = resumed or any(item[2] for item in state["segments"])
                state.setdefault("sources", [])
            mix = sources_agreeing[:count]  # the sources serving now; the rest wait to take the place of one that leaves
            bench = sources_agreeing[count:]
            # Where every byte came from, as [first, last, source index]; None for a state written before this existed,
            # whose bytes then count as from unknown sources.
            prov = state.get("provenance") if isinstance(state.get("provenance"), list) else None
            if prov is None:
                state.pop("provenance", None)
            else:
                state["provenance"] = prov
            ends = {span[1]: span for span in prov} if prov is not None else {}
            guard = threading.Lock()
            stop = threading.Event()
            # Rung when a range ends, a connection finishes or the run stops: an idle connection or the hasher waits on
            # it instead of sleeping, so a finished run returns at once (a 0.25-second poll held each run back).
            changed = threading.Condition()
            running = {"workers": 0}

            def wake():
                with changed:
                    changed.notify_all()
            errors: list[BaseException] = []
            counted = {"since": 0, "run": 0}
            fd = os.open(partial, os.O_RDWR)

            saving = threading.Lock()

            def save():
                # One save at a time, each whole: two at once would share the temporary file and could land an older
                # snapshot over a newer one. The progress is read before the flush, so the state never claims a byte
                # the flush did not cover.
                with saving:
                    with guard:
                        claimed = {**state, "segments": [list(item) for item in state["segments"]],
                                   "sources": list(state["sources"])}
                        if prov is not None:
                            claimed["provenance"] = sorted(list(span) for span in prov)
                    os.fsync(fd)
                    write_state(claimed)

            owner: dict[int, str] = {}  # each range's source: the one its next request goes to
            hold = cooldown  # a source asked to wait (Retry-After): when it may be asked again
            fails: dict[str, int] = {}  # failures in a row, cleared by the next byte a source delivers
            busy: dict[str, int] = {}  # requests in flight, by source
            speed: dict[str, float] = {}  # a source's pace on its last finished request
            reading: dict[int, tuple[list, str]] = {}  # the ranges with a request in flight, and the source of each
            # Ranges whose progress was just invalidated, each with the number of invalidations still unsaved: nothing is
            # written to a range until every invalidation that cut it has its state saved (one's save finishing must
            # not release a range another's cut rewound further).
            parked: dict[int, int] = {}
            taken: set[int] = set()
            working: set[int] = set()  # ranges a connection is working on now
            pace: dict[int, tuple[float, int]] = {}  # each range's current request: when it began, and its progress then
            for number, item in enumerate(state["segments"]):
                owner[id(item)] = mix[number % len(mix)]

            def usable(avoid: str | None = None) -> list[str]:
                now = time.monotonic()
                return [name for name in mix if name != avoid and hold.get(name, 0.0) <= now]

            def other_source(avoid: str | None = None) -> str | None:
                """A source for a range that must not stay where it was: the one with the fewest requests in flight, one
                that has not just failed first."""
                options = usable(avoid)
                return min(options, key=lambda name: (fails.get(name, 0) > 0, busy.get(name, 0), mix.index(name)), default=None)

            def pace_of(name: str) -> float:
                """A source's pace now: the best of its requests in flight, else its last finished one."""
                now, rates = time.monotonic(), []
                for item, source_ in reading.values():
                    began, then = pace.get(id(item), (0.0, item[2]))
                    if source_ == name and began and now - began >= 0.25:
                        rates.append((item[2] - then) / (now - began))
                return max(rates) if rates else speed.get(name, 0.0)

            def fastest() -> str | None:
                options = usable()
                return max(options, key=lambda name: (fails.get(name, 0) == 0, pace_of(name), -busy.get(name, 0), -mix.index(name)),
                           default=None)

            def pick(item: list) -> tuple[str | None, float]:
                """The source for a range's next request, and the seconds to wait before it. The range stays with its
                source unless that one has left or been asked to wait and another is free."""
                name = owner.get(id(item))
                if name in mix and hold.get(name, 0.0) <= time.monotonic():
                    return name, 0.0
                other = other_source()
                if other is not None:
                    owner[id(item)] = other
                    return other, 0.0
                if not mix:
                    return None, 0.0
                name = min(mix, key=lambda candidate: hold.get(candidate, 0.0))  # every source is waiting: the first to be free
                owner[id(item)] = name
                return name, max(0.0, hold.get(name, 0.0) - time.monotonic())

            def failed(reason: str, retry_after: float | None = None, progressed: bool = False, source: str | None = None,
                       item: list | None = None):
                with guard:
                    pause = charge(reason, retry_after, progressed, stay=True, source=source)
                    fails[source] = fails.get(source, 0) + 1
                    other = other_source(avoid=source)
                    if other is not None and item is not None:
                        owner[id(item)] = other  # the failed source's range goes on at another
                        pause = 0.0
                if stop.wait(pause):
                    raise Refused("incomplete: another segment failed; the partial file is kept")

            def rest(item: list) -> int:
                return item[1] - (item[0] + item[2]) + 1


            def save_or_stop():
                # A state that cannot be written ends the run as such: the partial is kept for a rerun.
                try:
                    save()
                except Refused as error:  # _write_json's own refusal (a failed temporary write or rename)
                    errors.append(error)
                    stop.set()
                    wake()
                except OSError as error:
                    errors.append(Refused(f"incomplete: the download state could not be written ({error.strerror}); the partial file is kept"))
                    stop.set()
                    wake()

            def invalidate(source: str):
                """The bytes `source` wrote are no longer trusted: every range's progress is cut back to the first byte
                of it, the cut saved before any replacement byte is written (the ranges are parked until it is), and
                the in-order digest is reset to be rebuilt over the replacements."""
                with guard:
                    index = state["sources"].index(source) if source in state["sources"] else None
                    # Every range's cut is found against the provenance as it stands, before any of it changes: one
                    # span can run across range boundaries (the same source wrote the end of one range and the start
                    # of the next), so trimming it for the first range must not hide the source's bytes in the others.
                    cuts = []
                    for item in state["segments"]:
                        first, last, done = item
                        if not done:
                            continue
                        if prov is None:
                            cut = first  # unknown provenance: any of it may be this source's
                        else:
                            found = [max(span[0], first) for span in prov
                                     if span[2] == index and span[1] >= first and span[0] <= first + done - 1]
                            if not found:
                                continue
                            cut = min(found)
                        cuts.append((item, cut, first + done - 1))
                    cut_ranges = [item for item, _, _ in cuts]
                    for item, cut, written in cuts:
                        item[2] = cut - item[0]
                        if prov is not None:
                            # Everything the range held from the cut on goes, whoever wrote it; a span that runs on
                            # past the cut keeps the part before it (and the part after the range's old end, if any).
                            kept = []
                            for span in prov:
                                if span[1] < cut or span[0] > written:
                                    kept.append(span)
                                    continue
                                if span[0] < cut:
                                    kept.append([span[0], cut - 1, span[2]])
                                if span[1] > written:
                                    kept.append([written + 1, span[1], span[2]])
                            prov[:] = kept
                    if not cut_ranges:
                        return
                    ends.clear()
                    ends.update({span[1]: span for span in prov or []})
                    hashed.invalidate()
                    for item in cut_ranges:
                        parked[id(item)] = parked.get(id(item), 0) + 1
                        if id(item) not in working:
                            taken.discard(id(item))  # nobody is on it: the next free connection takes it
                save_or_stop()
                with guard:
                    for item in cut_ranges:
                        if parked[id(item)] <= 1:
                            del parked[id(item)]
                        else:
                            parked[id(item)] -= 1
                wake()

            def leave(source: str, error: BaseException, route: bool = False, changed_file: bool = False) -> bool:
                """`source` goes out of the mix, its connections ending where they are. True when other sources remain to
                carry the run on; otherwise the run ends with `error`. A refused route also rules the URL out for the run;
                a changed file also invalidates what the source wrote."""
                with guard:
                    if source not in mix:
                        return bool(mix)
                    mix.remove(source)
                    if bench:
                        mix.append(bench.pop(0))
                    if not route:
                        barred.add(source)
                    remaining = bool(mix)
                    if remaining and route:
                        drop(error, source)  # more than this URL is live: it is the mix that held them
                if not remaining:
                    error.source = source
                    errors.append(error)
                    stop.set()
                    wake()
                    return False
                log(f"fetch: {source} leaves the mix ({error}); the others go on")
                if changed_file:
                    invalidate(source)
                wake()
                return True

            def run(item: list):
                while not stop.is_set():
                    with guard:
                        first, last, done = item
                        if first + done > last:
                            working.discard(id(item))
                            return
                        if id(item) in parked:
                            name, delay = "", 0.0
                        else:
                            name, delay = pick(item)
                    if name == "":
                        with changed:
                            changed.wait(HASH_WAIT)  # rung once the invalidation is saved
                        continue
                    if name is None:
                        return  # no source is left: the run is ending
                    if delay and stop.wait(delay):
                        return
                    progressed = False
                    with guard:
                        if name not in mix or id(item) in parked:
                            continue
                        at = item[0] + item[2]
                        last = item[1]
                        busy[name] = busy.get(name, 0) + 1
                        reading[id(item)] = (item, name)
                        pace[id(item)] = (time.monotonic(), item[2])
                    watch = _Watchdog(min_rate, rate_window).__enter__()
                    source = name
                    began = time.monotonic()
                    got = 0
                    try:
                        try:
                            connection, response, _ = _request(
                                source, {"Range": f"bytes={at}-{last}", "If-Range": state["validator"]}, timeout,
                                allow_loopback, watch, ca_file=ca_file)
                        except _Retry as error:
                            failed(str(error), source=source, item=item)
                            continue
                        try:
                            if response.status == 429 or response.status >= 500:
                                failed(f"HTTP {response.status}", _retry_after(response.getheader("Retry-After")),
                                       source=source, item=item)
                                continue
                            if response.status >= 400 and response.status != 416:
                                # This URL refuses the file (expired access, a missing copy): it is ruled out, as the
                                # one stream rules it out, and the others carry on.
                                raise _Route(f"refused: HTTP {response.status}")
                            span = _content_range(response.getheader("Content-Range"))
                            encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                            if (response.status != 206 or span is None or span[0] != at or span[1] > last
                                    or span[2] != state["total"] or encoding != "identity"
                                    or not _same_representation(response.headers, state["validator"])
                                    or (response.getheader("Content-Length") is not None
                                        and _count(response.getheader("Content-Length")) != span[1] - span[0] + 1)):
                                newer = _validator(response.headers)
                                length = _count(response.getheader("Content-Length"))
                                differs = ((newer is not None and newer != state["validator"])
                                           or (span is not None and span[2] != state["total"])
                                           or (response.status == 200 and length is not None and length != state["total"]))
                                raise _Misfit("a segment's answer does not fit the file", changed=differs)
                            abandoned = False
                            while True:
                                with guard:
                                    end = min(span[1], item[1])  # a free connection may have taken this range's tail
                                    abandoned = name not in mix or at != item[0] + item[2]
                                if abandoned or at > end:
                                    break
                                if stop.is_set():
                                    return  # another segment ended the run: this one stops where it is
                                block = response.read1(min(CHUNK, end - at + 1))
                                if not block:
                                    break
                                with guard:
                                    if name not in mix or at != item[0] + item[2]:
                                        # The source left, or the range's progress was cut back, while this block was
                                        # in flight: it is not written.
                                        abandoned = True
                                        block = b""
                                    block = block[:max(0, item[1] - at + 1)]  # never past this range's current end
                                    if block:
                                        # The floor with this write counted, one writer at a time: the partial is
                                        # sparse, so each write takes space, and no two ranges can pass one check.
                                        if shutil.disk_usage(partial_dir).free - len(block) < min_free:
                                            raise Refused("incomplete: the disk fell under its free-space floor; the partial file is kept")
                                        view = memoryview(block)
                                        while view:  # pwrite may write less than asked (a nearly full disk)
                                            view = view[os.pwrite(fd, view, at + len(block) - len(view)):]
                                        if source not in state["sources"]:
                                            state["sources"].append(source)
                                        if prov is not None:
                                            index = state["sources"].index(source)
                                            tail = ends.pop(at - 1, None)
                                            if tail is not None and tail[2] == index:
                                                tail[1] = at + len(block) - 1
                                                ends[tail[1]] = tail
                                            else:
                                                if tail is not None:
                                                    ends[at - 1] = tail
                                                fresh = [at, at + len(block) - 1, index]
                                                prov.append(fresh)
                                                ends[fresh[1]] = fresh
                                        at += len(block)
                                        item[2] = at - item[0]
                                        fails[source] = 0
                                        counted["since"] += len(block)
                                        counted["run"] += len(block)
                                    due = counted["since"] >= STATE_EVERY
                                if block:
                                    progressed = True
                                    got += len(block)
                                    watch.bytes += len(block)
                                if abandoned:
                                    break
                                if due:
                                    wake()  # the hasher's thread saves it, so this connection never waits on a flush
                            if abandoned:
                                continue  # the source left or the range was cut back: the next request is chosen afresh
                            with guard:
                                end = min(span[1], item[1])
                            if at <= end:
                                # A valid shorter answer is progress; one that stopped early is a failure.
                                failed("slower than the rate floor" if watch.tripped else "a segment ended early",
                                       progressed=progressed and not watch.tripped, source=source, item=item)
                            elif span[1] - span[0] + 1 < SHORT_ANSWER and last - span[0] + 1 >= 2 * SHORT_ANSWER:
                                # Valid, but tiny when more was asked: progress a hostile host could stretch forever.
                                failed(f"a range answer of {span[1] - span[0] + 1} bytes when more was asked",
                                       progressed=True, source=source, item=item)
                        finally:
                            connection.close()
                    except _Route as error:
                        if not leave(source, error, route=True):
                            return
                    except _Misfit as error:
                        if not leave(source, error, changed_file=error.changed):
                            return
                    except Refused as error:
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
                                   else f"a segment broke off ({error.__class__.__name__})",
                                   progressed=progressed and not watch.tripped, source=source, item=item)
                        except Refused as spent:
                            errors.append(spent)
                            stop.set()
                            return
                    finally:
                        watch.__exit__()
                        with guard:
                            busy[source] -= 1
                            reading.pop(id(item), None)
                            elapsed = time.monotonic() - began
                            if got:
                                speed[source] = got / max(elapsed, 0.001)

            def left(item: list) -> float:
                """Seconds of this range still to come at its own pace; 0 when its pace is not yet known."""
                began, then = pace.get(id(item), (0.0, item[2]))
                elapsed = time.monotonic() - began
                if not began or elapsed < 0.25:
                    return 0.0
                rate = (item[2] - then) / elapsed
                return float("inf") if rate <= 0 else rest(item) / rate

            def claim() -> list | None:
                """The next range for a free connection: an untaken one, or else the second half of the range with the
                longest still to come (it stops at the new end, in the same step the new range is made, so the taken
                tail starts at once and no byte has two writers), read from the fastest source."""
                with guard:
                    for item in state["segments"]:
                        if id(item) not in taken and id(item) not in parked and rest(item) > 0:
                            taken.add(id(item))
                            working.add(id(item))
                            return item
                    # A range about to finish is left alone: splitting it would only throw away bytes on their way.
                    busy_ranges = [item for item in state["segments"]
                                   if id(item) in taken and id(item) not in parked and rest(item) >= 2 * MIN_SPLIT
                                   and left(item) >= SPLIT_AFTER]
                    if not busy_ranges or len(state["segments"]) >= MAX_RANGES:
                        return None
                    widest = max(busy_ranges, key=left)
                    middle = widest[0] + widest[2] + rest(widest) // 2
                    tail = [middle, widest[1], 0]
                    widest[1] = middle - 1
                    state["segments"].insert(state["segments"].index(widest) + 1, tail)
                    taken.add(id(tail))
                    working.add(id(tail))
                    owner[id(tail)] = fastest() or owner.get(id(widest))
                    return tail

            def worker():
                try:
                    attempt_work()
                finally:
                    with guard:
                        running["workers"] -= 1
                    wake()

            def attempt_work():
                # Any failure ends the run with a reason, never a range left claimed while the others wait on it.
                try:
                    work()
                except (Refused, _Misfit) as error:
                    errors.append(error)
                    stop.set()
                except Exception as error:
                    errors.append(Refused(f"incomplete: a range failed unexpectedly ({error.__class__.__name__}); the partial file is kept"))
                    stop.set()

            def work():
                while not stop.is_set():
                    item = claim()
                    if item is None:
                        # Nothing to take now; a range still being read may become worth splitting in a moment, or
                        # end: either rings `changed` (checked under it, so no ring is missed).
                        with changed:
                            with guard:
                                unfinished = any(rest(item) > 0 for item in state["segments"])
                            if not unfinished or stop.is_set():
                                return
                            changed.wait(IDLE_WAIT)
                        continue
                    run(item)
                    wake()

            def frontier_held() -> int:
                # The end of the unbroken run of written bytes from the start of the file; `guard` is held.
                for item in state["segments"]:
                    if rest(item) > 0:
                        return item[0] + item[2]
                return state["total"]

            def frontier() -> int:
                with guard:
                    return frontier_held()

            hashed = _InOrderDigest(kind, fd, guard, frontier_held)

            def hash_along():
                # The digest is computed in file order as the leading ranges fill, read back from the file, so only
                # the last stretch is left to hash when the transfer ends (aria2c hashes the whole file after it).
                try:
                    while not stop.is_set():
                        hashed.hash_up_to(frontier())
                        with guard:
                            due = counted["since"] >= STATE_EVERY
                            if due:
                                counted["since"] = 0
                        if due:
                            save_or_stop()
                        with changed:
                            with guard:
                                if running["workers"] == 0:
                                    break
                                if counted["since"] >= STATE_EVERY:
                                    continue  # more came while saving: save again before waiting
                            changed.wait(HASH_WAIT)
                except OSError:
                    hashed.failed = True  # the whole-file pass after the transfer judges it instead

            try:
                threads = [threading.Thread(target=worker, daemon=True) for _ in range(count)]
                running["workers"] = len(threads)
                for thread in threads:
                    thread.start()
                along = threading.Thread(target=hash_along, daemon=True)
                along.start()
                try:
                    for thread in threads:
                        thread.join()
                    along.join()
                except BaseException:
                    # Interrupted (Ctrl-C in a caller that goes on): every range stops and is waited for before the
                    # shared descriptor closes, so none writes or saves after this call returns.
                    stop.set()
                    wake()
                    for thread in (*threads, along):
                        thread.join()
                    raise
                if not errors and not hashed.failed and frontier() == state["total"]:
                    try:
                        hashed.hash_up_to(state["total"])
                        if hashed.at == state["total"]:
                            streamed["digest"] = hashed.hash.hexdigest()
                    except OSError:
                        pass  # the whole-file pass after the transfer judges it instead
                try:
                    save()
                except OSError as error:
                    raise Refused(f"incomplete: the download state could not be written ({error.strerror}); the partial file is kept") from error
            finally:
                os.close(fd)
                fetched += counted["run"]
            misfit = next((error for error in errors if isinstance(error, _Misfit)), None)
            if misfit is not None:
                # No source is left that the ranges can be trusted from: it starts again on the one stream.
                one_stream = True
                restart(str(misfit))
                return "again"
            final = next((error for error in errors if "attempts failed" in str(error) or "disk" in str(error)), None)
            if final is not None:
                raise final
            route = next((error for error in errors if isinstance(error, _Route)), None)
            if route is not None:
                drop(route, getattr(route, "source", None))  # the ranges done stay: the next URL resumes them
                return "again"
            if errors:
                raise errors[0]
            return "done" if all(item[0] + item[2] > item[1] for item in state["segments"]) else "again"

        trial_path = partial_dir / f"{target.name}.trial"

        def trial(candidate: str, total: int) -> str:
            """One whole-file download from `candidate` alone, into a temporary file of its own and checked against the
            published digest, so no other source's bytes can be in it. "verified" (the file is now the partial),
            "wrong" (this source gives other bytes), "failed" (a counted failure: it may be asked again), "unusable" (it
            answers, but not with this whole file: another status, length or coding) or "skip" (its route is refused)."""
            nonlocal fetched
            room(total)
            cool(candidate)
            watch = _Watchdog(min_rate, rate_window).__enter__()
            try:
                try:
                    connection, response, _ = _request(candidate, {}, timeout, allow_loopback, watch, ca_file=ca_file)
                except _Route as error:
                    drop(error, candidate)
                    return "skip"
                except _Retry as error:
                    pause = charge("slower than the rate floor" if watch.tripped else str(error), stay=True)
                    sleep(pause)
                    return "failed"
                try:
                    code = response.status
                    if code == 429 or code >= 500:
                        pause = charge(f"HTTP {code}", _retry_after(response.getheader("Retry-After")), stay=True,
                                       source=candidate)
                        sleep(pause)
                        cooldown.pop(candidate, None)  # waited out here
                        return "failed"
                    encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                    if code != 200 or _count(response.getheader("Content-Length")) != total or encoding != "identity":
                        log(f"fetch: {candidate} does not give the whole file this download is of")
                        return "unusable"
                    hash_, got, base = hashlib.new(kind), 0, _folder_bytes(source)
                    try:
                        with trial_path.open("wb") as handle:
                            while True:
                                block = response.read1(CHUNK)
                                if not block:
                                    break
                                got += len(block)
                                fetched += len(block)
                                watch.bytes += len(block)
                                if got > total:
                                    raise Refused("refused: the server sent more than it said")
                                if base + got > source_limit:
                                    raise Refused(f"refused: {source} would pass its limit of {source_limit} bytes")
                                if shutil.disk_usage(partial_dir).free - len(block) < min_free:
                                    raise Refused("incomplete: the disk fell under its free-space floor; the partial file is kept")
                                handle.write(block)
                                hash_.update(block)
                            handle.flush()
                            os.fsync(handle.fileno())
                    except (OSError, http.client.HTTPException) as error:
                        if getattr(error, "errno", None) == errno.ENOSPC:
                            raise Refused("incomplete: the disk is full") from error
                        sleep(charge("slower than the rate floor" if watch.tripped else f"the transfer broke off ({error.__class__.__name__})",
                                     progressed=got > 0 and not watch.tripped, stay=True))
                        return "failed"
                    if watch.tripped or got < total:
                        sleep(charge("slower than the rate floor" if watch.tripped else f"the body ended at {got} of {total} bytes",
                                     stay=True))
                        return "failed"
                    if hash_.hexdigest() != want:
                        return "wrong"
                    os.replace(trial_path, partial)
                    return "verified"
                finally:
                    connection.close()
            finally:
                watch.__exit__()
                trial_path.unlink(missing_ok=True)

        def recover() -> bool:
            """The search a mixed-source digest failure starts: each candidate source, one at a time, downloaded whole on
            its own (`trial`). The one whose bytes verify is published and every one whose bytes do not is ruled out. The
            candidates, and the sources ruled out so far, are kept in the state, so a fresh process goes on from there
            and never asks a ruled-out source again. True when a trial verified; False when every candidate is spent
            (the other live URLs then start the file again, whole, under their own representation)."""
            nonlocal state
            recovery = state["recovery"]
            queue = [name for name in recovery["candidates"] if name in live and name not in excluded]
            while queue:
                candidate = queue.pop(0)
                result = trial(candidate, state["total"])
                if result == "verified":
                    state = {"url": url, "expected": [kind, want], "validator": state.get("validator"),
                             "encoding": state.get("encoding"), "total": state["total"], "sources": [candidate]}
                    log(f"fetch: {candidate} gives bytes that verify; published")
                    return True
                if result == "failed":
                    queue.append(candidate)  # the budget bounds how often
                elif result in ("wrong", "unusable", "skip"):
                    # A source whose bytes do not match, or that gives no whole file to check (another status, length
                    # or coding, or a refused route), is ruled out and the outcome saved: it is never asked again, so a
                    # server that corrupts ranges and refuses whole files cannot send the run round again.
                    exclude(candidate)
                    write_state()
                    if candidate in live:
                        live.remove(candidate)
                    where["at"] = where["at"] % len(live) if live else 0
                    why = "gives bytes that do not match" if result == "wrong" else "gives no whole file to check"
                    log(f"fetch: {candidate} {why}; ruled out ({len(live)} URLs left)")
            partial.unlink(missing_ok=True)
            if live:
                forget()  # the other URLs start the file again, keeping the exclusions
            else:
                state_file.unlink(missing_ok=True)
            state = {}
            if not live:
                raise Refused(f"refused: the {kind} does not match the published one and no URL is left to ask; the partial file is removed")
            return False

        found = None
        while True:
            if state.get("recovery"):
                if recover():
                    found = want
                    break
                continue
            while True:
                step = segmented()
                if step == "done":
                    break
                if step == "again":
                    continue
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
                cool(here())
                watch = _Watchdog(min_rate, rate_window).__enter__()
                try:
                    connection, response, final_url = _request(here(), headers, timeout, allow_loopback, watch,
                                                               ca_file=ca_file)
                except _Route as error:
                    watch.__exit__()
                    drop(error)
                    continue
                except _Retry as error:
                    watch.__exit__()
                    spend("slower than the rate floor" if watch.tripped else str(error))
                    continue
                try:
                    code = response.status
                    if code == 416:
                        unsatisfied = response.getheader("Content-Range") or ""
                        whole = re.fullmatch(r"bytes \*/(\d{1,19})", unsatisfied)  # bounded, as every header count
                        if have and whole and int(whole.group(1)) == have:
                            state["total"] = have
                            break
                        restart("the server's range does not fit the partial file")
                        continue
                    if code == 429 or code >= 500:
                        spend(f"HTTP {code}", _retry_after(response.getheader("Retry-After")))
                        continue
                    if code not in (200, 206):
                        drop(_Route(f"refused: HTTP {code}"))  # this URL does not serve the file; the next may
                        continue
                    encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                    length = response.getheader("Content-Length")
                    if code == 206:
                        span = _content_range(response.getheader("Content-Range"))
                        same = _same_representation(response.headers, state.get("validator")) and encoding == state.get("encoding")
                        fits = (
                            span is not None
                            and span[0] == have
                            and state.get("total") in (None, span[2])
                            and (length is None or _count(length) == span[1] - span[0] + 1)
                        )
                        if not (same and fits):
                            restart("the server's range or validator does not match the partial file")
                            continue
                        body = span[1] - span[0] + 1
                        state["total"] = span[2]
                        state.setdefault("sources", [])  # this URL is added once it supplies a byte that is kept
                        mode = "ab"
                        resumed = True
                    else:
                        body = _count(length)
                        # The partial this answer replaces is counted once: it is truncated before the body arrives.
                        room(max((body or 0) - have, 0))
                        # Truncate first, then record the new answer: old bytes never sit under the new validator.
                        with partial.open("wb") as handle:
                            os.fsync(handle.fileno())
                        state = {"url": url, "expected": [kind, want], "validator": _validator(response.headers),
                                 "encoding": encoding, "total": body, "final_url": final_url, "sources": []}
                        write_state()
                        have = 0
                        mode = "ab"
                        resumed = False
                    got = 0
                    supplier = here()
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
                                if supplier not in state["sources"]:
                                    # The file now holds this URL's bytes: named only from the first byte it gave, so a
                                    # source that answered and sent nothing is not one that supplied the file.
                                    handle.flush()
                                    state["sources"].append(supplier)
                                    write_state()
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
                        spend("slower than the rate floor" if watch.tripped else f"the transfer broke off ({error.__class__.__name__})",
                              progressed=got > 0 and not watch.tripped)
                        continue
                    except _Retry as error:
                        spend(str(error))
                        continue
                    if watch.tripped:
                        # The watchdog shut the socket: an end it caused is not the end of the file.
                        spend("slower than the rate floor")
                        continue
                    if body is not None and got < body:
                        spend(f"the body ended at {got} of {body} bytes", progressed=got > 0)
                        continue
                    if state.get("total") is None:
                        state["total"] = have + got  # no length given: whatever arrived whole is what the digest will judge
                        write_state()
                    # A valid shorter range is progress, not a failure: the loop asks for the next one. A tiny one when
                    # more was asked spends an attempt, so a host answering a byte at a time cannot go on forever.
                    if (code == 206 and body is not None and body < SHORT_ANSWER
                            and (state.get("total") or 0) - have >= 2 * SHORT_ANSWER):
                        spend(f"a range answer of {body} bytes when more was asked", progressed=True)
                finally:
                    watch.__exit__()
                    connection.close()

            try:
                found = streamed.pop("digest", None) or _digest(partial, kind)
            except OSError as error:
                raise Refused(f"incomplete: the partial file could not be read ({error.strerror}); it is kept") from error
            if found != want:
                partial.unlink(missing_ok=True)
                mismatch = Refused(f"refused: the {kind} does not match the published one; the partial file is removed")
                suppliers = contributors()
                kept = {key: state.get(key) for key in ("validator", "encoding", "total")}
                state = {}
                one_stream = segments == 1
                if len(suppliers) == 1 or (len(live) == 1 and len(suppliers) < 2):
                    # The file was one URL's bytes alone (or one URL is all there is and nothing says another wrote
                    # any of it): it serves other bytes, and is ruled out; with no other URL left, that is the answer.
                    # Bytes from several URLs stay a mixed file even when only one of them is live now: a source
                    # dropped mid-run (a 404) may be the one that served the bad bytes, and the one left may be good.
                    if len(live) > 1:
                        exclude(suppliers[0])
                        forget()
                    else:
                        state_file.unlink(missing_ok=True)
                    drop(mismatch, suppliers[0] if len(suppliers) == 1 else None)
                else:
                    # Bytes from several URLs (or from a run that did not record them): no one URL can be blamed. Each
                    # source that agreed on the file is tried alone, whole, into a file of its own (`recover`).
                    known = {*suppliers, *agreed}
                    candidates = [name for name in dict.fromkeys([url, *mirrors]) if name in live and name in known]
                    state = {"url": url, "expected": [kind, want], **kept, "sources": [],
                             "recovery": {"candidates": candidates or list(live), "ruled_out": list(excluded)}}
                    write_state()
                    log(f"fetch: the {kind} does not match and the bytes came from {len(suppliers) or 'unrecorded'} URLs; "
                        "trying each source alone")
                continue
            break
        supplied = contributors() or [here()]
        sha256 = found if kind == "sha256" else _digest(partial, "sha256")
        try:
            with partial.open("rb") as handle:
                os.fsync(handle.fileno())
            os.replace(partial, target)
        except OSError as error:
            raise Refused(f"incomplete: the verified file could not be moved into place ({error.strerror}); a rerun moves it") from error
        try:
            _sync_dir(source)
        except OSError as error:
            # The verified file is in place under its name; only the folder's record of the move is not yet flushed.
            log(f"fetch: the folder could not be flushed after the move ({error.strerror}); the file is in place")
        try:
            state_file.unlink(missing_ok=True)
        except OSError:
            pass  # the file is in place and verified; a stale state file beside no partial is ignored by the next run
        return outcome("fetched", sha256=sha256, resumed=resumed, url=supplied[0], urls=supplied)
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
    parser.add_argument("--mirror", action="append", default=[],
                        help="another URL for the same file; repeatable. Mirrors that agree on the file (same length and "
                             "strong validator) serve ranges together; a mirror that disagrees is the ordered fallback")
    parser.add_argument("--ca-file", help="a PEM file of extra certificate authorities to trust (verification stays on)")
    parser.add_argument("--allow-loopback", action="store_true", help="for the tests' local server only")
    args = parser.parse_args(argv)
    expected = ("sha256", (args.sha256 or "").lower()) if args.sha256 is not None else ("md5", (args.md5 or "").lower())
    try:
        line = fetch(args.url, args.dest, expected, source_limit=args.source_limit, min_free=args.min_free,
                     timeout=args.timeout, attempts=args.attempts, min_rate=args.min_rate, segments=args.segments,
                     segment_threshold=args.segment_threshold, mirrors=args.mirror, ca_file=args.ca_file,
                     allow_loopback=args.allow_loopback)
    except Refused as error:
        reason = str(error)
        # The same fields as a success, so a caller reads one shape; `fetched` is unknown on a failure.
        print(json.dumps({"status": reason.split(":")[0], "bytes": 0, "fetched": None, "sha256": None,
                          "resumed": False, "url": None, "urls": [], "reason": reason}))
        return 1
    print(json.dumps(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())
