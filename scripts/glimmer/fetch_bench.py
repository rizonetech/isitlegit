"""fetch.py against aria2c, measured the same way (D03 T04 §20, §21).

    python3 scripts/glimmer/fetch_bench.py [--size-mib 96] [--cap-mib 8] [--pairs 20] [--latency-ms 20]
        [--gigabyte-mib 1024] [--two-sources-mib N] [--deadline 900] [--require-wan] [--out docs/glimmer/fetch-bench.json]

A local HTTPS server (a certificate for 127.0.0.1 made per run with this host's openssl, trusted through each tool's
own option, never by turning verification off) serves a seeded payload with range support, at most `--cap-mib` MiB a
second on each connection, with `--latency-ms` added before every answer (each request's delay measured, by kind).
Three scenarios: `drop`, the first transfer cut once an eighth of the file has been sent; `mirror`, the first URL
answering every request 503 and a second serving the file; `gigabyte` (`--gigabyte-mib`), each tool's first process
killed with the server holding every connection at exactly an eighth of the file written, and a second process
finishing it, which may fetch again no more than `RESUME_SLACK`. Tools: fetch.py on one stream and on four segments,
aria2c 1.37.0 on one connection and on four (`-x4 -s4 -k1M`, its control file saved every second), all with the same
tries, waits, timeouts, rate floor and published SHA-256; the gigabyte scenario runs the four-connection tools only.

A fourth scenario, `two-sources` (D03 T04 §22): two hosts, each with its own aggregate cap shared by every connection
to it (`--cap-mib` a second on each host in all, not on each connection), four connections in all for each tool, both
URLs given to both tools, no interruption. Each host logs which bytes it served and when; a run is judged on its raw
launch-to-verified time, on both hosts transferring at the same time (their busy intervals overlap), and on at most
four connections open at once across the two.

Paired runs (D03 T04 §23): in every scenario the two tools of a comparison run as `--pairs` pairs (default 20), turn
about: fetch.py first in odd pairs, aria2c first in even ones, so a change in the host's load falls on both alike. The
comparisons are fetch.py on four segments against aria2c on four connections in every scenario, and, in `drop` and
`mirror`, fetch.py on one stream against aria2c on one connection. Every pair is kept with its id, order, both raw
launch-to-verified times and the host's load. A comparison's ratio is the median over its pairs of fetch.py's time over
aria2c's; its 95 percent interval is a paired bootstrap over the pairs (`RESAMPLES` resamples, fixed `SEED`). A pair in
which either run was not whole (not recovered, intact, cut or resumed as the scenario requires, or past its deadline)
is a loss for fetch.py, an infinite ratio, and is never dropped.

The acceptance line (`acceptance()`, D03 T04 §21, §23) judges every comparison of every required scenario on every
gate: at least `PAIRS` pairs, complete, in alternating order and matching the runs, every run of both tools whole, no
more bytes refetched than aria2c, and an interval whose upper bound is strictly under 1.00 (a constant or
non-positive-time interval is refused as degenerate). `REQUIRED` names the scenarios; the WAN scenarios
(`WAN_SCENARIOS`) are required only with `--require-wan`, until their measurement exists (D03 T04 §23).

Figures go temp-then-rename to `--out` with every command (folders as placeholders), version, estimate and wall time;
every tool run and helper has a deadline, and its process group, servers and folders are always ended. The exit is 0
only when every required comparison is met. aria2c is `~/.local/aria2` (Ubuntu's signed packages unpacked there) or
`aria2c` on PATH.
"""

import argparse
import contextlib
import hashlib
import ssl
import http.server
import json
import math
import os
import random
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FETCH = ROOT / "scripts" / "glimmer" / "fetch.py"
LOCAL_ARIA2 = Path.home() / ".local" / "aria2" / "root" / "usr"


def payload(size: int) -> bytes:
    """Seeded bytes: the same payload every run."""
    out = bytearray()
    block = hashlib.sha256(b"isitlegit fetch bench").digest()
    while len(out) < size:
        block = hashlib.sha256(block).digest()
        out += block * 64
    return bytes(out[:size])


HELPER_DEADLINE = 60  # seconds for each helper command (openssl, a start-up probe, a version)


def make_certificate(folder: Path) -> tuple[Path, Path]:
    """A self-signed certificate for 127.0.0.1 (its subject alternative name), made by this host's openssl for the
    run; each tool trusts it through its own option, never by turning verification off."""
    cert, key = folder / "bench-cert.pem", folder / "bench-key.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
                    "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
                   check=True, capture_output=True, timeout=HELPER_DEADLINE)
    return cert, key


def openssl_version() -> str:
    return subprocess.run(["openssl", "version"], capture_output=True, text=True, check=False,
                          timeout=HELPER_DEADLINE).stdout.strip()


