"""One dataset file, downloaded so an interruption resumes and nothing unverified is accepted (D03 T04 §16).

    python3 <repo>/scripts/glimmer/fetch.py --url URL --dest SOURCE/NAME (--sha256 HEX | --md5 HEX | --pin IMMUTABLE_REF)
        [--source-limit BYTES] [--min-free BYTES] [--timeout 30] [--attempts 3] [--min-rate BYTES_PER_SECOND]
        [--segments 0..4] [--segment-threshold BYTES] [--mirror URL ...]
    python3 <repo>/scripts/glimmer/fetch.py --manifest FILE [the same options, but none of --url, --dest, --sha256,
        --md5, --pin or --mirror]

Run from the store's `raw/` folder, as the collection brief's collector runs. The bytes go to
`SOURCE/.partial/NAME`, with `NAME.state.json` beside them (the URL, the published digest and the first answer's
validator, written temp-then-rename and synced), and move to `SOURCE/NAME` by an atomic rename only once the whole
file's digest matches the published one (SHA-256, or the MD5 a dataset such as a Zenodo record publishes instead), and
that digest is of the very file renamed: a file renamed over the partial's name after the check is taken back out and
nothing is published. A file already in place whose digest matches is reported `present` and not fetched again, so a rerun of a multi-file
source reuses what it finished. A supported immutable GitHub/Hugging Face artifact can instead use --pin: its first complete SHA-256 is durably recorded in .download-pins/ before publication and governs every later fetch. Other sources without a published digest are refused.

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

A fresh download's first request is `GET Range: bytes=0-(N-1)` (D03 T04 §23; N is a quarter of the segment threshold,
at least 128 KiB), as aria2c's is, and its answer is read, not asked again. A valid `206` from byte 0 that gives the
total length (`Content-Range`), a strong validator and no content coding answers for the `HEAD`, which is then not
sent: the file qualifies on it (a length of at least the threshold), and its bytes are the first bytes of the first
range, or of the one stream when it does not qualify. Only where that answer cannot answer for it is the `HEAD` asked,
once the first range has answered: a `200` (the range ignored), a `206` with no strong validator or no total, another
answer, or a failure (a failure asked to wait with `Retry-After` is waited out first, unless other sources answered,
when this one sits out the round). A first range whose route is refused rules its URL out, with no `HEAD`. Every
mirror is still asked a `HEAD` beside the first range, and serves ranges only when it gives the same length and strong
validator as the first source's answer. When the `HEAD` is asked, its answer decides as before: a `200` is the whole
stream from byte 0, never mixed with ranges, unless other sources agree on the file, when this one only leaves the mix;
a `HEAD` that disagrees on length or validator adopts nothing; a failed first range is blamed as any request is, with
its `Retry-After`. A partial file or a saved state sends no first range. The adopted bytes are written and recorded as
any range's are.

`--manifest FILE` (D03 T04 §23) downloads every file a source lists in one process, several at once, so the interpreter
starts once a source rather than once a file. The manifest is JSON Lines, one object a file: `url`, `dest`
(SOURCE/NAME), one of `sha256` or `md5`, an optional `mirrors` list, and optionally any of `source_limit`, `min_free`,
`timeout`, `attempts`, `min_rate`, `segments` and `segment_threshold`. Precedence: a line's own value, then the command
line's, then the default; `--ca-file` and `--allow-loopback` hold for the whole run and are never read from a line, and
`--url`, `--dest`, `--sha256`, `--md5` and `--mirror` are refused beside `--manifest` (a file's own URLs, digest and
mirrors come from its line). Blank lines are skipped. A manifest that cannot be read, lists no file, has a line that is
not a JSON object, carries an unknown key or a value of the wrong type, lacks `url` or `dest`, has both digests or
neither or one that is not hex of its length, or names a destination an earlier line named or one whose download would
write another line's working file (its partial, state, the state's temporary file or trial, or the lock: `src/a.bin` and
`src/a.bin.state.json` collide, as the second's partial is the first's state), is refused before anything is fetched:
one message on standard error naming the line, nothing on standard output, exit 2. Otherwise each file is fetched
exactly as its own run would be (the same rules, state, resume, digest and refusals; a malformed URL is that file's
refusal line, never the batch's end) and its JSON line, the same
shape as a single run's, is printed once it and every line before it are done, one a file in the manifest's order; a
failed file does not stop the others. The exit is 0 only when every file is in place (`fetched` or `present`), and 1
when any is not (its line says why: `refused` or `incomplete`). A batch run again (after a kill, or a failure) reports a
file already in place and verified `present` without fetching it (a file a killed batch finished behind one still
running had no line yet), resumes a partial from its own state, and fetches the rest. The files share the run's four
connections (`_Budget`): every HEAD, first range, range and stream holds a place, and a connection kept open between
requests holds one too. Files start in the manifest's order as places free up; a file takes a second place only when no
other file waits for one (one place: a fresh file of one URL sends its first range alone, which answers for its HEAD
where it can, and reads one range), so a source of small files
runs one connection a file, and a file left alone splits into ranges as a single run does. A connection read whole and
left open carries the next request to the same origin, from any file (`_POOL`), so no request opens a connection to a
host while one kept open to it waits idle. The files of one source share its lock and count the bytes the others have
reserved (`_Ledger`), and a file reserves only once every earlier file has, so when a source's limit or the free-space
floor binds, the earlier file gets the room, as one file after another would; a single run keeps nothing and runs alone,
as before.
"""

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
import socket
import ssl
import stat
import sys
import threading
import time
import urllib.parse
from pathlib import Path

CHUNK = 64 * 1024
SEGMENT_THRESHOLD = 64 * 1024 * 1024
MIN_SPLIT = 2 * 1024 * 1024  # the least a range's rest must hold for a free connection to take half of it
MAX_RANGES = 64
CONNECTIONS = 4  # the most connections a run holds open at once, its HEADs and transfers (a batch's files) together
SHORT_ANSWER = 64 * 1024  # a range answer under this, when at least twice it was asked, spends an attempt (one-byte answers)
IDLE_WAIT = 0.25  # the longest an idle connection waits before looking for work again, when nothing rings it
HASH_WAIT = 0.05  # the longest the hasher waits before reading on, when nothing rings it
SPLIT_AFTER = 1.0  # a range is split only when its own pace says at least this many seconds of it are left
STATE_EVERY = 1024 * 1024  # progress saved after each MiB, by the hasher's thread: a killed run loses about that
SAVE_EVERY = 1.0  # and at least this often (seconds) while any is unsaved, so a stalled transfer loses none (aria2c: 1 s)
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


class _Closing:
    """A connection whose `close()` also closes its last response. `http.client` hands the socket to a response that
    will close the connection (`Connection: close`, no length) and forgets it, so closing the connection alone would
    leave the socket open until the response is collected; a place in the batch's budget (`_Budget`) is given back
    only once the socket is shut."""

    _answer = None

    def getresponse(self):
        self._answer = super().getresponse()
        return self._answer

    def close(self):
        super().close()
        answer, self._answer = self._answer, None
        if answer is not None:
            answer.close()


def _connect(url: str, timeout: float, allow_loopback: bool, watch=None, ca_file: str | None = None):
    """A connection pinned to the vetted address: the name is resolved once, here, and never again by the library."""
    parts = urllib.parse.urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    address = _vetted(parts.hostname or "", port, allow_loopback)
    if parts.scheme == "https":
        context = _tls_context(ca_file)

        class Pinned(_Closing, http.client.HTTPSConnection):
            def connect(self):
                raw = socket.create_connection((address, port), timeout)
                # Wrapping detaches the plain socket (its descriptor moves to the TLS one), so the watchdog holds the
                # TLS socket, from before the handshake: shutting the detached one would cut nothing.
                tls = context.wrap_socket(raw, server_hostname=parts.hostname, do_handshake_on_connect=False)
                if watch is not None:
                    watch.sock = tls
                try:
                    tls.do_handshake()
                except BaseException:
                    tls.close()
                    raise
                self.sock = tls

        return Pinned(parts.hostname, port, timeout=timeout, context=context)

    class PinnedPlain(_Closing, http.client.HTTPConnection):
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


def _origin(url: str):
    """The origin a kept connection is matched by, or None for a URL that has none (a malformed port, a broken IPv6
    host): such a URL matches no kept link, and its own request refuses it (`_split_url`), as a single run does."""
    try:
        parts = _split_url(url)
    except _Route:
        return None
    return parts.scheme, (parts.hostname or "").lower(), parts.port or (443 if parts.scheme == "https" else 80)


def _split_url(url: str):
    """`url` read as every request reads it, or `_Route` refusing a form no request can be sent to (a malformed port or
    host, a scheme other than https or http, no host, or a character an HTTP request line cannot carry: a raw non-ASCII
    letter, a space or a control character, which must be percent-encoded first)."""
    if not url.isascii() or any(ch.isspace() or ord(ch) < 0x20 or ord(ch) == 0x7F for ch in url):
        raise _Route("refused: a URL holding a character a request cannot carry (percent-encode it)")
    try:
        parts = urllib.parse.urlsplit(url)
        parts.port  # noqa: B018 (a malformed port raises here, before anything connects)
    except ValueError as error:
        raise _Route(f"refused: a malformed URL ({error})") from error
    if parts.scheme not in ("https", "http") or not parts.hostname:
        raise _Route(f"refused: {parts.scheme or 'no'} scheme")
    return parts


