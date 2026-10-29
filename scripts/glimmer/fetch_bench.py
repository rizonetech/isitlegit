"""fetch.py against aria2c, measured the same way (D03 T04 §20).

    python3 scripts/glimmer/fetch_bench.py [--size-mib 96] [--cap-mib 8] [--runs 5] [--out docs/glimmer/fetch-bench.json]

A local server serves a seeded payload (its SHA-256 recorded) with range support, at most `--cap-mib` MiB a second on
each connection (as a dataset host caps one connection), and drops each run's first transfer at half its length. Each
tool fetches it `--runs` times under one recorded configuration: `fetch.py` (one stream, as built in §16), aria2c with
one connection, and aria2c with four (`-x4 -s4 -k1M`), all three with 3 tries, a 1-second retry wait, 30-second
connect and read timeouts, a 16 KiB/s rate floor and the published SHA-256. The medians of time, the bytes the server
sent past the first drop (refetched), whether the run recovered (exit 0) and whether the file's digest matched are
written temp-then-rename to `--out`, with each tool's exact command and version. aria2c is `~/.local/aria2` (Ubuntu's
signed packages unpacked there) or `aria2c` on PATH; without it, only `fetch.py` is measured and the file says so.
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

    def __init__(self, body: bytes, cap: int):
        super().__init__(("127.0.0.1", 0), Handler)
        self.body = body
        self.cap = cap
        self.dropped = False
        self.sent = 0
        self.lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # `do_GET` is the name BaseHTTPRequestHandler dispatches a GET to.
    def do_GET(self):  # noqa: N802
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
            drop_at = None if server.dropped else len(body) // 2
            server.dropped = True
        at, began = start, time.monotonic()
        try:
            while at <= end:
                piece = body[at:min(end + 1, at + 65536)]
                if drop_at is not None and at - start + len(piece) > drop_at - start and at < drop_at:
                    piece = body[at:drop_at]
                    self.wfile.write(piece)
                    with server.lock:
                        server.sent += len(piece)
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


def tools(url: str, sha: str, dest: Path) -> dict[str, list[str]]:
    out = {
        "fetch.py (one stream)": [sys.executable, "-I", str(FETCH), "--url", url, "--dest", "src/data.bin", "--sha256", sha,
                                  "--allow-loopback", "--min-free", "0", "--source-limit", str(10**12), "--attempts", "3",
                                  "--timeout", "30", "--min-rate", str(16 * 1024)],
    }
    binary = aria2c()
    if binary:
        common = [f"--checksum=sha-256={sha}", "--max-tries=3", "--retry-wait=1", "--lowest-speed-limit=16K",
                  "--connect-timeout=30", "--timeout=30", "--allow-overwrite=true", "--auto-file-renaming=false",
                  "--file-allocation=none", "--console-log-level=error", "--summary-interval=0", "-d", str(dest / "src"),
                  "-o", "data.bin"]
        out["aria2c (one connection)"] = [*binary, "-x1", "-s1", *common, url]
        out["aria2c (four connections)"] = [*binary, "-x4", "-s4", "-k1M", *common, url]
    return out


def portable(part: str, url: str, work: Path) -> str:
    """A command word as the figures file records it: the run's URL and folder, the repository and the home folder
    written as placeholders, so the file names no one's machine."""
    part = part.replace(url, "<url>").replace(str(work), "<dir>").replace(str(ROOT), "<repo>")
    return part.replace(str(Path.home()), "~")


def measure(size: int, cap: int, runs: int) -> dict:
    body = payload(size)
    sha = hashlib.sha256(body).hexdigest()
    results = {}
    commands = {}
    for name in tools("URL", sha, Path("DIR")):
        rows = []
        for _ in range(runs):
            server = Bench(body, cap)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            url = f"http://127.0.0.1:{server.server_address[1]}/payload.bin"
            work = Path(tempfile.mkdtemp(prefix="fetch-bench-"))
            (work / "src").mkdir()
            command = tools(url, sha, work)[name]
            commands[name] = [portable(part, url, work) for part in command]
            began = time.monotonic()
            done = subprocess.run(command, cwd=work, capture_output=True, text=True, check=False)
            seconds = time.monotonic() - began
            got = work / "src" / "data.bin"
            intact = got.exists() and hashlib.sha256(got.read_bytes()).hexdigest() == sha
            rows.append({"seconds": seconds, "refetched": max(0, server.sent - size // 2), "recovered": done.returncode == 0,
                         "intact": intact})
            server.shutdown()
            server.server_close()
            shutil.rmtree(work, ignore_errors=True)
        results[name] = {
            "median_seconds": round(statistics.median(r["seconds"] for r in rows), 2),
            "median_refetched_bytes": int(statistics.median(r["refetched"] for r in rows)),
            "recovered": sum(r["recovered"] for r in rows),
            "intact": sum(r["intact"] for r in rows),
            "runs": runs,
        }
    binary = aria2c()
    version = subprocess.run([*binary, "--version"], capture_output=True, text=True).stdout.splitlines()[0] if binary else None
    return {"payload_bytes": size, "payload_sha256": sha, "cap_bytes_per_connection": cap, "drop_at_bytes": size // 2,
            "aria2c": version or "not installed: only fetch.py was measured", "commands": commands, "results": results}


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
    print(json.dumps(figures["results"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