class Bench(http.server.ThreadingHTTPServer):
    daemon_threads = True

    @contextlib.contextmanager
    def counted(self):
        meter = self.meter
        with meter["lock"]:
            meter["active"] += 1
            meter["peak"] = max(meter["peak"], meter["active"])
        try:
            yield
        finally:
            with meter["lock"]:
                meter["active"] -= 1

    def __init__(self, body: bytes, cap: int, failing: bool = False, tls: tuple[Path, Path] | None = None,
                 latency: float = 0.0, aggregate: bool = False):
        super().__init__(("127.0.0.1", 0), Handler)
        if tls is not None:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(tls[0]), str(tls[1]))
            # The handshake happens in each request's own thread, so one slow client never holds the others back.
            self.socket = context.wrap_socket(self.socket, server_side=True, do_handshake_on_connect=False)
        self.scheme = "https" if tls is not None else "http"
        self.latency = latency
        self.delayed = 0  # requests answered after the added latency: every one of them must be
        self.requests = 0
        self.waits: list[tuple[str, float]] = []  # each request's kind and the delay it actually paid
        self.kill_at: int | None = None  # bytes after which `reached` is set, so a run can be killed at that byte
        self.reached = threading.Event()
        self.release = threading.Event()  # set once the run being killed is dead: held connections may then end
        self.phase = 1
        self.log: list[tuple[int, int, int]] = []  # (phase, the first byte a GET asked for, the bytes it was sent)
        self.body = body
        self.cap = cap
        # A host's own cap shared by every connection to it (`aggregate`), as a dataset host's link is; otherwise the cap
        # holds on each connection, as a host that limits one stream does.
        self.aggregate = aggregate
        self.link_free = 0.0  # when this host's link has sent everything promised to it
        self.meter = {"active": 0, "peak": 0, "lock": threading.Lock()}  # requests open now and the most at once; shared by a run's hosts
        self.transfers: list[tuple[float, float, int, int]] = []  # each GET that sent bytes: began, ended, first byte, bytes
        self.failing = failing
        self.dropped = False
        self.drops = 0  # cuts actually made: a run that was never cut measured no recovery
        self.sent = 0  # bytes written to clients
        self.reserved = 0  # bytes promised to a write under way, so all connections together stop at the kill byte
        self.lock = threading.Lock()
        # Connections open now, and a condition signalled as each one ends: the second run starts once the first's
        # connections have all ended on this side, never after a guessed pause (D00 T01 §14).
        self.open = 0
        self.closed = threading.Condition(self.lock)
        # Each request's first byte and the bytes sent to it so far, live: what a held tool has received in each range
        # while no request has ended yet (the log records a request only at its end).
        self.progress: dict[int, int] = {}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self):
        with self.server.lock:
            self.server.open += 1
        super().setup()

    def finish(self):
        try:
            super().finish()
        finally:
            with self.server.lock:
                self.server.open -= 1
                self.server.closed.notify_all()

    # `do_HEAD` and `do_GET` are the names BaseHTTPRequestHandler dispatches to; each counts the request while it is open,
    # across every host that shares the run's meter.
    def do_HEAD(self):  # noqa: N802
        with self.server.counted():
            self.serve_head()

    def do_GET(self):  # noqa: N802
        with self.server.counted():
            self.serve_get()

    def log_message(self, *args):
        pass

    def wait(self):
        """The added latency, before any answer: every request pays it (the HEAD, each range, each retry, each refusal),
        and the delay it actually paid is recorded with its kind."""
        with self.server.lock:
            self.server.requests += 1
        began = time.monotonic()
        time.sleep(self.server.latency)
        paid = time.monotonic() - began
        kind = f"{self.command}{' range' if self.headers.get('Range') else ''}{' refused' if self.server.failing else ''}"
        with self.server.lock:
            self.server.delayed += 1
            self.server.waits.append((kind, paid))

    def refuse(self) -> bool:
        self.wait()
        if not self.server.failing:
            return False
        self.send_response(503)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def serve_head(self):
        if self.refuse():
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.server.body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", '"bench"')
        self.end_headers()

    def serve_get(self):
        if self.refuse():
            return
        server, body = self.server, self.server.body
        start, end = 0, len(body) - 1
        ranged = self.headers.get("Range")
        asked = int(ranged.split("=")[1].split("-")[0]) if ranged else 0
        phase = server.phase
        if ranged:
            first, _, last = ranged.split("=")[1].partition("-")
            start, end = int(first), int(last) if last else len(body) - 1
            if start >= len(body):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(body)}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            end = min(end, len(body) - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(body)}")
        else:
            self.send_response(200)
        self.send_header("ETag", '"bench"')
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with server.lock:
            # An eighth of the file into the first transfer, whatever range it asked for: the same byte for every tool.
            drop_at = None if server.dropped else min(end + 1, start + len(body) // 8)
            server.dropped = True
        at, began = start, time.monotonic()
        try:
            self.serve_body(server, body, start, end, at, began, drop_at)
        finally:
            with server.lock:
                server.log.append((phase, asked, self.body_sent))
                if self.body_sent:
                    server.transfers.append((began, time.monotonic(), asked, self.body_sent))

    def serve_body(self, server, body, start, end, at, began, drop_at):
        self.body_sent = 0
        try:
            while at <= end:
                piece = body[at:min(end + 1, at + 65536)]
                if drop_at is not None and at + len(piece) >= drop_at:
                    # The piece that reaches the cut point, even exactly on a piece boundary, is the last one sent.
                    piece = body[at:drop_at]
                    self.wfile.write(piece)
                    self.wfile.flush()
                    self.body_sent += len(piece)
                    with server.lock:
                        server.sent += len(piece)
                        server.reserved += len(piece)
                        server.drops += 1
                    self.connection.shutdown(2)
                    return
                with server.lock:
                    if server.kill_at is not None:
                        # Bytes are reserved under the lock: every connection together stops exactly at the kill byte.
                        piece = piece[:max(0, server.kill_at - server.reserved)]
                    server.reserved += len(piece)
                    held = server.kill_at is not None and server.reserved >= server.kill_at
                if piece:
                    try:
                        self.wfile.write(piece)
                        self.wfile.flush()
                    except OSError:
                        with server.lock:
                            server.reserved -= len(piece)  # not sent after all: another connection may send it
                        raise
                    self.body_sent += len(piece)
                with server.lock:
                    server.sent += len(piece)
                    server.progress[start] = self.body_sent
                    # Rung only once the bytes up to the kill byte have all been written, never on a promise.
                    if server.kill_at is not None and server.sent >= server.kill_at:
                        server.reached.set()
                if held:
                    server.release.wait(60)  # nothing more is sent until the process is dead
                    return
                at += len(piece)
                if server.aggregate:
                    # The host's cap: every connection to it together send no more than cap bytes a second, each
                    # write taking its share of the one link.
                    with server.lock:
                        server.link_free = max(server.link_free, time.monotonic()) + len(piece) / server.cap
                        due = server.link_free
                    ahead = due - time.monotonic()
                else:
                    # The per-connection cap: this connection never runs ahead of cap bytes a second.
                    ahead = (at - start) / server.cap - (time.monotonic() - began)
                if ahead > 0:
                    time.sleep(ahead)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # the client closed this connection (a segment finished or a retry began)


def aria2c() -> list[str] | None:
    local = LOCAL_ARIA2 / "bin" / "aria2c"
    if local.exists():
        return ["env", f"LD_LIBRARY_PATH={LOCAL_ARIA2 / 'lib' / 'x86_64-linux-gnu'}", str(local)]
    found = shutil.which("aria2c")
    return [found] if found else None


def tools(urls: list[str], sha: str, dest: Path, ca: Path | None = None) -> dict[str, list[str]]:
    """Each tool's command for the URLs (the first, then mirrors), under the one configuration; `ca`, the run's
    certificate, is trusted through each tool's own option."""
    tries = "3" if len(urls) == 1 else "6"
    fetch = [sys.executable, "-I", str(FETCH), "--url", urls[0], "--dest", "src/data.bin", "--sha256", sha,
             "--allow-loopback", "--min-free", "0", "--source-limit", str(10**12), "--attempts", tries, "--timeout", "30",
             "--min-rate", str(16 * 1024)] + (["--ca-file", str(ca)] if ca else [])
    for mirror in urls[1:]:
        fetch += ["--mirror", mirror]
    out = {
        "fetch.py (one stream)": [*fetch, "--segments", "1"],
        "fetch.py (four segments)": [*fetch, "--segments", "4", "--segment-threshold", str(1 << 20)],
    }
    binary = aria2c()
    if binary:
        common = [f"--checksum=sha-256={sha}", f"--max-tries={tries}", "--retry-wait=1", "--lowest-speed-limit=16K",
                  "--connect-timeout=30", "--timeout=30", "--allow-overwrite=true", "--auto-file-renaming=false",
                  "--file-allocation=none", "--console-log-level=error", "--summary-interval=0", "-d", str(dest / "src"),
                  "-o", "data.bin", "--continue=true", "--auto-save-interval=1"]
        # aria2c's own control file saved every second and read on a rerun, as fetch.py's range state is: a killed run
        # of either tool resumes from what it last saved.
        common += [f"--ca-certificate={ca}", "--check-certificate=true"] if ca else []
        out["aria2c (one connection)"] = [*binary, "-x1", "-s1", *common, *urls]
        out["aria2c (four connections)"] = [*binary, "-x4", "-s4", "-k1M", *common, *urls]
    return out


def portable(part: str, url: str, work: Path) -> str:
    """A command word as the figures file records it: the run's URL and folder, the repository and the home folder
    written as placeholders, so the file names no one's machine."""
    part = part.replace(url, "<url>").replace(str(work), "<dir>").replace(str(ROOT), "<repo>")
    return part.replace(str(Path.home()), "~")


def startup_seconds(tool: str) -> float:
    """A tool's own start-up, median of seven: fetch.py refusing a run before it connects (its interpreter, imports
    and argument checks), aria2c printing its version (its program and libraries loading)."""
    if tool.startswith("fetch.py"):
        command = [sys.executable, "-I", str(FETCH), "--url", "https://127.0.0.1:9/x", "--dest", "src/x", "--sha256", "bad"]
    else:
        binary = aria2c()
        if not binary:
            return 0.0
        command = [*binary, "--version"]
    times = []
    for _ in range(7):
        began = time.monotonic()
        subprocess.run(command, capture_output=True, check=False, cwd=tempfile.gettempdir(), timeout=HELPER_DEADLINE)
        times.append(time.monotonic() - began)
    return statistics.median(times)


RUN_DEADLINE = 900.0
# A resume may fetch again at most this much: a save interval's worth (fetch.py saves every MiB, aria2c every second and
# by 1 MiB pieces) plus the bytes in flight when the first process died. More is a restart, not a resume.
RESUME_SLACK = 4 * 1024 * 1024  # bytes a resumed tool may fetch again: four ranges' unsaved last MiB
# fetch.py saves a range's progress after each MiB it receives (`STATE_EVERY` in scripts/glimmer/fetch.py).
STATE_EVERY = 1024 * 1024


def run_bounded(command: list[str], cwd: Path, deadline: float = RUN_DEADLINE) -> int | None:
    """The tool's exit code, or None when it passed the deadline and was ended (its whole process group)."""
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    try:
        return process.wait(timeout=deadline)
    except subprocess.TimeoutExpired:
        return None
    finally:
        if process.poll() is None:
            end_group(process)  # past the deadline, or the harness interrupted: no tool outlives its run


def file_sha256(path: Path) -> str | None:
    if not path.exists():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 22), b""):
            digest.update(block)
    return digest.hexdigest()