class _Pool:
    """Kept-alive connections handed from one file of a `--manifest` batch to the next (D03 T04 §23), as aria2c carries
    its connections from file to file. A range connection read whole and left open at the end of a file is kept here
    instead of closed, and the next file's first requests to the same origin go on it, so a host that keeps a request
    open until the pace of its last piece is paid never sees the next file's requests beside the last file's (five
    open at once, measured). At most `CONNECTIONS` are kept; a file closes the kept links to every origin it does not
    use before it starts, so idle links never add to its four. Off outside a batch: a single run never keeps or takes
    one."""

    def __init__(self):
        self.lock = threading.Lock()
        self.links: list = []  # (origin, connection, socket), oldest first
        self.enabled = False
        self.changed = None  # the batch's budget, told when a kept link is taken (one place fewer in use)

    def put(self, url: str, connection, sock) -> bool:
        with self.lock:
            return self._put(url, connection, sock)

    def _put(self, url: str, connection, sock) -> bool:
        return self._keep((_origin(url), connection, sock))

    def _keep(self, link) -> bool:
        if not self.enabled or len(self.links) >= CONNECTIONS:
            return False
        self.links.append(link)
        return True

    def take(self, url: str):
        if not self.enabled:
            return None
        with self.lock:
            link = self._take(url)
            if link is not None and self.changed is not None:
                self.changed.notify_all()
            return link

    def _take(self, url: str):
        wanted = _origin(url)
        if wanted is None:
            return None  # a URL with no origin: no kept link is its own
        for number, (origin, connection, sock) in enumerate(self.links):
            if origin == wanted:
                del self.links[number]
                return connection, sock
        return None

    def keep_only(self, urls) -> None:
        """Every kept link to an origin none of `urls` names closed; `urls` empty closes them all."""
        wanted = {_origin(url) for url in urls}
        with self.lock:
            gone = [link for link in self.links if link[0] not in wanted]
            self.links = [link for link in self.links if link[0] in wanted]
            if gone and self.changed is not None:
                self.changed.notify_all()
        for _, connection, _ in gone:
            connection.close()


_POOL = _Pool()


class _Place:
    """One of a batch's `CONNECTIONS` places, held by whoever has a connection open or is about to open one. `link`, a
    kept connection to one origin, is the connection this place already has: the first request to that origin goes on
    it (`_request`). Given back with `release()` (a link it still carries is kept, still holding the place) or turned
    into a kept connection with `keep()`."""

    __slots__ = ("budget", "link")

    def __init__(self, budget, link=None):
        self.budget, self.link = budget, link

    def keep(self, url: str, connection, sock) -> None:
        """The place goes on as a kept connection (`_POOL`) that the next request to its origin takes, from any file."""
        try:
            self.link = (_origin(url), connection, sock)
        finally:
            self.release()  # given back however the link is made: a place is never left counted held by no one

    def release(self) -> None:
        budget, self.budget = self.budget, None
        if budget is None:
            return  # given back already
        with budget.cond:
            link, self.link = self.link, None
            # Kept before the place is counted free, so the count never runs below what is open.
            kept = link is not None and budget.pool._keep(link)
            budget.held -= 1
            budget.cond.notify_all()
        if link is not None and not kept:
            link[1].close()


class _Budget:
    """The connections a `--manifest` batch holds open at once, at most `CONNECTIONS` across every file it fetches
    together (D03 T04 §23), counted as places: each HEAD, first range, range worker, one stream and trial holds one
    while it has a connection open or is about to open one, and each connection kept between requests (`_POOL`) holds
    one. A taker that finds none free takes a kept link to its own origin (so the request goes on it, never on a new
    connection beside it), else closes a kept link to another origin, else waits its turn. An extra place (a file's
    second connection and beyond) is only ever taken when free, with no one waiting and no file of the batch left to
    start: a file's first connection comes before another's extra one. Off outside a batch."""

    def __init__(self, pool: _Pool):
        self.pool = pool
        self.cond = threading.Condition(pool.lock)
        pool.changed = self.cond
        self.enabled = False
        self.held = 0  # places held by takers; kept links are counted by the pool's length
        self.queue: list = []  # the takers waiting, in the order they came
        self.unstarted = 0  # files of the batch not started yet: no extra place is taken from them
        self.bells: set = set()  # rung when a taker starts waiting, so an idle range worker gives its place up

    def wanted(self) -> bool:
        """Some file waits for a place (read without the lock: a stale answer only delays a give-back by one wait)."""
        return bool(self.queue) or self.unstarted > 0

    def _grant(self, url: str | None):
        if url is not None:
            link = self.pool._take(url)
            if link is not None:
                self.held += 1
                return _Place(self, (_origin(url), *link))
        if self.held + len(self.pool.links) < CONNECTIONS:
            self.held += 1
            return _Place(self)
        if self.pool.links:
            _, connection, _ = self.pool.links.pop(0)  # the oldest kept link, to another origin
            connection.close()
            self.held += 1
            return _Place(self)
        return None

    def take(self, url: str | None = None, wait: bool = True, extra: bool = False):
        """A place, preferably one carrying a kept link to `url`'s origin. `wait` false: None when none is free now.
        `extra`: only from what no other file wants, never waiting."""
        with self.cond:
            if extra:
                return None if self.queue or self.unstarted else self._grant(url)
            ticket = object()
            try:
                while True:
                    if not self.queue or self.queue[0] is ticket:
                        place = self._grant(url)
                        if place is not None:
                            return place
                    if not wait:
                        return None
                    if ticket not in self.queue:
                        self.queue.append(ticket)
                        for bell in list(self.bells):
                            bell()
                    self.cond.wait()
            finally:
                if ticket in self.queue:
                    self.queue.remove(ticket)
                    self.cond.notify_all()


_BUDGET = _Budget(_POOL)


class _Share:
    """The places one file of a batch holds (D03 T04 §23): the one it started with, and any extra it took. A file holds
    one from its start until it has reserved its bytes (`_Ledger`), so a file the later ones wait for can always go on.
    Places are lent to the requests that use them (`pop_*`, `take_extra`) and come back (`push`), or leave as a kept
    connection (`keep`) or freed (`drop`); once it holds none, the file no longer holds the files after it back
    (`settle`). Every place lent is in `out` until it comes back or leaves, so each is counted once at every moment: a
    place given back twice is pushed once, and a file that ends with any still out has leaked one (the tests check)."""

    def __init__(self, place: _Place, settle):
        self.lock = threading.Lock()
        self.places = [place]
        self.out: set = set()  # the places lent: to a request, or to an open answer or a worker that holds one for it
        self.settle = settle

    def __len__(self) -> int:
        with self.lock:
            return len(self.places)

    def ensure(self, url: str) -> None:
        """At least one place, waiting its turn for it when the file holds none."""
        with self.lock:
            if self.places:
                return
        self.push(_BUDGET.take(url), lent=False)

    def extra(self, url: str) -> bool:
        place = _BUDGET.take(url, extra=True)
        if place is not None:
            self.push(place, lent=False)
        return place is not None

    def pop_if_any(self) -> _Place | None:
        """A place for a request, one carrying a kept link first (its connection is open already); None when none."""
        with self.lock:
            if not self.places:
                return None
            linked = [place for place in self.places if place.link is not None]
            place = linked[0] if linked else self.places[-1]
            self.places.remove(place)
            self.out.add(place)
            return place

    def take_extra(self, url: str) -> _Place | None:
        """An extra place lent straight to a request, or None while another file wants one."""
        place = _BUDGET.take(url, extra=True)
        if place is not None:
            with self.lock:
                self.out.add(place)
        return place

    def pop_all(self) -> list:
        with self.lock:
            places, self.places = self.places, []
            self.out.update(places)
            return places

    def pop_or_take(self, url: str) -> _Place:
        with self.lock:
            if self.places:
                place = self.places.pop()
                self.out.add(place)
                return place
        place = _BUDGET.take(url)
        with self.lock:
            self.out.add(place)
        return place

    def push(self, place: _Place | None, lent: bool = True) -> None:
        """`place` back on hand. A lent place that is no longer out (given back already, kept or dropped) is not pushed
        again, so a `finally` that gives back what its section may have handed on already never counts it twice."""
        if place is None:
            return
        with self.lock:
            if lent:
                if place not in self.out:
                    return
                self.out.discard(place)
            self.places.append(place)

    def keep(self, place: _Place, url: str, connection, sock) -> None:
        try:
            place.keep(url, connection, sock)
        finally:
            self._gone(place)

    def drop(self, place: _Place) -> None:
        try:
            place.release()
        finally:
            self._gone(place)

    def _gone(self, place: _Place) -> None:
        with self.lock:
            self.out.discard(place)
            empty = not self.places and not self.out
        if empty:
            self.settle()

    def trim(self, keep: int) -> None:
        """All but `keep` of the places on hand given back (a carried link stays kept)."""
        with self.lock:
            gone, self.places = self.places[keep:], self.places[:keep]
            empty = not self.places and not self.out
        for place in gone:
            place.release()
        if empty:
            self.settle()


