"""fetch.py against aria2c, measured the same way (D03 T04 §20, §21).

    python3 scripts/glimmer/fetch_bench.py [--size-mib 96] [--cap-mib 8] [--runs 5] [--latency-ms 20]
        [--gigabyte-mib 1024] [--deadline 900] [--out docs/glimmer/fetch-bench.json]

A local HTTPS server (a certificate for 127.0.0.1 made per run with this host's openssl, trusted through each tool's
own option, never by turning verification off) serves a seeded payload with range support, at most `--cap-mib` MiB a
second on each connection, with `--latency-ms` added before every answer (each request's delay measured, by kind).
Three scenarios: `drop`, the first transfer cut once an eighth of the file has been sent; `mirror`, the first URL
answering every request 503 and a second serving the file; `gigabyte` (`--gigabyte-mib`), each tool's first process
killed with the server holding every connection at exactly an eighth of the file written, and a second process
finishing it, which may fetch again no more than `RESUME_SLACK`. Tools: fetch.py on one stream and on four segments,
aria2c 1.37.0 on one connection and on four (`-x4 -s4 -k1M`, its control file saved every second), all with the same
tries, waits, timeouts, rate floor and published SHA-256; the gigabyte scenario runs the four-connection tools only.

The acceptance line (`acceptance()`, D03 T04 §21) compares fetch.py on four segments with aria2c on four connections
per scenario, at full precision: at least five runs of each, every run recovered, cut, intact and paying the latency
(and in the gigabyte scenario resumed), no more bytes refetched than aria2c, and a median time ratio with each tool's
own start-up (measured in the same run) taken off under its bar (`BARS`: the gigabyte file and the failing first URL
strictly under 1.00; §20's 96 MiB cut scenario within 1.10, as a regression guard). The raw ratio is kept beside it.
Figures go temp-then-rename to `--out` with every command (folders as placeholders), version, estimate and wall time;
every tool run and helper has a deadline, and its process group, servers and folders are always ended. The exit is 0
only when the bar is met. aria2c is `~/.local/aria2` (Ubuntu's signed packages unpacked there) or `aria2c` on PATH.
"""

import argparse
import hashlib
import ssl
import http.server
import json
import os
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

    def __init__(self, body: bytes, cap: int, failing: bool = False, tls: tuple[Path, Path] | None = None,
                 latency: float = 0.0):
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

    # `do_HEAD` is the name BaseHTTPRequestHandler dispatches a HEAD to.
    def do_HEAD(self):  # noqa: N802
        if self.refuse():
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.server.body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", '"bench"')
        self.end_headers()

    # `do_GET` is the name BaseHTTPRequestHandler dispatches a GET to.
    def do_GET(self):  # noqa: N802
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
                    # Rung only once the bytes up to the kill byte have all been written, never on a promise.
                    if server.kill_at is not None and server.sent >= server.kill_at:
                        server.reached.set()
                if held:
                    server.release.wait(60)  # nothing more is sent until the process is dead
                    return
                at += len(piece)
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
RESUME_SLACK = 4 * 1024 * 1024  # seconds a tool run may take before it is ended with its process group


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


