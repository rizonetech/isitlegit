"""fetch.py against aria2c, measured the same way (D03 T04 §20).

    python3 scripts/glimmer/fetch_bench.py [--size-mib 96] [--cap-mib 8] [--runs 5] [--out docs/glimmer/fetch-bench.json]

A local server serves a seeded payload (its SHA-256 recorded) with range support, at most `--cap-mib` MiB a second on
each connection (as a dataset host caps one connection). Two scenarios: `drop`, where each run's first transfer is cut
once it has sent an eighth of the file (12 MiB of 96: inside the first range of every tool, since aria2c's first
connection reads only its quarter of the file and a cut at half of what it asked for never reached it), and `mirror`, where the first URL answers every request `503` and a second URL (the same
file, cut the same way) has to serve it. Each tool fetches it `--runs` times per scenario under one recorded
configuration: `fetch.py` on one stream and on four segments, aria2c on one connection and on four (`-x4 -s4 -k1M`),
all with 3 tries, a 1-second retry wait, 30-second connect and read timeouts, a 16 KiB/s rate floor and the published
SHA-256 (in the mirror scenario `fetch.py` takes `--mirror` and aria2c both URLs, with `--max-tries=6` on both, since
aria2c spends its tries per URL). The medians of time and of bytes sent beyond one copy of the file (refetched),
whether the run recovered (exit 0) and whether the file's digest matched are written temp-then-rename to `--out`,
with each tool's exact command and version and the acceptance line (D03 T04 §20): `fetch.py` on four segments no more
than 10 percent slower than aria2c on four connections, refetching no more, and intact in every run. aria2c is
`~/.local/aria2` (Ubuntu's signed packages unpacked there) or `aria2c` on PATH; without it only `fetch.py` is measured.
"""

import argparse
import hashlib
import http.server
import json
import os
import shutil
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


class Bench(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, body: bytes, cap: int, failing: bool = False):
        super().__init__(("127.0.0.1", 0), Handler)
        self.body = body
        self.cap = cap
        self.failing = failing
        self.dropped = False
        self.drops = 0  # cuts actually made: a run that was never cut measured no recovery
        self.sent = 0
        self.lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def refuse(self) -> bool:
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
            while at <= end:
                piece = body[at:min(end + 1, at + 65536)]
                if drop_at is not None and at + len(piece) >= drop_at:
                    # The piece that reaches the cut point, even exactly on a piece boundary, is the last one sent.
                    piece = body[at:drop_at]
                    self.wfile.write(piece)
                    self.wfile.flush()
                    with server.lock:
                        server.sent += len(piece)
                        server.drops += 1
                    self.connection.shutdown(2)
                    return
                self.wfile.write(piece)
                with server.lock:
                    server.sent += len(piece)
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


def tools(urls: list[str], sha: str, dest: Path) -> dict[str, list[str]]:
    """Each tool's command for the URLs (the first, then mirrors), under the one configuration."""
    tries = "3" if len(urls) == 1 else "6"
    fetch = [sys.executable, "-I", str(FETCH), "--url", urls[0], "--dest", "src/data.bin", "--sha256", sha,
             "--allow-loopback", "--min-free", "0", "--source-limit", str(10**12), "--attempts", tries, "--timeout", "30",
             "--min-rate", str(16 * 1024)]
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
                  "-o", "data.bin"]
        out["aria2c (one connection)"] = [*binary, "-x1", "-s1", *common, *urls]
        out["aria2c (four connections)"] = [*binary, "-x4", "-s4", "-k1M", *common, *urls]
    return out


def portable(part: str, url: str, work: Path) -> str:
    """A command word as the figures file records it: the run's URL and folder, the repository and the home folder
    written as placeholders, so the file names no one's machine."""
    part = part.replace(url, "<url>").replace(str(work), "<dir>").replace(str(ROOT), "<repo>")
    return part.replace(str(Path.home()), "~")