class _Ledger:
    """The files a batch fetches at once, for what a single run checks alone (D03 T04 §23): one lock a source folder
    for the whole process (`lock_source`), and the bytes each file has reserved, so a file's limit and free-space
    checks (`room`) count the bytes the others will still add. A file decides only once every earlier file of the
    manifest has reserved its bytes (or ended), so when a limit binds, the earlier file gets the room and the later
    one is refused, as one file after another would be."""

    def __init__(self):
        self.cond = threading.Condition()
        self.files: dict[int, dict] = {}  # manifest index -> {source, paths, target, settled}
        self.locks: dict = {}  # a source's `.partial` folder -> [the open lock file, files using it]

    def join(self, index: int) -> None:
        with self.cond:
            self.files[index] = {"source": None, "paths": (), "target": None, "settled": False}

    def leave(self, index: int) -> None:
        with self.cond:
            self.files.pop(index, None)
            self.cond.notify_all()

    def settle(self, index: int) -> None:
        with self.cond:
            if index in self.files:
                self.files[index]["settled"] = True
                self.cond.notify_all()

    def lock_source(self, partial_dir: Path) -> None:
        """The source's lock, taken once for every file of this batch in it; BlockingIOError when another process
        holds it."""
        key = partial_dir.resolve()
        with self.cond:
            if key in self.locks:
                self.locks[key][1] += 1
                return
            lock = (partial_dir / _LOCK_NAME).open("a")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                lock.close()
                raise
            self.locks[key] = [lock, 1]

    def unlock_source(self, partial_dir: Path) -> None:
        key = partial_dir.resolve()
        with self.cond:
            held = self.locks.get(key)
            if held is None:
                return
            held[1] -= 1
            if not held[1]:
                del self.locks[key]
                held[0].close()

    @staticmethod
    def _sizes(paths) -> tuple[int, int]:
        """The bytes `paths` hold (as the folder limit counts them) and the bytes they take on the disk."""
        size = used = 0
        for path in paths:
            try:
                stats = path.stat()
            except OSError:
                continue
            size += stats.st_size
            used += getattr(stats, "st_blocks", stats.st_size // 512) * 512
        return size, used

    def _others(self, index: int, source: Path) -> tuple[int, int]:
        """What the other files still to finish will add: to `source`'s folder, and to the disk; `cond` is held."""
        folder = disk = 0
        for number, entry in self.files.items():
            if number == index or entry["target"] is None:
                continue
            size, used = self._sizes(entry["paths"])
            disk += max(0, entry["target"] - used)
            if entry["source"] == source:
                folder += max(0, entry["target"] - size)
        return folder, disk

    def others_left(self, index: int, source: Path) -> int:
        with self.cond:
            return self._others(index, source.resolve())[0]

    def room(self, index: int, more: int, known: bool, source: Path, paths, limit: int, min_free: int,
             partial_dir: Path) -> None:
        """`room(more)` for the file at `index`, with what the other files reserved counted; a known `more` reserves it."""
        key = source.resolve()
        with self.cond:
            while any(number < index and not entry["settled"] for number, entry in self.files.items()):
                self.cond.wait()
            entry = self.files[index]
            entry["source"], entry["paths"] = key, tuple(paths)
            folder, disk = self._others(index, key)
            if _folder_bytes(source) + folder + more > limit:
                raise Refused(f"refused: {source} would pass its limit of {limit} bytes")
            if _free_space(partial_dir) - more - disk < min_free:
                raise Refused("incomplete: the disk would fall under its free-space floor; the partial file is kept")
            if known:
                entry["target"] = self._sizes(paths)[0] + more
                entry["settled"] = True
                self.cond.notify_all()


class _Turn:
    """One file's part in a batch: its place in the manifest, the batch's ledger and the places it holds."""

    def __init__(self, index: int, ledger: _Ledger, place: _Place):
        self.index, self.ledger = index, ledger
        self.share = _Share(place, lambda: ledger.settle(index))


def _request(url: str, headers: dict, timeout: float, allow_loopback: bool, watch: _Watchdog | None = None,
             method: str = "GET", ca_file: str | None = None, reuse=None, place: _Place | None = None, route_check=None):
    """The final response after at most 5 redirects, each hop checked, with the URL it came from. `reuse`, a
    (connection, socket) pair whose last answer from `url` was read whole, carries the first request instead of a new
    connection; one the server has closed meanwhile gives way to a new connection, as any HTTP client does. With no
    `reuse`, the kept link `place` carries (a batch's place, `_Budget`) or a link an earlier file of the batch kept to
    this origin (`_POOL`) carries it the same way; a carried link to another origin is closed first."""
    if place is not None and place.link is not None:
        origin, connection, sock = place.link
        place.link = None
        if reuse is None and origin == _origin(url):
            reuse = (connection, sock)
        else:
            connection.close()
    if reuse is None:
        reuse = _POOL.take(url)
    previous = None
    for _ in range(MAX_REDIRECTS + 1):
        parts = _split_url(url)
        if route_check is not None:
            route_check(previous, url)
        if parts.scheme == "http" and previous is not None and urllib.parse.urlsplit(previous).hostname != parts.hostname:
            raise _Route("refused: a redirect to plain http on another host")
        path = parts.path or "/"
        if parts.query:
            path += f"?{parts.query}"
        sent = {"User-Agent": "isitlegit-fetch/2", "Accept-Encoding": "identity", **headers}
        response = None
        if reuse is not None:
            connection, sock = reuse
            reuse = None
            if watch is not None:
                watch.sock = sock
            try:
                connection.request(method, path, headers=sent)
                response = connection.getresponse()
            except (OSError, http.client.HTTPException):
                connection.close()  # closed by the server since its last answer: a new connection below
                response = None
        if response is None:
            connection = _connect(url, timeout, allow_loopback, watch, ca_file)
        try:
            if response is None:
                connection.request(method, path, headers=sent)
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


def _digest(path, kind: str) -> str:
    """The digest of the file at `path`, or of an open binary file read from its first byte (the very file it is)."""
    hash_ = hashlib.new(kind)
    if not isinstance(path, Path):
        path.seek(0)
        for block in iter(lambda: path.read(1 << 20), b""):
            hash_.update(block)
        return hash_.hexdigest()
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


def _temporary(path: Path) -> Path:
    """The file `path` is written through before it is renamed into place (`_write_json_now`): this process's own."""
    return path.with_name(f"{path.name}.{os.getpid()}.tmp")


_LOCK_NAME = ".lock"  # a source's lock file, in its `.partial` folder: shared by every download into the source


def _working_paths(target: Path) -> dict:
    """Every file a download of `target` (SOURCE/NAME) writes besides `target` itself, by role: its partial, its state,
    the state's temporary file, its trial, and the source's lock (the one file two downloads share). A batch refuses a
    manifest whose files would write each other's (`_read_manifest`)."""
    partial_dir = target.parent / ".partial"
    state = partial_dir / f"{target.name}.state.json"
    return {"partial": partial_dir / target.name, "state": state, "state temporary": _temporary(state),
            "trial": partial_dir / f"{target.name}.trial", "lock": partial_dir / _LOCK_NAME}


def _write_json_now(path: Path, value: dict) -> None:
    temporary = _temporary(path)
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    _sync_dir(path.parent)


def _free_space(path: Path) -> int:
    """The bytes a non-privileged writer can still take on `path`'s filesystem (what `shutil.disk_usage(...).free`
    reports, without importing `shutil` and its compression modules on every download)."""
    if not hasattr(os, "statvfs"):  # Windows has no statvfs; shutil asks the system there
        import shutil

        return shutil.disk_usage(path).free
    stats = os.statvfs(path)
    return stats.f_bavail * stats.f_frsize


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
    """The bytes the files under `folder` hold. A file gone between the listing and its count (another file of a batch
    renaming its state into place, or publishing) holds none."""
    total = 0
    for path in folder.rglob("*") if folder.exists() else ():
        try:
            stats = path.stat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(stats.st_mode):
            total += stats.st_size
    return total


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


_PIN_HELPERS = None
_PIN_EVIDENCE_LOCK = threading.Lock()


def _pin_helpers():
    global _PIN_HELPERS
    if _PIN_HELPERS is None:
        import importlib.util
        parent = Path(__file__).resolve().parent
        path = parent / (".fetch-inputs.py" if Path(__file__).name == ".fetch.py" else "inputs.py")
        try:
            spec = importlib.util.spec_from_file_location("fetch_pin_inputs", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        except (OSError, ImportError, AttributeError):
            raise Refused("refused: the pinned-download validator is missing or unreadable") from None
        if not all(callable(getattr(module, name, None)) for name in ("pin_artifact", "pin_redirect", "read_pin_receipt", "mark_pin_mode", "save_pin_receipt")):
            raise Refused("refused: the pinned-download validator is incompatible")
        _PIN_HELPERS = module
    return _PIN_HELPERS


def fetch(url: str, dest: str, expected: tuple[str, str], *, source_limit: int = 5 * 10**9, min_free: int = 10 * 10**9,
          timeout: float = 30.0, attempts: int = 3, min_rate: float = 16 * 1024, rate_window: float = RATE_WINDOW,
          segments: int = 0, segment_threshold: int = SEGMENT_THRESHOLD, mirrors: tuple[str, ...] | list[str] = (),
          ca_file: str | None = None,
          allow_loopback: bool = False,
          writer=None, sleep=time.sleep, log=lambda line: print(line, file=sys.stderr), turn: _Turn | None = None) -> dict:
    """The file at `dest`, fetched or found in place. `expected` is (`sha256` or `md5`, its published hex). Raises
    `Refused`; the CLI turns that into a result line and a non-zero exit. `turn`: this file's part in a `--manifest`
    batch (its places in the batch's connection budget and its ledger entry); None for a single run."""
    share = turn.share if turn is not None else None
    kind, want = expected
    pin, pin_api, artifact = None, None, None
    state_expected = [kind, want]
    if kind == "pin":
        pin, pin_api = want, _pin_helpers()
        try:
            artifact = pin_api.pin_artifact(pin, url)
            if any(pin_api.pin_artifact(pin, mirror) != artifact for mirror in mirrors):
                raise pin_api.Refused("mirrors must name the same immutable artifact")
        except pin_api.Refused as error:
            raise Refused(f"refused: {error}") from None
        state_expected = ["pin", pin, artifact]
        kind, want = "sha256", None
    if pin is None and (kind not in ("sha256", "md5") or not re.fullmatch(r"[0-9a-f]{64}" if kind == "sha256" else r"[0-9a-f]{32}", want or "")):
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
    working = _working_paths(target)
    partial, state_file, trial_path = working["partial"], working["state"], working["trial"]
    partial_dir = partial.parent
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

    def pin_call(function, *args, **kwargs):
        try:
            return function(*args, **kwargs)
        except (pin_api.Refused, OSError) as error:
            raise Refused(f"incomplete: pinned download evidence refused ({type(error).__name__}); preserve its receipt and retry only after resolving it") from None

    def pin_route(previous, target_url):
        try:
            if previous is None:
                if pin_api.pin_artifact(pin, target_url) != artifact:
                    raise pin_api.Refused("different artifact")
            else:
                pin_api.pin_redirect(artifact, pin, previous, target_url)
        except (pin_api.Refused, ValueError):
            raise _Route("refused: pinned artifact redirect mismatch") from None

    request = _request if pin is None else lambda *args, **kwargs: _request(*args, route_check=pin_route, **kwargs)
    if pin is not None:
        recorded_pin = pin_call(pin_api.read_pin_receipt, source, target.name, pin, artifact)
        want = recorded_pin["sha256"] if recorded_pin else None
        if target.exists() and recorded_pin is None:
            raise Refused("refused: existing file has no first-download pin receipt")

    if target.exists():
        if share is not None:
            share.trim(0)  # nothing to fetch: its place goes to the batch's other files, which need not wait on it
        try:
            found = _digest(target, kind)
        except OSError as error:
            raise Refused(f"incomplete: {target} could not be read ({error.strerror})") from error
        if found == want:
            # Not fetched this run, so no URL served it: `url` is null (the line keeps one shape).
            return outcome("present", sha256=_digest(target, "sha256") if kind != "sha256" else found, resumed=False,
                           url=None, urls=[])
        raise Refused(f"refused: {target} is in place but its {kind} differs")

    opened = None  # the partial opened for publication, with its stats and digest (`publishable`)
    early: dict = {}  # `held`: the first range's open answer, waiting for the one that will read it (D03 T04 §23)

    def close_early() -> None:
        held = early.pop("held", None)
        if held is not None:
            close_unread(held)

    def close_unread(answer: dict) -> None:
        """A first range's answer closed with nothing read from it; its place (in a batch) goes back to the file, after
        the connection closes and however the close ends. Closing one already closed changes nothing."""
        try:
            connection = answer.pop("connection", None)
            if connection is not None:
                connection.close()
        finally:
            if answer.get("place") is not None:
                share.push(answer.pop("place"))

    partial_dir.mkdir(parents=True, exist_ok=True)
    # One download into a source at a time: its byte limit is counted over the whole folder, so two at once could
    # pass it together. A batch's files share the one lock and count each other's reserved bytes (`_Ledger`).
    lock = None
    try:
        if turn is None:
            lock = working["lock"].open("a")
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            turn.ledger.lock_source(partial_dir)
    except BlockingIOError:
        if lock is not None:
            lock.close()
        raise Refused("incomplete: another download into this source is running; run this one after it") from None
    try:
        if pin is not None:
            recorded_pin = pin_call(pin_api.read_pin_receipt, source, target.name, pin, artifact)
            want = recorded_pin["sha256"] if recorded_pin else None
        state = {}
        if state_file.exists():
            try:
                state = json.loads(state_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                state = {}
        # A partial whose state is for another URL or digest, or has no state, is not resumed: it starts again.
        if state.get("url") != url or state.get("expected") != state_expected:
            previous = state.get("expected")
            if partial.exists() and (pin is not None or (isinstance(previous, list) and previous[:1] == ["pin"])):
                raise Refused("refused: interrupted pinned transfer has another identity or invalid state; preserve it and use a new destination")
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
        trial_path.unlink(missing_ok=True)  # a killed process's trial: not part of any download
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
                _write_json(state_file, {"url": url, "expected": state_expected, "ruled_out": list(excluded)})
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

        def room(more: int, known: bool = True):
            if turn is not None:
                # With the bytes the batch's other files have reserved counted; a known `more` reserves this file's.
                turn.ledger.room(turn.index, more, known, source, (partial, trial_path, target),
                                 source_limit, min_free, partial_dir)
                return
            if _folder_bytes(source) + more > source_limit:
                raise Refused(f"refused: {source} would pass its limit of {source_limit} bytes")
            if _free_space(partial_dir) - more < min_free:
                raise Refused("incomplete: the disk would fall under its free-space floor; the partial file is kept")

        def folder_now() -> int:
            """The source folder's bytes, and in a batch what its other files there will still add."""
            held = _folder_bytes(source)
            return held + turn.ledger.others_left(turn.index, source) if turn is not None else held

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

        def probe(candidate: str, place: _Place | None = None, keep: bool = False) -> dict:
            """One URL's `HEAD`, sorted: `qualifies` (a length of at least `segment_threshold`, `Accept-Ranges: bytes`, no
            content coding and a strong validator), `other` (it answered, but not so), `failed` (a counted failure) or
            `route` (a refused route). In a batch, `place` is the place it uses; with `keep`, a connection the answer
            left open stays with that place for the file's next request to the same origin."""
            watch = _Watchdog(min_rate, rate_window).__enter__()
            try:
                connection, response, final = request(candidate, {}, timeout, allow_loopback, watch, method="HEAD",
                                                       ca_file=ca_file, place=place)
                try:
                    status = response.status
                    length = _count(response.getheader("Content-Length"))
                    # A list of range units (RFC 9110 14.3): `bytes` among them qualifies.
                    ranges = {unit.strip().lower() for unit in (response.getheader("Accept-Ranges") or "").split(",")}
                    validator = _validator(response.headers)
                    encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                    wait_asked = _retry_after(response.getheader("Retry-After"))
                    if keep:
                        response.read()  # a HEAD's answer has no body: this ends it, so the connection can go on
                finally:
                    if (keep and response.isclosed() and not response.will_close and connection.sock is not None
                            and final == candidate and watch.sock is not None and not watch.tripped):
                        place.link = (_origin(candidate), connection, watch.sock)
                    else:
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
                    "no_head": status == 501, "ok": status == 200}

        def first_range(candidate: str, size: int, place: _Place | None = None) -> dict:
            """The speculative first range `bytes=0-(size-1)`, a fresh download's first request, sorted: `range` (a valid
            `206` from byte 0, held open with nothing read; with a strong validator it answers for the source's `HEAD`),
            `whole` (a `200`: the range was ignored; held open), `failed` (a counted failure), `route` (a refused route)
            or `unusable` (any other answer, closed unread: the `HEAD` and the later requests meet it themselves)."""
            watch = _Watchdog(min_rate, rate_window).__enter__()
            try:
                connection, response, final = request(candidate, {"Range": f"bytes=0-{size - 1}"}, timeout, allow_loopback,
                                                       watch, ca_file=ca_file, place=place)
            except _Route as error:
                watch.__exit__()
                return {"kind": "route", "error": error}
            except (_Retry, OSError, http.client.HTTPException) as error:
                watch.__exit__()
                return {"kind": "failed", "wait": None,
                        "reason": "the first range was slower than the rate floor" if watch.tripped
                        else f"the first range failed ({error})"}
            held = False
            try:
                status = response.status
                if status == 429 or status >= 500:
                    return {"kind": "failed", "reason": f"HTTP {status} to the first range",
                            "wait": _retry_after(response.getheader("Retry-After"))}
                length = _count(response.getheader("Content-Length"))
                encoding = (response.getheader("Content-Encoding") or "identity").strip().lower()
                validator = _validator(response.headers)
                answer = {"kind": "unusable"}
                if status == 206:
                    span = _content_range(response.getheader("Content-Range"))
                    # From byte 0, inside what was asked, plain, as long as it says, and either named by a strong
                    # validator (so the rest can be asked for under it) or the whole file.
                    if (span is not None and span[0] == 0 and span[1] <= size - 1 and encoding == "identity"
                            and (length is None or length == span[1] + 1) and (validator or span[1] == span[2] - 1)):
                        answer = {"kind": "range", "total": span[2], "validator": validator, "span": span,
                                  "encoding": encoding}
                elif status == 200:
                    answer = {"kind": "whole", "total": length, "validator": validator, "encoding": encoding}
                if answer["kind"] != "unusable":
                    held = True
                    answer.update(name=candidate, connection=connection, response=response, sock=watch.sock, final_url=final)
                return answer
            finally:
                watch.__exit__()  # the one who reads the body starts its own
                if not held:
                    connection.close()

        def choose(resuming: bool, limit: int = CONNECTIONS):
            """The URLs that serve ranges together: every live URL whose `HEAD` gives the same length and the same strong
            validator as the first to answer (on a resume, as the saved ranges). One that answers otherwise stays in
            `live` for the ordered fallback and is kept out of the mix. Returns (URLs, length, validator), or the status
            that hands the run back to its caller."""
            nonlocal state, one_stream, agreed
            close_early()
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
            # A fresh download asks for its first range, which answers for its source's HEAD where it can (D03 T04 §23); a
            # partial, a saved state or a resume asks for none, so no byte of a saved range can be overwritten or fetched
            # twice.
            fresh = not resuming and not state and not (partial.exists() and partial.stat().st_size)
            first_name = order[0] if fresh and order else None
            first: dict = {}
            # In a batch, the places this round's requests use (`_Share`): the file's own and whatever extra no other
            # file wants. The first range stands in for its source's HEAD (asked only when the answer cannot answer for
            # it), so a fresh file of one source on one place sends the first range alone. With one place and several
            # sources, the HEADs go one at a time, as before: the first range would need a second connection.
            lent: list = []
            lending = threading.Lock()
            first_place = None
            try:
                if share is not None:
                    share.ensure(order[0])
                    want = min(len(order), min(limit, CONNECTIONS))
                    while len(share) < want and share.extra(order[0]):
                        pass
                    if len(share) < 2 and len(order) > 1:
                        first_name = None
                    lent = share.pop_all()
                    if first_name is not None:
                        first_place = lent.pop()  # this round's to hand on (with the first range's answer) or give back

                def ask(name: str, place: _Place | None = None):
                    try:
                        results[name] = probe(name, place, keep=place is not None)
                    except Exception as error:  # a probe that raised is a failed HEAD, not a lost thread
                        results[name] = {"kind": "failed", "reason": f"the HEAD failed ({error.__class__.__name__})", "wait": None}

                def ask_first():
                    try:
                        first.update(first_range(first_name, max(-(-segment_threshold // limit), 2 * SHORT_ANSWER), first_place))
                    except Exception as error:
                        first.update({"kind": "failed", "reason": f"the first range failed ({error.__class__.__name__})", "wait": None})

                if len(order) == 1 and first_name is None:
                    ask(order[0], lent[0] if lent else None)
                else:
                    # No more requests at once than the run may hold connections: the transfers have not begun, so these are
                    # all of the run's connections, and a fifth source waits for a place. The first range keeps its place
                    # (its connection stays open for the transfer that reads it) until every HEAD is answered. In a batch,
                    # the run's connections are the places it holds, each request on one of them.
                    places = threading.BoundedSemaphore(len(lent) + (first_place is not None) if share is not None
                                                        else min(limit, CONNECTIONS))

                    def ask_in_turn(name: str):
                        with places:
                            if share is None:
                                ask(name)
                                return
                            with lending:
                                place = lent.pop()
                            try:
                                ask(name, place)
                            finally:
                                with lending:
                                    lent.append(place)

                    if first_name is not None:
                        places.acquire()
                    # The first range's source is not sent a HEAD beside it: its answer is asked to stand in for one.
                    threads = [threading.Thread(target=ask_in_turn, args=(name,), daemon=True) for name in order
                               if name != first_name]
                    if first_name is not None:
                        threads.append(threading.Thread(target=ask_first, daemon=True))
                    started = []
                    try:
                        for thread in threads:
                            thread.start()
                            started.append(thread)
                    finally:
                        # Every request begun is waited for, however the starting ended: each gives its place back to `lent`
                        # before the round gives them all back.
                        for thread in started:
                            thread.join()
                    if first_name is not None:
                        places.release()
                if share is not None:
                    if first_place is not None:
                        if first.get("kind") in ("range", "whole"):
                            first["place"] = first_place  # held with its answer, for the request that reads it
                        else:
                            lent.append(first_place)
                        first_place = None  # handed on: the answer owns it now, or it is in `lent`
                    for place in lent:
                        share.push(place)
                    lent.clear()
                first_charged = False
                pauses = []
                if first_name is not None:
                    if first.get("kind") == "range" and first["validator"] is not None:
                        # A valid 206 from byte 0 tells everything the HEAD would: the total length (`Content-Range`), a
                        # strong validator, no content coding, and that ranges are served. It is the source's answer, so
                        # its HEAD is not sent (aria2c's first request is its first range, with no HEAD before it).
                        total = first["total"]
                        results[first_name] = {"kind": "qualifies" if total >= segment_threshold else "other",
                                               "total": total, "validator": first["validator"], "no_head": False, "ok": True}
                    elif first.get("kind") == "route":
                        results[first_name] = {"kind": "skipped"}  # the URL is ruled out below: nothing to ask it
                    else:
                        # The answer cannot stand in for the HEAD (a 200, a 206 with no strong validator, another answer or
                        # a failure): the HEAD is asked now, as it was beside the first range before.
                        if first.get("kind") == "failed":
                            first_charged = True
                            pause = charge(first["reason"], first["wait"], stay=True, source=first_name)
                            others = any(results[name]["kind"] in ("qualifies", "other")
                                         for name in order if name != first_name)
                            if cooldown.get(first_name, 0.0) > time.monotonic() and not others:
                                cool(first_name)  # asked to wait (Retry-After), and no other source answered: waited out
                            else:
                                pauses.append(pause)
                                if cooldown.get(first_name, 0.0) > time.monotonic():
                                    # Asked to wait while other sources answered: they go on; this one stays live as the
                                    # fallback, not asked again before its wait ends.
                                    results[first_name] = {"kind": "waiting"}
                        if first_name not in results:
                            place = None
                            try:
                                if share is not None:
                                    # A place of the file's own; else, while the answer holds one, an extra no other file
                                    # wants; else the answer's own, closed unread (nothing was read, so nothing is fetched
                                    # twice).
                                    place = share.pop_if_any()
                                    held = first.get("kind") in ("range", "whole")
                                    if place is None and held:
                                        place = share.take_extra(first_name)
                                    if place is None and held:
                                        place = first.pop("place")
                                        first.pop("connection").close()
                                        first.clear()
                                        first["kind"] = "closed"
                                    if place is None:
                                        place = share.pop_or_take(first_name)
                                ask(first_name, place)
                            finally:
                                if share is not None:
                                    share.push(place)  # however the HEAD ended; None when none was taken
                for name in order:
                    if results[name]["kind"] == "route":
                        drop(results[name]["error"], name)
                    elif results[name]["kind"] == "failed" and not (first_charged and name == first_name):
                        # One failure a source a round: a failed first range has been counted for its source already.
                        pauses.append(charge(results[name]["reason"], results[name]["wait"], stay=True, source=name))
                if first.get("kind") == "route":
                    drop(first["error"], first_name)
                adoptable = first if first.get("kind") in ("range", "whole") else None
                if adoptable is not None:
                    head = results[first_name]
                    if first_name not in live or first_name in barred or head["kind"] not in ("qualifies", "other"):
                        adoptable = None  # its HEAD did not answer (or its URL is out): nothing says what this answer is part of
                    elif head["ok"] and ((head["total"] is not None and adoptable["total"] is not None
                                          and head["total"] != adoptable["total"]) or head["validator"] != adoptable["validator"]):
                        log(f"fetch: {first_name}: the first range and the HEAD disagree on the file; neither is trusted")
                        adoptable = None
                    if adoptable is None:
                        close_unread(first)  # nothing was read from it, so nothing was fetched

                def decide():
                    nonlocal state, one_stream, agreed
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

                outcome = decide()
                if adoptable is not None:
                    if adoptable["kind"] == "whole" and isinstance(outcome, tuple) and first_name in agreed:
                        # The range was ignored. The others that agree on the file go on in ranges without this source; with
                        # none left, its answer is the whole stream, never mixed with ranges.
                        barred.add(first_name)
                        agreed.remove(first_name)
                        log(f"fetch: {first_name} ignored the range; it stays in the fallback, not in the mix")
                        if not agreed:
                            one_stream, outcome = True, "one-stream"
                    if outcome == "one-stream" or (isinstance(outcome, tuple) and adoptable["kind"] == "range"
                                                   and agreed and agreed[0] == first_name):
                        early["held"] = adoptable
                    else:
                        close_unread(first)
                if isinstance(outcome, tuple) and agreed and all(cooldown.get(name, 0.0) > time.monotonic() for name in agreed):
                    cool(min(agreed, key=lambda name: cooldown.get(name, 0.0)))  # a rate-limited first range: waited out here
                return outcome
            except BaseException:
                # Whatever ends the round early (a spent attempt budget, a refused route, a raise from any step) still
                # gives back what it holds (§23 review rounds 2 and 3): the places not handed on, and the first range's
                # answer with its place unless the round handed it to `early`, which the run closes in the end.
                try:
                    if first and first is not early.get("held"):
                        close_unread(first)
                finally:
                    if share is not None:
                        with lending:
                            for place in [*lent, first_place]:
                                share.push(place)
                            lent.clear()
                raise

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
            layout = count  # the ranges a fresh file is cut into
            if share is not None:
                # In a batch, the ranges' connections are the places this file holds: the first range's (its answer is
                # range 0's first bytes), its own, and any extra no other file wants (none while a file waits to
                # start). A fresh file makes one range a place, so a file on one place reads one range, not four in
                # turn. The other workers wait for a place no file wants and then take half of the slowest range, as a
                # free connection does; a worker that finds nothing to take gives its place to a file waiting for one.
                # The first range's place stays with its open answer (one connection, one place) and goes to the worker
                # that reads range 0 (`work`), never to another worker beside it.
                held = early.get("held")
                riding = 1 if held is not None and held.get("place") is not None else 0
                if not riding:
                    share.ensure(sources_agreeing[0])
                while len(share) + riding < count and share.extra(sources_agreeing[0]):
                    pass
                share.trim(count - riding)
                layout = len(share) + riding
            if not resuming:
                size = -(-total // layout)
                room(total)
                try:
                    with partial.open("wb") as handle:
                        handle.truncate(total)
                        os.fsync(handle.fileno())
                except OSError as error:
                    raise Refused(f"incomplete: the partial file could not be made ({error.strerror})") from error
                state = {"url": url, "expected": state_expected, "validator": validator, "encoding": "identity",
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
            counted = {"since": 0, "run": 0, "saved_at": time.monotonic()}
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

            def run(item: list, spare: dict, place: _Place | None = None):
                """Reads `item` to its end. `spare` is this connection's open link to one source, its last answer read
                whole: the next request to that source goes on it (as aria2c's do), so a range that ends and the next
                one begun are never two connections at once; a request to another source closes it first. `place`:
                this worker's place in a batch's budget."""
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
                        # The first range's open answer is the first bytes of the file's first range (D03 T04 §23); it
                        # is read like any answer, through the same checks, writes and provenance.
                        adopted = None
                        if (early.get("held") is not None and item is state["segments"][0] and at == 0
                                and name == early["held"]["name"]):
                            adopted = early.pop("held")
                        elif share is not None and early.get("held") is not None and item is state["segments"][0] and at == 0:
                            # Range 0 goes elsewhere: the first range's answer will not be read, and in a batch its
                            # connection is closed before this one opens (its place is this worker's).
                            early.pop("held")["connection"].close()
                        reuse = None
                        if adopted is None and spare.get("name") == name:
                            reuse = (spare["connection"], spare["sock"])
                            spare.clear()
                        busy[name] = busy.get(name, 0) + 1
                        reading[id(item)] = (item, name)
                        pace[id(item)] = (time.monotonic(), item[2])
                    if spare:
                        spare.pop("connection").close()  # another source: this connection ends before the next opens
                        spare.clear()
                    watch = _Watchdog(min_rate, rate_window).__enter__()
                    source = name
                    began = time.monotonic()
                    got = 0
                    keep = False
                    try:
                        try:
                            if adopted is not None:
                                connection, response = adopted["connection"], adopted["response"]
                                watch.sock, final = adopted["sock"], adopted["final_url"]
                            else:
                                connection, response, final = request(
                                    source, {"Range": f"bytes={at}-{last}", "If-Range": state["validator"]}, timeout,
                                    allow_loopback, watch, ca_file=ca_file, reuse=reuse, place=place)
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
                            if (response.status != 206 or span is None or span[0] != at
                                    or (span[1] > last and adopted is None)  # the first range may reach past this range's end
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
                                        if _free_space(partial_dir) - len(block) < min_free:
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
                            elif (response.isclosed() and not response.will_close and connection.sock is not None
                                  and final == source and watch.sock is not None and not watch.tripped):
                                # Read whole and left open by the server: the next request to this source goes on it
                                # (the rest of range 0 after the first range's answer, or a range taken next).
                                spare.update(name=source, connection=connection, sock=watch.sock)
                                keep = True
                        finally:
                            if not keep:
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

            def worker(first: dict | None = None):
                try:
                    attempt_work(first)
                finally:
                    with guard:
                        running["workers"] -= 1
                    wake()

            def attempt_work(first: dict | None):
                # Any failure ends the run with a reason, never a range left claimed while the others wait on it.
                try:
                    work(first)
                except (Refused, _Misfit) as error:
                    errors.append(error)
                    stop.set()
                except Exception as error:
                    errors.append(Refused(f"incomplete: a range failed unexpectedly ({error.__class__.__name__}); the partial file is kept"))
                    stop.set()

            def work(first: dict | None):
                """One connection's work. `first`, in a batch with the first range's answer open: that answer's place
                and range 0, which this worker reads first (adopting the answer, or closing it before its own request),
                so the answer's connection and its place are one connection and one place at every moment."""
                spare: dict = {}  # this connection's kept link, closed when it ends
                if first is not None:
                    place = first["place"]
                else:
                    place = share.pop_if_any() if share is not None else None  # in a batch, this worker's place
                try:
                    if first is not None:
                        run(first["item"], spare, place)
                        wake()
                    while share is not None and place is None:
                        # A worker the file had no place for: it waits for one no other file wants (the budget's
                        # `extra`), and gives up when the file's ranges are all done or taken.
                        with changed:
                            with guard:
                                unfinished = any(rest(item) > 0 for item in state["segments"])
                            if not unfinished or stop.is_set():
                                return
                            changed.wait(IDLE_WAIT)
                        place = share.take_extra(mix[0] if mix else url)
                    while not stop.is_set():
                        item = claim()
                        if item is None:
                            # Nothing to take now; a range still being read may become worth splitting in a moment, or
                            # end: either rings `changed` (checked under it, so no ring is missed). In a batch, a file
                            # waiting for a place gets this one instead (the budget rings `changed` when one starts to).
                            with changed:
                                with guard:
                                    unfinished = any(rest(item) > 0 for item in state["segments"])
                                if not unfinished or stop.is_set() or (share is not None and _BUDGET.wanted()):
                                    return
                                changed.wait(IDLE_WAIT)
                            continue
                        run(item, spare, place)
                        wake()
                finally:
                    try:
                        if first is not None:
                            with guard:
                                unread = early.pop("held", None)
                            if unread is not None:
                                unread["connection"].close()  # never read (the run stopped first): closed before its place goes
                    finally:
                        if place is not None:
                            if spare:
                                share.keep(place, spare["name"], spare["connection"], spare["sock"])
                            else:
                                share.drop(place)
                        elif spare and not _POOL.put(spare["name"], spare["connection"], spare["sock"]):
                            spare["connection"].close()

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
                            # After each MiB, and at least every second while any byte is unsaved: a transfer that
                            # stalls (or is held) keeps nothing it received out of the state for long.
                            now = time.monotonic()
                            due = counted["since"] >= STATE_EVERY or (counted["since"] > 0
                                                                      and now - counted["saved_at"] >= SAVE_EVERY)
                            if due:
                                counted["since"] = 0
                                counted["saved_at"] = now
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

            if share is not None:
                _BUDGET.bells.add(wake)
            try:
                adopter = None
                started: list = []  # the threads running: each is waited for before the shared descriptor closes
                try:
                    answer = early.get("held")
                    if share is not None and answer is not None and answer.get("place") is not None:
                        # The first range's answer and its place go together to one worker, with range 0 claimed for it.
                        range_0 = state["segments"][0]
                        with guard:
                            taken.add(id(range_0))
                            working.add(id(range_0))
                        adopter = {"place": answer.pop("place"), "item": range_0}
                    threads = [threading.Thread(target=worker, args=(adopter if number == 0 else None,), daemon=True)
                               for number in range(count)]
                    running["workers"] = len(threads)
                    for thread in threads:
                        thread.start()
                        started.append(thread)  # the first started owns the adopter's place from here (`work`)
                    along = threading.Thread(target=hash_along, daemon=True)
                    along.start()
                    started.append(along)
                    for thread in started:
                        thread.join()
                except BaseException:
                    # Interrupted (Ctrl-C in a caller that goes on), or a thread that could not start: every range stops
                    # and is waited for before the shared descriptor closes, so none writes or saves after this call
                    # returns.
                    stop.set()
                    wake()
                    for thread in started:
                        thread.join()
                    raise
                if not errors and not hashed.failed and frontier() == state["total"]:
                    try:
                        hashed.hash_up_to(state["total"])
                        if hashed.at == state["total"]:
                            # Kept with the file it is of (`publishable`): the bytes of another file renamed over the
                            # partial's name meanwhile are never published under it.
                            made = os.fstat(fd)
                            streamed["digest"] = (made.st_dev, made.st_ino, state["total"], hashed.hash.hexdigest())
                    except OSError:
                        pass  # the whole-file pass after the transfer judges it instead
                try:
                    save()
                except OSError as error:
                    raise Refused(f"incomplete: the download state could not be written ({error.strerror}); the partial file is kept") from error
            finally:
                _BUDGET.bells.discard(wake)
                try:
                    close_early()  # an answer no range read (its source was in use, or the run stopped first)
                finally:
                    if adopter is not None and not started:
                        share.push(adopter.pop("place"))  # its worker never started: the place, its answer closed, goes back
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

        def trial(candidate: str, total: int) -> str:
            """One whole-file download from `candidate` alone, into a temporary file of its own and checked against the
            published digest, so no other source's bytes can be in it. "verified" (the file is now the partial),
            "wrong" (this source gives other bytes), "failed" (a counted failure: it may be asked again), "unusable" (it
            answers, but not with this whole file: another status, length or coding) or "skip" (its route is refused)."""
            nonlocal fetched
            room(total)
            cool(candidate)
            place = share.pop_or_take(candidate) if share is not None else None  # in a batch, its connection's place
            try:
                watch = _Watchdog(min_rate, rate_window).__enter__()
                try:
                    try:
                        connection, response, _ = request(candidate, {}, timeout, allow_loopback, watch, ca_file=ca_file,
                                                           place=place)
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
                        hash_, got, base = hashlib.new(kind), 0, folder_now()
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
                                    if _free_space(partial_dir) - len(block) < min_free:
                                        raise Refused("incomplete: the disk fell under its free-space floor; the partial file is kept")
                                    handle.write(block)
                                    hash_.update(block)
                                handle.flush()
                                os.fsync(handle.fileno())
                                made = os.fstat(handle.fileno())
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
                        streamed["digest"] = (made.st_dev, made.st_ino, got, hash_.hexdigest())  # the file it is of
                        return "verified"
                    finally:
                        connection.close()
                finally:
                    watch.__exit__()
                    trial_path.unlink(missing_ok=True)
            finally:
                # The place goes back however the trial ended, a failed cleanup (§23 review round 3) or a raise from
                # any step included: the connection is closed by then, so the place is free.
                if share is not None:
                    share.push(place)

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
                    state = {"url": url, "expected": state_expected, "validator": state.get("validator"),
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

        def publishable():
            """The partial opened for publication, and the digest of that very file: the one computed as it was written
            when the open file is that one, whole (the same device, inode and length), else read from the descriptor
            now. Another file renamed over the partial's name (a run's working file, written beside it) is then judged
            by its own bytes, never by the digest of the file it replaced."""
            handle = partial.open("rb")
            try:
                stats = os.fstat(handle.fileno())
                kept = streamed.pop("digest", None)
                if kept is not None and kept[:3] == (stats.st_dev, stats.st_ino, stats.st_size):
                    return handle, stats, kept[3]
                return handle, stats, _digest(handle, kind)
            except BaseException:
                handle.close()
                raise

        if pin is not None:
            with _PIN_EVIDENCE_LOCK:
                pin_call(pin_api.mark_pin_mode, source, check_space=room)
        found = None
        while True:
            if state.get("recovery"):
                if recover():
                    try:
                        opened = publishable()
                    except OSError as error:
                        raise Refused(f"incomplete: the partial file could not be read ({error.strerror}); it is kept") from error
                    found = opened[2]
                    if want is not None and found != want:
                        opened[0].close()
                        partial.unlink(missing_ok=True)
                        forget()
                        raise Refused("incomplete: the verified file was replaced before it was published; nothing is "
                                      "published, and a rerun fetches it again")
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
                room(max((total or 0) - have, 0), known=total is not None)
                headers = {}
                if have and state.get("validator"):
                    headers = {"Range": f"bytes={have}-", "If-Range": state["validator"]}
                elif have:
                    restart("no validator to resume against")
                    continue
                held = early.pop("held", None)
                adopted = None
                if held is not None:
                    if not have and not state and held["name"] == here():
                        adopted = held  # the first range's open answer begins the stream (D03 T04 §23)
                    else:
                        close_unread(held)
                if adopted is None:
                    cool(here())
                asked = here()
                place = None
                try:
                    if share is not None:
                        # In a batch, the one stream's place: the first range's, or one the file holds (waiting its turn
                        # for one when it holds none); the rest go back for the other files.
                        place = adopted.pop("place", None) if adopted is not None else None
                        if place is None:
                            place = share.pop_or_take(asked)
                        share.trim(0)
                    watch = _Watchdog(min_rate, rate_window).__enter__()
                except BaseException:
                    # Nothing was asked yet: the adopted answer is closed unread and the place goes back, in that order.
                    try:
                        if adopted is not None:
                            close_unread(adopted)
                    finally:
                        if share is not None:
                            share.push(place)
                    raise
                try:
                    if adopted is not None:
                        connection, response, final_url = adopted["connection"], adopted["response"], adopted["final_url"]
                        watch.sock = adopted["sock"]
                    else:
                        connection, response, final_url = request(asked, headers, timeout, allow_loopback, watch,
                                                                   ca_file=ca_file, place=place)
                except BaseException as error:
                    # Any failure gives the place back, before a wait or a raise: a place kept by a failed request would
                    # hold the batch's other files waiting for ever (§23 review round 2).
                    try:
                        watch.__exit__()
                    finally:
                        if share is not None:
                            share.push(place)
                    if isinstance(error, _Route):
                        drop(error)
                        continue
                    if isinstance(error, _Retry):
                        spend("slower than the rate floor" if watch.tripped else str(error))
                        continue
                    raise
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
                    if code == 206 and adopted is not None:
                        # The first range's answer, checked when it was asked for: the file's own first bytes, from
                        # which the rest is asked for under its validator, as a resume is.
                        span = adopted["span"]
                        body = span[1] + 1
                        room(span[2])
                        with partial.open("wb") as handle:
                            os.fsync(handle.fileno())
                        state = {"url": url, "expected": state_expected, "validator": adopted["validator"],
                                 "encoding": adopted["encoding"], "total": span[2], "final_url": final_url, "sources": []}
                        write_state()
                        have = 0
                        mode = "ab"
                        resumed = False
                    elif code == 206:
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
                        room(max((body or 0) - have, 0), known=body is not None)
                        # Truncate first, then record the new answer: old bytes never sit under the new validator.
                        with partial.open("wb") as handle:
                            os.fsync(handle.fileno())
                        state = {"url": url, "expected": state_expected, "validator": _validator(response.headers),
                                 "encoding": encoding, "total": body, "final_url": final_url, "sources": []}
                        write_state()
                        have = 0
                        mode = "ab"
                        resumed = False
                    got = 0
                    supplier = here()
                    base = folder_now()  # what the source holds before this body, the partial's start included
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
                                if _free_space(partial_dir) - len(block) < min_free:
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
                    # The connection is kept with its place or closed, and the place given back, however the body ended
                    # (a raise from the read, a write, the state's save or the watchdog included).
                    kept = False
                    try:
                        watch.__exit__()
                        if (place is not None and response.isclosed() and not response.will_close
                                and connection.sock is not None and final_url == asked and watch.sock is not None
                                and not watch.tripped):
                            # Read whole and left open: the next request to this origin, from any file, goes on it.
                            kept = True
                            share.keep(place, asked, connection, watch.sock)
                    finally:
                        if not kept:
                            try:
                                connection.close()
                            finally:
                                if place is not None:
                                    share.push(place)

            if share is not None:
                share.trim(0)  # no request until the digest is judged: the places go to the other files
            try:
                opened = publishable()
            except OSError as error:
                raise Refused(f"incomplete: the partial file could not be read ({error.strerror}); it is kept") from error
            found = opened[2]
            if want is not None and found != want:
                opened[0].close()
                opened = None
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
                    state = {"url": url, "expected": state_expected, **kept, "sources": [],
                             "recovery": {"candidates": candidates or list(live), "ruled_out": list(excluded)}}
                    write_state()
                    log(f"fetch: the {kind} does not match and the bytes came from {len(suppliers) or 'unrecorded'} URLs; "
                        "trying each source alone")
                continue
            break
        supplied = contributors() or [here()]
        handle, verified, _ = opened
        with handle:
            try:
                sha256 = found if kind == "sha256" else _digest(handle, "sha256")
            except OSError as error:
                raise Refused(f"incomplete: the partial file could not be read ({error.strerror}); it is kept") from error
            try:
                os.fsync(handle.fileno())
                if pin is not None:
                    with _PIN_EVIDENCE_LOCK:
                        pin_call(pin_api.save_pin_receipt, source, target.name, pin, artifact, sha256, verified.st_size, check_space=room)
                os.replace(partial, target)
            except OSError as error:
                raise Refused(f"incomplete: the verified file could not be moved into place ({error.strerror}); a rerun moves it") from error
            # The rename moves whatever holds the partial's name now: it must be the file just verified. Anything else
            # (renamed over it after the check) is taken back out, and nothing is published.
            try:
                placed = os.stat(target)
            except OSError:
                placed = None
            if placed is None or (placed.st_dev, placed.st_ino) != (verified.st_dev, verified.st_ino):
                target.unlink(missing_ok=True)
                forget()
                raise Refused("incomplete: the partial file was replaced as it was published; nothing is published, and "
                              "a rerun fetches the file again")
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
        try:
            close_early()  # an answer still held: its connection closed and its place given back
        finally:
            if opened is not None:
                opened[0].close()
            if turn is None:
                lock.close()
            else:
                turn.ledger.unlock_source(partial_dir)


# Every option's default once: the quick reader and the argparse parser both start from this table.
_DEFAULTS = {"url": None, "dest": None, "sha256": None, "md5": None, "pin": None, "source_limit": 5 * 10**9, "min_free": 10 * 10**9,
             "timeout": 30.0, "attempts": 3, "min_rate": 16 * 1024, "segments": 0, "segment_threshold": SEGMENT_THRESHOLD,
             "mirror": [], "ca_file": None, "allow_loopback": False, "manifest": None}
_VALUE_OPTIONS = {"--url": str, "--dest": str, "--sha256": str, "--md5": str, "--pin": str, "--source-limit": int, "--min-free": int,
                  "--timeout": float, "--attempts": int, "--min-rate": float, "--segments": int,
                  "--segment-threshold": int, "--mirror": str, "--ca-file": str, "--manifest": str}
# What `--manifest` replaces on the command line: a file's own URLs and digest come from its line.
_PER_FILE_ONLY = ("url", "dest", "sha256", "md5", "pin")


def _quick_args(argv: list[str]):
    """The arguments of a command line that is plainly well formed, read without importing `argparse` (tens of ms of
    start-up, most of it `argparse`'s own imports), or None for anything else: help, an abbreviated or unknown option, a
    repeated one, a value that starts with a dash or fails its type, a missing or doubled digest, a stray word, a
    `--manifest` beside a file's own options. None sends the line to `_parser`, which owns every message and exit code,
    so a line is only ever read here when `argparse` would read it the same way."""
    from types import SimpleNamespace

    found = dict(_DEFAULTS, mirror=[])
    seen = set()
    tokens = iter(argv)
    for token in tokens:
        name, joined, inline = token.partition("=")
        if name == "--allow-loopback" and not joined:
            value = True
        elif name in _VALUE_OPTIONS:
            value = inline if joined else next(tokens, None)
            if value is None or value.startswith("-"):
                return None
            try:
                value = _VALUE_OPTIONS[name](value)
            except ValueError:
                return None
        else:
            return None
        key = name[2:].replace("-", "_")
        if key == "mirror":
            found["mirror"].append(value)
            continue
        if key in seen:
            return None
        seen.add(key)
        found[key] = value
    if found["manifest"] is not None:
        if any(found[key] is not None for key in _PER_FILE_ONLY) or found["mirror"]:
            return None
    elif found["url"] is None or found["dest"] is None or sum(found[k] is not None for k in ("sha256", "md5", "pin")) != 1:
        return None
    return SimpleNamespace(**found)


def _parser():
    import argparse  # deferred: only a line `_quick_args` did not take (help, an error) needs it

    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--url", help="required unless --manifest is given")
    parser.add_argument("--dest", help="SOURCE/NAME; required unless --manifest is given")
    digest = parser.add_mutually_exclusive_group()
    digest.add_argument("--sha256", help="the published SHA-256; one of --sha256, --md5 or --pin is required unless --manifest is given")
    digest.add_argument("--md5")
    digest.add_argument("--pin", help="immutable GitHub/Hugging Face repository and commit; alternative to published digest")
    parser.add_argument("--source-limit", type=int, default=_DEFAULTS["source_limit"])
    parser.add_argument("--min-free", type=int, default=_DEFAULTS["min_free"])
    parser.add_argument("--timeout", type=float, default=_DEFAULTS["timeout"])
    parser.add_argument("--attempts", type=int, default=_DEFAULTS["attempts"])
    parser.add_argument("--min-rate", type=float, default=_DEFAULTS["min_rate"])
    parser.add_argument("--segments", type=int, default=_DEFAULTS["segments"],
                        help="0: automatic (up to 4 over 64 MiB); 1: one stream")
    parser.add_argument("--segment-threshold", type=int, default=_DEFAULTS["segment_threshold"],
                        help="the smallest file segmented")
    parser.add_argument("--mirror", action="append", default=[],
                        help="another URL for the same file; repeatable. Mirrors that agree on the file (same length and "
                             "strong validator) serve ranges together; a mirror that disagrees is the ordered fallback")
    parser.add_argument("--ca-file", help="a PEM file of extra certificate authorities to trust (verification stays on)")
    parser.add_argument("--allow-loopback", action="store_true", help="for the tests' local server only")
    parser.add_argument("--manifest",
                        help="a JSON Lines file, one object a file (url, dest, sha256 or md5 or pin, optional mirrors list, and "
                             "optionally source_limit, min_free, timeout, attempts, min_rate, segments, "
                             "segment_threshold), all fetched by this one process, several at once inside its four "
                             "connections. Precedence: a line's own value, then this command line's option, then the "
                             "default; --ca-file and --allow-loopback "
                             "hold for every file and are never read from a line; --url, --dest, --sha256, --md5, --pin and "
                             "--mirror are refused beside it. One JSON line a file, in order; a failed file does not "
                             "stop the rest. Exit 0 only when every file is in place, 1 when any is not, 2 when the "
                             "command line or the manifest (empty, malformed, or a destination repeated or writing "
                             "another line's working files) is refused "
                             "before anything is fetched")
    return parser


# The keys a manifest line may carry and the JSON types each takes (D03 T04 §23); a bool is never a number here.
_MANIFEST_KEYS = {"url": (str,), "dest": (str,), "sha256": (str,), "md5": (str,), "pin": (str,), "mirrors": (list,),
                  "source_limit": (int,), "min_free": (int,), "timeout": (int, float), "attempts": (int,),
                  "min_rate": (int, float), "segments": (int,), "segment_threshold": (int,)}
# The options a line may set for its own file, over the command line's.
_PER_FILE_OPTIONS = ("source_limit", "min_free", "timeout", "attempts", "min_rate", "segments", "segment_threshold")


class _BadManifest(Exception):
    """A manifest refused before anything is fetched."""


def _read_manifest(path: str) -> list[dict]:
    """Every file the manifest lists, each line checked, or `_BadManifest` naming the first line that is wrong."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise _BadManifest(f"refused: the manifest {path} could not be read ({error})") from None
    entries = []
    owned: dict = {}  # every path an earlier line's file writes (its destination and `_working_paths`) -> (line, role)
    for number, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip():
            continue
        where = f"refused: manifest line {number}"
        try:
            entry = json.loads(raw)
        except ValueError as error:
            raise _BadManifest(f"{where} is not JSON ({error})") from None
        if not isinstance(entry, dict):
            raise _BadManifest(f"{where} is not a JSON object")
        unknown = sorted(set(entry) - set(_MANIFEST_KEYS))
        if unknown:
            raise _BadManifest(f"{where} has an unknown key: {', '.join(unknown)}")
        for key, value in entry.items():
            if isinstance(value, bool) or not isinstance(value, _MANIFEST_KEYS[key]):
                raise _BadManifest(f"{where}: {key} has the wrong type")
        if not all(isinstance(mirror, str) and mirror for mirror in entry.get("mirrors", [])):
            raise _BadManifest(f"{where}: mirrors must be a list of URLs")
        if not entry.get("url") or not entry.get("dest"):
            raise _BadManifest(f"{where} needs a url and a dest")
        if sum(k in entry for k in ("sha256", "md5", "pin")) != 1:
            raise _BadManifest(f"{where} needs exactly one of sha256 or md5 or pin")
        kind = next(k for k in ("sha256", "md5", "pin") if k in entry)
        if kind == "pin":
            try:
                api = _pin_helpers()
            except Refused as error:
                raise _BadManifest(f"{where}: {error}") from None
            try:
                identity = api.pin_artifact(entry["pin"], entry["url"])
                if any(api.pin_artifact(entry["pin"], mirror) != identity for mirror in entry.get("mirrors", [])):
                    raise api.Refused("mirrors name different artifacts")
            except api.Refused as error:
                raise _BadManifest(f"{where}: {error}") from None
        elif not re.fullmatch(r"[0-9a-fA-F]{64}" if kind == "sha256" else r"[0-9a-fA-F]{32}", entry[kind]):
            raise _BadManifest(f"{where}: {kind} is not {64 if kind == 'sha256' else 32} hex digits")
        # The same file named twice, however spelled (src/a, src//a, ./src/a), or a destination whose download would
        # write another line's working file (src/a.bin.state.json is src/a.bin's partial beside src/a.bin's state): two
        # downloads writing one path. Only the source's lock is theirs to share.
        target = Path(entry["dest"])
        paths = {"destination": target, **_working_paths(target)}
        for role, path in paths.items():
            line, theirs = owned.get(path, (None, None))
            if line is None or role == theirs == "lock":
                continue
            if role == theirs == "destination":
                raise _BadManifest(f"{where} names the destination {entry['dest']} that line {line} named")
            mine = "destination" if role == "destination" else f"{role} file"
            raise _BadManifest(f"{where} names the destination {entry['dest']}, whose {mine} {path} is line {line}'s "
                               f"{theirs} file")
        for role, path in paths.items():
            owned.setdefault(path, (number, role))
        entries.append(entry)
    if not entries:
        raise _BadManifest(f"refused: the manifest {path} lists no file")
    return entries


def _fetch_line(url: str, dest: str, expected: tuple[str, str], **options) -> dict:
    """One file fetched and its JSON line, a refusal included: the same fields as a success, so a caller reads one
    shape; `fetched` is unknown on a failure."""
    try:
        return fetch(url, dest, expected, **options)
    except Refused as error:
        reason = str(error)
        return {"status": reason.split(":")[0], "bytes": 0, "fetched": None, "sha256": None, "resumed": False,
                "url": None, "urls": [], "reason": reason}


def _run_manifest(args) -> int:
    try:
        entries = _read_manifest(args.manifest)
    except _BadManifest as error:
        print(f"fetch.py: {error}", file=sys.stderr)
        return 2
    _POOL.enabled = _BUDGET.enabled = True
    try:
        return _run_entries(args, entries)
    finally:
        _POOL.enabled = _BUDGET.enabled = False
        _POOL.keep_only(())


def _run_entries(args, entries: list[dict]) -> int:
    """Every file of the manifest, several at once inside the run's `CONNECTIONS` (D03 T04 §23): each starts, in the
    manifest's order, once a place is free for its first connection (`_Budget`), and takes more only when no other file
    waits for one, so a source of small files runs one connection a file, as aria2c's `-j4 -x1` does, and a file left
    alone splits into ranges. Each file is fetched exactly as its own run would be; its line is printed once it and
    every line before it are done, so the lines keep the manifest's order."""
    ledger = _Ledger()
    lines: list = [None] * len(entries)
    shown = {"next": 0}
    printing = threading.Lock()

    def show(index: int, line: dict) -> None:
        with printing:
            lines[index] = line
            while shown["next"] < len(lines) and lines[shown["next"]] is not None:
                print(json.dumps(lines[shown["next"]]), flush=True)
                shown["next"] += 1

    def unexpected(error: Exception) -> dict:
        reason = f"incomplete: an unexpected error ({error.__class__.__name__}); a rerun resumes the file"
        return {"status": "incomplete", "bytes": 0, "fetched": None, "sha256": None, "resumed": False, "url": None,
                "urls": [], "reason": reason}

    def one(index: int, entry: dict, turn: _Turn) -> None:
        try:
            expected = ("pin", entry["pin"]) if "pin" in entry else (("sha256", entry["sha256"].lower()) if "sha256" in entry else ("md5", entry["md5"].lower()))
            options = {key: entry.get(key, getattr(args, key)) for key in _PER_FILE_OPTIONS}
            line = _fetch_line(entry["url"], entry["dest"], expected, mirrors=entry.get("mirrors", []),
                               ca_file=args.ca_file, allow_loopback=args.allow_loopback, turn=turn, **options)
        except Exception as error:  # noqa: BLE001 - one file's unexpected error must not stop the other files
            line = unexpected(error)
        finally:
            turn.share.trim(0)
            ledger.leave(index)
        show(index, line)

    with _BUDGET.cond:
        _BUDGET.unstarted = len(entries)
    threads = []
    for index, entry in enumerate(entries):
        # This file's first connection, in the manifest's order; asked by a URL only when it has an origin to match a
        # kept link by (`_origin`): a malformed one is refused by its own request, as its own run refuses it.
        place = None
        try:
            try:
                place = _BUDGET.take(entry["url"] if _origin(entry["url"]) is not None else None)
            finally:
                with _BUDGET.cond:
                    _BUDGET.unstarted -= 1
            ledger.join(index)
            thread = threading.Thread(target=one, args=(index, entry, _Turn(index, ledger, place)), daemon=True)
            thread.start()
        except Exception as error:  # noqa: BLE001 - nothing one file does may stop the files after it
            if place is not None:
                place.release()
            ledger.leave(index)
            show(index, unexpected(error))
            continue
        threads.append(thread)
    for thread in threads:
        thread.join()
    return 1 if any(line["status"] not in ("fetched", "present") for line in lines) else 0


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else list(argv)
    args = _quick_args(argv)
    if args is None:
        parser = _parser()
        args = parser.parse_args(argv)
        if args.manifest is not None:
            if any(getattr(args, key) is not None for key in _PER_FILE_ONLY) or args.mirror:
                parser.error("--url, --dest, --sha256, --md5, --pin and --mirror come from the manifest's lines, not beside "
                             "--manifest")
        elif args.url is None or args.dest is None or (args.sha256 is None and args.md5 is None and args.pin is None):
            parser.error("--url, --dest and one of --sha256, --md5 or --pin is required (or --manifest FILE)")
    if args.manifest is not None:
        return _run_manifest(args)
    expected = ("pin", args.pin) if args.pin is not None else (("sha256", (args.sha256 or "").lower()) if args.sha256 is not None else ("md5", (args.md5 or "").lower()))
    line = _fetch_line(args.url, args.dest, expected, source_limit=args.source_limit, min_free=args.min_free,
                       timeout=args.timeout, attempts=args.attempts, min_rate=args.min_rate, segments=args.segments,
                       segment_threshold=args.segment_threshold, mirrors=args.mirror, ca_file=args.ca_file,
                       allow_loopback=args.allow_loopback)
    print(json.dumps(line))
    return 0 if line["status"] in ("fetched", "present") else 1


if __name__ == "__main__":
    sys.exit(main())