def saved_ranges(cwd: Path) -> list[tuple[int, int, int]] | None:
    """fetch.py's ranges from its state file: each one's first byte, the byte after its last, and the byte after its
    last saved one; None when there is no state file or it cannot be read (caught mid-replace, or another tool's)."""
    for state in (cwd / "src" / ".partial").glob("*.state.json"):
        try:
            return [(int(seg[0]), int(seg[1]) + 1, int(seg[0]) + int(seg[2]))
                    for seg in json.loads(state.read_text())["segments"]]
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            return None
    return None


def tool_saved(cwd: Path, since: float, progress: dict[int, int]) -> bool:
    """Whether a tool held at the kill byte has saved its progress, so killing it now tests its resume rather than the
    race with its next save (D00 T01 §14). aria2c rewrites its control file every second it runs, so one written since
    the hold holds all it had. fetch.py saves each range after every MiB it receives (`STATE_EVERY`), so each range must
    be saved to within a MiB of the furthest byte the server sent into it (`progress`: each request's first byte and
    the bytes sent to it), whatever the other ranges hold (plan review)."""
    control = list((cwd / "src").glob("*.aria2"))
    if control:
        return any(path.stat().st_mtime >= since for path in control)
    ranges = saved_ranges(cwd)
    if ranges is None:
        return False
    for first, end, saved_to in ranges:
        reached = max((start + sent for start, sent in progress.items() if first <= start < end), default=first)
        if saved_to < reached - STATE_EVERY:
            return False
    return True