def measure(size: int, cap: int, runs: int) -> dict:
    body = payload(size)
    sha = hashlib.sha256(body).hexdigest()
    scenarios = {}
    commands = {}
    for scenario in ("drop", "mirror"):
        results = {}
        for name in tools(["URL"], sha, Path("DIR")):
            rows = []
            for _ in range(runs):
                servers = [Bench(body, cap)] if scenario == "drop" else [Bench(body, cap, failing=True), Bench(body, cap)]
                for server in servers:
                    threading.Thread(target=server.serve_forever, daemon=True).start()
                urls = [f"http://127.0.0.1:{server.server_address[1]}/payload.bin" for server in servers]
                work = Path(tempfile.mkdtemp(prefix="fetch-bench-"))
                (work / "src").mkdir()
                command = tools(urls, sha, work)[name]
                shown = command
                for index, address in enumerate(urls):
                    shown = [part.replace(address, "<url>" if index == 0 else f"<mirror {index}>") for part in shown]
                commands.setdefault(scenario, {})[name] = [portable(part, "<url>", work) for part in shown]
                began = time.monotonic()
                done = subprocess.run(command, cwd=work, capture_output=True, text=True, check=False)
                seconds = time.monotonic() - began
                got = work / "src" / "data.bin"
                intact = got.exists() and hashlib.sha256(got.read_bytes()).hexdigest() == sha
                sent = sum(server.sent for server in servers)
                rows.append({"seconds": seconds, "refetched": max(0, sent - size), "recovered": done.returncode == 0,
                             "intact": intact, "cut": sum(server.drops for server in servers) > 0})
                for server in servers:
                    server.shutdown()
                    server.server_close()
                shutil.rmtree(work, ignore_errors=True)
            results[name] = {
                "median_seconds": round(statistics.median(r["seconds"] for r in rows), 2),
                "median_refetched_bytes": int(statistics.median(r["refetched"] for r in rows)),
                "recovered": sum(r["recovered"] for r in rows),
                "intact": sum(r["intact"] for r in rows),
                "cut": sum(r["cut"] for r in rows),
                "runs": runs,
            }
        scenarios[scenario] = results
    binary = aria2c()
    version = subprocess.run([*binary, "--version"], capture_output=True, text=True).stdout.splitlines()[0] if binary else None
    return {"payload_bytes": size, "payload_sha256": sha, "cap_bytes_per_connection": cap,
            "aria2c": version or "not installed: only fetch.py was measured", "commands": commands,
            "scenarios": scenarios, "acceptance": acceptance(scenarios)}


def acceptance(scenarios: dict) -> dict:
    """The bar D03 T04 §20 set, judged per scenario: fetch.py on four segments against aria2c on four connections."""
    verdicts = {}
    for scenario, results in scenarios.items():
        ours, theirs = results.get("fetch.py (four segments)"), results.get("aria2c (four connections)")
        if ours is None or theirs is None:
            verdicts[scenario] = {"met": None, "reason": "aria2c was not measured"}
            continue
        ratio = ours["median_seconds"] / theirs["median_seconds"] if theirs["median_seconds"] else float("inf")
        # Every run of both tools must have been cut: a run the server never interrupted proves no recovery.
        # Every compared run must have recovered (exit 0) and been cut, for both tools, and ours left the file intact.
        whole = all(row.get("recovered") == row["runs"] and row.get("cut") == row["runs"] for row in (ours, theirs))
        met = (ratio <= 1.10 and ours["median_refetched_bytes"] <= theirs["median_refetched_bytes"]
               and ours["intact"] == ours["runs"] and whole)
        verdicts[scenario] = {"met": met, "time_ratio": round(ratio, 3),
                              "refetched": [ours["median_refetched_bytes"], theirs["median_refetched_bytes"]],
                              "intact": [ours["intact"], ours["runs"]], "cut": [ours.get("cut"), theirs.get("cut")],
                              "recovered": [ours.get("recovered"), theirs.get("recovered")]}
    return verdicts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--size-mib", type=float, default=96)
    parser.add_argument("--cap-mib", type=float, default=8)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--out", default=str(ROOT / "docs" / "glimmer" / "fetch-bench.json"))
    args = parser.parse_args(argv)
    if args.size_mib <= 0 or args.cap_mib <= 0 or args.runs < 1:
        print("--size-mib, --cap-mib and --runs must be positive", file=sys.stderr)
        return 2
    figures = measure(int(args.size_mib * 1024 * 1024), int(args.cap_mib * 1024 * 1024), args.runs)
    figures["measured"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    out = Path(args.out)
    temporary = out.with_name(f"{out.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(figures, indent=1) + "\n", encoding="utf-8")
    os.replace(temporary, out)
    print(json.dumps({"scenarios": figures["scenarios"], "acceptance": figures["acceptance"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