def tool_saved(cwd: Path, since: float, at_kill: int) -> bool:
    """Whether a tool held at the kill byte has saved its progress, so killing it now tests its resume rather than the
    race with its next save (D00 T01 §14): aria2c rewrites its control file every second it runs, so one written since
    the hold holds all it had; fetch.py saves its ranges after each MiB, so its state must cover all but
    `RESUME_SLACK` of what it was sent."""
    source = cwd / "src"
    control = list(source.glob("*.aria2"))
    if control:
        return any(path.stat().st_mtime >= since for path in control)
    for state in (source / ".partial").glob("*.state.json"):
        try:
            segments = json.loads(state.read_text())["segments"]
            return sum(int(segment[2]) for segment in segments) >= at_kill - RESUME_SLACK
        except (OSError, ValueError, KeyError, TypeError, IndexError):
            return False  # caught mid-replace or unreadable: not yet known to be saved
    return False


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
    try:
        signalled = server.reached.wait(deadline) and first.poll() is None
        at_kill = server.sent
        # Held at the byte, the tool is killed only once it has saved what it had: polled, within the run's deadline.
        held = time.time()
        while signalled and first.poll() is None and time.monotonic() - began < deadline:
            if tool_saved(cwd, held, at_kill):
                saved = True
                break
            time.sleep(0.05)
    finally:
        end_group(first)  # whatever ended the wait (the signal, the deadline, Ctrl-C), the first process is gone
        server.release.set()
    killed = signalled and at_kill == kill_at
    # The dead process's connections end on this side before the second run starts.
    with server.lock:
        server.closed.wait_for(lambda: server.open == 0, timeout=max(1.0, deadline - (time.monotonic() - began)))
    before = server.sent
    with server.lock:
        server.kill_at = None
        server.phase = 2
    code = run_bounded(command, cwd, max(1.0, deadline - (time.monotonic() - began)))
    after = server.sent - before
    again = max(0, before + after - len(server.body))
    requests = [(start, sent) for phase, start, sent in server.log if phase == 2]
    return {"seconds": time.monotonic() - began, "code": code, "killed": killed, "saved": saved, "at_signal": at_kill,
            "at_kill": at_kill,
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
# interrupted (a cut connection, or a killed process resumed by a second), and the tools it compares.
FOUR = ("fetch.py (four segments)", "aria2c (four connections)")


def measure(size: int, cap: int, runs: int, latency: float = 0.02, gigabyte: int = 1 << 30,
            deadline: float = RUN_DEADLINE) -> dict:
    scenarios_spec = {
        "drop": {"size": size, "servers": (False,), "interrupt": "cut", "tools": None},
        "mirror": {"size": size, "servers": (True, False), "interrupt": "cut", "tools": None},
        "gigabyte": {"size": gigabyte, "servers": (False,), "interrupt": "kill", "tools": FOUR},
    }
    certificates = Path(tempfile.mkdtemp(prefix="fetch-bench-tls-"))
    try:
        return _measure(scenarios_spec, runs, cap, latency, deadline, make_certificate(certificates))
    finally:
        shutil.rmtree(certificates, ignore_errors=True)


def _measure(scenarios_spec: dict, runs: int, cap: int, latency: float, deadline: float, tls: tuple[Path, Path]) -> dict:
    estimate = sum(spec["size"] / (cap * (4 if spec["tools"] else 2.5)) * runs * len(spec["tools"] or tools(["URL"], "0", Path("D")))
                   for spec in scenarios_spec.values())
    print(f"fetch_bench: about {estimate / 60:.0f} minutes of transfer at {cap / 2**20:.0f} MiB/s a connection",
          file=sys.stderr)
    started = time.monotonic()
    scenarios, commands = {}, {}
    for scenario, spec in scenarios_spec.items():
        body = payload(spec["size"])
        sha = hashlib.sha256(body).hexdigest()
        results = {}
        for name in tools(["URL"], sha, Path("DIR")):
            if spec["tools"] and name not in spec["tools"]:
                continue
            rows = []
            for _ in range(runs):
                servers = [Bench(body, cap, failing=failing, tls=tls, latency=latency) for failing in spec["servers"]]
                for server in servers:
                    threading.Thread(target=server.serve_forever, daemon=True).start()
                    server.dropped = spec["interrupt"] != "cut"  # a killed process is the interruption instead
                work = Path(tempfile.mkdtemp(prefix="fetch-bench-"))
                try:  # the run's servers and folder are always ended, whatever the run raised
                    (work / "src").mkdir()
                    urls = [f"{server.scheme}://127.0.0.1:{server.server_address[1]}/payload.bin" for server in servers]
                    command = tools(urls, sha, work, ca=tls[0])[name]
                    shown = command
                    for index, address in enumerate(urls):
                        shown = [part.replace(address, "<url>" if index == 0 else f"<mirror {index}>") for part in shown]
                    shown = [part.replace(str(tls[0]), "<certificate>") for part in shown]
                    commands.setdefault(scenario, {})[name] = [portable(part, "<url>", work) for part in shown]
                    kill = None
                    if spec["interrupt"] == "kill":
                        run = killed_and_resumed(command, work, servers[-1], spec["size"] // 8, deadline)
                        seconds, code, cut, resumed = run["seconds"], run["code"], run["killed"], run["resumed"]
                        kill = {key: run[key] for key in ("at_signal", "at_kill", "second_bytes", "second_requests")}
                    else:
                        began = time.monotonic()
                        code = run_bounded(command, work, deadline)
                        seconds, cut, resumed = time.monotonic() - began, sum(s.drops for s in servers) > 0, None
                    intact = file_sha256(work / "src" / "data.bin") == sha
                    sent = sum(server.sent for server in servers)
                    # Every request of every server paid the latency, measured, not counted (a sleep removed shows here).
                    paid = all(s.delayed == s.requests > 0 and min(w for _, w in s.waits) >= latency * 0.95 for s in servers)
                    row = {"seconds": seconds, "refetched": max(0, sent - spec["size"]), "recovered": code == 0,
                           "intact": intact, "cut": cut, "latency": paid,
                           "waits": sorted({kind for s in servers for kind, _ in s.waits})}
                    if resumed is not None:
                        row["resumed"] = resumed
                        row["kill"] = kill
                    rows.append(row)
                finally:
                    for server in servers:
                        server.shutdown()
                        server.server_close()
                    shutil.rmtree(work, ignore_errors=True)
            results[name] = {
                # Full precision: the acceptance line judges these, unrounded.
                "median_seconds": statistics.median(r["seconds"] for r in rows),
                "startup_seconds": startup_seconds(name),
                "median_refetched_bytes": int(statistics.median(r["refetched"] for r in rows)),
                **{check: sum(r[check] for r in rows) for check in ("recovered", "intact", "cut", "latency")},
                **({"resumed": sum(r["resumed"] for r in rows)} if "resumed" in rows[0] else {}),
                "runs": runs,
                "seconds": [r["seconds"] for r in rows],
                "waits": sorted({kind for r in rows for kind in r["waits"]}),
                **({"kills": [r["kill"] for r in rows]} if "kill" in rows[0] else {}),
            }
        scenarios[scenario] = {"payload_bytes": spec["size"], "payload_sha256": sha, **results}
    binary = aria2c()
    version = (subprocess.run([*binary, "--version"], capture_output=True, text=True, timeout=HELPER_DEADLINE)
               .stdout.splitlines()[0] if binary else None)
    return {"cap_bytes_per_connection": cap,
            "transport": f"HTTPS, a certificate for 127.0.0.1 made per run by {openssl_version()}, trusted through each "
                         "tool's own option", "latency_ms": round(latency * 1000),
            "estimate_seconds": round(estimate), "wall_seconds": round(time.monotonic() - started),
            "aria2c": version or "not installed: only fetch.py was measured", "commands": commands,
            "scenarios": scenarios, "acceptance": acceptance(scenarios)}


# The scenarios D03 T04 §21's bar is judged on, and the evidence each must carry; one missing is a bar not met. The
# gigabyte file (a dataset's size, killed and resumed) and the failing first URL must beat aria2c; §20's 96 MiB cut
# scenario must stay within §20's 10 percent (a regression guard: its last round trip is D03 T04 §23's).
REQUIRED = ("drop", "mirror", "gigabyte")
BARS = {"drop": 1.10, "mirror": 1.0, "gigabyte": 1.0}
EVIDENCE = {"drop": ("latency",), "mirror": ("latency",), "gigabyte": ("latency", "resumed")}
MIN_RUNS = 5
OURS, THEIRS = "fetch.py (four segments)", "aria2c (four connections)"


def acceptance(scenarios: dict, required: tuple[str, ...] = REQUIRED) -> dict:
    """The bar D03 T04 §21 sets, per scenario and overall: fetch.py on four segments against aria2c on four connections,
    every run of both tools recovered (exit 0), cut, intact (the file's digest matched; aria2c checks its own too) and,
    where the scenario resumes in a second process, resumed there; no more bytes refetched than aria2c; and a median
    time ratio, unrounded, strictly under 1.00 with each tool's own start-up (measured in the same run) taken off its
    time, so the bar judges the download, not a Python interpreter against a C program's start (decided 2026-10-29,
    D03 T04 §21; the raw ratio is kept beside it)."""
    verdicts = {}
    for scenario in sorted(set(required) | set(scenarios)):
        results = scenarios.get(scenario)
        ours, theirs = (results or {}).get(OURS), (results or {}).get(THEIRS)
        if ours is None or theirs is None:
            verdicts[scenario] = {"met": False, "reason": "not measured for both tools"}
            continue
        ratio = ours["median_seconds"] / theirs["median_seconds"] if theirs["median_seconds"] else float("inf")
        ours_net = ours["median_seconds"] - ours.get("startup_seconds", 0.0)
        theirs_net = theirs["median_seconds"] - theirs.get("startup_seconds", 0.0)
        net = ours_net / theirs_net if theirs_net > 0 else float("inf")
        checks = ["recovered", "cut", "intact", *EVIDENCE.get(scenario, ("latency",))]
        whole = all(row["runs"] >= MIN_RUNS and row.get(check) == row["runs"] for row in (ours, theirs) for check in checks)
        bar = BARS.get(scenario, 1.0)
        met = (net < bar if bar == 1.0 else net <= bar) and ours["median_refetched_bytes"] <= theirs["median_refetched_bytes"] and whole
        verdicts[scenario] = {"met": met, "bar": bar, "net_ratio": net, "time_ratio": ratio,
                              "startup": [ours.get("startup_seconds", 0.0), theirs.get("startup_seconds", 0.0)],
                              "refetched": [ours["median_refetched_bytes"], theirs["median_refetched_bytes"]],
                              **{check: [ours.get(check), theirs.get(check)] for check in checks}}
    verdicts["all"] = {"met": all(v["met"] for name, v in verdicts.items() if name != "all"), "required": list(required)}
    return verdicts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--size-mib", type=float, default=96)
    parser.add_argument("--cap-mib", type=float, default=8)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--latency-ms", type=float, default=20, help="added before every answer")
    parser.add_argument("--gigabyte-mib", type=float, default=1024, help="the size of the gigabyte scenario's file")
    parser.add_argument("--deadline", type=float, default=RUN_DEADLINE, help="seconds a tool run may take")
    parser.add_argument("--out", default=str(ROOT / "docs" / "glimmer" / "fetch-bench.json"))
    args = parser.parse_args(argv)
    if args.size_mib <= 0 or args.cap_mib <= 0 or args.runs < 1 or args.latency_ms < 0:
        print("--size-mib, --cap-mib and --runs must be positive", file=sys.stderr)
        return 2
    figures = measure(int(args.size_mib * 1024 * 1024), int(args.cap_mib * 1024 * 1024), args.runs, args.latency_ms / 1000,
                      int(args.gigabyte_mib * 1024 * 1024), args.deadline)
    figures["measured"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    out = Path(args.out)
    temporary = out.with_name(f"{out.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(figures, indent=1) + "\n", encoding="utf-8")
    os.replace(temporary, out)
    print(json.dumps({"scenarios": figures["scenarios"], "acceptance": figures["acceptance"]}))
    # The figures are kept either way; the exit says whether the bar was met, so automation cannot take a miss as a pass.
    return 0 if figures["acceptance"]["all"]["met"] else 1


if __name__ == "__main__":
    sys.exit(main())