def killed_and_resumed(command: list[str], cwd: Path, server: "Bench", kill_at: int, deadline: float) -> dict:
    """The first process killed (SIGKILL, its whole group) with the server holding every connection at exactly
    `kill_at` bytes sent, so both tools die at the same byte; then a second process started on the same folder. Time and
    bytes count across both. Recorded: the bytes at the kill (which must equal `kill_at`, or the run does not count as
    cut), the second process's bytes, the bytes fetched twice, and each of its requests' first byte and bytes.
    `resumed`: the second process fetched again no more than `RESUME_SLACK` (what the first saved, kept)."""
    server.kill_at = kill_at
    began = time.monotonic()
    first = subprocess.Popen(command, cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    saved = False
    kept: list[tuple[int, int, int]] | None = None
    try:
        signalled = server.reached.wait(deadline) and first.poll() is None
        at_kill = server.sent
        # Held at the byte, the tool is killed only once it has saved what it had: polled, within the run's deadline.
        held = time.time()
        while signalled and first.poll() is None and time.monotonic() - began < deadline:
            with server.lock:
                progress = dict(server.progress)
            if tool_saved(cwd, held, progress):
                saved = True
                kept = saved_ranges(cwd)
                break
            time.sleep(0.05)
    finally:
        end_group(first)  # whatever ended the wait (the signal, the deadline, Ctrl-C), the first process is gone
        server.release.set()
    killed = signalled and at_kill == kill_at
    # The dead process's connections end on this side before the second run starts.
    with server.lock:
        closed = server.closed.wait_for(lambda: server.open == 0,
                                        timeout=max(1.0, deadline - (time.monotonic() - began)))
    if not (saved and closed):
        # A wait that never ended is a failed measurement, never a resume measured anyway (plan review): no second run.
        reason = "the tool never saved its progress" if not saved else "the first run's connections never closed"
        return {"seconds": time.monotonic() - began, "code": None, "killed": killed, "saved": saved, "closed": closed,
                "failed": reason, "at_signal": at_kill, "at_kill": at_kill, "kept": kept, "second_bytes": 0,
                "fetched_twice": 0, "second_requests": [], "resumed": False}
    before = server.sent
    with server.lock:
        server.kill_at = None
        server.phase = 2
    code = run_bounded(command, cwd, max(1.0, deadline - (time.monotonic() - began)))
    after = server.sent - before
    again = max(0, before + after - len(server.body))
    requests = [(start, sent) for phase, start, sent in server.log if phase == 2]
    return {"seconds": time.monotonic() - began, "code": code, "killed": killed, "saved": saved, "closed": closed,
            "failed": None, "kept": kept, "at_signal": at_kill, "at_kill": at_kill,
            "second_bytes": after, "fetched_twice": again, "second_requests": sorted(requests)[:16],
            "resumed": killed and code == 0 and again <= RESUME_SLACK}


def end_group(process: subprocess.Popen) -> None:
    """The process and everything it started, killed and reaped."""
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # it had ended, its group with it
    process.wait()


def server_size(server: "Bench") -> int:
    return len(server.body)


# Each scenario: its payload, its servers (False a healthy one, True one answering every request 503), how each run is
# interrupted (a cut connection, a killed process resumed by a second, or not at all), and the tools it compares.
# `hosts` marks the scenario of two healthy hosts each with its own aggregate cap. The tools of each comparison run
# as paired, alternating runs (`COMPARISONS`, `PAIRS`).
FOUR = ("fetch.py (four segments)", "aria2c (four connections)")
OVERLAP_SHARE = 0.25  # the share of the shorter host's busy time that both hosts must be busy together for it to count
MAX_CONNECTIONS = 4  # the most requests open at once, across both hosts, for a tool run with four connections


def measure(size: int, cap: int, pairs: int, latency: float = 0.02, gigabyte: int = 1 << 30,
            deadline: float = RUN_DEADLINE, two_sources: int | None = None, required: tuple[str, ...] | None = None) -> dict:
    scenarios_spec = {
        "drop": {"size": size, "servers": (False,), "interrupt": "cut", "tools": None},
        "mirror": {"size": size, "servers": (True, False), "interrupt": "cut", "tools": None},
        "gigabyte": {"size": gigabyte, "servers": (False,), "interrupt": "kill", "tools": FOUR},
        "two-sources": {"size": two_sources or size, "servers": (False, False), "interrupt": None, "tools": FOUR,
                        "hosts": True},
    }
    certificates = Path(tempfile.mkdtemp(prefix="fetch-bench-tls-"))
    try:
        return _measure(scenarios_spec, pairs, cap, latency, deadline, make_certificate(certificates), required)
    finally:
        shutil.rmtree(certificates, ignore_errors=True)


def busy(transfers: list, launched: float) -> list[tuple[float, float]]:
    """A host's busy intervals, seconds after launch, merged: the spans in which it was sending a body."""
    merged: list[list[float]] = []
    for began, ended, _, _ in sorted(transfers):
        span = [began - launched, ended - launched]
        if merged and span[0] <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], span[1])
        else:
            merged.append(span)
    return [(a, b) for a, b in merged]


def together(first: list[tuple[float, float]], second: list[tuple[float, float]]) -> float:
    """The seconds both sets of intervals (each merged and sorted) cover at once."""
    total = 0.0
    for a, b in first:
        for c, d in second:
            total += max(0.0, min(b, d) - max(a, c))
    return total


def both_hosts_busy(transfers: list[list], launched: float) -> tuple[bool, float]:
    """Whether the two hosts were sending at the same time (the share of the shorter one's busy time they were busy
    together is at least `OVERLAP_SHARE`), and the seconds of it: a tool that used one host after the other has none."""
    first, second = (busy(host, launched) for host in transfers)
    shorter = min(sum(b - a for a, b in first), sum(b - a for a, b in second))
    overlap = together(first, second)
    return shorter > 0 and overlap >= OVERLAP_SHARE * shorter, overlap


def one_run(spec: dict, scenario: str, name: str, body: bytes, sha: str, cap: int, latency: float, deadline: float,
            tls: tuple[Path, Path], commands: dict) -> dict:
    """One run of one tool: its servers and folder are made and always ended, whatever the run raised."""
    servers = [Bench(body, cap, failing=failing, tls=tls, latency=latency, aggregate=bool(spec.get("hosts")))
               for failing in spec["servers"]]
    meter = servers[0].meter
    for server in servers:
        server.meter = meter  # the hosts count their open requests together
        threading.Thread(target=server.serve_forever, daemon=True).start()
        server.dropped = spec["interrupt"] != "cut"  # a killed process, or no interruption, in place of a cut
    work = Path(tempfile.mkdtemp(prefix="fetch-bench-"))
    try:
        (work / "src").mkdir()
        urls = [f"{server.scheme}://127.0.0.1:{server.server_address[1]}/payload.bin" for server in servers]
        command = tools(urls, sha, work, ca=tls[0])[name]
        shown = command
        for index, address in enumerate(urls):
            shown = [part.replace(address, "<url>" if index == 0 else f"<mirror {index}>") for part in shown]
        shown = [part.replace(str(tls[0]), "<certificate>") for part in shown]
        commands.setdefault(scenario, {})[name] = [portable(part, "<url>", work) for part in shown]
        kill, resumed, launched, load = None, None, time.monotonic(), [os.getloadavg()[0]]
        if spec["interrupt"] == "kill":
            run = killed_and_resumed(command, work, servers[-1], spec["size"] // 8, deadline)
            seconds, code, cut, resumed = run["seconds"], run["code"], run["killed"], run["resumed"]
            kill = {key: run[key] for key in ("at_signal", "at_kill", "second_bytes", "second_requests", "kept",
                                          "failed")}
        else:
            code = run_bounded(command, work, deadline)
            seconds, cut = time.monotonic() - launched, sum(s.drops for s in servers) > 0
        load.append(os.getloadavg()[0])
        intact = file_sha256(work / "src" / "data.bin") == sha
        sent = sum(server.sent for server in servers)
        # Every request of every server paid the latency, measured, not counted (a sleep removed shows here).
        paid = all(s.delayed == s.requests > 0 and min(w for _, w in s.waits) >= latency * 0.95 for s in servers)
        row = {"seconds": seconds, "refetched": max(0, sent - spec["size"]), "recovered": code == 0,
               "intact": intact, "latency": paid, "load": load,
               "waits": sorted({kind for s in servers for kind, _ in s.waits})}
        if spec["interrupt"]:
            row["cut"] = cut
        if resumed is not None:
            row["resumed"] = resumed
            row["kill"] = kill
        if spec.get("hosts"):
            overlapped, overlap = both_hosts_busy([server.transfers for server in servers], launched)
            row.update({
                "overlap": overlapped, "overlap_seconds": overlap, "connections": meter["peak"] <= MAX_CONNECTIONS,
                "peak_connections": meter["peak"],
                # Which host served which bytes, and when (seconds after launch): first byte, bytes, began, ended.
                "hosts": [[[first, count, round(began - launched, 4), round(ended - launched, 4)]
                           for began, ended, first, count in sorted(server.transfers)] for server in servers]})
        return row
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()
        shutil.rmtree(work, ignore_errors=True)


def spec_checks(spec: dict) -> list[str]:
    """The gates every run of a scenario must hold, from its spec (`CHECKS` is the same list, judged from the record)."""
    return ["recovered", "intact", "latency", *(["cut"] if spec["interrupt"] else []),
            *(["overlap", "connections"] if spec.get("hosts") else [])]


def pair_record(number: int, order: tuple[str, str], rows: dict, checks: list[str]) -> dict:
    """One pair as the figures keep it: its id, which tool ran first (as a role, `ours` or `theirs`), both raw
    launch-to-verified times, whether each run was whole, and the host's load at each run's start and end."""
    ours, theirs = rows["ours"], rows["theirs"]

    def whole(row):
        return all(bool(row.get(check)) for check in checks) and bool(row.get("resumed", True))

    return {"pair": number, "order": list(order), "ours_seconds": ours["seconds"], "theirs_seconds": theirs["seconds"],
            "ours_whole": whole(ours), "theirs_whole": whole(theirs),
            "load": {"ours": ours.get("load"), "theirs": theirs.get("load")}}


def _measure(scenarios_spec: dict, pairs: int, cap: int, latency: float, deadline: float, tls: tuple[Path, Path],
             required: tuple[str, ...] | None = None) -> dict:
    estimate = sum(spec["size"] / (cap * (2 if spec.get("hosts") else 4 if spec["tools"] else 2.5)) * pairs
                   * len(spec["tools"] or tools(["URL"], "0", Path("D")))
                   for spec in scenarios_spec.values())
    print(f"fetch_bench: about {estimate / 60:.0f} minutes of transfer at {cap / 2**20:.0f} MiB/s a connection",
          file=sys.stderr)
    started = time.monotonic()
    scenarios, commands = {}, {}
    for scenario, spec in scenarios_spec.items():
        body = payload(spec["size"])
        sha = hashlib.sha256(body).hexdigest()
        names = [name for name in tools(["URL"], sha, Path("DIR")) if not spec["tools"] or name in spec["tools"]]
        checks = spec_checks(spec)
        rows: dict[str, list[dict]] = {name: [] for name in names}
        comparisons = {}

        def run(name):
            row = one_run(spec, scenario, name, body, sha, cap, latency, deadline, tls, commands)
            rows[name].append(row)
            return row

        for key in SCENARIO_COMPARISONS.get(scenario, ("four",)):
            ours_name, theirs_name = COMPARISONS[key]
            if ours_name not in names:
                continue
            if theirs_name not in names:
                for _ in range(pairs):  # aria2c is not installed: fetch.py alone, nothing to pair with
                    run(ours_name)
                continue
            records = []
            for number in range(1, pairs + 1):
                # Turn about: fetch.py first in odd pairs, aria2c first in even ones.
                order = ("ours", "theirs") if number % 2 else ("theirs", "ours")
                ran = {}
                for role in order:
                    ran[role] = run(ours_name if role == "ours" else theirs_name)
                records.append(pair_record(number, order, ran, checks))
            comparisons[key] = {"ours": ours_name, "theirs": theirs_name, "pairs": records,
                                "statistics": jsonable(paired_statistics(records))}
        results = {}
        for name in names:
            tool = rows[name]
            results[name] = {
                # Full precision: the acceptance line judges these, unrounded.
                "median_seconds": statistics.median(r["seconds"] for r in tool),
                "startup_seconds": startup_seconds(name),
                "median_refetched_bytes": int(statistics.median(r["refetched"] for r in tool)),
                **{check: sum(r[check] for r in tool) for check in checks},
                **({"resumed": sum(r["resumed"] for r in tool)} if "resumed" in tool[0] else {}),
                "runs": len(tool),
                "seconds": [r["seconds"] for r in tool],
                "load": [r["load"] for r in tool],
                "waits": sorted({kind for r in tool for kind in r["waits"]}),
                **({"kills": [r["kill"] for r in tool]} if "kill" in tool[0] else {}),
                **({"overlap_seconds": [r["overlap_seconds"] for r in tool],
                    "peak_connections": [r["peak_connections"] for r in tool],
                    "hosts": [r["hosts"] for r in tool]} if spec.get("hosts") else {}),
            }
        scenarios[scenario] = {"payload_bytes": spec["size"], "payload_sha256": sha, **results,
                               "comparisons": comparisons}
    binary = aria2c()
    version = (subprocess.run([*binary, "--version"], capture_output=True, text=True, timeout=HELPER_DEADLINE)
               .stdout.splitlines()[0] if binary else None)
    return {"cap_bytes_per_connection": cap,
            "cap_note": "per connection in drop, mirror and gigabyte; per host, shared by all its connections, in two-sources",
            "transport": f"HTTPS, a certificate for 127.0.0.1 made per run by {openssl_version()}, trusted through each "
                         "tool's own option", "latency_ms": round(latency * 1000), "pairs": pairs,
            "statistics": {"ratio": "median over pairs of fetch.py seconds over aria2c seconds, start-up included; "
                                    "a pair with either run not whole is a loss for fetch.py (infinite ratio, null)",
                           "interval": "95 percent, paired bootstrap over the pairs", "resamples": RESAMPLES, "seed": SEED},
            "estimate_seconds": round(estimate), "wall_seconds": round(time.monotonic() - started),
            "aria2c": version or "not installed: only fetch.py was measured", "commands": commands,
            "scenarios": scenarios, "acceptance": acceptance(scenarios, required or REQUIRED)}


# The scenarios the bar is judged on, and the evidence each must carry; one missing is a bar not met. Each is judged on
# every gate and on the paired statistics (D03 T04 §21, §22, §23): the 96 MiB cut scenario, the failing first URL, the
# gigabyte file (a dataset's size, killed and resumed) and two healthy hosts each capped as a whole must all beat
# aria2c, the raw launch-to-verified ratio's 95 percent interval entirely under 1.00.
REQUIRED = ("drop", "mirror", "gigabyte", "two-sources")
# The WAN scenarios (added delay with jitter, a varying cap, packet loss; D03 T04 §23, its WAN item) are required only
# with `--require-wan`: they do not exist yet, so requiring them by default would make the bench unrunnable. They are
# judged exactly as the others once measured.
WAN_SCENARIOS = ("wan-jitter", "wan-loss")
CHECKS = {"drop": ("recovered", "cut", "intact", "latency"), "mirror": ("recovered", "cut", "intact", "latency"),
          "gigabyte": ("recovered", "cut", "intact", "latency", "resumed"),
          "two-sources": ("recovered", "intact", "latency", "overlap", "connections")}
DEFAULT_CHECKS = ("recovered", "cut", "intact", "latency")
OURS, THEIRS = "fetch.py (four segments)", "aria2c (four connections)"
OURS_ONE, THEIRS_ONE = "fetch.py (one stream)", "aria2c (one connection)"
COMPARISONS = {"four": (OURS, THEIRS), "one": (OURS_ONE, THEIRS_ONE)}
# The comparisons each scenario is judged on: the one-stream rows are judged as the four-connection ones are, where
# the scenario runs them (gigabyte and two-sources run four-connection tools only).
SCENARIO_COMPARISONS = {"drop": ("four", "one"), "mirror": ("four", "one"), "gigabyte": ("four",),
                        "two-sources": ("four",)}
PAIRS = 20  # pairs a scenario's comparison runs, and the fewest the acceptance accepts
RESAMPLES = 10000  # bootstrap resamples of the pairs
SEED = 20261031  # fixed, so the same pairs give the same interval
CONFIDENCE = 0.95


def pair_ratio(pair: dict) -> float:
    """One pair's fetch.py time over aria2c's. A pair in which either run was not whole is a loss for fetch.py (an
    infinite ratio): it is counted, never dropped, and never turned into a finite figure."""
    if not (pair.get("ours_whole") and pair.get("theirs_whole")):
        return math.inf
    return pair["ours_seconds"] / pair["theirs_seconds"]


def median_of(values: list[float]) -> float:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def paired_statistics(pairs: list[dict], resamples: int = RESAMPLES, seed: int = SEED) -> dict:
    """The ratio (median over pairs of `pair_ratio`) and its 95 percent paired-bootstrap interval, or why the pairs
    cannot be judged: none, a pair id or order that is not 1, 2, 3 ... with fetch.py first in the odd ones, a time
    that is not a positive finite number, or ratios that are all the same (a constant interval hides whether the run
    measured anything). A loss is an infinite ratio, so a median that most pairs lose is infinite and its interval
    cannot sit under 1.00."""
    def invalid(reason):
        return {"valid": False, "reason": reason, "pairs": len(pairs), "failed_pairs": None, "ratio": None,
                "lower": None, "upper": None, "resamples": resamples, "seed": seed}

    if not pairs:
        return invalid("no pairs")
    for index, pair in enumerate(pairs, start=1):
        expected = ["ours", "theirs"] if index % 2 else ["theirs", "ours"]
        if pair.get("pair") != index or pair.get("order") != expected:
            return invalid(f"pair {index} is not in sequence and alternating order")
        for key in ("ours_seconds", "theirs_seconds"):
            value = pair.get(key)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not (0 < value < math.inf):
                return invalid(f"pair {index} has a time that is not positive and finite ({key})")
    ratios = [pair_ratio(pair) for pair in pairs]
    # Constant to within rounding (a clock that does not move, a replayed figure), or every pair a loss.
    finite = [r for r in ratios if r != math.inf]
    if len(finite) == len(ratios) and max(ratios) - min(ratios) <= 1e-9 * max(ratios) or len(set(ratios)) < 2:
        return invalid("every pair has the same ratio: a constant interval hides failures")
    rng = random.Random(seed)
    medians = sorted(median_of(rng.choices(ratios, k=len(ratios))) for _ in range(resamples))
    tail = (1 - CONFIDENCE) / 2
    lower, upper = medians[int(tail * resamples)], medians[math.ceil((1 - tail) * resamples) - 1]
    return {"valid": True, "reason": None, "pairs": len(pairs), "failed_pairs": sum(r == math.inf for r in ratios),
            "ratio": median_of(ratios), "lower": lower, "upper": upper, "resamples": resamples, "seed": seed}


def jsonable(figures: dict) -> dict:
    """Figures for the record: an infinite figure (a lost pair's ratio) is written as null, as strict JSON needs."""
    return {key: (None if isinstance(value, float) and not math.isfinite(value) else value)
            for key, value in figures.items()}


def acceptance(scenarios: dict, required: tuple[str, ...] = REQUIRED) -> dict:
    """The bar D03 T04 §21, §22 and §23 set, per comparison and overall. Each comparison of each scenario (fetch.py on
    four segments against aria2c on four connections, and in `drop` and `mirror` fetch.py on one stream against aria2c
    on one connection, judged the same way; a one-stream row left unjudged is a bar not met) is met only when every
    gate holds: every run of both tools whole (recovered, cut, intact, paying the latency and, where the scenario
    resumes in a second process, resumed), at least `PAIRS` runs of each, no more bytes refetched than aria2c, and
    `paired_statistics` valid over exactly those runs with the interval's upper bound strictly under 1.00. A timing
    win with a gate failed is not met. The ratio is raw (start-up included, D03 T04 §23); the earlier start-up-off
    figure is kept beside it for the record only. `all` is met only when every comparison of every required scenario
    is, and the command's exit follows it."""
    verdicts = {}
    for scenario in sorted(set(required) | set(scenarios)):
        results = scenarios.get(scenario) or {}
        for key in SCENARIO_COMPARISONS.get(scenario, ("four",)):
            label = scenario if key == "four" else f"{scenario} (one stream)"
            verdicts[label] = judge(scenario, key, results)
    verdicts["all"] = {"met": all(v["met"] for name, v in verdicts.items()), "required": list(required)}
    return verdicts


def judge(scenario: str, key: str, results: dict) -> dict:
    ours_name, theirs_name = COMPARISONS[key]
    ours, theirs = results.get(ours_name), results.get(theirs_name)
    if ours is None or theirs is None:
        return {"met": False, "reason": "not measured for both tools", "failed_gates": ["measured"]}
    checks = list(CHECKS.get(scenario, DEFAULT_CHECKS))
    pairs = ((results.get("comparisons") or {}).get(key) or {}).get("pairs") or []
    stats = paired_statistics(pairs)
    ratio = ours["median_seconds"] / theirs["median_seconds"] if theirs["median_seconds"] else float("inf")
    ours_net = ours["median_seconds"] - ours.get("startup_seconds", 0.0)
    theirs_net = theirs["median_seconds"] - theirs.get("startup_seconds", 0.0)
    net = ours_net / theirs_net if theirs_net > 0 else float("inf")
    runs_ok = (stats["pairs"] >= PAIRS and ours["runs"] >= PAIRS and ours["runs"] == theirs["runs"] == stats["pairs"])
    gates = {
        "pairs": stats["valid"] and runs_ok,
        "whole": all(row.get(check) == row["runs"] for row in (ours, theirs) for check in checks),
        "refetch": ours["median_refetched_bytes"] <= theirs["median_refetched_bytes"],
        "interval": stats["valid"] and stats["upper"] < 1.0,
    }
    return {"met": all(gates.values()), "failed_gates": [name for name, held in gates.items() if not held],
            "pairs": stats["pairs"], "failed_pairs": stats["failed_pairs"], "ratio": stats["ratio"],
            "interval": [stats["lower"], stats["upper"]], "statistics": stats["reason"],
            "time_ratio": ratio, "net_ratio": net, "judged_on": "raw, paired",
            "startup": [ours.get("startup_seconds", 0.0), theirs.get("startup_seconds", 0.0)],
            "refetched": [ours["median_refetched_bytes"], theirs["median_refetched_bytes"]],
            **{check: [ours.get(check), theirs.get(check)] for check in checks}}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--size-mib", type=float, default=96)
    parser.add_argument("--cap-mib", type=float, default=8)
    parser.add_argument("--pairs", "--runs", dest="pairs", type=int, default=PAIRS,
                        help="pairs of runs a scenario's comparison makes, fetch.py first in the odd ones")
    parser.add_argument("--latency-ms", type=float, default=20, help="added before every answer")
    parser.add_argument("--gigabyte-mib", type=float, default=1024, help="the size of the gigabyte scenario's file")
    parser.add_argument("--two-sources-mib", type=float, default=None,
                        help="the size of the two-sources scenario's file (default: --size-mib)")
    parser.add_argument("--require-wan", action="store_true",
                        help=f"also require the WAN scenarios ({', '.join(WAN_SCENARIOS)}), once they are measured")
    parser.add_argument("--deadline", type=float, default=RUN_DEADLINE, help="seconds a tool run may take")
    parser.add_argument("--out", default=str(ROOT / "docs" / "glimmer" / "fetch-bench.json"))
    args = parser.parse_args(argv)
    if args.size_mib <= 0 or args.cap_mib <= 0 or args.pairs < 1 or args.latency_ms < 0:
        print("--size-mib, --cap-mib and --pairs must be positive", file=sys.stderr)
        return 2
    figures = measure(int(args.size_mib * 1024 * 1024), int(args.cap_mib * 1024 * 1024), args.pairs, args.latency_ms / 1000,
                      int(args.gigabyte_mib * 1024 * 1024), args.deadline,
                      int(args.two_sources_mib * 1024 * 1024) if args.two_sources_mib else None,
                      REQUIRED + WAN_SCENARIOS if args.require_wan else REQUIRED)
    figures["measured"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    out = Path(args.out)
    temporary = out.with_name(f"{out.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(figures, indent=1) + "\n", encoding="utf-8")
    os.replace(temporary, out)
    print(json.dumps({"scenarios": figures["scenarios"], "acceptance": figures["acceptance"]}))
    # The figures are kept either way; the exit says whether every required comparison was met, so automation cannot take a miss as a pass.
    return 0 if figures["acceptance"]["all"]["met"] else 1


if __name__ == "__main__":
    sys.exit(main())
