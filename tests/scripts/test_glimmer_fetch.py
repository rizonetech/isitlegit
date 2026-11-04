"""scripts/glimmer/fetch.py (D03 T04 §16): a download that resumes where it stopped and accepts nothing unverified,
against a local server that can drop, lie about ranges, change the file, redirect, stall, throttle or fail."""
import contextlib
import errno
import fcntl
import io
import hashlib
import re
import http.server
import importlib.util
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "fetch.py"
spec = importlib.util.spec_from_file_location("fetch", SCRIPT)
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)

SIZE = 10 * 1024 * 1024
BODY = bytes((i * 7 + 3) % 251 for i in range(SIZE))
SHA = hashlib.sha256(BODY).hexdigest()
ROOMY = {"min_free": 0, "source_limit": 10 * SIZE}


def established(sock) -> bool:
    """The connection is open at both ends: no FIN or reset from its client has arrived and this side has not closed it
    (Linux's TCP_ESTABLISHED, 1), read from the kernel whatever unread bytes are ahead of the client's close."""
    try:
        return sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 1)[0] == 1
    except OSError:
        return False  # closed here already


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.modes = set()
        self.stall = 3  # seconds of nothing in the "stall" mode
        self.body = BODY
        self.etag = '"v1"'
        self.served = []  # bytes sent per request for /file
        self.requests = 0
        self.lock = threading.Lock()
        self.segment_requests = 0  # ranges asked with an end: what only the segmented path sends
        self.active = 0
        self.peak = 0  # the most segment requests open at once
        self.group = None  # a shared {"active", "peak", "lock"} when several servers count their open ranges together
        self.pace = 0.0  # seconds between 64 KiB pieces of a ranged answer, when set
        self.damaged = set()  # absolute offsets whose byte this server gets wrong, whichever request covers them
        self.flip_after = None  # after this many ranged requests the server's file has another validator
        self.ranges = []  # (first, last, when) of every ranged request, in arrival order
        self.asked = []  # (method, Range header or None) of every HEAD and GET of /file, in arrival order
        self.heads = 0
        self.head_at = []  # when each HEAD arrived (time.monotonic())
        self.range_pause = 0.0  # seconds a ranged request waits before it is answered
        self.trial_bodies = 0  # whole-file bodies begun and left waiting (`trial-stall`)
        self.head_pause = 0.0  # seconds each HEAD is held open, so concurrent HEADs are seen to overlap
        self.flip_etag = '"v2"'  # what the validator becomes at the flip (None: it stays)
        self.flip_body = None  # what the file becomes at the flip (None: it stays)
        # Seconds a paced answer stays open after its last piece, as a host pacing its link keeps the request open until
        # the pace of that piece is paid (the bench's host does): a new connection opened then is seen beside it.
        self.linger = 0.0
        self.hold_at = None  # paced bytes after which every paced answer holds where it is until `release` is set
        self.release = threading.Event()
        self.paced_sent = 0  # paced bytes sent in all, counted against `hold_at`
        # A shared {"open", "peak", "lock"} when several servers count the client's open connections together (TCP
        # connections, idle kept ones included, not requests in flight).
        self.sockets = None

    def process_request(self, request, client_address):
        tally = self.sockets
        if tally is not None:
            with tally["lock"]:
                # A connection its client has closed no longer counts, though its handler may not have seen the end
                # yet: on loopback the client's close arrives before its next connection's handshake, so it is read
                # here from the kernel's TCP state (a FIN or a reset has arrived, whatever unread bytes are ahead of
                # it) and a connection closed before the next one opens is never seen beside it.
                tally["open"] = {sock for sock in tally["open"] if established(sock)}
                tally["open"].add(request)
                tally["peak"] = max(tally["peak"], len(tally["open"]))
        super().process_request(request, client_address)

    def shutdown_request(self, request):
        tally = self.sockets
        if tally is not None:
            with tally["lock"]:
                tally["open"].discard(request)
        super().shutdown_request(request)

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            super().handle_error(request, client_address)  # a killed fetcher resets its connection, as it must


def count_open(server, step):
    """A HEAD or ranged GET opening (+1) or ending (-1) in the group of servers that count together, under the group's
    own lock (each server's lock guards only its own counts); with `hosts`, how many servers have one open at once."""
    group = server.group
    if group is None:
        return
    with group["lock"]:
        group["active"] += step
        # The requests the servers see at once; the connection cap is proven where fetch.py holds them (`share_peak`).
        group["server_peak"] = max(group.get("server_peak", 0), group["active"])
        hosts = group["hosts"]
        hosts[id(server)] = hosts.get(id(server), 0) + step
        group["together"] = max(group["together"], sum(1 for n in hosts.values() if n > 0))


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # `do_HEAD` is the name BaseHTTPRequestHandler dispatches a HEAD to.
    def do_HEAD(self):  # noqa: N802
        server = self.server
        with server.lock:
            server.heads += 1
            server.asked.append(("HEAD", None))
            server.head_at.append(time.monotonic())
        count_open(server, 1)
        try:
            time.sleep(server.head_pause)
            return self.answer_head()
        finally:
            count_open(server, -1)

    def answer_head(self):
        server, modes = self.server, self.server.modes
        if "head-429" in modes:
            self.send_response(429)
            self.send_header("Retry-After", "30")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if "head-trickle" in modes:
            # Headers a byte at a time, each well inside the socket timeout: only a rate check ends it.
            try:
                for byte in b"HTTP/1.1 200 OK\r\nX-Slow: " + b"x" * 200:
                    self.wfile.write(bytes([byte]))
                    self.wfile.flush()
                    time.sleep(0.05)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass  # the rate check cut it, as it must
            self.close_connection = True
            return
        if "fail" in modes or "no-head" in modes or "head-501" in modes:
            self.send_response(503 if "fail" in modes else 501 if "head-501" in modes else 405)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        if "no-length" not in modes:
            self.send_header("Content-Length", str(len(server.body) - 1 if "head-other-length" in modes else len(server.body)))
        if "no-accept-ranges" not in modes:
            self.send_header("Accept-Ranges", "none, bytes" if "listed-ranges" in modes else "bytes")
        if "date-only" in modes:
            self.send_header("Last-Modified", "Wed, 01 Jan 2025 00:00:00 GMT")  # as the GET names it
        elif "head-other-etag" in modes:
            self.send_header("ETag", '"head-only"')  # a validator the GET never gives
        else:
            self.send_header("ETag", 'W/"v1"' if "weak-etag" in modes else server.etag)
        if "encoding" in modes:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()

    # `do_GET` is the name BaseHTTPRequestHandler dispatches a GET to.
    def do_GET(self):  # noqa: N802
        ranged = self.headers.get("Range") or ""
        if self.path == "/file":
            with self.server.lock:
                self.server.asked.append(("GET", ranged or None))
        if re.fullmatch(r"bytes=\d+-\d+", ranged) and self.path == "/file":
            first, last = (int(n) for n in ranged.split("=")[1].split("-"))
            with self.server.lock:
                self.server.segment_requests += 1
                self.range_number = self.server.segment_requests  # this request's place in the order they arrived
                self.server.active += 1
                self.server.peak = max(self.server.peak, self.server.active)
                self.server.ranges.append((first, last, time.monotonic()))
                if self.server.flip_after is not None and self.server.segment_requests > self.server.flip_after:
                    self.server.etag = self.server.flip_etag or self.server.etag
                    self.server.body = self.server.flip_body or self.server.body
            count_open(self.server, 1)
            try:
                time.sleep(self.server.range_pause)
                return self.answer()
            finally:
                count_open(self.server, -1)
                with self.server.lock:
                    self.server.active -= 1
        return self.answer()

    def answer(self):
        server = self.server
        modes = server.modes
        if self.path == "/hop":
            target = "/loop" if "loop" in modes else "https://10.0.0.1/x" if "private" in modes else "/file"
            return self.redirect(target)
        if self.path == "/loop":
            return self.redirect("/loop")
        if self.path in ("/slow-framing", "/slow-framing-close"):
            # A chunked body whose first chunk-size line is a long extension sent a byte at a time.
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            if self.path.endswith("-close"):
                # http.client then drops the connection's own reference to the socket the response reads.
                self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(b"10;")
                for _ in range(200):
                    self.wfile.write(b"x")
                    self.wfile.flush()
                    time.sleep(0.05)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass  # the watchdog shut the connection, as it must
            return
        if self.path == "/asctime":
            self.send_response(200)
            self.send_header("Last-Modified", "Sun Nov  6 08:49:37 1994")
            self.send_header("Content-Length", str(len(server.body)))
            self.end_headers()
            self.wfile.write(server.body)
            return
        if self.path == "/endless-redirect":
            self.send_response(302)
            self.send_header("Location", "/file")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            try:
                for _ in range(10_000):
                    self.wfile.write(b"10000\r\n" + b"x" * 0x10000 + b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass  # the fetcher left the redirect's body unread, as it must
            return
        with server.lock:
            server.requests += 1
            n = server.requests
        if "fail" in modes or ("fail-after-first" in modes and n > 1) or ({"429-once", "429-date", "429-asctime"} & modes and n == 1):
            self.send_response(503 if "fail" in modes else 429)
            if "429-once" in modes:
                self.send_header("Retry-After", "1")
            if "429-date" in modes:
                self.send_header("Retry-After", self.date_time_string(time.time() + 20))
            if "429-asctime" in modes:
                self.send_header("Retry-After", time.strftime("%a %b %d %H:%M:%S %Y", time.gmtime(time.time() + 20)))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if "segment-404-after-first" in modes and re.fullmatch(r"bytes=\d+-\d+", self.headers.get("Range") or "") \
                and getattr(self, "range_number", 0) > 1:
            deadline = time.monotonic() + 10
            while not server.served and time.monotonic() < deadline:
                time.sleep(0.01)
            time.sleep(0.3)  # the first answer is whole and written before this one refuses
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if modes & {"first-range-429", "first-range-503"} and getattr(self, "range_number", 0) == 1:
            # Only the first ranged request to arrive (the first range, asked for beside the HEAD) is refused.
            self.send_response(429 if "first-range-429" in modes else 503)
            if "first-range-429" in modes:
                self.send_header("Retry-After", "30")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if "segment-403" in modes and re.fullmatch(r"bytes=\d+-\d+", self.headers.get("Range") or ""):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        ranged_get = bool(re.fullmatch(r"bytes=\d+-\d+", self.headers.get("Range") or ""))
        if ranged_get and modes & {"segment-503", "segment-429"}:
            self.send_response(503 if "segment-503" in modes else 429)
            if "segment-429" in modes:
                self.send_header("Retry-After", "30")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if ranged_get and "segment-private" in modes:
            return self.redirect("https://10.0.0.1/x")
        if "not-found" in modes:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = server.body
        ranged = self.headers.get("Range")
        validator_ok = self.headers.get("If-Range") in (None, server.etag, "Wed, 01 Jan 2025 00:00:00 GMT")
        honour = ranged and "ignore-range" not in modes and validator_ok
        if honour:
            start = int(ranged.split("=")[1].split("-")[0])
            if start >= len(body):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{'9' * 5000 if 'huge-416' in modes else len(body)}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            asked = ranged.split("=")[1].split("-")[1]
            end = min(int(asked), len(body) - 1) if asked else len(body) - 1
            segment = bool(asked)
            if "segment-short" in modes and segment:
                end = start + (end - start) // 2
            if "one-byte-ranges" in modes and segment:
                end = start
            if "short-ranges" in modes:
                end = min(end, start + SIZE // 4 - 1)
            if "segment-503-then-private" in modes and segment:
                with server.lock:
                    server.routed = getattr(server, "routed", 0) + 1
                    k = server.routed
                if k == 1:
                    self.send_response(503)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                time.sleep(0.3)  # after the 503 has moved the run on to the mirror
                return self.redirect("https://10.0.0.1/x")
            first = start + 1000 if "wrong-offset" in modes or ("segment-wrong-offset" in modes and segment) else start
            last = end + 5 if "bad-bounds" in modes else end
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {first}-{last}/{len(body)}")
            chunk = body[start:end + 1]
            for offset in server.damaged:
                if start <= offset <= end:
                    chunk = chunk[:offset - start] + bytes([chunk[offset - start] ^ 0xFF]) + chunk[offset - start + 1:]
            if "segment-corrupt" in modes and segment and start > 0:
                chunk = bytes(b ^ 0xFF for b in chunk[:16]) + chunk[16:]
            length = len(chunk) + (7 if "bad-length" in modes or ("segment-bad-length" in modes and segment) else 0)
            if "segment-huge" in modes and segment:
                self.send_header("Content-Range", f"bytes {start}-{end}/{'9' * 5000}")
            if "unknown-total" in modes:
                self.send_header("Content-Range", f"bytes {start}-{end}/*")  # a 206 that does not say the file's length
            if "encoding" in modes:
                self.send_header("Content-Encoding", "gzip")
        else:
            if "whole-404" in modes:
                self.send_response(404)  # a whole-file request this source cannot answer, whatever its ranges give
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(200)
            chunk = body
            for offset in server.damaged:
                chunk = chunk[:offset] + bytes([chunk[offset] ^ 0xFF]) + chunk[offset + 1:]
            length = len(chunk) - 1 if "whole-length" in modes else len(chunk)
            if "whole-gzip" in modes:
                self.send_header("Content-Encoding", "gzip")
        if "no-validator-on-range" in modes and honour:
            pass  # a 206 that names no representation
        elif "weak-etag" in modes or ("weak-etag-on-range" in modes and honour):
            self.send_header("ETag", 'W/"v2"' if "weak-etag-on-range" in modes else 'W/"v1"')
        elif "date-now" in modes:
            self.send_header("Last-Modified", self.date_time_string())
        elif "date-only" in modes:
            self.send_header("Last-Modified", "Wed, 01 Jan 2025 00:00:00 GMT")
        else:
            self.send_header("ETag", server.etag)
        chunked = "chunked" in modes
        if chunked:
            self.send_header("Transfer-Encoding", "chunked")
        elif "no-length" not in modes:
            self.send_header("Content-Length", str(length))
        else:
            self.send_header("Connection", "close")
        self.end_headers()
        cut = len(chunk)
        if "drop-once" in modes and n == 1:
            cut = int(len(chunk) * 0.9)
        if "drop-empty" in modes and n == 1:
            cut = 0  # the valid headers, then the connection closes before any byte
        if "corrupt-drop-once" in modes and n == 1:
            # Wrong bytes for the first half, then the connection drops: a host serving a damaged copy.
            chunk = bytes(len(chunk))
            cut = len(chunk) // 2
        segment = honour and bool(ranged.split("=")[1].split("-")[1])
        if "segment-drop-once" in modes and segment and start > 0:
            with server.lock:
                drop = not getattr(server, "dropped_segment", False)
                server.dropped_segment = True
            if drop:
                cut = len(chunk) // 2
        if "segment-stall" in modes and segment:
            try:
                self.wfile.write(chunk[:1 << 16])
                with server.lock:
                    server.served.append(1 << 16)
                time.sleep(5)  # then nothing: only the rate floor ends it
            except (BrokenPipeError, ConnectionResetError):
                pass  # the fetcher cut the stalled answer, as it must
            return
        if ("segment-slow" in modes and segment) or (server.pace and segment) or ("slow-first-range" in modes and segment and start == 0):
            try:
                for at in range(0, cut, 1 << 16):
                    piece = chunk[at:min(cut, at + (1 << 16))]
                    with server.lock:
                        if server.hold_at is not None:
                            piece = piece[:max(0, server.hold_at - server.paced_sent)]
                        server.paced_sent += len(piece)
                        holding = server.hold_at is not None and server.paced_sent >= server.hold_at
                    self.wfile.write(piece)
                    with server.lock:
                        server.served.append(len(piece))
                    if holding:
                        server.release.wait(30)  # every answer stops at the hold byte until the fetcher is gone
                        self.close_connection = True
                        return
                    if at + (1 << 16) < cut:  # none after the last piece: the answer ends when its bytes have gone
                        time.sleep(server.pace or 0.05)
                time.sleep(server.linger)
                if "close-after-answer" in modes:
                    # A keep-alive answer whose connection the server then ends unannounced (an idle timeout).
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the fetcher was killed mid-download, as the test means it to be
            return
        if "trial-stall" in modes and not ranged:
            try:
                self.wfile.write(chunk[:1 << 16])  # the first block of a whole-file body, then nothing for a while
                self.wfile.flush()
                with server.lock:
                    server.trial_bodies += 1
                time.sleep(8)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the fetcher was killed mid-body, as the test means it to be
            return
        if "stall" in modes:
            time.sleep(server.stall)
        if "trickle" in modes:
            try:
                for at in range(0, len(chunk), 1024):
                    self.wfile.write(chunk[at:at + 1024])
                    time.sleep(0.05)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the fetcher cut the trickle on purpose
            return
        try:
            if chunked:
                for at in range(0, cut, 1 << 16):
                    piece = chunk[at:min(cut, at + (1 << 16))]
                    self.wfile.write(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
                if cut == len(chunk):
                    self.wfile.write(b"0\r\n\r\n")
            else:
                self.wfile.write(chunk[:cut])
        except (BrokenPipeError, ConnectionResetError):
            pass  # the fetcher gave up on this response on purpose (a limit or a timeout case)
        server.served.append(cut)
        if cut < len(chunk) or "no-length" in modes:
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass  # already closed by the fetcher

    def redirect(self, target):
        self.send_response(302)
        self.send_header("Location", target)
        self.send_header("Content-Length", "0")
        self.end_headers()


def state(base, total=SIZE, validator='"v1"'):
    return json.dumps({"url": base + "/file", "expected": ["sha256", SHA], "validator": validator, "encoding": "identity", "total": total})


class Fetch(unittest.TestCase):
    def setUp(self):
        self.server = Server()
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.dir = Path(tempfile.mkdtemp(prefix="fetch-"))
        self.old = os.getcwd()
        os.chdir(self.dir)
        self.addCleanup(self.tear)

    def tear(self):
        os.chdir(self.old)
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_fetch(self, path="/file", sha=SHA, dest="src/data.bin", **kw):
        options = {**ROOMY, "timeout": 2, "sleep": lambda s: None, "log": lambda line: None, **kw}
        return fetch.fetch(self.base + path, dest, ("sha256", sha), allow_loopback=True, **options)

    def half_partial(self, validator='"v1"'):
        Path("src/.partial").mkdir(parents=True, exist_ok=True)
        Path("src/.partial/data.bin").write_bytes(BODY[: SIZE // 2])
        Path("src/.partial/data.bin.state.json").write_text(state(self.base, validator=validator))

    def cli(self, *args, sha=SHA):
        return subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin", "--sha256", sha,
             "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE), "--timeout", "2", *args],
            capture_output=True, text=True, cwd=self.dir, check=False)

    def test_the_exact_command_fetches_and_reports_from_a_store_folder(self):
        out = self.cli()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        line = json.loads(out.stdout)
        self.assertEqual((line["status"], line["sha256"], line["fetched"]), ("fetched", SHA, SIZE))
        self.assertEqual((self.dir / "src/data.bin").read_bytes(), BODY)
        self.assertFalse((self.dir / "src/.partial/data.bin").exists())

    LEAN = ("argparse", "shutil", "dataclasses", "inspect", "_colorize")  # not email.utils: http.client loads it itself

    def test_free_space_matches_shutil_and_falls_back_where_there_is_no_statvfs(self):
        import shutil
        from unittest import mock

        here = Path(tempfile.mkdtemp(prefix="free-"))
        self.addCleanup(shutil.rmtree, here, True)
        self.assertAlmostEqual(fetch._free_space(here), shutil.disk_usage(here).free, delta=64 * 1024 * 1024)
        # Where the system has no statvfs (Windows), shutil answers instead.
        usage = mock.Mock(free=12345)
        with mock.patch.object(fetch.os, "statvfs", create=True), mock.patch("shutil.disk_usage", return_value=usage):
            del fetch.os.statvfs
            self.assertEqual(fetch._free_space(here), 12345)

    def test_a_plain_download_does_not_import_what_only_rare_paths_need(self):
        # `-S` leaves out site and any sitecustomize, so only what fetch.py itself imports is counted.
        code = ("import json, runpy, sys\n"
                "sys.argv = ['fetch.py', *json.loads(sys.argv[1])]\n"
                "try:\n"
                "    runpy.run_path(%r, run_name='__main__')\n"
                "except SystemExit as stop:\n"
                "    code = stop.code\n"
                "else:\n"
                "    code = 0\n"
                "print(json.dumps(sorted(sys.modules)), file=sys.stderr)\n"
                "sys.exit(code)\n") % str(SCRIPT)
        arguments = ["--url", self.base + "/file", "--dest", "src/data.bin", "--sha256", SHA, "--allow-loopback",
                     "--min-free", "0", "--source-limit", str(10 * SIZE), "--timeout", "2"]
        out = subprocess.run([sys.executable, "-I", "-S", "-c", code, json.dumps(arguments)], capture_output=True, text=True,
                             cwd=self.dir, check=False)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertEqual(json.loads(out.stdout)["status"], "fetched")
        loaded = set(json.loads(out.stderr.strip().splitlines()[-1]))
        self.assertIn("http.client", loaded)  # the probe saw the download path's own imports
        self.assertEqual(sorted(loaded & set(self.LEAN)), [], "imports moved back onto the download path")

    def test_the_quick_reader_takes_a_line_only_when_argparse_reads_it_the_same_way(self):
        parser = fetch._parser()
        base = ["--url", "http://h/f", "--dest", "src/f", "--sha256", "AB" * 32]
        taken = [
            base,
            [*base, "--mirror", "http://m/1", "--mirror=http://m/2", "--segments", "1", "--timeout=2.5", "--attempts", "7"],
            ["--url=http://h/f", "--dest=src/f", "--md5=" + "c" * 32, "--allow-loopback", "--ca-file", "ca.pem"],
            [*base, "--min-free", "0", "--source-limit", "10", "--min-rate", "0", "--segment-threshold", "1_000"],
            [*base, "--timeout", "nan"],
            ["--md5", "x", "--dest", "d", "--url", ""],
            ["--manifest", "batch.jsonl", "--allow-loopback", "--segments", "4", "--source-limit", "10"],
        ]
        for line in taken:
            quick = fetch._quick_args(line)
            self.assertIsNotNone(quick, line)
            self.assertEqual(vars(quick).keys(), vars(parser.parse_args(line)).keys(), line)
            for key, value in vars(parser.parse_args(line)).items():
                got = vars(quick)[key]
                self.assertEqual((type(got), got) if got == got else "nan", (type(value), value) if value == value else "nan", (line, key))
        sent_on = [
            [], ["--help"], ["-h"], base[:-2], base[:2] + ["--sha256", "a", "--md5", "b", "--dest", "d"],
            [*base, "--sha256", "again"], [*base, "--url", "again"], [*base, "--seg", "2"], [*base, "--segments"],
            [*base, "--segments", "two"], [*base, "--timeout", "-1"], [*base, "--attempts=-1"], [*base, "--unknown"],
            [*base, "stray"], [*base, "--allow-loopback=yes"], [*base, "--ca-file", "--dest"], [*base, "--"],
            ["--dest", "d", "--sha256", "a"],
            ["--manifest", "m", "--url", "u"], ["--manifest", "m", "--mirror", "u"], ["--manifest", "m", "--md5", "a"],
            ["--manifest", "m", "--manifest", "n"],
        ]
        for line in sent_on:
            self.assertIsNone(fetch._quick_args(line), line)

    def test_refuses_a_missing_or_malformed_digest_and_bad_limits(self):
        for args in ([], ["--sha256", "abc"], ["--md5", "z" * 32]):
            out = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/x", *args],
                                 capture_output=True, text=True, cwd=self.dir, check=False)
            self.assertNotEqual(out.returncode, 0, args)
        for bad in (["--attempts", "0"], ["--timeout", "nan"], ["--timeout", "-1"]):
            self.assertNotEqual(self.cli(*bad).returncode, 0, bad)
        self.assertFalse((self.dir / "src/x").exists())
        self.assertFalse((self.dir / "src/data.bin").exists())

    def test_an_interrupted_transfer_resumes_with_the_last_tenth_only(self):
        self.server.modes = {"drop-once"}
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", True))
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)
        self.assertLessEqual(self.server.served[1], SIZE // 10 + 64 * 1024)
        self.assertEqual(line["fetched"], sum(self.server.served))

    def test_a_second_process_resumes_an_unchanged_file(self):
        self.half_partial()
        out = self.cli()
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertTrue(json.loads(out.stdout)["resumed"])
        self.assertEqual(self.server.served, [SIZE // 2])
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_resume_through_a_redirect(self):
        self.server.modes = {"drop-once"}
        self.assertEqual(self.run_fetch(path="/hop")["status"], "fetched")
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_weak_etag_restarts_and_a_date_resumes_only_with_no_etag(self):
        self.half_partial(validator=None)
        self.server.modes = {"weak-etag"}
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", False))
        shutil.rmtree("src")
        self.server.modes = {"date-only", "drop-once"}
        self.server.requests = 0
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", True))

    def test_a_server_that_ignores_ranges_is_fetched_whole(self):
        self.half_partial()
        self.server.modes = {"ignore-range"}
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", False))
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_bad_range_is_never_appended(self):
        for mode in ("wrong-offset", "encoding", "bad-bounds", "bad-length"):
            with self.subTest(mode=mode):
                shutil.rmtree("src", ignore_errors=True)
                self.half_partial()
                self.server.modes = {mode}
                original = Handler.do_GET

                def then_normal(handler, original=original):
                    original(handler)
                    handler.server.modes = set()

                with mock.patch.object(Handler, "do_GET", then_normal):
                    line = self.run_fetch()
                self.assertEqual((line["status"], line["resumed"]), ("fetched", False))
                self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_valid_shorter_ranges_are_progress_not_failures(self):
        self.half_partial()
        self.server.modes = {"short-ranges"}
        line = self.run_fetch(attempts=1)
        self.assertEqual((line["status"], line["resumed"]), ("fetched", True))
        self.assertEqual(len(self.server.served), 2)
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_every_restart_spends_the_one_attempt_budget(self):
        self.half_partial()
        self.server.modes = {"wrong-offset"}
        with self.assertRaisesRegex(fetch.Refused, "1 attempts"):
            self.run_fetch(attempts=1)
        self.assertEqual(self.server.requests, 1)

    def test_a_mismatch_is_refused_and_removed_and_a_clean_attempt_then_succeeds(self):
        with self.assertRaisesRegex(fetch.Refused, "does not match"):
            self.run_fetch(sha="0" * 64)
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.assertFalse(Path("src/data.bin").exists())
        Path("src/.partial").mkdir(parents=True, exist_ok=True)
        Path("src/.partial/data.bin").write_bytes(b"\0" * (SIZE // 2))
        Path("src/.partial/data.bin.state.json").write_text(state(self.base))
        with self.assertRaisesRegex(fetch.Refused, "does not match"):
            self.run_fetch()
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.assertEqual(self.run_fetch()["status"], "fetched")

    def test_a_redirect_body_is_never_read(self):
        self.assertEqual(self.run_fetch(path="/endless-redirect")["status"], "fetched")
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_changed_weak_etag_on_a_range_restarts(self):
        self.half_partial()
        self.server.modes = {"weak-etag-on-range"}
        original = Handler.do_GET

        def once(handler):
            original(handler)
            handler.server.modes = set()

        with mock.patch.object(Handler, "do_GET", once):
            line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", False))

    def test_a_range_that_names_no_validator_restarts(self):
        self.half_partial()
        self.server.modes = {"no-validator-on-range"}
        original = Handler.do_GET

        def once(handler):
            original(handler)
            handler.server.modes = set()

        with mock.patch.object(Handler, "do_GET", once):
            line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", False))

    def test_a_malformed_url_is_a_refusal_with_the_documented_fields(self):
        out = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", "http://127.0.0.1:99999/x", "--dest", "src/x",
                              "--sha256", SHA, "--allow-loopback", "--min-free", "0"], capture_output=True, text=True,
                             cwd=self.dir, check=False)
        self.assertEqual(out.returncode, 1, out.stderr)
        line = json.loads(out.stdout)
        self.assertEqual(set(line), {"status", "bytes", "fetched", "sha256", "resumed", "url", "urls", "reason"})
        self.assertIn("malformed URL", line["reason"])

    def test_one_download_into_a_source_at_a_time(self):
        Path("src/.partial").mkdir(parents=True)
        with open("src/.partial/.lock", "a") as held:
            import fcntl

            fcntl.flock(held, fcntl.LOCK_EX)
            with self.assertRaisesRegex(fetch.Refused, "another download"):
                self.run_fetch()
        self.assertEqual(self.run_fetch()["status"], "fetched")

    def test_a_date_validator_is_used_only_when_strong(self):
        # Last-Modified equal to the response's Date is weak: a drop then means starting again, not resuming.
        self.server.modes = {"date-now", "drop-once"}
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", False))
        self.assertEqual(len(self.server.served), 2)
        self.assertEqual(self.server.served[1], SIZE)

    def test_slow_chunk_framing_is_cut_by_the_watchdog(self):
        for path in ("/slow-framing", "/slow-framing-close"):
            with self.subTest(path=path):
                # The refusal is the watchdog's own: left alone, the 10-second trickle ends in a whole answer, so no
                # wall-clock bound is needed (a loaded runner broke one, 2026-10-31).
                with self.assertRaisesRegex(fetch.Refused, "slower than the rate floor"):
                    self.run_fetch(path=path, min_rate=1024 * 1024, rate_window=0.5, attempts=1, timeout=5)

    def test_obsolete_asctime_dates_are_read_as_gmt(self):
        self.assertEqual(self.run_fetch(path="/asctime")["status"], "fetched")
        self.server.modes = {"429-asctime"}
        waits = []
        shutil.rmtree("src")
        self.assertEqual(self.run_fetch(sleep=waits.append)["status"], "fetched")
        self.assertGreater(waits[0], 10)

    def test_a_retry_after_date_is_waited_for(self):
        self.server.modes = {"429-date"}
        waits = []
        self.assertEqual(self.run_fetch(sleep=waits.append)["status"], "fetched")
        self.assertGreater(waits[0], 15)

    def test_a_restart_after_an_ignored_range_counts_the_partial_once(self):
        self.half_partial()
        self.server.modes = {"ignore-range"}
        # Room for the whole file and a little, not for the half partial and the whole file together.
        self.assertEqual(self.run_fetch(source_limit=SIZE + 1024)["status"], "fetched")

    def test_an_equal_length_partial_answered_416_is_verified_or_refused(self):
        for sha, outcome in ((SHA, "fetched"), ("0" * 64, None)):
            with self.subTest(sha=sha[:4]):
                shutil.rmtree("src", ignore_errors=True)
                Path("src/.partial").mkdir(parents=True)
                Path("src/.partial/data.bin").write_bytes(BODY)
                Path("src/.partial/data.bin.state.json").write_text(state(self.base, total=None).replace(SHA, sha))
                requests = self.server.requests
                if outcome:
                    self.assertEqual(self.run_fetch(sha=sha)["status"], outcome)
                else:
                    with self.assertRaisesRegex(fetch.Refused, "does not match"):
                        self.run_fetch(sha=sha)
                self.assertEqual(self.server.requests, requests + 1)

    def test_a_whole_partial_is_verified_and_an_oversized_one_restarted(self):
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(BODY)
        Path("src/.partial/data.bin.state.json").write_text(state(self.base))
        line = self.run_fetch()
        self.assertEqual((line["status"], line["fetched"]), ("fetched", 0))
        shutil.rmtree("src")
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(BODY + b"extra")
        Path("src/.partial/data.bin.state.json").write_text(state(self.base, total=None))
        self.assertEqual(self.run_fetch()["status"], "fetched")
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_changed_file_starts_again_under_its_new_validator(self):
        self.half_partial()
        self.server.body = BODY[::-1]
        self.server.etag = '"v2"'
        new = hashlib.sha256(BODY[::-1]).hexdigest()
        Path("src/.partial/data.bin.state.json").write_text(state(self.base).replace(SHA, new))
        line = self.run_fetch(sha=new)
        self.assertEqual((line["status"], line["resumed"]), ("fetched", False))
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY[::-1])

    def test_redirects_are_bounded_and_a_private_one_refused(self):
        self.server.modes = {"loop"}
        with self.assertRaisesRegex(fetch.Refused, "redirects"):
            self.run_fetch(path="/loop")
        self.server.modes = {"private"}
        with self.assertRaisesRegex(fetch.Refused, "non-public"):
            self.run_fetch(path="/hop")

    def test_the_connection_uses_the_address_that_was_checked(self):
        # A name that resolves publicly for one lookup and privately for the next never gets a second lookup for the
        # same connection: one stream, and segments (a HEAD and four ranges), each look the name up once per connection.
        for options in ({"segments": 1}, {"segment_threshold": 1 << 20}):
            shutil.rmtree("src", ignore_errors=True)
            calls, connections = [], []
            real_lookup, real_connect = fetch.socket.getaddrinfo, fetch.socket.create_connection

            def rebinding(host, port, *args, **kwargs):
                calls.append(host)
                return real_lookup("127.0.0.1", port, *args, **kwargs)

            def connecting(address, *args, **kwargs):
                connections.append(address[0])
                return real_connect(address, *args, **kwargs)

            with mock.patch.object(fetch.socket, "getaddrinfo", rebinding), \
                    mock.patch.object(fetch.socket, "create_connection", connecting):
                fetch.fetch(f"http://rebind.example:{self.server.server_address[1]}/file", "src/data.bin", ("sha256", SHA),
                            allow_loopback=True, timeout=2, sleep=lambda s: None, log=lambda line: None, **ROOMY, **options)
            # Only the name is looked up, once a connection; each connection goes to the address its lookup checked.
            names = [host for host in calls if not host.replace(".", "").isdigit()]
            self.assertEqual(names, ["rebind.example"] * len(connections), options)
            self.assertEqual(set(connections), {"127.0.0.1"}, options)
            # One stream: one connection. Segments: at most four (the first range, which answers for the HEAD and whose
            # connection carries the rest of it, and the other ranges); a range that ends early may carry another's
            # request on its kept connection (D03 T04 §23), so fewer is the threads' timing, not a lookup skipped.
            if options.get("segments") == 1:
                self.assertEqual(len(connections), 1, options)
            else:
                self.assertTrue(1 <= len(connections) <= 4, (options, connections))

    # Segmented downloads (D03 T04 §20): the test file is 10 MiB, so a 1 MiB threshold makes it qualify.
    SEGMENTED = {"segment_threshold": 1 << 20}

    def ranges_after_the_first(self):
        """The ranges asked with an end that begin past byte 0: what only a segmented run sends. The first range asked
        for beside the HEAD (D03 T04 §23) begins at 0 and is the one request a one-stream run makes of this kind."""
        return [item for item in self.server.ranges if item[0] > 0]

    def assert_whole(self):
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.assertFalse(Path("src/.partial/data.bin.state.json").exists())

    def test_a_large_file_comes_in_four_ranges_at_once(self):
        # Paced answers, so the ranges are seen to overlap (a loopback answer otherwise ends before the next starts).
        self.server.modes = {"segment-slow"}
        result = self.run_fetch(min_rate=0, **self.SEGMENTED)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        # Four ranges, and the first one in two requests: the first range asked for beside the HEAD (D03 T04 §23), then
        # the rest of range 0 from where it ended.
        self.assertEqual(self.server.segment_requests, 5)
        self.assertEqual(sorted(first for first, _, _ in self.server.ranges)[:2], [0, self.server.ranges[0][1] + 1])
        self.assertGreaterEqual(self.server.peak, 2)
        self.assertLessEqual(self.server.peak, 4)

    def test_a_server_that_does_not_qualify_gets_one_stream(self):
        # A HEAD that lacks `Accept-Ranges` or a length, or no HEAD at all, no longer decides: the first range's valid 206
        # answers for it (D03 T04 §23), as `test_a_206_that_answers_for_the_head_qualifies_a_head_that_would_not` shows.
        # What the GETs themselves do not qualify for still gets one stream.
        for modes in ({"weak-etag"}, {"encoding"}, set()):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.segment_requests, self.server.ranges = set(modes), 0, []
                # An empty mode set with segments=1 is the operator forcing one stream on a server that qualifies.
                options = {"segment_threshold": 1 << 20} if modes else {"segments": 1, "segment_threshold": 1 << 20}
                self.run_fetch(**options)
                self.assertEqual(Path("src/data.bin").read_bytes(), BODY)
                self.assertEqual(self.ranges_after_the_first(), [])
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes, self.server.ranges = set(), []
        self.run_fetch(segment_threshold=SIZE + 1)  # under the threshold
        self.assertEqual(self.ranges_after_the_first(), [])

    def test_a_segment_answer_that_does_not_fit_starts_again_on_one_stream(self):
        self.server.modes = {"segment-wrong-offset"}
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()

    def test_a_shorter_segment_answer_is_continued(self):
        self.server.modes = {"segment-short"}
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertGreater(self.server.segment_requests, 4)

    # The first range, asked for beside the HEAD (D03 T04 §23): the file is 10 MiB.
    def first_range_size(self, threshold):
        return max(-(-threshold // 4), 2 * fetch.SHORT_ANSWER)

    def asked_spans(self):
        """The byte spans every ranged GET asked for, sorted, an open end meaning the file's end."""
        spans = []
        for method, header in self.server.asked:
            if method == "GET" and header:
                first, last = header.split("=")[1].split("-")
                spans.append((int(first), min(int(last), SIZE - 1) if last else SIZE - 1))
        return sorted(spans)

    def assert_each_byte_asked_once(self):
        """The requests tile the file with no gap and no overlap: nothing was fetched twice."""
        at = 0
        for first, last in self.asked_spans():
            self.assertEqual(first, at, self.asked_spans())
            at = last + 1
        self.assertEqual(at, SIZE, self.asked_spans())

    def test_the_first_range_beside_the_head_is_the_first_range_when_the_file_qualifies(self):
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        size = self.first_range_size(1 << 20)
        gets = [header for method, header in self.server.asked if method == "GET"]
        self.assertEqual(gets[0], f"bytes=0-{size - 1}")  # the first request is the first range
        self.assertEqual(self.server.heads, 0)  # its valid 206 answered for the HEAD, which was never sent
        self.assertEqual(len(gets), 5)  # four ranges, the first in two parts
        self.assert_each_byte_asked_once()  # its bytes were adopted, not asked for again
        self.assertTrue(any(header.startswith(f"bytes={size}-") for header in gets), gets)

    def test_the_first_range_is_the_one_streams_first_bytes_when_the_file_does_not_qualify(self):
        # Under the threshold the first range is part of the file: the rest is asked for from where it ended.
        result = self.run_fetch(segment_threshold=SIZE + 1)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        size = self.first_range_size(SIZE + 1)
        self.assertEqual([header for method, header in self.server.asked if method == "GET"],
                         [f"bytes=0-{size - 1}", f"bytes={size}-"])
        self.assert_each_byte_asked_once()
        # A small file is all of it in the first range: one request, nothing after it.
        shutil.rmtree("src", ignore_errors=True)
        self.server.asked.clear()
        result = self.run_fetch(segment_threshold=8 * SIZE)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        self.assertEqual(len([1 for method, _ in self.server.asked if method == "GET"]), 1)
        self.assert_each_byte_asked_once()

    def test_a_206_that_answers_for_the_head_qualifies_a_head_that_would_not(self):
        # A HEAD that is unsupported (405, 501) or lacks `Accept-Ranges` or a length is never sent: the first range's
        # valid 206 (a total length, a strong validator, no coding) answers for it, so the file comes in ranges, the
        # first range's bytes adopted as range 0's first bytes (D03 T04 §23).
        for modes in ({"no-head"}, {"head-501"}, {"no-accept-ranges"}, {"no-length"}):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.asked, self.server.heads, self.server.ranges = set(modes), [], 0, []
                result = self.run_fetch(**self.SEGMENTED)
                self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
                self.assert_whole()
                self.assertEqual(self.server.heads, 0)
                self.assertNotEqual(self.ranges_after_the_first(), [])  # ranges, not one stream
                self.assert_each_byte_asked_once()

    def test_a_valid_206_is_adopted_when_the_head_is_unsupported_or_does_not_qualify(self):
        # Under the threshold, a valid 206 from a server with no HEAD is the one stream's first bytes, and a 206 that
        # is the whole file needs no validator: one stream, no HEAD where the 206 answers for it, nothing asked twice.
        for modes in ({"no-head"}, {"head-501"}, {"no-accept-ranges"}, {"no-length"}):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.asked, self.server.heads = set(modes), [], 0
                result = self.run_fetch(segment_threshold=SIZE + 1)
                self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
                self.assert_whole()
                self.assertEqual(self.ranges_after_the_first(), [])  # one stream, never ranges beside it
                gets = [header for method, header in self.server.asked if method == "GET"]
                self.assertEqual(len(gets), 2, gets)  # the first range, then the rest of the stream
                self.assertEqual(self.server.heads, 0)
                self.assert_each_byte_asked_once()
        # A 206 that names no strong validator cannot be continued under one, so it is not adopted: the file is asked
        # for whole, as before.
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes, self.server.asked = {"weak-etag"}, []
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        self.assertEqual([header for method, header in self.server.asked if method == "GET"][1:], [None])

    def test_an_ignored_range_answered_200_is_the_whole_stream_never_mixed_with_ranges(self):
        # The HEAD says ranges work; the GET ignores the range and answers the whole file: that answer is the stream.
        self.server.modes = {"ignore-range"}
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        gets = [header for method, header in self.server.asked if method == "GET"]
        self.assertEqual(gets, [f"bytes=0-{self.first_range_size(1 << 20) - 1}"])  # one request, no range after it
        self.assertEqual(self.server.heads, 1)
        self.assertEqual(self.ranges_after_the_first(), [])

    def test_a_first_range_and_a_head_that_disagree_adopt_nothing(self):
        # The HEAD is asked only where the first range cannot answer for it (D03 T04 §23): here the range is ignored
        # (a 200), so the HEAD is asked after it, and it disagrees with the 200 on the file.
        for mode in ("head-other-etag", "head-other-length"):
            with self.subTest(mode=mode):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.asked = {mode, "ignore-range"}, []
                logged = []
                result = self.run_fetch(log=logged.append, **self.SEGMENTED)
                self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
                self.assert_whole()
                self.assertTrue(any("disagree on the file" in line for line in logged), logged)
                # Nothing of the unread first range is in the file: every byte came from a request made after it.
                gets = [header for method, header in self.server.asked if method == "GET"]
                self.assertEqual(self.server.asked[:2], [("GET", f"bytes=0-{self.first_range_size(1 << 20) - 1}"),
                                                         ("HEAD", None)])
                self.assertGreater(len(gets), 1, gets)  # the unread 200 was closed and the file asked for again
        # Where the first range answers a full 206, no HEAD is sent, so a HEAD that would have disagreed is never heard:
        # the file is the one the GETs name, every later answer held to the 206's length and validator.
        for mode in ("head-other-etag", "head-other-length"):
            with self.subTest(mode=mode, range_answered=True):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.asked, self.server.heads = {mode}, [], 0
                result = self.run_fetch(**self.SEGMENTED)
                self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
                self.assert_whole()
                self.assertEqual(self.server.heads, 0)
                self.assert_each_byte_asked_once()

    def test_a_failed_or_rate_limited_first_range_is_blamed_and_the_heads_answer_is_still_used(self):
        for mode, reason in (("first-range-503", "HTTP 503 to the first range"), ("first-range-429", "HTTP 429 to the first range")):
            with self.subTest(mode=mode):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.asked, self.server.heads, self.server.segment_requests = {mode}, [], 0, 0
                logged, waits, self.server.head_at = [], [], []
                result = self.run_fetch(log=logged.append, sleep=lambda seconds: waits.append((time.monotonic(), seconds)),
                                        **self.SEGMENTED)
                self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
                self.assert_whole()
                self.assertTrue(any(line.startswith("fetch: " + reason) and "(1 of 3 attempts spent)" in line for line in logged),
                                logged)  # one attempt, as a refused range spends
                # The failed first range could not answer for the HEAD, so the HEAD was asked once, and its answer used.
                self.assertEqual(self.server.heads, 1)
                if mode == "first-range-429":
                    waited = [when for when, seconds in waits if 25 <= seconds <= 30]
                    self.assertTrue(waited, waits)  # its Retry-After was waited out
                    self.assertLess(waited[0], self.server.head_at[0])  # before the HEAD was asked of that source
                else:
                    self.assertEqual(waits, [])
                # Nothing was adopted: range 0 was asked for from byte 0 again, and the file is the four ranges.
                self.assertEqual(len([item for item in self.asked_spans() if item[0] == 0]), 2)

    # The first range answers for the HEAD where it can (D03 T04 §23): the HEAD is sent only where it cannot.
    def test_a_fresh_qualifying_download_sends_no_head_when_the_first_range_answers_a_full_206(self):
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        self.assertNotIn("HEAD", [method for method, _ in self.server.asked])
        self.assertEqual(self.server.asked[0], ("GET", f"bytes=0-{self.first_range_size(1 << 20) - 1}"))
        self.assertNotEqual(self.ranges_after_the_first(), [])  # it qualified on the 206 alone: ranges
        self.assert_each_byte_asked_once()

    def test_a_206_without_a_strong_validator_or_a_total_length_falls_back_to_the_head(self):
        # No validator, a weak one, or a `Content-Range` with no total: the 206 cannot answer for the HEAD, so the HEAD
        # is asked once the first range has answered, and decides as before.
        for modes in ({"no-validator-on-range"}, {"weak-etag-on-range"}, {"unknown-total"}):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.asked, self.server.heads = set(modes), [], 0
                result = self.run_fetch(**self.SEGMENTED)
                self.assertEqual(result["status"], "fetched")
                self.assert_whole()
                self.assertEqual(self.server.heads, 1)
                self.assertEqual(self.server.asked[:2], [("GET", f"bytes=0-{self.first_range_size(1 << 20) - 1}"),
                                                         ("HEAD", None)])
        # A 206 that is the whole file is held open with no validator (nothing of it needs continuing), but it still
        # cannot answer for the HEAD: the HEAD is asked.
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes, self.server.asked, self.server.heads = {"no-validator-on-range"}, [], 0
        result = self.run_fetch(segment_threshold=8 * SIZE)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertEqual(self.server.asked[:2], [("GET", f"bytes=0-{self.first_range_size(8 * SIZE) - 1}"), ("HEAD", None)])

    def test_an_ignored_range_still_asks_the_head_and_is_the_whole_stream(self):
        self.server.modes = {"ignore-range"}
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        # The 200 cannot answer for the HEAD (no range was served), so the HEAD is asked after it, and the 200 held
        # open meanwhile is the whole stream: one GET, nothing asked twice.
        self.assertEqual(self.server.asked, [("GET", f"bytes=0-{self.first_range_size(1 << 20) - 1}"), ("HEAD", None)])
        self.assertEqual(sum(self.server.served), SIZE)

    def test_a_redirected_first_range_answers_for_the_head_and_a_refused_redirect_rules_the_url_out(self):
        # Through a redirect the first range's 206 answers for the HEAD as at the URL itself: each hop is checked as
        # the HEAD's would be, and every later range is asked of the given URL and held to the 206's validator.
        result = self.run_fetch(path="/hop", **self.SEGMENTED)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        self.assertEqual(self.server.heads, 0)
        self.assert_each_byte_asked_once()
        # A redirect to a private address refuses the URL on the first range: no HEAD is sent to a URL ruled out.
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes, self.server.heads = {"private"}, 0
        with self.assertRaisesRegex(fetch.Refused, "non-public"):
            self.run_fetch(path="/hop", **self.SEGMENTED)
        self.assertEqual(self.server.heads, 0)
        self.assertFalse(Path("src/data.bin").exists())
        # A redirect loop is refused the same way.
        self.server.modes = {"loop"}
        with self.assertRaisesRegex(fetch.Refused, "redirects"):
            self.run_fetch(path="/loop", **self.SEGMENTED)
        self.assertEqual(self.server.heads, 0)

    def test_a_mirror_mixes_only_when_its_head_agrees_with_the_first_ranges_206(self):
        # The first URL is asked no HEAD (its 206 answers for it); each mirror still is, and joins the ranges only when
        # its HEAD gives the 206's total length and strong validator.
        other, base = self.mirror()
        self.server.pace = other.pace = 0.02
        result = self.mixed(base, min_rate=0)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        self.assertEqual((self.server.heads, other.heads), (0, 1))
        self.assertGreater(other.segment_requests, 0)  # it agreed, so it served ranges
        for change in ("etag", "length"):
            with self.subTest(mirror_differs_by=change):
                shutil.rmtree("src", ignore_errors=True)
                other, base = self.mirror()
                if change == "etag":
                    other.etag = '"v2"'
                else:
                    other.modes = {"head-other-length"}
                logged = []
                result = self.mixed(base, log=logged.append)
                self.assertEqual(result["status"], "fetched")
                self.assert_whole()
                self.assertEqual(other.heads, 1)
                self.assertEqual(other.segment_requests, 0)  # kept out of the mix
                self.assertTrue(any(base in line and "not in the mix" in line for line in logged), logged)

    def test_a_failed_first_range_and_its_head_spend_one_attempt_a_round(self):
        # Every request fails: each round's first range is counted, and the HEAD asked after it is not counted again
        # (one failure a source a round, as when the two went side by side), so three attempts make three rounds.
        self.server.modes = {"fail"}
        with self.assertRaisesRegex(fetch.Refused, "3 attempts failed"):
            self.run_fetch(attempts=3, **self.SEGMENTED)
        self.assertEqual([method for method, _ in self.server.asked], ["GET", "HEAD", "GET", "HEAD", "GET"])

    def test_a_batch_of_small_files_sends_no_heads(self):
        made = [self.mirror() for _ in range(3)]
        entries = [{"url": base + "/file", "dest": f"src/f{number}.bin", "sha256": SHA}
                   for number, (_, base) in enumerate(made)]
        out = self.run_manifest(entries, segment_threshold=8 * SIZE)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
        self.assertEqual([json.loads(line)["status"] for line in out.stdout.splitlines()], ["fetched"] * 3)
        # Each file is its first range whole (a 206 for every byte): one request a file, and no HEAD at all.
        self.assertEqual([server.asked for server, _ in made],
                         [[("GET", f"bytes=0-{self.first_range_size(8 * SIZE) - 1}")]] * 3)

    def test_an_existing_partial_is_resumed_with_no_first_range_and_nothing_overwritten(self):
        # A one-stream partial: the one request is the rest, from where the partial ends, and no HEAD.
        self.half_partial()
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual((result["status"], result["resumed"], result["fetched"]), ("fetched", True, SIZE - SIZE // 2))
        self.assert_whole()
        self.assertEqual(self.server.asked, [("GET", f"bytes={SIZE // 2}-")])
        # Saved ranges, resumed over two sources that both answer a HEAD: only what is missing is asked for, each from
        # where its range stopped, and no source is sent a first range.
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes = {"segment-drop-once"}
        with self.assertRaisesRegex(fetch.Refused, "1 attempts failed"):
            self.run_fetch(attempts=1, **self.SEGMENTED)
        saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())["segments"]
        deadline = time.monotonic() + 10
        while self.server.active and time.monotonic() < deadline:
            time.sleep(0.05)
        other, base = self.mirror()
        self.server.modes, self.server.asked = set(), []
        result = self.mixed(base)
        self.assertTrue(result["resumed"])
        self.assert_whole()
        resumes = {first + done for first, last, done in saved if done <= last - first}
        for server in (self.server, other):
            asked = {int(header.split("=")[1].split("-")[0]) for method, header in server.asked if method == "GET"}
            self.assertLessEqual(asked, resumes)  # no request begins where saved bytes are; none is a first range
        self.assertEqual(result["fetched"], sum(last - first + 1 - done for first, last, done in saved))

    def test_the_rest_of_range_0_goes_on_the_first_ranges_connection_and_a_closed_one_gives_way_unspent(self):
        # D03 T04 §23: the first range's answer, read whole, carries the request for the rest of range 0, so the run
        # opens no connection for it; a server that ended that connection meanwhile costs a new one, not an attempt.
        for modes, connections_expected in (({"segment-slow"}, 4), ({"segment-slow", "close-after-answer"}, 5)):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes = set(modes)
                opened, real_connect = [], fetch.socket.create_connection

                def connecting(address, *args, **kwargs):
                    opened.append(address)
                    return real_connect(address, *args, **kwargs)

                with mock.patch.object(fetch.socket, "create_connection", connecting):
                    result = self.run_fetch(min_rate=0, attempts=1, **self.SEGMENTED)
                self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
                self.assert_whole()
                # The first range (then the rest of range 0 on it; no HEAD, the 206 answered for it), and three
                # ranges; one more when the server closed the first range's connection after its answer.
                self.assertEqual(len(opened), connections_expected, modes)

    def test_a_fresh_process_resumes_after_an_adopted_first_range_without_refetching_it(self):
        threshold = 4 << 20
        size = self.first_range_size(threshold)
        self.server.modes = {"segment-slow"}
        command = [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin", "--sha256", SHA,
                   "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE), "--segment-threshold", str(threshold),
                   "--min-rate", "0"]
        first = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        state_path = Path("src/.partial/data.bin.state.json")
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            try:
                if json.loads(state_path.read_text())["segments"][0][2] >= size:
                    break  # the saved state holds the whole first range, the adopted part of it included
            except (OSError, ValueError, KeyError, IndexError):
                pass  # not written yet
            time.sleep(0.05)
        first.kill()
        first.wait()
        saved = json.loads(state_path.read_text())
        kept = sum(item[2] for item in saved["segments"])
        self.assertGreaterEqual(saved["segments"][0][2], size)
        self.assertTrue(any(span[0] == 0 and span[1] >= size - 1 for span in saved["provenance"]), saved["provenance"])
        deadline = time.monotonic() + 10
        while self.server.active and time.monotonic() < deadline:
            time.sleep(0.05)
        self.server.modes = set()
        self.server.served.clear()
        done = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr[-400:])
        line = json.loads(done.stdout)
        self.assertEqual((line["resumed"], line["fetched"]), (True, SIZE - kept))
        self.assert_whole()
        self.assertEqual(sum(self.server.served), SIZE - kept)  # nothing the first process saved was fetched again

    def test_nothing_is_published_when_the_digest_fails_after_adoption(self):
        for options, where in (({"segment_threshold": 1 << 20}, "a segmented run"), ({"segment_threshold": 8 * SIZE}, "one stream")):
            with self.subTest(where=where):
                shutil.rmtree("src", ignore_errors=True)
                self.server.damaged = {100}  # a byte inside the first range, which is adopted
                self.server.asked = []
                with self.assertRaisesRegex(fetch.Refused, "does not match"):
                    self.run_fetch(**options)
                gets = [header for method, header in self.server.asked if method == "GET"]
                self.assertEqual(gets[0], f"bytes=0-{self.first_range_size(options['segment_threshold']) - 1}")
                self.assertFalse(Path("src/data.bin").exists())
                self.assertFalse(Path("src/.partial/data.bin").exists())

    def test_a_dropped_segment_is_resumed_by_a_fresh_process_refetching_only_what_is_missing(self):
        self.server.modes = {"segment-drop-once"}
        with self.assertRaisesRegex(fetch.Refused, "1 attempts failed"):
            self.run_fetch(attempts=1, **self.SEGMENTED)
        saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
        self.assertEqual(len(saved["segments"]), 4)
        missing = sum(last - first + 1 - done for first, last, done in saved["segments"])
        self.assertGreater(missing, 0)
        # The first run's cut-off answers count their bytes when their write ends; only then is the count cleared.
        deadline = time.monotonic() + 10
        while self.server.active and time.monotonic() < deadline:
            time.sleep(0.05)
        self.server.served.clear()
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin",
                               "--sha256", SHA, "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE),
                               "--segment-threshold", str(1 << 20)], capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr[-400:])
        self.assertTrue(json.loads(done.stdout)["resumed"])
        self.assert_whole()
        self.assertEqual(sum(self.server.served), missing)

    def test_a_killed_download_resumes_from_its_saved_ranges(self):
        # Four slow segments; the process is killed once the state has saved some progress, then a new one finishes.
        self.server.modes = {"segment-slow"}
        command = [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin", "--sha256", SHA,
                   "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE), "--segment-threshold", str(1 << 20),
                   "--min-rate", "0"]
        first = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        state_path = Path("src/.partial/data.bin.state.json")
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                if any(item[2] for item in json.loads(state_path.read_text())["segments"]):
                    break
            except (OSError, ValueError, KeyError):
                pass  # not written yet
            time.sleep(0.05)
        first.kill()
        first.wait()
        saved = json.loads(state_path.read_text())
        kept = sum(item[2] for item in saved["segments"])
        self.assertGreater(kept, 0)
        # The killed process's slow answers end when their next write meets the closed socket; only then is the
        # count cleared, so it holds the new process's bytes alone.
        deadline = time.monotonic() + 10
        while self.server.active and time.monotonic() < deadline:
            time.sleep(0.05)
        self.server.modes = set()
        self.server.served.clear()
        done = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr[-400:])
        self.assert_whole()
        self.assertEqual(sum(self.server.served), SIZE - kept)

    def test_a_killed_run_has_saved_its_progress_every_mib(self):
        # At the production interval: killed once 2.5 MiB have arrived, the state holds at least 1 MiB of progress
        # (with saves 4 MiB apart it held none, and a resume fetched everything again).
        self.server.modes = {"segment-slow"}
        command = [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin", "--sha256", SHA,
                   "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE), "--segment-threshold", str(1 << 20),
                   "--min-rate", "0"]
        run = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 30
        while sum(self.server.served) < 5 * 512 * 1024 and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.2)  # the hasher's thread is rung at each MiB; let it write the last one due
        run.kill()
        run.wait()
        saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
        self.assertGreaterEqual(sum(item[2] for item in saved["segments"]), 1024 * 1024)

    def test_segment_limits_hold(self):
        with self.assertRaisesRegex(fetch.Refused, "limit"):
            self.run_fetch(source_limit=SIZE // 2, **self.SEGMENTED)
        self.assertEqual(self.ranges_after_the_first(), [])  # only the first range, closed unread
        with self.assertRaisesRegex(fetch.Refused, "free-space floor"):
            self.run_fetch(min_free=10**18, **self.SEGMENTED)
        # The floor crossed mid-download (another writer on the disk) ends every segment with the partial kept.
        real = fetch._free_space
        calls = {"n": 0}

        def filling(path):
            calls["n"] += 1
            return 0 if calls["n"] > 20 else real(path)

        shutil.rmtree("src", ignore_errors=True)
        with mock.patch.object(fetch, "_free_space", filling), self.assertRaisesRegex(fetch.Refused, "free-space floor"):
            self.run_fetch(min_free=1, **self.SEGMENTED)
        self.assertTrue(Path("src/.partial/data.bin").exists())
        self.assertFalse(Path("src/data.bin").exists())

    def test_a_segmented_file_is_published_only_whole_and_verified(self):
        self.server.modes = {"segment-corrupt"}
        with self.assertRaisesRegex(fetch.Refused, "does not match"):
            self.run_fetch(**self.SEGMENTED)
        self.assertFalse(Path("src/data.bin").exists())
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.server.modes = set()
        # The last state write fails: nothing is published, the partial is kept, and a rerun publishes it.
        real = fetch._write_json
        calls = {"n": 0}

        def failing_last(path, value):
            calls["n"] += 1
            if all(item[0] + item[2] > item[1] for item in value.get("segments", [[0, 0, 0]])):
                raise OSError(errno.EIO, "I/O error")
            return real(path, value)

        with mock.patch.object(fetch, "_write_json", failing_last), \
                self.assertRaisesRegex(fetch.Refused, "state could not be written"):
            self.run_fetch(**self.SEGMENTED)
        self.assertFalse(Path("src/data.bin").exists())
        # The move into place fails once: still nothing published; the rerun moves it without fetching again.
        real_replace = fetch.os.replace

        def failing_publish(source, destination):
            if Path(destination) == Path("src/data.bin"):
                raise OSError(errno.EIO, "I/O error")
            return real_replace(source, destination)

        with mock.patch.object(fetch.os, "replace", failing_publish), \
                self.assertRaisesRegex(fetch.Refused, "moved into place"):
            self.run_fetch(**self.SEGMENTED)
        self.assertFalse(Path("src/data.bin").exists())
        self.server.served.clear()
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assertEqual(sum(self.server.served), 0)
        self.assert_whole()

    def test_segments_saving_at_once_never_collide(self):
        # Every range saves its progress often and each write is slowed, so saves from four ranges would overlap
        # (CI did, 2026-10-29: one save's rename found its temporary file already moved by another).
        real = fetch._write_json
        open_saves = {"now": 0, "most": 0}
        lock = threading.Lock()

        def slow(path, value):
            with lock:
                open_saves["now"] += 1
                open_saves["most"] = max(open_saves["most"], open_saves["now"])
            time.sleep(0.01)
            try:
                return real(path, value)
            finally:
                with lock:
                    open_saves["now"] -= 1

        with mock.patch.object(fetch, "STATE_EVERY", 64 * 1024), mock.patch.object(fetch, "_write_json", slow):
            result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertEqual(open_saves["most"], 1)

    def test_a_free_connection_takes_half_of_a_slow_range(self):
        # The first range is paced, the other three are not: once they finish, their connections split the slow
        # range's rest between them, so it is not left to one connection (aria2c's connections do the same).
        self.server.modes = {"slow-first-range"}
        with mock.patch.object(fetch, "MIN_SPLIT", 128 * 1024):
            result = self.run_fetch(min_rate=0, **self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertGreater(self.server.segment_requests, 4)
        # The slow connection stops at its new end: what it read past it is at most what was in flight.
        self.assertLessEqual(sum(self.server.served) - SIZE, 4 * 128 * 1024)

    def test_a_cut_after_bytes_arrived_is_tried_again_at_once(self):
        waits = []
        self.server.modes = {"drop-once"}
        result = self.run_fetch(segments=1, sleep=waits.append)
        self.assertEqual(result["status"], "fetched")
        self.assertEqual(waits, [])  # counted against the budget, but no backoff: the host was answering
        self.server.modes, self.server.requests = {"fail"}, 0
        shutil.rmtree("src", ignore_errors=True)
        with self.assertRaises(fetch.Refused):
            self.run_fetch(segments=1, sleep=waits.append)
        self.assertEqual(waits, [1.0, 2.0])  # a host that answers nothing still gets the backoff

    def test_a_first_url_whose_head_fails_still_segments_from_the_mirror(self):
        other, base = self.mirror()
        self.server.modes = {"fail"}
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=2, sleep=lambda s: None, log=lambda line: None,
                             segment_threshold=1 << 20, **ROOMY)
        self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
        self.assert_whole()
        self.assertGreaterEqual(other.segment_requests, 4)

    # Completion review gaps (D03 T04 §20, G1 to G8).
    def test_a_segment_whose_length_disagrees_with_its_range_does_not_fit(self):
        logged = []
        self.server.modes = {"segment-bad-length"}
        result = self.run_fetch(log=logged.append, **self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertTrue(any("does not fit" in line for line in logged), logged)

    def test_hostile_numbers_are_bounded_and_a_failing_range_ends_the_run(self):
        self.assertIsNone(fetch._content_range("bytes 0-1/" + "9" * 5000))
        self.assertIsNone(fetch._count("9" * 5000))
        self.assertIsNone(fetch._retry_after("9" * 5000))
        self.server.modes = {"segment-huge"}
        self.assertEqual(self.run_fetch(**self.SEGMENTED)["status"], "fetched")  # a misfit: one stream instead
        self.assert_whole()
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes = set()
        real = fetch._content_range
        calls = {"n": 0}

        def breaking(value):
            calls["n"] += 1
            if calls["n"] == 2:
                raise ValueError("unexpected")
            return real(value)

        started = time.monotonic()
        with mock.patch.object(fetch, "_content_range", breaking), \
                self.assertRaisesRegex(fetch.Refused, "failed unexpectedly"):
            self.run_fetch(**self.SEGMENTED)
        self.assertTrue(Path("src/.partial/data.bin").exists())

    def test_a_trickling_head_is_cut_by_the_rate_check_and_the_mirror_used(self):
        other, base = self.mirror()
        # The first range's 206 names no validator, so it cannot answer for the HEAD and the HEAD is asked (D03 T04 §23).
        self.server.modes = {"head-trickle", "no-validator-on-range"}
        started = time.monotonic()
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=30, sleep=lambda s: None, log=lambda line: None,
                             segment_threshold=1 << 20, rate_window=0.5, min_rate=1000, **ROOMY)
        self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
        self.assert_whole()

    def test_a_resumed_segment_state_is_held_to_the_source_limit(self):
        self.server.modes = {"segment-drop-once"}
        with self.assertRaises(fetch.Refused):
            self.run_fetch(attempts=1, **self.SEGMENTED)
        self.server.modes = set()
        with self.assertRaisesRegex(fetch.Refused, "limit"):
            self.run_fetch(source_limit=SIZE // 2, **self.SEGMENTED)
        self.assertFalse(Path("src/data.bin").exists())

    def test_the_floor_counts_the_write_about_to_be_made(self):
        real = fetch._free_space
        calls = {"n": 0}

        def tight(path):
            calls["n"] += 1
            # Room for the start's checks, then only a little over the floor: the next 64 KiB write would cross it.
            return real(path) if calls["n"] <= 3 else 10**6 + 1000

        with mock.patch.object(fetch, "_free_space", tight), self.assertRaisesRegex(fetch.Refused, "free-space floor"):
            self.run_fetch(min_free=10**6, **self.SEGMENTED)
        self.assertFalse(Path("src/data.bin").exists())

    def test_a_mirror_with_another_file_version_is_started_again_there(self):
        # Ranges saved under "v1" from the first URL; that URL now fails, and the mirror holds "v2": the file starts
        # again on the mirror, instead of the restart sending the run back to the failing URL until its tries run out.
        self.server.modes = {"segment-drop-once"}
        with self.assertRaises(fetch.Refused):
            self.run_fetch(attempts=1, **self.SEGMENTED)
        other, base = self.mirror()
        other.etag = '"v2"'
        self.server.modes = {"fail"}
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=2, sleep=lambda s: None, log=lambda line: None,
                             segment_threshold=1 << 20, **ROOMY)
        self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
        self.assert_whole()

    def test_a_late_refusal_from_a_url_already_left_rules_out_that_url_only(self):
        # A range's 503 moves the run to the mirror; another range's request to the first URL then comes back as a
        # redirect to a private address. Only the first URL is ruled out: the mirror the run moved to stays.
        other, base = self.mirror()
        self.server.modes = {"segment-503-then-private"}
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=2, sleep=lambda s: None, log=lambda line: None,
                             segment_threshold=1 << 20, attempts=5, **ROOMY)
        self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
        self.assert_whole()

    def test_eligibility_and_range_checks_hold_through_the_cli(self):
        def cli():
            return subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin",
                                   "--sha256", SHA, "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE),
                                   "--segment-threshold", str(1 << 20)], capture_output=True, text=True, check=False)

        # A HEAD without `Accept-Ranges` or a length, or none at all, is not asked: the first range's 206 answers for
        # it (D03 T04 §23), so those servers are segmented.
        cases = (({"segment-slow"}, True), ({"no-accept-ranges"}, True), ({"weak-etag"}, False), ({"no-length"}, True),
                 ({"encoding"}, False), ({"head-501"}, True), ({"segment-wrong-offset"}, True), ({"bad-bounds"}, True),
                 ({"segment-bad-length"}, True), ({"no-validator-on-range"}, True), ({"segment-short"}, True))
        for modes, segmented in cases:
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.segment_requests, self.server.ranges = set(modes), 0, []
                done = cli()
                self.assertEqual(done.returncode, 0, done.stderr[-300:])
                self.assert_whole()
                # A segmented run asks for some range other than the first range beside the HEAD: the rest of range 0
                # or another range. Not only one past byte 0: a misfit answer to range 0 can end the run before any
                # other range is asked for, depending on scheduling.
                probe = (0, self.first_range_size(1 << 20) - 1)
                self.assertEqual(any(item[:2] != probe for item in self.server.ranges), segmented, self.server.ranges)

    def test_a_failed_flush_never_publishes(self):
        real = fetch.os.fsync

        def failing(kind):
            def fsync(fd):
                path = os.readlink(f"/proc/self/fd/{fd}")
                mode = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
                if path.endswith(".partial/data.bin") and mode == kind:
                    raise OSError(errno.EIO, "I/O error")
                return real(fd)
            return fsync

        # The range writer's flush (read-write descriptor) and the flush before the move (read-only) each fail.
        for kind, reason in ((os.O_RDWR, "state could not be written"), (os.O_RDONLY, "moved into place")):
            with self.subTest(reason=reason):
                shutil.rmtree("src", ignore_errors=True)
                with mock.patch.object(fetch.os, "fsync", failing(kind)), self.assertRaisesRegex(fetch.Refused, reason):
                    self.run_fetch(**self.SEGMENTED)
                self.assertFalse(Path("src/data.bin").exists())
        result = self.run_fetch(**self.SEGMENTED)  # the rerun publishes what the last one verified
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()

    def test_a_segmented_file_is_hashed_as_it_arrives(self):
        # No second pass over the whole file after the transfer: the digest was read back in file order as the ranges
        # filled (a corrupt range is still caught by it: test_a_segmented_file_is_published_only_whole_and_verified).
        with mock.patch.object(fetch, "_digest", side_effect=AssertionError("a whole-file pass")):
            result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual((result["status"], result["sha256"]), ("fetched", SHA))
        self.assert_whole()

    def test_a_partial_replaced_under_its_name_is_never_published(self):
        # D03 T04 §23 round 1: the digest computed as the ranges arrived is of the file the range writer holds open, so
        # another file renamed over the partial's name (a state checkpoint, 413 bytes of JSON) must not be published
        # on it. Replaced during the transfer, and again between the check and the rename.
        impostor = Path("impostor")
        real_pwrite, real_replace = fetch.os.pwrite, fetch.os.replace
        swapped = {"done": False}

        def swap():
            if not swapped["done"]:
                swapped["done"] = True
                impostor.write_text(json.dumps({"url": "x", "segments": [[0, 9, 0]]}) + " " * 380)
                real_replace(impostor, "src/.partial/data.bin")

        def pwrite(descriptor, data, offset):
            written = real_pwrite(descriptor, data, offset)
            swap()
            return written

        def replace(source, destination):
            if Path(destination) == Path("src/data.bin"):
                swap()
            return real_replace(source, destination)

        for where, patch, reason in (("mid-run", mock.patch.object(fetch.os, "pwrite", pwrite), "does not match"),
                                     ("at the rename", mock.patch.object(fetch.os, "replace", replace),
                                      "replaced as it was published")):
            with self.subTest(replaced=where):
                shutil.rmtree("src", ignore_errors=True)
                swapped["done"] = False
                with patch, self.assertRaisesRegex(fetch.Refused, reason):
                    self.run_fetch(**self.SEGMENTED)
                self.assertTrue(swapped["done"])
                self.assertFalse(Path("src/data.bin").exists())
        result = self.run_fetch(**self.SEGMENTED)  # and an untouched run still publishes
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()

    # Round 1 findings (D03 T04 §20).
    def test_a_corrupt_first_url_does_not_get_the_healthy_mirror_ruled_out(self):
        other, base = self.mirror()
        self.server.modes = {"corrupt-drop-once", "fail-after-first"}
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=2, sleep=lambda s: None, log=lambda line: None,
                             segments=1, attempts=5, **ROOMY)
        self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
        self.assert_whole()

    def test_one_stream_asked_for_resumes_saved_ranges(self):
        self.server.modes = {"segment-drop-once"}
        with self.assertRaises(fetch.Refused):
            self.run_fetch(attempts=1, **self.SEGMENTED)
        saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
        missing = sum(last - first + 1 - done for first, last, done in saved["segments"])
        deadline = time.monotonic() + 10
        while self.server.active and time.monotonic() < deadline:
            time.sleep(0.05)
        self.server.modes = set()
        self.server.served.clear()
        result = self.run_fetch(segments=1, **self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertEqual(sum(self.server.served), missing)

    def test_a_short_write_is_finished_not_counted_as_whole(self):
        real = fetch.os.pwrite

        def half(fd, data, offset):
            return real(fd, bytes(data[: max(1, len(data) // 2)]), offset)

        with mock.patch.object(fetch.os, "pwrite", half):
            result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()

    def test_a_range_refused_by_the_first_url_fails_over_without_spending_attempts(self):
        # The HEAD qualifies but every range GET is refused (access that expired after the HEAD): the mirror serves it.
        other, base = self.mirror()
        self.server.modes = {"segment-403"}
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=2, sleep=lambda s: None, log=lambda line: None,
                             segment_threshold=1 << 20, attempts=1, **ROOMY)
        self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
        self.assert_whole()

    # Final review findings (D03 T04 §20).
    def test_a_hostile_416_total_is_a_refusal_line_not_a_traceback(self):
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(BODY)
        Path("src/.partial/data.bin.state.json").write_text(state(self.base, total=None))
        self.server.modes = {"huge-416"}
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin",
                               "--sha256", SHA, "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE),
                               "--segments", "1"], capture_output=True, text=True, check=False)
        self.assertNotIn("Traceback", done.stderr)
        line = json.loads(done.stdout)  # one JSON line, either way
        self.assertIn(line["status"], ("fetched", "incomplete", "refused"))

    def test_one_stream_over_an_inconsistent_segment_state_starts_again(self):
        Path("src/.partial").mkdir(parents=True)
        with open("src/.partial/data.bin", "wb") as handle:
            handle.truncate(SIZE)  # a sparse partial of the full length, as a segmented run leaves
        Path("src/.partial/data.bin.state.json").write_text(json.dumps(
            {"url": self.base + "/file", "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity",
             "total": SIZE, "segments": [[0, 99, 100], [200, SIZE - 1, 0]]}))
        result = self.run_fetch(segments=1)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()

    def test_a_bad_ca_file_is_refused_before_anything_connects(self):
        Path("not-pem.pem").write_text("not a certificate")
        Path("unreadable.pem").write_text("x")
        os.chmod("unreadable.pem", 0)
        for name in ("no-such-ca.pem", "not-pem.pem", "unreadable.pem"):
            with self.subTest(name=name), self.assertRaisesRegex(fetch.Refused, "--ca-file"):
                self.run_fetch(ca_file=name)
        self.assertEqual(self.server.requests, 0)
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin",
                               "--sha256", SHA, "--ca-file", "not-pem.pem"], capture_output=True, text=True, check=False)
        self.assertNotIn("Traceback", done.stderr)
        self.assertIn("--ca-file", json.loads(done.stdout)["reason"])

    # Final review findings (D03 T04 §21).
    def test_a_refused_state_write_ends_the_run_instead_of_silently_stopping_saves(self):
        real = fetch._write_json
        calls = {"n": 0}

        def failing_after_the_first(path, value):
            calls["n"] += 1
            if calls["n"] > 1:
                raise fetch.Refused("incomplete: the download state could not be written (I/O error)")
            return real(path, value)

        with mock.patch.object(fetch, "_write_json", failing_after_the_first), \
                mock.patch.object(fetch, "STATE_EVERY", 256 * 1024), \
                self.assertRaisesRegex(fetch.Refused, "state could not be written"):
            self.run_fetch(**self.SEGMENTED)
        self.assertFalse(Path("src/data.bin").exists())
        self.assertTrue(Path("src/.partial/data.bin").exists())

    def test_one_byte_range_answers_spend_the_attempts(self):
        self.server.modes = {"one-byte-ranges"}
        started = time.monotonic()
        with self.assertRaisesRegex(fetch.Refused, "attempts failed"):
            self.run_fetch(**self.SEGMENTED)

    def test_the_ca_file_is_read_once(self):
        folder = Path(tempfile.mkdtemp(prefix="ca-"))
        self.addCleanup(shutil.rmtree, folder, True)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(folder / "k.pem"),
                        "-out", str(folder / "c.pem"), "-days", "1", "-subj", "/CN=test"], check=True, capture_output=True)
        first = fetch._tls_context(str(folder / "c.pem"))
        (folder / "c.pem").unlink()  # removed after the run's check: later connections still verify
        self.assertIs(fetch._tls_context(str(folder / "c.pem")), first)

    def test_a_ca_file_adds_to_the_system_authorities(self):
        folder = Path(tempfile.mkdtemp(prefix="ca-"))
        self.addCleanup(shutil.rmtree, folder, True)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(folder / "k.pem"),
                        "-out", str(folder / "c.pem"), "-days", "1", "-subj", "/CN=test"], check=True, capture_output=True)
        plain = fetch._tls_context(None).cert_store_stats()["x509_ca"]
        added = fetch._tls_context(str(folder / "c.pem")).cert_store_stats()["x509_ca"]
        self.assertEqual(added, plain + 1)  # the system's authorities kept, one added

    def test_every_json_line_has_a_url(self):
        self.run_fetch()
        self.assertIsNone(self.run_fetch()["url"])  # present: not fetched this run
        self.server.modes = {"fail"}
        shutil.rmtree("src", ignore_errors=True)
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin",
                               "--sha256", SHA, "--allow-loopback", "--min-free", "0", "--attempts", "1"],
                              capture_output=True, text=True, check=False)
        self.assertIn("url", json.loads(done.stdout))

    def test_accept_ranges_is_read_as_a_list(self):
        self.server.modes = {"listed-ranges"}
        self.run_fetch(**self.SEGMENTED)
        self.assert_whole()
        self.assertGreaterEqual(self.server.segment_requests, 4)

    def test_no_connection_waits_on_a_state_write(self):
        # Saves are made on the hasher's thread: slowed to 0.2 seconds each, with a save due every 256 KiB, the
        # transfer does not slow with them (forty saves inline would cost eight seconds).
        # Read from who does what, not the clock (2026-10-31): no thread that writes the file's ranges ever makes a save.
        real, real_pwrite = fetch._write_json, fetch.os.pwrite
        saves, savers, writers = [], set(), set()

        def slow(path, value):
            saves.append(path)
            savers.add(threading.get_ident())
            time.sleep(0.2)
            return real(path, value)

        def writing(fd, data, offset):
            writers.add(threading.get_ident())
            return real_pwrite(fd, data, offset)

        with mock.patch.object(fetch, "_write_json", slow), mock.patch.object(fetch, "STATE_EVERY", 256 * 1024), \
                mock.patch.object(fetch.os, "pwrite", writing):
            result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertGreaterEqual(len(saves), 2)  # the creating save and at least one of progress
        progress = savers - {threading.get_ident()}  # the creating save is made before any range starts
        self.assertTrue(writers)
        self.assertEqual(progress & writers, set())

    def test_a_finished_run_returns_at_once_not_after_an_idle_poll(self):
        # One slow range keeps the other connections idle; when it ends, they and the hasher are rung, not left to
        # wake on their poll (the poll held each run back about 0.2 seconds in the bench; here it is made 5 seconds).
        # Read from the waits, not the clock (a loaded runner broke an elapsed bound, 2026-10-31): the polls are made
        # 600 seconds, and every condition wait is recorded; a run that finished on a poll would have one time out.
        self.server.modes = {"slow-first-range"}
        real_wait = threading.Condition.wait
        timed_out = []

        def recording(condition, timeout=None):
            woken = real_wait(condition, timeout)
            if not woken and timeout is not None and timeout >= 600:
                timed_out.append(timeout)
            return woken

        outcome = {}
        with mock.patch.object(fetch, "IDLE_WAIT", 600.0), mock.patch.object(fetch, "HASH_WAIT", 600.0), \
                mock.patch.object(fetch, "MIN_SPLIT", 64 * 1024 * 1024), \
                mock.patch.object(threading.Condition, "wait", recording):  # no splitting: the slow range ends alone
            runner = threading.Thread(target=lambda: outcome.update(self.run_fetch(min_rate=0, **self.SEGMENTED)))
            runner.start()
            runner.join(300)  # a run left to its 600-second poll is still going here, and fails below
        self.assertFalse(runner.is_alive(), "the run waited on a poll instead of being rung")
        self.assertEqual(outcome.get("status"), "fetched")
        self.assertEqual(timed_out, [])
        self.assert_whole()

    def test_an_interrupted_segmented_fetch_leaves_no_range_writing(self):
        # A caller that catches Ctrl-C and goes on: once fetch() has returned, no range writes or saves.
        self.server.modes = {"segment-slow"}
        writes = []
        real_pwrite, real_join = fetch.os.pwrite, threading.Thread.join
        interrupted = {"done": False}

        def counting(fd, data, offset):
            writes.append(offset)
            return real_pwrite(fd, data, offset)

        def interrupting(thread, *args, **kwargs):
            if not interrupted["done"] and writes:
                interrupted["done"] = True
                raise KeyboardInterrupt
            return real_join(thread, *args, **kwargs)

        with mock.patch.object(fetch.os, "pwrite", counting), mock.patch.object(threading.Thread, "join", interrupting):
            with self.assertRaises(KeyboardInterrupt):
                self.run_fetch(min_rate=0, **self.SEGMENTED)
        after = len(writes)
        time.sleep(0.5)
        self.assertEqual(len(writes), after)

    def test_a_server_without_head_is_fetched_by_its_get(self):
        self.server.modes = {"head-501"}
        result = self.run_fetch(attempts=1, **self.SEGMENTED)  # no attempt spent on the HEAD
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()

    def test_a_failed_folder_flush_after_the_move_still_reports_the_file_in_place(self):
        logged = []
        real = fetch._sync_dir

        def failing_source(path):
            if Path(path) == Path("src"):  # only the source folder's flush after the move; the state's still works
                raise OSError(errno.EIO, "I/O error")
            return real(path)

        with mock.patch.object(fetch, "_sync_dir", failing_source):
            result = self.run_fetch(log=logged.append)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertTrue(any("folder could not be flushed" in line for line in logged))

    def test_an_inconsistent_segment_state_starts_again(self):
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(b"x" * 100)
        Path("src/.partial/data.bin.state.json").write_text(json.dumps(
            {"url": self.base + "/file", "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity",
             "total": SIZE, "segments": [[0, 99, 100], [200, SIZE - 1, 0]]}))
        result = self.run_fetch(**self.SEGMENTED)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()

    # Mirrors (D03 T04 §20): a second server holds the same file; the first one fails in each way a host can.
    def mirror(self):
        other = Server()
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (other.shutdown(), other.server_close()))
        return other, f"http://127.0.0.1:{other.server_address[1]}"

    def test_a_failing_first_url_hands_the_file_to_the_next_mirror(self):
        closed = socket.socket()
        closed.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{closed.getsockname()[1]}/file"
        closed.close()  # nothing listens there now: a refused connection
        cases = {
            "an HTTP 503": ({"fail"}, None),
            "a refused connection": (set(), dead),
            "a redirect to a private address": ({"private"}, "/hop"),
            "different bytes": ({"other-bytes"}, None),
            "an HTTP 404": ({"not-found"}, None),
        }
        for name, (modes, first) in cases.items():
            with self.subTest(name):
                shutil.rmtree("src", ignore_errors=True)
                other, base = self.mirror()
                self.server.modes = set(modes)
                self.server.body = bytes(SIZE) if "other-bytes" in modes else BODY
                start = first if first and first.startswith("http") else self.base + (first or "/file")
                result = fetch.fetch(start, "src/data.bin", ("sha256", SHA), allow_loopback=True, mirrors=[base + "/file"],
                                     timeout=2, sleep=lambda s: None, log=lambda line: None, **ROOMY)
                self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
                self.assert_whole()
        self.server.body = BODY

    def test_every_mirror_failing_is_a_failure_with_the_partial_kept(self):
        other, base = self.mirror()
        self.server.modes = {"fail"}
        other.modes = {"fail"}
        with self.assertRaisesRegex(fetch.Refused, "3 attempts failed"):
            fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True, mirrors=[base + "/file"],
                        timeout=2, sleep=lambda s: None, log=lambda line: None, **ROOMY)
        self.assertFalse(Path("src/data.bin").exists())
        # Both mirrors served other bytes: the last mismatch is the answer, and nothing is kept.
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes, other.modes = set(), set()
        self.server.body = other.body = bytes(SIZE)
        with self.assertRaisesRegex(fetch.Refused, "does not match"):
            fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True, mirrors=[base + "/file"],
                        timeout=2, sleep=lambda s: None, log=lambda line: None, **ROOMY)
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.server.body = BODY

    def test_segments_dropped_by_one_mirror_are_resumed_from_the_next(self):
        other, base = self.mirror()
        self.server.modes = {"segment-drop-once"}
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=2, sleep=lambda s: None, log=lambda line: None,
                             segment_threshold=1 << 20, **ROOMY)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        # After the drop every range's next request goes to the mirror, and the same validator lets each resume there:
        # the two hosts together sent the file once, nothing twice.
        self.assertGreater(sum(other.served), 0)
        self.assertEqual(sum(self.server.served) + sum(other.served), SIZE)

    def test_the_cli_takes_repeated_mirrors_in_order(self):
        other, base = self.mirror()
        self.server.modes = {"fail"}
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin",
                               "--sha256", SHA, "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE),
                               "--mirror", self.base + "/hop", "--mirror", base + "/file", "--attempts", "5"],
                              capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr[-400:])
        line = json.loads(done.stdout)
        self.assertEqual((line["status"], line["url"]), ("fetched", base + "/file"))
        self.assert_whole()

    def test_the_segment_and_mirror_options_are_documented_where_operators_read(self):
        guide = (SCRIPT.parents[2] / "docs" / "glimmer" / "importing.md").read_text(encoding="utf-8")
        for words in ("--segments", "--segment-threshold", "--mirror"):
            self.assertIn(words, fetch.__doc__)
            self.assertIn(words, guide)
        self.assertIn("### Segmented downloads", guide)
        self.assertIn("### Mirrors", guide)

    def test_limits_and_failures_end_bounded_with_the_partial_kept(self):
        with self.assertRaisesRegex(fetch.Refused, "limit"):
            self.run_fetch(source_limit=SIZE // 2)
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes = {"fail"}
        with self.assertRaisesRegex(fetch.Refused, "3 attempts"):
            self.run_fetch()
        self.server.modes = {"drop-once"}
        self.server.requests = 0
        with self.assertRaisesRegex(fetch.Refused, "incomplete"):
            self.run_fetch(attempts=1)
        self.assertTrue(Path("src/.partial/data.bin").exists())
        with self.assertRaisesRegex(fetch.Refused, "free-space floor"):
            self.run_fetch(min_free=10**18)
        # A floor crossed while streaming a file of no stated length stops it, before its first write past the floor.
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes = {"no-length", "ignore-range"}  # a range answer would state the length (Content-Range)
        # A disk whose free space falls by exactly what the download writes, so nothing else on the host moves it.
        start = 10**12

        def disk(_path):
            written = Path("src/.partial/data.bin")
            return start - (written.stat().st_size if written.exists() else 0)

        with mock.patch.object(fetch, "_free_space", disk), self.assertRaisesRegex(fetch.Refused, "fell under"):
            self.run_fetch(min_free=start - 512 * 1024)
        self.assertFalse(Path("src/data.bin").exists())

    def test_a_429_waits_as_long_as_the_server_asks(self):
        self.server.modes = {"429-once"}
        waits = []
        self.assertEqual(self.run_fetch(sleep=waits.append)["status"], "fetched")
        # The first range, sent beside the HEAD, is the request that is asked to wait; what is left of the second by the
        # time it is waited out is the wait (the clock runs from the 429, not from the sleep).
        self.assertEqual(len(waits), 1)
        self.assertAlmostEqual(waits[0], 1.0, delta=0.2)

    def test_a_stalled_server_times_out_within_its_attempts(self):
        self.server.modes = {"stall"}
        with self.assertRaisesRegex(fetch.Refused, "2 attempts"):
            self.run_fetch(timeout=1, attempts=2)

    def test_a_trickle_slower_than_the_floor_is_cut(self):
        # One small write at a time: the rate check runs as bytes arrive, not once per 64 KiB.
        self.server.modes = {"trickle"}
        with self.assertRaisesRegex(fetch.Refused, "slower than"):
            self.run_fetch(min_rate=1024 * 1024, rate_window=0.5, attempts=1)

    def test_a_chunked_body_that_breaks_off_is_tried_again(self):
        self.server.modes = {"chunked", "drop-once"}
        line = self.run_fetch()
        self.assertEqual(line["status"], "fetched")
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_body_with_no_length_is_judged_by_its_digest(self):
        self.server.modes = {"no-length"}
        self.assertEqual(self.run_fetch()["status"], "fetched")
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_full_disk_keeps_the_partial_and_the_next_run_finishes(self):
        calls = {"n": 0}

        def full(handle, block):
            calls["n"] += 1
            if calls["n"] == 20:
                raise OSError(errno.ENOSPC, "No space left on device")
            handle.write(block)

        with self.assertRaisesRegex(fetch.Refused, "disk is full"):
            self.run_fetch(writer=full)
        self.assertTrue(Path("src/.partial/data.bin").exists())
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", True))
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_failure_at_the_state_write_or_the_promotion_recovers_on_the_next_run(self):
        with mock.patch.object(fetch, "_write_json_now", side_effect=OSError(errno.EIO, "I/O error")), \
                self.assertRaisesRegex(fetch.Refused, "state could not be written"):
            self.run_fetch()
        self.assertFalse(Path("src/data.bin").exists())
        self.assertEqual(self.run_fetch()["status"], "fetched")
        shutil.rmtree("src")
        real = os.replace

        def promotion_fails(src, dst):
            if str(dst).endswith("src/data.bin"):
                raise OSError(errno.EIO, "I/O error")
            return real(src, dst)

        with mock.patch.object(fetch.os, "replace", promotion_fails), \
                self.assertRaisesRegex(fetch.Refused, "could not be moved into place"):
            self.run_fetch()
        served = len(self.server.served)
        line = self.run_fetch()
        # The verified partial was kept: the next run promotes it without fetching it again.
        self.assertEqual((line["status"], line["fetched"], len(self.server.served)), ("fetched", 0, served))

    def test_a_multi_file_source_stopped_between_files_reuses_the_first(self):
        other = hashlib.sha256(BODY[::-1]).hexdigest()
        self.run_fetch(dest="src/a.bin")
        self.server.body = BODY[::-1]
        self.server.modes = {"drop-once"}
        self.server.requests = 0
        with self.assertRaises(fetch.Refused):
            self.run_fetch(dest="src/b.bin", sha=other, attempts=1)
        self.server.body = BODY
        self.server.modes = set()
        served = len(self.server.served)
        self.assertEqual(self.run_fetch(dest="src/a.bin")["status"], "present")
        self.assertEqual(len(self.server.served), served)
        self.server.body = BODY[::-1]
        line = self.run_fetch(dest="src/b.bin", sha=other)
        self.assertEqual((line["status"], line["resumed"]), ("fetched", True))
        Path("src/a.bin").write_bytes(b"changed")
        with self.assertRaisesRegex(fetch.Refused, "differs"):
            self.run_fetch(dest="src/a.bin")


    # Several healthy mirrors at once (D03 T04 §22).
    def mixed(self, *others, log=None, **options):
        """This server first, then each of `others` (their base URLs) as mirrors, all given the one segmented run."""
        merged = {**ROOMY, "timeout": 2, "sleep": lambda s: None, "log": log or (lambda line: None),
                  "segment_threshold": 1 << 20, **options}
        return fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                           mirrors=[base + "/file" for base in others], **merged)

    def share_peak(self, *servers):
        """The servers counted together (`hosts`, `together`), and `peak`: the most connections fetch.py itself held open
        at once, every socket it opened until it closed it, idle kept ones included. A loaded server sees a client's
        close late, so its own count is no proof of the cap (2026-10-31)."""
        group = {"active": 0, "peak": 0, "lock": threading.Lock(), "hosts": {}, "together": 0, "open": 0}
        for server in servers:
            server.group = group
        real_connect = fetch._connect

        def counting(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            with group["lock"]:
                group["open"] += 1
                group["peak"] = max(group["peak"], group["open"])
            real_close, closed = connection.close, []

            def close():
                with group["lock"]:
                    if not closed:
                        closed.append(True)
                        group["open"] -= 1
                return real_close()

            connection.close = close
            return connection

        patch = mock.patch.object(fetch, "_connect", counting)
        patch.start()
        self.addCleanup(patch.stop)
        return group

    def recording_writes(self):
        """Every write the ranges make: (when, offset, length), and the patch that records them."""
        writes, real = [], os.pwrite

        def pwrite(descriptor, data, offset):
            writes.append((time.monotonic(), offset, len(data)))
            return real(descriptor, data, offset)

        return writes, mock.patch.object(fetch.os, "pwrite", pwrite)

    def assert_no_overlap(self, writes):
        spans = sorted((offset, offset + length) for _, offset, length in writes)
        for (_, before), (after, _) in zip(spans, spans[1:]):
            self.assertGreaterEqual(after, before)

    def test_two_agreeing_hosts_both_serve_ranges_with_four_connections_at_most(self):
        other, base = self.mirror()
        self.server.pace = other.pace = 0.02  # paced, so the ranges are seen to overlap
        # The connections counted where fetch.py holds them, not as a loaded server happens to see them (2026-10-31):
        # every socket it opens, until it is closed.
        real_connect, held = fetch._connect, {"open": 0, "peak": 0, "lock": threading.Lock()}

        def counting(*args, **kwargs):
            connection = real_connect(*args, **kwargs)
            with held["lock"]:
                held["open"] += 1
                held["peak"] = max(held["peak"], held["open"])
            real_close, closed = connection.close, []

            def close():
                if not closed:
                    closed.append(True)
                    with held["lock"]:
                        held["open"] -= 1
                return real_close()

            connection.close = close
            return connection

        with mock.patch.object(fetch, "_connect", counting):
            result = self.mixed(base, min_rate=0)
        self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
        self.assert_whole()
        self.assertEqual((self.server.segment_requests, other.segment_requests), (3, 2))  # 4 ranges and the first one's rest
        self.assertEqual(sum(self.server.served) + sum(other.served), SIZE)
        self.assertEqual(set(result["urls"]), {self.base + "/file", base + "/file"})
        self.assertEqual(result["url"], result["urls"][0])
        self.assertGreaterEqual(held["peak"], 2)  # ranges in flight together
        self.assertLessEqual(held["peak"], 4)

    def test_five_sources_never_hold_more_than_four_connections_across_the_heads_and_the_ranges(self):
        others = [self.mirror() for _ in range(4)]
        servers = [self.server, *(other for other, _ in others)]
        group = self.share_peak(*servers)
        for server in servers:
            server.head_pause = 0.3  # held open, so five HEADs started together would be seen at once
            server.pace = 0.01
        result = self.mixed(*(base for _, base in others), min_rate=0)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        # Every source was asked: the first by its first range, whose 206 answered for its HEAD, the mirrors by a HEAD.
        self.assertEqual([server.heads for server in servers], [0] + [1] * 4)
        self.assertEqual(self.server.ranges[0][:2], (0, self.first_range_size(1 << 20) - 1))
        # The HEADs held open together, and nothing went past four (the most at once is the scheduler's on a loaded host).
        self.assertGreaterEqual(group["peak"], 2)
        self.assertLessEqual(group["peak"], 4)

    def test_the_first_range_adopted_with_two_agreeing_sources_holds_four_connections_at_most(self):
        # D03 T04 §23 (the 2026-10-31 01:42 UTC bench: five at once in 14 of 20 runs). Each host keeps a paced answer open
        # a moment after its last piece, as the bench's host does while it pays that piece's pace, so the first range's
        # answer is still open at the host when its last byte has arrived. The rest of range 0 must not come on a new
        # connection then: with the three other ranges open, that is a fifth. Forced: range 0 (and the first range
        # beside the HEAD) on the first URL's host and on the mirror's, and the HEADs outlasting the first range.
        for first_host, head_pause in ((0, 0.0), (1, 0.0), (0, 0.3), (1, 0.3)):
            with self.subTest(range_0_on=("first URL", "mirror")[first_host], head_pause=head_pause):
                shutil.rmtree("src", ignore_errors=True)
                servers = [self.mirror() for _ in range(2)]
                group = self.share_peak(*(server for server, _ in servers))
                for server, _ in servers:
                    server.pace, server.linger = 0.02, 0.3
                servers[1 - first_host][0].head_pause = head_pause  # the other host's HEAD answered after the first range
                (probe_host, first_base), (_, mirror_base) = servers[first_host], servers[1 - first_host]
                result = fetch.fetch(first_base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                                     mirrors=[mirror_base + "/file"], timeout=2, sleep=lambda s: None,
                                     log=lambda line: None, segment_threshold=1 << 20, min_rate=0, **ROOMY)
                self.assertEqual((result["status"], result["fetched"]), ("fetched", SIZE))
                self.assert_whole()
                size = self.first_range_size(1 << 20)
                self.assertEqual(probe_host.ranges[0][:2], (0, size - 1))  # the first range was asked of this host
                self.assertIn(size, [first for first, _, _ in probe_host.ranges])  # and the rest of range 0 too
                self.assertEqual(sum(sum(server.served) for server, _ in servers), SIZE)  # its bytes were adopted
                self.assertGreaterEqual(group["peak"], 2)
                self.assertLessEqual(group["peak"], 4)

    def test_a_held_download_saves_all_it_received_and_a_resume_refetches_no_more_than_a_block_a_range(self):
        # D03 T04 §23 (the bench's gigabyte row: 827,392 bytes fetched again against aria2c's 65,536). Every paced answer
        # stops at one byte and holds there, as the bench's host does before the kill. Within about a second the saved
        # state holds every byte that arrived (aria2c saves its control file every second; saving only after each MiB
        # left up to a MiB unsaved however long the transfer stalled), so a second process asks again for no more than
        # a block in each range open at the kill: the bench's figure, the bytes sent across both processes over the size.
        self.server.pace = 0.01
        self.server.hold_at = 2 * 1024 * 1024 + 640 * 1024  # well past the MiB saves, by less than a MiB
        command = [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin", "--sha256", SHA,
                   "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE), "--segment-threshold", str(1 << 20),
                   "--min-rate", "0", "--timeout", "30"]
        first = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        state_path = Path("src/.partial/data.bin.state.json")
        kept, deadline = 0, time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                with self.server.lock:
                    sent = sum(self.server.served)
                try:
                    kept = sum(item[2] for item in json.loads(state_path.read_text())["segments"])
                except (OSError, ValueError, KeyError, TypeError):
                    kept = 0  # not written yet, or caught mid-replace
                if sent >= self.server.hold_at and kept >= sent:
                    break  # held, and everything that arrived is saved
                time.sleep(0.05)
        finally:
            first.kill()
            first.wait()
            self.server.release.set()
        self.assertGreaterEqual(sum(self.server.served), self.server.hold_at)
        deadline = time.monotonic() + 10
        while self.server.active and time.monotonic() < deadline:
            time.sleep(0.05)
        self.server.hold_at, self.server.pace = None, 0.0
        done = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertEqual(done.returncode, 0, done.stderr[-400:])
        self.assert_whole()
        refetched = sum(self.server.served) - SIZE
        self.assertLessEqual(refetched, 4 * fetch.CHUNK, (refetched, kept))

    def test_a_host_that_disagrees_on_the_file_serves_no_range_while_the_others_are_healthy(self):
        agreeing, first = self.mirror()
        disagreeing, second = self.mirror()
        disagreeing.etag = '"v2"'
        logged = []
        result = self.mixed(second, first, log=logged.append)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertEqual((disagreeing.segment_requests, disagreeing.requests), (0, 0))
        self.assertGreater(agreeing.segment_requests, 0)
        self.assertGreater(self.server.segment_requests, 0)
        self.assertTrue(any(second in line and "not in the mix" in line for line in logged), logged)
        # A length that differs is a disagreement too.
        shutil.rmtree("src")
        disagreeing.etag, disagreeing.body = '"v1"', BODY + b"x"
        self.run_mixed_without_a_range_from(disagreeing, second, first)

    def run_mixed_without_a_range_from(self, outsider, outside, inside):
        result = self.mixed(outside, inside)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertEqual(outsider.segment_requests, 0)

    def test_the_disagreeing_host_completes_when_the_agreeing_one_serves_an_outdated_file(self):
        outdated, first = self.mirror()
        outdated.body = self.server.body = bytes(SIZE)  # the same validator, other bytes: outdated copies
        current, second = self.mirror()
        current.etag = '"v2"'
        result = self.mixed(first, second)  # this server and `outdated` agree and are both outdated
        self.assertEqual((result["status"], result["url"], result["urls"]), ("fetched", second + "/file", [second + "/file"]))
        self.assert_whole()
        self.assertGreater(current.requests, 0)

    def test_a_host_that_slows_leaves_its_tail_to_the_faster_one_and_no_byte_has_two_writers(self):
        fast, base = self.mirror()
        self.server.pace = 0.05
        group = self.share_peak(self.server, fast)
        writes, recording = self.recording_writes()
        with mock.patch.object(fetch, "MIN_SPLIT", 128 * 1024), recording:
            result = self.mixed(base, min_rate=0)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assert_no_overlap(writes)
        self.assertLessEqual(group["peak"], 4)
        quarter = -(-SIZE // 4)
        slow_ranges = [(0, quarter - 1), (2 * quarter, 3 * quarter - 1)]
        taken = [(first, last) for first, last, _ in fast.ranges
                 if any(low < first <= high for low, high in slow_ranges)]
        self.assertTrue(taken, fast.ranges)  # the fast host was asked for part of a range the slow one began
        middle = taken[0][0]
        low, high = next((low, high) for low, high in slow_ranges if low < middle <= high)
        tail_done = max(when for when, offset, _ in writes if middle <= offset <= high)
        kept_done = max(when for when, offset, _ in writes if low <= offset < middle)
        self.assertLess(tail_done, kept_done)  # the taken tail was finished before the slow host's kept half

    def test_a_stalled_host_loses_its_work_to_the_other_within_the_one_budget(self):
        healthy, base = self.mirror()
        self.server.modes = {"segment-stall"}
        group = self.share_peak(self.server, healthy)
        writes, recording = self.recording_writes()
        started = time.monotonic()
        with mock.patch.object(fetch, "MIN_SPLIT", 128 * 1024), recording:
            result = self.mixed(base, attempts=5, rate_window=0.6, min_rate=50_000)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assert_no_overlap(writes)
        self.assertLessEqual(group["peak"], 4)
        quarter = -(-SIZE // 4)
        slow_ranges = [(0, quarter - 1), (2 * quarter, 3 * quarter - 1)]
        taken = [first for first, _, _ in healthy.ranges if any(low < first <= high for low, high in slow_ranges)]
        self.assertTrue(taken, healthy.ranges)  # the healthy host was asked for the tail of a range the stalled one began
        middle = taken[0]
        low, high = next((low, high) for low, high in slow_ranges if low < middle <= high)
        tail_done = max(when for when, offset, _ in writes if middle <= offset <= high)
        kept_done = max(when for when, offset, _ in writes if low <= offset < middle)
        self.assertLess(tail_done, kept_done)  # the taken tail was finished before the stalled host's kept half
        self.assertIn(base + "/file", result["urls"])

    def test_a_host_that_disconnects_hands_its_unfinished_range_to_the_other(self):
        healthy, base = self.mirror()
        self.server.modes = {"segment-drop-once"}
        group = self.share_peak(self.server, healthy)
        writes, recording = self.recording_writes()
        with recording:
            result = self.mixed(base)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assert_no_overlap(writes)
        self.assertLessEqual(group["peak"], 4)
        quarter = -(-SIZE // 4)
        # Every request the healthy host got beyond its own two ranges began inside a range this host had begun.
        starts = sorted(first for first, _, _ in healthy.ranges)
        self.assertEqual(len(starts), 3, starts)
        self.assertTrue(any(first not in (quarter, 3 * quarter) for first in starts), starts)


    # §20's rules with several sources active (D03 T04 §22).
    def test_failures_from_any_source_spend_the_one_budget_and_blame_stays_with_the_source(self):
        healthy, base = self.mirror()
        self.server.modes = {"segment-503"}  # this host answers HEAD, then refuses every range
        result = self.mixed(base, attempts=5)
        self.assertEqual((result["status"], result["urls"]), ("fetched", [base + "/file"]))
        self.assert_whole()
        # The first range asked for beside the HEAD, and its two ranges, each refused once and handed to the other.
        self.assertEqual(self.server.segment_requests, 3)
        self.assertEqual(sum(healthy.served), SIZE)
        shutil.rmtree("src")
        self.server.segment_requests = 0
        with self.assertRaisesRegex(fetch.Refused, "2 attempts failed"):
            self.mixed(base, attempts=2)  # the same two refusals, counted against a budget of two
        self.assertFalse(Path("src/data.bin").exists())

    def test_a_retry_after_pauses_only_the_source_that_sent_it(self):
        healthy, base = self.mirror()
        self.server.modes = {"segment-429"}  # Retry-After: 30
        logged = []
        # Read from the waits, not the clock (2026-10-31): no wait of 30 seconds or more is ever left to time out.
        waited = []
        real_event, real_condition = threading.Event.wait, threading.Condition.wait

        def event_wait(event, timeout=None):
            woken = real_event(event, timeout)
            if not woken and timeout is not None and timeout >= 30:
                waited.append(timeout)
            return woken

        def condition_wait(condition, timeout=None):
            woken = real_condition(condition, timeout)
            if not woken and timeout is not None and timeout >= 30:
                waited.append(timeout)
            return woken

        with mock.patch.object(threading.Event, "wait", event_wait), mock.patch.object(threading.Condition, "wait", condition_wait):
            result = self.mixed(base, attempts=5, log=logged.append)
        self.assertEqual((result["status"], result["urls"]), ("fetched", [base + "/file"]))
        self.assert_whole()
        self.assertEqual(waited, [])  # nobody waited the 30 seconds out
        self.assertTrue(any("trying again in 30 seconds" in line for line in logged), logged)  # the pause was taken
        # The paused host was not asked again: it saw only the ranges already in flight when its 429 came back (one
        # or two, as the healthy mirror's speed decides under load); a client that ignored the pause would keep asking
        # it until the five attempts were spent, and one that waited it out would take the 30 seconds.
        self.assertIn(self.server.segment_requests, (1, 2))

    def test_a_retry_after_from_a_head_is_kept_until_the_fallback_asks_that_source_again(self):
        # The mirror is the one sent a HEAD (the first URL's first range answers for its own, D03 T04 §23).
        refusing, base = self.mirror()
        refusing.modes = {"segment-403"}  # the first URL: its every range is refused (the first range too)
        self.server.modes = {"head-429"}  # the mirror: Retry-After: 30, to the HEAD only
        slept = []
        result = fetch.fetch(base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[self.base + "/file"], attempts=5, timeout=2, log=lambda line: None,
                             sleep=lambda seconds: slept.append((time.monotonic(), seconds)), segment_threshold=1 << 20,
                             **ROOMY)
        self.assertEqual((result["status"], result["urls"]), ("fetched", [self.base + "/file"]))
        self.assert_whole()
        self.assertEqual(self.server.heads, 1)  # not asked again for a HEAD either
        self.assertEqual(refusing.heads, 1)  # its first range's 403 could not answer for its HEAD
        waited = [when for when, seconds in slept if 25 <= seconds <= 30]
        self.assertTrue(waited, slept)  # the 30 seconds were waited out before this source was asked for a range
        # Not asked for a range after the HEAD's 429 before the wait ended.
        later = sorted(when for _, _, when in self.server.ranges)
        self.assertTrue(later)
        self.assertLess(max(waited), min(later))

    def test_each_connection_keeps_its_rate_floor_while_the_other_source_writes(self):
        healthy, base = self.mirror()
        self.server.pace = 0.5  # 128 KiB a second on each connection, under the floor
        logged = []
        result = self.mixed(base, attempts=5, rate_window=1.0, min_rate=300_000, log=logged.append)
        self.assertEqual(result["status"], "fetched")
        self.assert_whole()
        self.assertTrue(any("slower than the rate floor" in line for line in logged), logged)
        self.assertIn(base + "/file", result["urls"])

    def test_the_lock_the_folder_limit_and_the_floor_hold_for_the_whole_run(self):
        healthy, base = self.mirror()
        with self.assertRaisesRegex(fetch.Refused, "limit"):
            self.mixed(base, source_limit=SIZE // 2)
        self.assertFalse(Path("src/data.bin").exists())
        def tight(path):
            return 10**6 + SIZE // 2  # room for about half the file

        with mock.patch.object(fetch, "_free_space", tight), self.assertRaisesRegex(fetch.Refused, "free-space floor"):
            self.mixed(base, min_free=10**6)
        self.assertFalse(Path("src/data.bin").exists())
        shutil.rmtree("src")
        self.server.pace = healthy.pace = 0.05
        outcome = {}
        runner = threading.Thread(target=lambda: outcome.update(self.mixed(base, min_rate=0)))
        runner.start()
        deadline = time.monotonic() + 10
        while not Path("src/.partial/data.bin.state.json").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        with self.assertRaisesRegex(fetch.Refused, "another download"):
            self.mixed(base)
        runner.join()
        self.assertEqual(outcome["status"], "fetched")

    def test_the_free_space_floor_is_held_while_both_sources_are_writing(self):
        healthy, base = self.mirror()
        self.server.pace = healthy.pace = 0.02  # both are mid-body when the floor is crossed
        written = [0]
        real_pwrite = os.pwrite

        def pwrite(descriptor, data, offset):
            written[0] += len(data)
            return real_pwrite(descriptor, data, offset)

        def shrinking(path):
            # Room for the whole file at the start (the preflight passes), then every byte written takes two.
            return 10**6 + SIZE + 1000 - 2 * written[0]

        with mock.patch.object(fetch, "_free_space", shrinking), mock.patch.object(fetch.os, "pwrite", pwrite), \
                self.assertRaisesRegex(fetch.Refused, "free-space floor"):
            self.mixed(base, min_free=10**6, min_rate=0)
        self.assertGreater(sum(self.server.served), 0)  # both sources had been writing
        self.assertGreater(sum(healthy.served), 0)
        self.assertFalse(Path("src/data.bin").exists())
        self.assertTrue(Path("src/.partial/data.bin.state.json").exists())  # the partial is kept for a rerun

    def test_an_ignored_range_a_malformed_answer_or_a_refused_redirect_fails_only_that_source(self):
        for modes in ({"ignore-range"}, {"segment-wrong-offset"}, {"segment-private"}, {"segment-bad-length"}):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                healthy, base = self.mirror()
                self.server.modes, self.server.segment_requests, self.server.requests = set(modes), 0, 0
                result = self.mixed(base, attempts=3)
                self.assertEqual((result["status"], result["urls"]), ("fetched", [base + "/file"]))
                self.assert_whole()
                # The healthy host was never asked for the whole file: nothing started again on one stream.
                self.assertEqual(healthy.requests, healthy.segment_requests)
                self.assertEqual(healthy.heads, 1)

    def changing_host(self, **flip):
        """This host, flipping to another file after its first two ranged answers, serving the first half of every
        range with a wrong byte early on, and a healthy mirror; the mirror's base URL."""
        healthy, base = self.mirror()
        self.server.modes = {"segment-short"}
        self.server.damaged = {100}
        self.server.flip_after = 2
        for name, value in flip.items():
            setattr(self.server, name, value)
        return healthy, base

    def snapshots(self):
        """Every state the run writes, and every write to the file, in order."""
        events, real_write, real_pwrite = [], fetch._write_json, os.pwrite

        def write_json(path, value):
            if path.name.endswith(".state.json"):
                events.append(("state", json.loads(json.dumps(value))))
            return real_write(path, value)

        def pwrite(descriptor, data, offset):
            events.append(("write", offset))
            return real_pwrite(descriptor, data, offset)

        return events, (mock.patch.object(fetch, "_write_json", write_json), mock.patch.object(fetch.os, "pwrite", pwrite))

    def test_a_source_whose_validator_changes_has_its_ranges_invalidated_before_any_replacement(self):
        for flip in ({}, {"flip_etag": None, "flip_body": BODY + b"x"}):  # a new validator; then a new length
            with self.subTest(flip=flip):
                shutil.rmtree("src", ignore_errors=True)
                self.server.etag, self.server.body, self.server.segment_requests = '"v1"', BODY, 0
                healthy, base = self.changing_host(**flip)
                events, (patch_state, patch_writes) = self.snapshots()
                with patch_state, patch_writes:
                    result = self.mixed(base, attempts=5)
                # The wrong bytes the changing host sent first never reached the published file, nor its digest:
                # nothing was started again whole, and the healthy host supplied everything.
                self.assertEqual((result["status"], result["urls"]), ("fetched", [base + "/file"]))
                self.assert_whole()
                self.assertEqual(healthy.requests, healthy.segment_requests)
                writes_at_start = [number for number, event in enumerate(events) if event == ("write", 0)]
                self.assertGreaterEqual(len(writes_at_start), 2)  # its bytes, then the replacement's
                saved = [event[1] for event in events[writes_at_start[0] + 1:writes_at_start[1]] if event[0] == "state"]
                mine = self.base + "/file"

                def cut(state_):
                    # Spans name their source by its place in `sources`, which only grows: a state saved before the
                    # changing host's first span was recorded (the threads decide when) can hold none of its spans.
                    sources = state_["sources"]
                    return state_["segments"][0][2] == 0 and sources and (
                        mine not in sources or all(span[2] != sources.index(mine) for span in state_["provenance"]))

                self.assertTrue(any(cut(state_) for state_ in saved), saved)  # the cut was saved before the replacement

    def test_a_changed_source_loses_every_range_its_one_provenance_span_covers(self):
        healthy, base = self.mirror()
        mine = self.base + "/file"
        quarter = -(-SIZE // 4)
        # An earlier process left the first two ranges whole from this host alone, so the provenance holds the one
        # span [0, 2 quarters) that runs across the boundary between them; the bytes are wrong, so any range left
        # behind would fail the digest.
        Path("src/.partial").mkdir(parents=True)
        with open("src/.partial/data.bin", "wb") as handle:
            handle.truncate(SIZE)
            handle.write(bytes(2 * quarter))
        Path("src/.partial/data.bin.state.json").write_text(json.dumps({
            "url": mine, "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE,
            "segments": [[0, quarter - 1, quarter], [quarter, 2 * quarter - 1, quarter],
                         [2 * quarter, 3 * quarter - 1, 0], [3 * quarter, SIZE - 1, 0]],
            "sources": [mine], "provenance": [[0, 2 * quarter - 1, 0]]}))
        self.server.flip_after = 0  # the first range it is asked for comes from another file
        events, (patch_state, patch_writes) = self.snapshots()
        with patch_state, patch_writes:
            result = self.mixed(base, attempts=5)
        self.assertEqual((result["status"], result["urls"]), ("fetched", [base + "/file"]))
        self.assert_whole()
        self.assertEqual(healthy.requests, healthy.segment_requests)  # nothing started again whole
        cut = [event[1] for event in events if event[0] == "state" and event[1]["segments"][0][2] == 0
               and event[1]["segments"][1][2] == 0 and "provenance" in event[1]
               and all(span[2] != event[1]["sources"].index(mine) for span in event[1]["provenance"])]
        self.assertTrue(cut, "the cut of both ranges was never saved")

    def test_overlapping_invalidations_keep_a_range_parked_until_the_last_cut_is_saved(self):
        second, second_base = self.mirror()
        third, third_base = self.mirror()
        mine, theirs = self.base + "/file", second_base + "/file"
        quarter = -(-SIZE // 4)
        # The first range holds this host's prefix and the second host's suffix (wrong bytes both); each of the two
        # changes its file at its first ranged answer, this one a moment after the other, so the second host's
        # invalidation (cutting back to the middle) is saved slowly while this host's (cutting back to the start)
        # waits behind it.
        Path("src/.partial").mkdir(parents=True)
        with open("src/.partial/data.bin", "wb") as handle:
            handle.truncate(SIZE)
            handle.write(bytes(quarter))
        Path("src/.partial/data.bin.state.json").write_text(json.dumps({
            "url": mine, "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE,
            "segments": [[0, quarter - 1, quarter], [quarter, 2 * quarter - 1, 0], [2 * quarter, 3 * quarter - 1, 0],
                         [3 * quarter, SIZE - 1, 0]],
            "sources": [mine, theirs], "provenance": [[0, quarter // 2 - 1, 0], [quarter // 2, quarter - 1, 1]]}))
        self.server.flip_after = second.flip_after = 0
        self.server.range_pause = 0.3
        events, real_write, real_pwrite = [], fetch._write_json, os.pwrite

        def write_json(path, value):
            if path.name.endswith(".state.json") and value["segments"][0][2] < quarter:
                time.sleep(0.6)  # every save of a cut is slow
                real_write(path, value)
                events.append(("saved", value["segments"][0][2]))
            else:
                real_write(path, value)

        def pwrite(descriptor, data, offset):
            if offset < quarter:
                events.append(("replaced", offset))
            return real_pwrite(descriptor, data, offset)

        with mock.patch.object(fetch, "_write_json", write_json), mock.patch.object(fetch.os, "pwrite", pwrite):
            result = self.mixed(second_base, third_base, attempts=5)
        self.assertEqual((result["status"], result["urls"]), ("fetched", [third_base + "/file"]))
        self.assert_whole()
        first_replacement = next(number for number, event in enumerate(events) if event[0] == "replaced")
        self.assertIn(("saved", 0), events[:first_replacement])  # the deeper cut was saved before any replacement byte

    def test_a_stop_during_a_replacement_is_resumed_by_a_fresh_process(self):
        for where in ("before the first replacement byte", "after some replacement bytes"):
            with self.subTest(where):
                shutil.rmtree("src", ignore_errors=True)
                self.server.etag, self.server.body, self.server.segment_requests = '"v1"', BODY, 0
                healthy, base = self.changing_host()
                mine = self.base + "/file"
                real_write, real_pwrite = fetch._write_json, os.pwrite
                seen = {"cut": False, "replaced": 0}

                def cut_saved(value):
                    names = value.get("sources") or []
                    return mine in names and all(span[2] != names.index(mine) for span in value.get("provenance") or [])

                def write_json(path, value):
                    real_write(path, value)
                    if path.name.endswith(".state.json") and cut_saved(value) and not seen["cut"]:
                        seen["cut"] = True
                        if where.startswith("before"):
                            raise fetch.Refused("incomplete: the test stops the run")

                def pwrite(descriptor, data, offset):
                    if seen["cut"] and not where.startswith("before"):
                        seen["replaced"] += 1
                        if seen["replaced"] == 3:
                            raise fetch.Refused("incomplete: the test stops the run")
                    return real_pwrite(descriptor, data, offset)

                with mock.patch.object(fetch, "_write_json", write_json), mock.patch.object(fetch.os, "pwrite", pwrite), \
                        self.assertRaisesRegex(fetch.Refused, "the test stops the run"):
                    self.mixed(base, attempts=5)
                self.assertTrue(seen["cut"])
                saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
                self.assertEqual(saved["segments"][0][2] if where.startswith("before") else 0, 0)
                names = saved["sources"]
                self.assertTrue(all(span[2] != names.index(mine) for span in saved["provenance"]))
                self.assertFalse(Path("src/data.bin").exists())
                code, result = self.cli_run("--mirror", base + "/file", "--attempts", "5")  # a fresh process
                self.assertEqual((code, result["status"], result["resumed"]), (0, "fetched", True), result)
                self.assertEqual(result["urls"], [base + "/file"])
                self.assert_whole()


    # A mixed-source digest failure, recovered in isolation (D03 T04 §22).
    def one_corrupt(self, corrupt_first: bool, offset: int):
        """This server first and a mirror second, one of them damaged at `offset`: (corrupt, healthy, their URLs)."""
        mirror, base = self.mirror()
        corrupt, healthy = (self.server, mirror) if corrupt_first else (mirror, self.server)
        corrupt.damaged = {offset}
        urls = (self.base + "/file", base + "/file")
        return corrupt, healthy, (urls[0], urls[1]) if corrupt_first else (urls[1], urls[0]), base

    @staticmethod
    def trials(server):
        """Whole-file requests the server answered: what a trial is (a range request carries its end)."""
        return server.requests - server.segment_requests

    def stopping_after(self, wanted):
        """Raises after the state the `wanted` test accepts has been written, as a killed process leaves it."""
        real = fetch._write_json
        seen = {"hit": False}

        def write_json(path, value):
            real(path, value)
            if path.name.endswith(".state.json") and not seen["hit"] and wanted(value):
                seen["hit"] = True
                raise fetch.Refused("incomplete: the test stops the run")

        return mock.patch.object(fetch, "_write_json", write_json)

    def test_a_mixed_source_digest_failure_publishes_only_the_healthy_sources_bytes(self):
        cases = ((True, 100), (True, 5_500_000), (False, 3_000_000), (False, 8_000_000))  # each order, early and late
        for corrupt_first, offset in cases:
            with self.subTest(corrupt_first=corrupt_first, offset=offset):
                shutil.rmtree("src", ignore_errors=True)
                self.server.damaged, self.server.requests, self.server.segment_requests = set(), 0, 0
                corrupt, healthy, (bad, good), base = self.one_corrupt(corrupt_first, offset)
                logged = []
                result = self.mixed(base, attempts=5, log=logged.append)
                self.assertEqual((result["status"], result["urls"], result["resumed"]), ("fetched", [good], False))
                self.assert_whole()
                self.assertEqual(self.trials(healthy), 1)
                ruled = [line for line in logged if "ruled out" in line]
                if corrupt_first:
                    # Its trial came first and named it; the healthy source's verified.
                    self.assertEqual(self.trials(corrupt), 1)
                    self.assertEqual(len(ruled), 1)
                    self.assertIn(bad, ruled[0])
                else:
                    self.assertEqual((self.trials(corrupt), ruled), (0, []))  # the healthy one verified first

    MATRIX = ((True, 100), (True, 5_500_000), (False, 3_000_000), (False, 8_000_000))  # the corrupt one first, then second

    def test_the_search_is_kept_in_the_state_and_a_fresh_process_goes_on_from_it(self):
        for corrupt_first, offset in self.MATRIX:
            with self.subTest(corrupt_first=corrupt_first, offset=offset):
                shutil.rmtree("src", ignore_errors=True)
                self.server.damaged, self.server.requests, self.server.segment_requests = set(), 0, 0
                corrupt, healthy, (bad, good), base = self.one_corrupt(corrupt_first, offset)

                def just_started(value):
                    return bool(value.get("recovery")) and not value["recovery"]["ruled_out"]

                with self.stopping_after(just_started), self.assertRaisesRegex(fetch.Refused, "the test stops the run"):
                    self.mixed(base, attempts=5)
                saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
                self.assertEqual((saved["recovery"]["candidates"], saved["recovery"]["ruled_out"]),
                                 ([self.base + "/file", base + "/file"], []))
                self.assertFalse(Path("src/.partial/data.bin").exists())  # the mixed bytes are gone: no trial reads them
                self.assertFalse(Path("src/data.bin").exists())
                code, line = self.cli_run("--mirror", base + "/file", "--attempts", "5")  # a fresh process
                self.assertEqual((code, line["status"], line["urls"]), (0, "fetched", [good]), line)
                self.assert_whole()
                self.assertEqual(self.trials(healthy), 1)
                self.assertEqual(self.trials(corrupt), 1 if corrupt_first else 0)  # the healthy one verified first

    def test_a_source_named_bad_is_never_readmitted_by_a_fresh_process(self):
        for offset in (100, 5_500_000):
            with self.subTest(offset=offset):
                shutil.rmtree("src", ignore_errors=True)
                self.server.damaged, self.server.requests, self.server.segment_requests = set(), 0, 0
                corrupt, healthy, (bad, good), base = self.one_corrupt(True, offset)

                def bad_named(value):
                    return (value.get("recovery") or {}).get("ruled_out") == [bad]

                with self.stopping_after(bad_named), self.assertRaisesRegex(fetch.Refused, "the test stops the run"):
                    self.mixed(base, attempts=5)
                saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
                self.assertEqual(saved["recovery"]["ruled_out"], [bad])
                before = (corrupt.heads, corrupt.requests)
                code, line = self.cli_run("--mirror", base + "/file", "--attempts", "5")  # a fresh process
                self.assertEqual((code, line["status"], line["urls"]), (0, "fetched", [good]), line)
                self.assert_whole()
                self.assertEqual((corrupt.heads, corrupt.requests), before)  # not asked again, not even for a HEAD

    def test_a_process_killed_during_a_trial_body_is_resumed_by_a_fresh_one(self):
        for corrupt_first, offset in self.MATRIX:
            with self.subTest(corrupt_first=corrupt_first, offset=offset):
                shutil.rmtree("src", ignore_errors=True)
                self.server.damaged, self.server.requests, self.server.segment_requests = set(), 0, 0
                corrupt, healthy, (bad, good), base = self.one_corrupt(corrupt_first, offset)
                self.server.trial_bodies = 0
                self.server.modes = {"trial-stall"}  # the first source tried gives a block of its whole file, then waits
                process = subprocess.Popen(self.cli_command("--mirror", base + "/file", "--attempts", "5"), cwd=self.dir,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline and process.poll() is None and not self.server.trial_bodies:
                        time.sleep(0.02)
                    time.sleep(0.3)  # the block it was sent has reached the trial
                    ended = process.poll()
                    process.kill()  # killed with the trial's body half arrived
                finally:
                    out, err = process.communicate()
                self.assertIsNone(ended, f"the run ended before its trial began: {out} {err[-600:]}")
                saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
                self.assertEqual((saved["recovery"]["candidates"], saved["recovery"]["ruled_out"]),
                                 ([self.base + "/file", base + "/file"], []))
                self.assertFalse(Path("src/data.bin").exists())
                self.server.modes = set()
                code, line = self.cli_run("--mirror", base + "/file", "--attempts", "5")  # a fresh process
                self.assertEqual((code, line["status"], line["urls"]), (0, "fetched", [good]), line)
                self.assert_whole()
                self.assertFalse((self.dir / "src/.partial/data.bin.trial").exists())

    def test_losing_the_corrupt_source_mid_run_still_recovers_from_the_healthy_one(self):
        healthy, base = self.mirror()
        # This host gives one damaged range, then a 404 for the next and is dropped; the healthy host finishes the file.
        self.server.damaged = {100, 5_500_000}
        self.server.modes = {"segment-404-after-first"}
        logged = []
        result = self.mixed(base, attempts=5, log=logged.append)
        self.assertEqual((result["status"], result["urls"]), ("fetched", [base + "/file"]))
        self.assert_whole()
        self.assertEqual(self.trials(healthy), 1, logged)  # the isolated trial of the one source left
        self.assertTrue(any("trying each source alone" in line for line in logged), logged)

    def test_a_state_from_before_provenance_existed_starts_the_trials(self):
        mirror, base = self.mirror()
        damaged = bytearray(BODY)
        damaged[100] ^= 0xFF
        half = SIZE // 2
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(bytes(damaged))
        Path("src/.partial/data.bin.state.json").write_text(json.dumps({
            "url": self.base + "/file", "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity",
            "total": SIZE, "segments": [[0, half - 1, half], [half, SIZE - 1, SIZE - half]],
            "sources": [self.base + "/file", base + "/file"]}))  # two sources, and no word of which wrote what
        result = self.mixed(base, attempts=5)
        self.assertEqual((result["status"], result["urls"]), ("fetched", [self.base + "/file"]))
        self.assert_whole()
        self.assertEqual(self.trials(self.server), 1)

    def test_a_search_that_runs_out_of_budget_or_of_sources_ends_refused_with_nothing_published(self):
        corrupt, healthy, (bad, good), base = self.one_corrupt(True, 100)

        def every_source_fails(value):
            if value.get("recovery"):
                self.server.modes = healthy.modes = {"fail"}
            return False

        with self.stopping_after(every_source_fails), self.assertRaisesRegex(fetch.Refused, "3 attempts failed"):
            self.mixed(base)
        self.assertFalse(Path("src/data.bin").exists())
        shutil.rmtree("src")
        self.server.modes = healthy.modes = set()
        self.server.damaged, healthy.damaged = {100}, {3_000_000}  # both sources give damaged bytes
        self.server.requests = healthy.requests = self.server.segment_requests = healthy.segment_requests = 0
        with self.assertRaisesRegex(fetch.Refused, "does not match"):
            self.mixed(base, attempts=5)
        self.assertEqual((self.trials(self.server), self.trials(healthy)), (1, 1))
        self.assertFalse(Path("src/data.bin").exists())
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.assertFalse(Path("src/.partial/data.bin.state.json").exists())


    WHOLE_FILE_UNUSABLE = ({"whole-404"}, {"whole-length"}, {"whole-gzip"})  # a wrong status, length and coding

    def corrupt_pair_and_an_outsider(self, whole_modes):
        """This server and a mirror that agree on the file and give a damaged byte in their ranges (and, unless
        `whole_modes` make the whole file unusable, in the whole file too), and an outsider with another validator and
        the true bytes: (the mirror, its base URL, the outsider, its base URL)."""
        second, second_base = self.mirror()
        outsider, outsider_base = self.mirror()
        outsider.etag = '"v2"'
        for server in (self.server, second):
            server.damaged = {100}
            server.modes = set(whole_modes)
        return second, second_base, outsider, outsider_base

    def test_a_search_whose_whole_file_answers_are_unusable_ends_refused_instead_of_repeating(self):
        for modes in ({"whole-404"}, {"whole-length"}, {"whole-gzip"}, set()):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.requests = self.server.segment_requests = 0
                second, second_base, _, _ = self.corrupt_pair_and_an_outsider(modes)
                second.requests = second.segment_requests = 0
                real, calls = fetch._request, []

                class Runaway(BaseException):
                    pass

                def counted(*args, **kwargs):
                    calls.append(1)
                    if len(calls) > 60 and threading.current_thread() is threading.main_thread():
                        raise Runaway("the same download and recovery went round again")
                    return real(*args, **kwargs)

                with mock.patch.object(fetch, "_request", counted), self.assertRaisesRegex(fetch.Refused, "does not match"):
                    self.mixed(second_base, attempts=5)
                self.assertEqual((self.trials(self.server), self.trials(second)), (1, 1))  # each asked once, then out
                self.assertFalse(Path("src/data.bin").exists())
                self.assertFalse(Path("src/.partial/data.bin").exists())
                self.assertFalse(Path("src/.partial/data.bin.state.json").exists())

    def test_ruled_out_sources_stay_ruled_out_through_the_fallback_and_a_fresh_process(self):
        for modes in ({"whole-404"}, {"whole-length"}, {"whole-gzip"}, set()):  # unusable answers, and wrong bytes
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.requests = self.server.segment_requests = self.server.heads = 0
                second, second_base, outsider, outsider_base = self.corrupt_pair_and_an_outsider(modes)
                second.requests = second.segment_requests = second.heads = 0
                mine, theirs, last = self.base + "/file", second_base + "/file", outsider_base + "/file"

                def fallback_begun(value):
                    # Both agreeing sources are out and the outsider's own download has its state saved.
                    return bool(value.get("segments")) and value.get("ruled_out") == [mine, theirs]

                with self.stopping_after(fallback_begun), self.assertRaisesRegex(fetch.Refused, "the test stops the run"):
                    self.mixed(second_base, outsider_base, attempts=5)
                saved = json.loads(Path("src/.partial/data.bin.state.json").read_text())
                self.assertEqual(saved["ruled_out"], [mine, theirs])  # kept beside the fallback's own progress
                before = [(server.heads, server.requests) for server in (self.server, second)]
                code, line = self.cli_run("--mirror", theirs, "--mirror", last)  # a fresh process
                self.assertEqual((code, line["status"], line["urls"]), (0, "fetched", [last]), line)
                self.assert_whole()
                self.assertEqual([(server.heads, server.requests) for server in (self.server, second)], before)

    # The JSON line's `urls` (D03 T04 §22).
    def cli_command(self, *args, dest="src/data.bin", sha=SHA):
        return [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", dest, "--sha256", sha,
                "--allow-loopback", "--min-free", "0", "--source-limit", str(10 * SIZE), "--timeout", "2",
                "--segment-threshold", str(1 << 20), *args]

    def cli_run(self, *args, dest="src/data.bin", sha=SHA):
        done = subprocess.run(self.cli_command(*args, dest=dest, sha=sha), capture_output=True, text=True, cwd=self.dir,
                              check=False)
        return done.returncode, json.loads(done.stdout)

    def test_the_json_line_names_every_url_that_supplied_bytes(self):
        other, base = self.mirror()
        mine, theirs = self.base + "/file", base + "/file"
        self.server.pace = other.pace = 0.01
        code, line = self.cli_run("--mirror", theirs, "--min-rate", "0")  # two sources
        self.assertEqual(code, 0, line)
        self.assertEqual(set(line["urls"]), {mine, theirs})
        self.assertEqual(line["url"], line["urls"][0])
        shutil.rmtree("src")
        self.server.pace = other.pace = 0.0
        code, line = self.cli_run()  # one source
        self.assertEqual((code, line["urls"], line["url"]), (0, [mine], mine))
        code, line = self.cli_run()  # already in place
        self.assertEqual((code, line["status"], line["urls"], line["url"]), (0, "present", [], None))
        code, line = self.cli_run(sha="0" * 64, dest="src/other.bin")  # refused: the digest never matches
        self.assertEqual((code, line["status"], line["urls"], line["url"]), (1, "refused", [], None))

    def test_a_resume_names_the_earlier_process_sources_and_the_new_one(self):
        other, base = self.mirror()
        mine, theirs = self.base + "/file", base + "/file"
        quarter = -(-SIZE // 4)
        # What an earlier process left: the first two ranges whole, from this host alone, with their source recorded.
        Path("src/.partial").mkdir(parents=True)
        with open("src/.partial/data.bin", "wb") as handle:
            handle.truncate(SIZE)
            handle.write(BODY[:2 * quarter])
        Path("src/.partial/data.bin.state.json").write_text(json.dumps({
            "url": mine, "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE,
            "segments": [[0, quarter - 1, quarter], [quarter, 2 * quarter - 1, quarter],
                         [2 * quarter, 3 * quarter - 1, 0], [3 * quarter, SIZE - 1, 0]],
            "sources": [mine], "provenance": [[0, 2 * quarter - 1, 0]]}))
        self.server.modes = {"fail"}  # the first host is down now: only the mirror gives the rest
        code, line = self.cli_run("--mirror", theirs)
        self.assertEqual(code, 0, line)
        self.assertEqual((line["resumed"], line["urls"], line["url"]), (True, [mine, theirs], mine))
        self.assert_whole()

    def test_a_resume_after_a_killed_process_names_what_that_process_wrote_and_the_new_source(self):
        other, base = self.mirror()
        mine, theirs = self.base + "/file", base + "/file"
        self.server.pace = 0.05  # slow enough to be killed part way
        process = subprocess.Popen(self.cli_command("--min-rate", "0"), cwd=self.dir, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True)
        saved_file = self.dir / "src/.partial/data.bin.state.json"
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and process.poll() is None:
                try:
                    saved = json.loads(saved_file.read_text())
                except (OSError, ValueError):
                    saved = {}
                if sum(item[2] for item in saved.get("segments", [])) > 0 and saved.get("provenance"):
                    break
                time.sleep(0.02)
            self.assertIsNone(process.poll(), "the run ended before it could be killed")
            process.kill()
        finally:
            process.communicate()
        self.server.pace = 0.0
        self.server.modes = {"fail"}  # the first host is down now: only the mirror gives the rest
        code, line = self.cli_run("--mirror", theirs)
        self.assertEqual(code, 0, line)
        self.assertEqual((line["resumed"], line["urls"], line["url"]), (True, [mine, theirs], mine))
        self.assert_whole()

    def test_a_url_that_answered_and_sent_no_byte_is_not_named_as_a_supplier(self):
        empty, second = self.mirror()
        finisher, third = self.mirror()
        mine = self.base + "/file"
        half = SIZE // 2
        # An earlier process left half the file from this host alone, in one stream.
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(BODY[:half])
        Path("src/.partial/data.bin.state.json").write_text(json.dumps({
            "url": mine, "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE,
            "sources": [mine]}))
        self.server.modes = {"fail"}  # down now
        empty.modes = {"drop-empty"}  # valid 206 headers for the rest, then nothing
        result = self.run_fetch(mirrors=[second + "/file", third + "/file"], attempts=5)
        self.assertEqual((result["status"], result["resumed"]), ("fetched", True))
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)
        self.assertGreater(empty.requests, 0)  # it was asked, and answered
        self.assertEqual((result["urls"], result["url"]), ([mine, third + "/file"], mine))

    def test_the_mirror_wording_is_in_the_help_and_the_guide(self):
        guide = (SCRIPT.parents[2] / "docs" / "glimmer" / "importing.md").read_text(encoding="utf-8")
        helped = subprocess.run([sys.executable, "-I", str(SCRIPT), "--help"], capture_output=True, text=True, check=False).stdout
        for words in ("Sources used together", "Failover between them", "`urls`", "same length and the same strong validator"):
            self.assertIn(words, guide)
        self.assertIn("serve ranges together", " ".join(helped.split()))
        self.assertIn("--mirror", helped)
        for words in ("`urls`", "serves ranges together"):
            self.assertIn(words, " ".join(fetch.__doc__.split()))


    # One process for every file of a source (`--manifest`, D03 T04 §23).
    REVERSED = BODY[::-1]
    REVERSED_SHA = hashlib.sha256(BODY[::-1]).hexdigest()

    def manifest_command(self, entries, **options):
        """fetch.py over a manifest of `entries` (dicts, or raw lines as strings), with the tests' options; `options`
        replaces one of them (`source_limit=...`) or adds one (`segment_threshold=...`)."""
        lines = [entry if isinstance(entry, str) else json.dumps(entry) for entry in entries]
        manifest = self.dir / "batch.jsonl"
        manifest.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        merged = {"min_free": 0, "source_limit": 10 * SIZE, "timeout": 2, **options}
        command = [sys.executable, "-I", str(SCRIPT), "--manifest", str(manifest), "--allow-loopback"]
        for key, value in merged.items():
            command += [f"--{key.replace('_', '-')}", str(value)]
        return command

    def run_manifest(self, entries, **options):
        return subprocess.run(self.manifest_command(entries, **options), capture_output=True, text=True, cwd=self.dir,
                              check=False)

    def reversed_server(self):
        other, base = self.mirror()
        other.body = self.REVERSED
        return other, base

    def test_a_manifest_fetches_every_file_in_turn_with_one_line_each(self):
        other, base = self.reversed_server()
        out = self.run_manifest([{"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA},
                                 {"url": base + "/file", "dest": "src/b.bin", "md5": hashlib.md5(self.REVERSED).hexdigest()}])
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([(line["status"], line["fetched"], line["url"]) for line in lines],
                         [("fetched", SIZE, self.base + "/file"), ("fetched", SIZE, base + "/file")])
        # Each line has exactly the fields a single run prints.
        single = json.loads(self.cli().stdout)
        self.assertEqual([sorted(line) for line in lines], [sorted(single)] * 2)
        self.assertEqual(lines[1]["sha256"], self.REVERSED_SHA)
        self.assertEqual((Path("src/a.bin").read_bytes(), Path("src/b.bin").read_bytes()), (BODY, self.REVERSED))

    def test_a_manifest_run_is_as_lean_as_a_plain_download(self):
        code = ("import json, runpy, sys\n"
                "sys.argv = ['fetch.py', *json.loads(sys.argv[1])]\n"
                "try:\n"
                "    runpy.run_path(%r, run_name='__main__')\n"
                "except SystemExit as stop:\n"
                "    code = stop.code\n"
                "else:\n"
                "    code = 0\n"
                "print(json.dumps(sorted(sys.modules)), file=sys.stderr)\n"
                "sys.exit(code)\n") % str(SCRIPT)
        arguments = self.manifest_command([{"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA}])[3:]
        out = subprocess.run([sys.executable, "-I", "-S", "-c", code, json.dumps(arguments)], capture_output=True,
                             text=True, cwd=self.dir, check=False)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
        loaded = set(json.loads(out.stderr.strip().splitlines()[-1]))
        self.assertIn("http.client", loaded)
        self.assertEqual(sorted(loaded & set(self.LEAN)), [], "a manifest run imports what only rare paths need")

    def test_a_batch_holds_four_connections_across_its_files(self):
        # A host that keeps each paced answer open a moment after its last piece (as the bench's host does): the next
        # file's HEAD and first range, on new connections, met the last file's ranges still open there (five at once,
        # measured by the bench). Links read whole are carried from file to file, as aria2c carries them.
        group = self.share_peak(self.server)
        self.server.pace, self.server.linger = 0.002, 0.1
        entries = [{"url": self.base + "/file", "dest": f"src/{name}.bin", "sha256": SHA} for name in "abc"]
        out = self.run_manifest(entries, segment_threshold=1 << 20, min_rate=0)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
        self.assertEqual([json.loads(line)["status"] for line in out.stdout.splitlines()], ["fetched"] * 3)
        self.assertEqual(self.server.heads, 0)  # each file's first range answered for its HEAD
        self.assertLessEqual(group["peak"], fetch.CONNECTIONS)
        # A single run keeps nothing for later: the pool is off outside a batch.
        self.assertFalse(fetch._POOL.enabled)
        self.assertIsNone(fetch._POOL.take(self.base + "/file"))

    def test_a_batch_closes_the_links_it_kept_to_an_origin_the_next_file_does_not_use(self):
        pool = fetch._Pool()
        pool.enabled = True
        closed = []
        for url in ("https://a.example/x", "https://a.example:443/y", "http://b.example/z"):
            link = mock.Mock()
            link.close.side_effect = lambda url=url: closed.append(url)
            self.assertTrue(pool.put(url, link, None))
        pool.keep_only(["https://A.example/other"])
        self.assertEqual(closed, ["http://b.example/z"])
        self.assertIsNotNone(pool.take("https://a.example/q"))
        self.assertIsNone(pool.take("http://b.example/z"))
        for _ in range(5):
            pool.put("https://a.example/x", mock.Mock(), None)
        self.assertEqual(len(pool.links), fetch.CONNECTIONS)  # never more kept than one fetch may hold
        pool.keep_only(())
        self.assertEqual(pool.links, [])

    def test_a_failed_file_does_not_stop_the_batch_and_the_exit_is_1(self):
        other, base = self.reversed_server()
        out = self.run_manifest([{"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA},
                                 {"url": base + "/file", "dest": "src/b.bin", "sha256": SHA},  # the wrong digest for b
                                 {"url": base + "/file", "dest": "src/c.bin", "sha256": self.REVERSED_SHA}])
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([line["status"] for line in lines], ["fetched", "refused", "fetched"])
        self.assertIn("does not match", lines[1]["reason"])
        self.assertEqual((Path("src/a.bin").read_bytes(), Path("src/c.bin").read_bytes()), (BODY, self.REVERSED))
        self.assertFalse(Path("src/b.bin").exists())
        # Run again with b's digest corrected: a and c are present and not fetched again, b is fetched, exit 0.
        served = (len(self.server.served), len(other.served))
        again = self.run_manifest([{"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA},
                                   {"url": base + "/file", "dest": "src/b.bin", "sha256": self.REVERSED_SHA},
                                   {"url": base + "/file", "dest": "src/c.bin", "sha256": self.REVERSED_SHA}])
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr[-400:])
        self.assertEqual([json.loads(line)["status"] for line in again.stdout.splitlines()], ["present", "fetched", "present"])
        self.assertEqual(len(self.server.served), served[0])
        self.assertEqual(sum(other.served[served[1]:]), SIZE)

    def test_an_interrupted_batch_is_resumed_by_a_fresh_process(self):
        other, base = self.reversed_server()
        other.modes = {"segment-slow"}
        entries = [{"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA},
                   {"url": base + "/file", "dest": "src/b.bin", "sha256": self.REVERSED_SHA},
                   {"url": self.base + "/file", "dest": "src/c.bin", "sha256": SHA}]
        command = self.manifest_command(entries, segment_threshold=1 << 20, min_rate=0)
        first = subprocess.Popen(command, cwd=self.dir, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        state_path = Path("src/.partial/b.bin.state.json")
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            try:
                if Path("src/a.bin").exists() and sum(item[2] for item in json.loads(state_path.read_text())["segments"]):
                    break  # a is in place and b's saved state holds progress
            except (OSError, ValueError, KeyError):
                pass  # not written yet
            time.sleep(0.05)
        first.kill()
        printed, _ = first.communicate()
        # a's line, then the kill: b is still running, so no line after it (c's included, finished or not) was printed.
        self.assertEqual([json.loads(line)["status"] for line in printed.splitlines()], ["fetched"])
        kept = self.saved("b.bin")
        self.assertGreater(kept, 0)
        # c runs beside b now (D03 T04 §23): the kill finds it in place, cut with its progress saved, or not begun.
        c_done, c_kept = Path("src/c.bin").exists(), self.saved("c.bin")
        deadline = time.monotonic() + 10
        while (other.active or self.server.active) and time.monotonic() < deadline:
            time.sleep(0.05)
        other.modes = set()
        other.served.clear()
        self.server.served.clear()
        done = subprocess.run(command, capture_output=True, text=True, cwd=self.dir, check=False)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr[-400:])
        lines = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual([(line["status"], line["resumed"]) for line in lines],
                         [("present", False), ("fetched", True), ("present", False) if c_done else ("fetched", c_kept > 0)])
        self.assertEqual(lines[1]["fetched"], SIZE - kept)
        self.assertEqual(sum(other.served), SIZE - kept)  # b: nothing the killed process saved fetched again
        # c alone from this host (a, present, was not fetched again), and none of what the killed process saved of c.
        self.assertEqual(sum(self.server.served), 0 if c_done else SIZE - c_kept)
        for name, body in (("a", BODY), ("b", self.REVERSED), ("c", BODY)):
            self.assertEqual(Path(f"src/{name}.bin").read_bytes(), body)

    def saved(self, name):
        """The bytes a killed run's saved range state says the partial of src/NAME holds: 0 when it has none."""
        try:
            return sum(item[2] for item in json.loads(Path(f"src/.partial/{name}.state.json").read_text())["segments"])
        except (OSError, ValueError, KeyError, TypeError):
            return 0

    def test_a_manifest_that_is_empty_malformed_or_repeats_a_destination_is_refused_before_anything_is_fetched(self):
        good = json.dumps({"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA})
        cases = {
            "empty": ([], "lists no file"),
            "only blank lines": (["", "   "], "lists no file"),
            "not JSON": ([good, "{not json"], "line 2 is not JSON"),
            "not an object": ([good, "[1, 2]"], "line 2 is not a JSON object"),
            "an unknown key": ([good, json.dumps({"url": "u", "dest": "src/b", "sha256": SHA, "sha265": SHA})],
                               "line 2 has an unknown key: sha265"),
            "no dest": ([good, json.dumps({"url": "u", "sha256": SHA})], "line 2 needs a url and a dest"),
            "both digests": ([good, json.dumps({"url": "u", "dest": "src/b", "sha256": SHA, "md5": "a" * 32})],
                             "line 2 needs exactly one of sha256 or md5"),
            "no digest": ([good, json.dumps({"url": "u", "dest": "src/b"})], "line 2 needs exactly one of sha256 or md5"),
            "a short digest": ([good, json.dumps({"url": "u", "dest": "src/b", "sha256": "ab"})], "line 2: sha256 is not 64"),
            "a bool for a number": ([good, json.dumps({"url": "u", "dest": "src/b", "sha256": SHA, "attempts": True})],
                                    "line 2: attempts has the wrong type"),
            "a mirror that is not a URL": ([good, json.dumps({"url": "u", "dest": "src/b", "sha256": SHA, "mirrors": [3]})],
                                           "line 2: mirrors must be a list"),
            "a repeated destination": ([good, "", json.dumps({"url": "u", "dest": "./src//a.bin", "sha256": SHA})],
                                       "line 3 names the destination ./src//a.bin that line 1 named"),
        }
        for name, (lines, message) in cases.items():
            out = self.run_manifest(lines)
            self.assertEqual((out.returncode, out.stdout), (2, ""), name)
            self.assertIn(message, out.stderr, name)
        missing = subprocess.run([sys.executable, "-I", str(SCRIPT), "--manifest", str(self.dir / "absent.jsonl")],
                                 capture_output=True, text=True, cwd=self.dir, check=False)
        self.assertEqual((missing.returncode, missing.stdout), (2, ""))
        self.assertIn("could not be read", missing.stderr)
        # A file's own options beside --manifest are a usage error, refused before the manifest is read.
        Path(self.dir / "batch.jsonl").write_text(good + "\n", encoding="utf-8")
        for extra in (["--url", self.base + "/file"], ["--dest", "src/a.bin"], ["--sha256", SHA], ["--md5", "a" * 32],
                      ["--mirror", self.base + "/file"]):
            out = subprocess.run([sys.executable, "-I", str(SCRIPT), "--manifest", str(self.dir / "batch.jsonl"),
                                  "--allow-loopback", *extra], capture_output=True, text=True, cwd=self.dir, check=False)
            self.assertEqual((out.returncode, out.stdout), (2, ""), extra)
            self.assertIn("beside --manifest", out.stderr, extra)
        self.assertEqual((self.server.asked, self.server.heads), ([], 0))  # nothing was asked of the server
        self.assertFalse((self.dir / "src").exists())

    def test_a_manifest_whose_files_would_write_each_other_s_working_files_is_refused_before_anything_is_fetched(self):
        # D03 T04 §23 round 1: src/data.bin.state.json's partial is src/data.bin's state; with both segmented, a state
        # checkpoint replaced the other file's partial and 413 bytes of JSON were published, exit 0.
        def line(dest):
            return {"url": self.base + "/file", "dest": dest, "sha256": SHA}

        cases = [
            (["src/data.bin", "src/data.bin.state.json"],
             "line 2 names the destination src/data.bin.state.json, whose partial file src/.partial/data.bin.state.json "
             "is line 1's state file"),
            (["src/data.bin.state.json", "src/data.bin"],
             "line 2 names the destination src/data.bin, whose state file src/.partial/data.bin.state.json is line 1's "
             "partial file"),
            (["src/data.bin", "src/x.bin", "src/data.bin.trial"], "line 3 names the destination src/data.bin.trial"),
        ]
        for dests, message in cases:
            with self.subTest(dests=dests):
                out = self.run_manifest([line(dest) for dest in dests], segment_threshold=1 << 20)
                self.assertEqual((out.returncode, out.stdout), (2, ""))
                self.assertIn(message, out.stderr)
        # The state's temporary file is named by the process that writes it: refused when it is this one's.
        manifest = self.dir / "own.jsonl"
        manifest.write_text("\n".join(json.dumps(line(dest)) for dest in
                                      ("src/a.bin", f"src/a.bin.state.json.{os.getpid()}.tmp")), encoding="utf-8")
        with self.assertRaisesRegex(fetch._BadManifest, "whose partial file .* is line 1's state temporary file"):
            fetch._read_manifest(str(manifest))
        self.assertEqual((self.server.asked, self.server.heads), ([], 0))  # nothing was asked of the server
        self.assertFalse((self.dir / "src").exists())
        # Files of one source share its lock, and names that only start alike are separate files.
        out = self.run_manifest([line("src/data.bin"), line("src/data.bin.gz")])
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])

    def test_urls_a_request_line_cannot_carry_are_refused_before_anything_connects(self):
        for url in ("https://example.com/\u00e9", "https://example.com/a b", "https://example.com/a\tb", "https://ex\u00e4mple.com/"):
            with self.subTest(url=url), self.assertRaises(fetch._Route):
                fetch._split_url(url)
        self.assertEqual(fetch._split_url("https://example.com/%C3%A9").path, "/%C3%A9")

    def test_four_unencodable_urls_in_a_batch_give_back_their_places_and_the_fifth_file_is_fetched(self):
        lines = [{"url": f"{self.base}/\u00e9{n}", "dest": f"src/bad{n}", "sha256": SHA, "segments": 1} for n in range(4)]
        lines.append({"url": self.base + "/file", "dest": "src/good", "sha256": SHA})
        Path("batch.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        done = subprocess.run([sys.executable, "-I", str(SCRIPT), "--manifest", "batch.jsonl", "--allow-loopback",
                               "--min-free", "0", "--source-limit", str(10 * SIZE)],
                              capture_output=True, text=True, timeout=60)
        results = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual([r["status"] for r in results], ["refused"] * 4 + ["fetched"])
        self.assertEqual(done.returncode, 1)

    BATCH_TIMEOUT = 60  # seconds an in-process batch may take before it counts as hung

    def run_batch_here(self, entries, **options):
        """A `--manifest` batch run in this process, so a fault can be injected into it, and bounded: a batch that never
        ends fails the test instead of hanging it. Returns its exit code and lines, once it is checked that the batch
        holds no place (`_Budget`) and that every file ended with every place it was lent back or handed on (`_Share`)."""
        merged = {"min_free": 0, "source_limit": 10 * SIZE, "timeout": 2, **options}
        manifest = self.dir / "here.jsonl"
        manifest.write_text("".join(json.dumps(entry) + "\n" for entry in entries), encoding="utf-8")
        argv = ["--manifest", str(manifest), "--allow-loopback"]
        for key, value in merged.items():
            argv += [f"--{key.replace('_', '-')}", str(value)]
        shares, printed, done = [], io.StringIO(), {}

        class Turn(fetch._Turn):
            def __init__(self, *args):
                super().__init__(*args)
                shares.append(self.share)

        def run():
            done["code"] = fetch.main(argv)

        with (mock.patch.object(fetch, "_Turn", Turn), contextlib.redirect_stdout(printed),
              contextlib.redirect_stderr(io.StringIO())):
            runner = threading.Thread(target=run, daemon=True)
            runner.start()
            runner.join(self.BATCH_TIMEOUT)
        self.assertFalse(runner.is_alive(), "the batch never ended: a place was not given back")
        self.assertEqual(len(shares), len(entries))
        for share in shares:
            self.assertEqual((share.out, share.places), (set(), []))  # nothing lent left out, nothing left on hand
        self.assertEqual((fetch._BUDGET.held, fetch._BUDGET.queue, fetch._POOL.links), (0, [], []))
        return done.get("code"), [json.loads(line) for line in printed.getvalue().splitlines()]

    @contextlib.contextmanager
    def fault(self, step, make, bad_base):
        """`make()`'s exception raised at `step` of every request (or HEAD alone), read, write, trial cleanup or state
        save of the files under bad/ (or from `bad_base`), and nowhere else."""
        def ours(path):
            return "bad" in Path(path).parts

        real_request, real_open, real_unlink = fetch._request, Path.open, Path.unlink
        real_pwrite, real_save = os.pwrite, fetch._write_json_now
        unlinked: dict = {}

        class Answer:
            def __init__(self, response):
                self.response = response

            def __getattr__(self, name):
                return getattr(self.response, name)

            def read(self, *args):
                raise make()

            read1 = read

        class Handle:
            def __init__(self, handle):
                self.handle = handle

            def __getattr__(self, name):
                return getattr(self.handle, name)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self.handle.close()

            def write(self, block):
                raise make()

        def request(url, *args, **kwargs):
            if url.startswith(bad_base) and (step == "request" or (step == "head" and kwargs.get("method") == "HEAD")):
                raise make()
            connection, response, final = real_request(url, *args, **kwargs)
            return connection, Answer(response) if step == "read" and url.startswith(bad_base) else response, final

        def opened(path, mode="r", *args, **kwargs):
            handle = real_open(path, mode, *args, **kwargs)
            written = ours(path) and set(mode) & set("wa") and not path.name.endswith(".tmp")  # not a state's save
            return Handle(handle) if step == "write" and written else handle

        def pwrite(fd, data, offset):
            if step == "write" and "/bad/.partial/" in os.readlink(f"/proc/self/fd/{fd}"):
                raise make()
            return real_pwrite(fd, data, offset)

        def unlink(path, *args, **kwargs):
            if step == "unlink" and ours(path) and path.name.endswith(".trial"):
                unlinked[path] = unlinked.get(path, 0) + 1
                if unlinked[path] > 1:  # the start's sweep of a killed run's trial passes; the trial's own cleanup fails
                    raise make()
            return real_unlink(path, *args, **kwargs)

        def save(path, value):
            if step == "save" and ours(path):
                raise make()
            return real_save(path, value)

        with (mock.patch.object(fetch, "_request", request), mock.patch.object(Path, "open", opened),
              mock.patch.object(Path, "unlink", unlink), mock.patch.object(os, "pwrite", pwrite),
              mock.patch.object(fetch, "_write_json_now", save)):
            yield

    def test_an_unexpected_error_in_any_place_holding_step_gives_the_place_back_and_the_batch_goes_on(self):
        # D03 T04 §23 rounds 2 and 3: a raise no handler expected (an unencodable URL, a trial cleanup on a disk gone
        # read-only) skipped the inline give-back, and four such files held all four places: the fifth waited for ever.
        # Each place-holding section, each risky step in it, an OS error and a non-OS one: four files that meet it, then
        # a healthy fifth, which must be fetched, with the four reported and every place back.
        small = BODY[: 1 << 20]
        small_sha = hashlib.sha256(small).hexdigest()
        bad, bad_base = self.mirror()
        bad.body = self.server.body = small
        # `whole-answer`: the first range is answered whole (the range ignored), so its answer holds its place while
        # the HEAD it cannot stand in for is asked; that HEAD's failure spends the last attempt.
        steps = {"one-stream": ("request", "read", "write", "save"), "segmented": ("request", "read", "write", "save"),
                 "trial": ("request", "read", "write", "unlink"), "whole-answer": ("head",)}
        errors = {"OSError": lambda: OSError(errno.EIO, "injected"), "RuntimeError": lambda: RuntimeError("injected")}
        for mode, mode_steps in steps.items():
            for step in mode_steps:
                for name, make in errors.items():
                    with self.subTest(mode=mode, step=step, error=name):
                        shutil.rmtree("bad", ignore_errors=True)
                        shutil.rmtree("src", ignore_errors=True)
                        bad.modes = {"ignore-range"} if mode == "whole-answer" else set()
                        entries = [{"url": f"{bad_base}/file", "dest": f"bad/f{n}", "sha256": small_sha,
                                    "segments": 1 if mode == "one-stream" else 4} for n in range(4)]
                        if mode == "trial":
                            # A mixed-source digest failure's recovery, under way: each file is downloaded whole, alone.
                            Path("bad/.partial").mkdir(parents=True)
                            for n, entry in enumerate(entries):
                                Path(f"bad/.partial/f{n}.state.json").write_text(json.dumps(
                                    {"url": entry["url"], "expected": ["sha256", small_sha], "validator": '"v1"',
                                     "encoding": "identity", "total": len(small), "sources": [],
                                     "recovery": {"candidates": [entry["url"]], "ruled_out": []}}))
                        entries.append({"url": self.base + "/file", "dest": "src/good", "sha256": small_sha})
                        with self.fault(step, make, bad_base):
                            code, lines = self.run_batch_here(entries, attempts=1, segment_threshold=64 << 10,
                                                              min_rate=0)
                        self.assertEqual(code, 1)
                        statuses = [line["status"] for line in lines]
                        self.assertEqual(len(statuses), 5)
                        self.assertTrue(all(status in ("incomplete", "refused") for status in statuses[:4]), statuses)
                        self.assertEqual(statuses[4], "fetched")
                        self.assertEqual(Path("src/good").read_bytes(), small)

    def test_a_mixed_batch_ends_holding_no_place(self):
        # Files present, one stream, segmented over two agreeing sources, and refused, at once: once the batch ends
        # every place is back in the budget (none borrowed) and every file gave back all it was lent.
        other, base = self.mirror()
        Path("src").mkdir()
        Path("src/here.bin").write_bytes(BODY)
        entries = [{"url": self.base + "/file", "dest": "src/here.bin", "sha256": SHA},
                   {"url": self.base + "/file", "dest": "src/one.bin", "sha256": SHA, "segments": 1},
                   {"url": self.base + "/file", "dest": "src/split.bin", "sha256": SHA, "mirrors": [base + "/file"]},
                   {"url": base + "/file", "dest": "src/wrong.bin", "sha256": "0" * 64, "segments": 1},
                   {"url": base + "/file", "dest": "src/small.bin", "sha256": SHA}]
        code, lines = self.run_batch_here(entries, segment_threshold=1 << 20, min_rate=0)
        self.assertEqual(code, 1)
        self.assertEqual([line["status"] for line in lines], ["present", "fetched", "fetched", "refused", "fetched"])
        for name in ("one", "split", "small"):
            self.assertEqual(Path(f"src/{name}.bin").read_bytes(), BODY)

    def test_a_place_given_back_twice_is_counted_once(self):
        budget = fetch._Budget(fetch._Pool())
        share = fetch._Share(budget.take(), lambda: None)
        place = share.pop_or_take(self.base + "/file")
        share.push(place)
        share.push(place)  # a finally that gives back what its section gave back already
        self.assertEqual((share.places, share.out, budget.held), ([place], set(), 1))
        place = share.pop_if_any()
        share.drop(place)
        share.push(place)  # dropped: not pushed again
        self.assertEqual((share.places, share.out, budget.held), ([], set(), 0))

    def test_a_malformed_url_in_a_batch_is_that_file_s_refusal_and_the_files_around_it_get_their_lines(self):
        # D03 T04 §23 round 1: once a finished file left a kept connection, the next file's place was matched to it by
        # the malformed URL's origin, which raised outside the per-file handler and ended the batch. Four files first,
        # so the malformed one waits for a place and finds a kept link.
        entries = [{"url": self.base + "/file", "dest": f"src/{name}.bin", "sha256": SHA} for name in "abcd"]
        entries.append({"url": "http://dataset.example:bad/e", "dest": "src/e.bin", "sha256": SHA})
        entries.append({"url": self.base + "/file", "dest": "src/f.bin", "sha256": SHA})
        out = self.run_manifest(entries)
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([line["status"] for line in lines], ["fetched"] * 4 + ["refused", "fetched"])
        self.assertIn("refused: a malformed URL", lines[4]["reason"])
        self.assertNotIn("Traceback", out.stderr)
        for name in "abcdf":
            self.assertEqual(Path(f"src/{name}.bin").read_bytes(), BODY)
        self.assertIsNone(fetch._origin("http://dataset.example:bad/e"))

    def test_a_one_file_batch_with_an_agreeing_keep_alive_mirror_holds_four_connections_at_most(self):
        # D03 T04 §23 round 1: the first range's place went back to the file's workers while range 0's worker, holding
        # the mirror's kept HEAD connection, adopted the first range's answer: another worker opened a connection on
        # that place, five open at once. Counted as TCP connections at both hosts, idle kept ones included.
        other, base = self.mirror()
        tally = {"open": set(), "peak": 0, "lock": threading.Lock()}
        self.server.sockets = other.sockets = tally
        self.server.pace = other.pace = 0.002
        heads = other.heads
        for _ in range(int(os.environ.get("FETCH_ROUNDS", "3"))):
            shutil.rmtree("src", ignore_errors=True)
            with tally["lock"]:
                tally["peak"] = 0
            out = self.run_manifest([{"url": self.base + "/file", "dest": "src/data.bin", "sha256": SHA,
                                      "mirrors": [base + "/file"], "segments": 4}], segment_threshold=1 << 20, min_rate=0)
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
            self.assertEqual(json.loads(out.stdout)["status"], "fetched")
            self.assert_whole()
            self.assertEqual(other.heads, heads + 1)  # the mirror was asked a HEAD beside the first range: a kept link
            heads = other.heads
            self.assertGreaterEqual(tally["peak"], 3)
            self.assertLessEqual(tally["peak"], fetch.CONNECTIONS)

    def test_a_line_s_own_option_wins_over_the_command_line_and_the_command_line_over_the_default(self):
        other, base = self.reversed_server()
        # The command line's source limit is too small for either file. Line a sets none, so the command line's holds
        # and a is refused; line b sets its own, which wins, and b is fetched. Line c sets an attempt budget of its own.
        out = self.run_manifest([{"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA},
                                 {"url": base + "/file", "dest": "other/b.bin", "sha256": self.REVERSED_SHA,
                                  "source_limit": 10 * SIZE},
                                 {"url": self.base + "/file", "dest": "third/c.bin", "sha256": SHA, "attempts": 0}],
                                source_limit=SIZE // 2)
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([line["status"] for line in lines], ["refused", "fetched", "refused"])
        self.assertIn(f"limit of {SIZE // 2} bytes", lines[0]["reason"])
        self.assertIn("--attempts", lines[2]["reason"])
        self.assertEqual(Path("other/b.bin").read_bytes(), self.REVERSED)
        # With no option anywhere, the default holds: c's file under the default limit is fetched.
        again = self.run_manifest([{"url": self.base + "/file", "dest": "third/c.bin", "sha256": SHA}])
        self.assertEqual(json.loads(again.stdout)["status"], "fetched")

    def test_the_source_limit_and_the_floor_hold_across_the_files_of_a_batch(self):
        # Two files into one source whose limit holds one and a half: the first fills it, the second is refused.
        other, base = self.reversed_server()
        out = self.run_manifest([{"url": self.base + "/file", "dest": "src/a.bin", "sha256": SHA},
                                 {"url": base + "/file", "dest": "src/b.bin", "sha256": self.REVERSED_SHA}],
                                source_limit=SIZE * 3 // 2)
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([line["status"] for line in lines], ["fetched", "refused"])
        self.assertIn("would pass its limit", lines[1]["reason"])
        # The free-space floor is checked for each file, the last included.
        with_floor = self.run_manifest([{"url": base + "/file", "dest": "more/b.bin", "sha256": self.REVERSED_SHA}],
                                       min_free=10**18)
        self.assertEqual(json.loads(with_floor.stdout)["status"], "incomplete")
        self.assertIn("free-space floor", json.loads(with_floor.stdout)["reason"])


    # Several files of a batch at once inside the four connections (D03 T04 §23).
    def hosts(self, count):
        """`count` hosts, each serving its own copy of the file, counting their open requests together."""
        made = [self.mirror() for _ in range(count)]
        return made, self.share_peak(*(server for server, _ in made))

    def test_a_batch_fetches_several_small_files_at_once_one_connection_each_and_four_at_most(self):
        made, group = self.hosts(6)
        for server, _ in made:
            server.pace = 0.004  # paced, so the files are seen to overlap
        entries = [{"url": base + "/file", "dest": f"src/f{number}.bin", "sha256": SHA}
                   for number, (_, base) in enumerate(made)]
        out = self.run_manifest(entries, segment_threshold=1 << 20, min_rate=0)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([(line["status"], line["url"]) for line in lines],
                         [("fetched", base + "/file") for _, base in made])
        for number in range(len(made)):
            self.assertEqual(Path(f"src/f{number}.bin").read_bytes(), BODY)
        self.assertGreaterEqual(group["together"], 2)  # more than one file's request open at the same moment
        self.assertLessEqual(group["peak"], fetch.CONNECTIONS)  # and never more than four in all
        # While files waited to start, each took one connection: its first range alone (its 206 answered for the HEAD,
        # so none was sent), then the rest of the file in one range on the same connection.
        self.assertEqual([server.peak for server, _ in made[:4]], [1] * 4)
        self.assertEqual([server.segment_requests for server, _ in made[:4]], [2] * 4)
        self.assertEqual([server.heads for server, _ in made], [0] * len(made))

    def test_batch_lines_keep_the_manifest_order_when_a_later_file_finishes_first(self):
        (slow, slow_base), (fast, fast_base) = self.mirror(), self.mirror()
        # The first file is held one piece short of its end until the second is in place, so the second finishes first
        # on any runner: a pace alone left the order to the machine's load (2026-11-01, run 41257943139: b came 154 ms
        # after a).
        slow.pace, slow.hold_at = 0.001, len(BODY) - 64 * 1024
        done = self.dir / "src/b.bin"

        def release_after_b():
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline and not (done.exists() and done.stat().st_size == len(BODY)):
                time.sleep(0.02)
            # The held answer ends at the release (as the mirror's hold does), and the fetcher's retry of the rest is
            # served whole.
            slow.hold_at = None
            slow.release.set()

        watcher = threading.Thread(target=release_after_b, daemon=True)
        watcher.start()
        # Two ranges for the held file: its four could take every connection the run holds open (fetch.CONNECTIONS)
        # while held, so the second file would wait for one and the hold for it, until both gave up (2026-11-01, CI run
        # 41296355921); one stream is no ranged answer, which the mirror neither paces nor holds.
        out = self.run_manifest([{"url": slow_base + "/file", "dest": "src/a.bin", "sha256": SHA, "segments": 2},
                                 {"url": fast_base + "/file", "dest": "src/b.bin", "sha256": SHA}],
                                segment_threshold=1 << 20, min_rate=0)
        watcher.join(5)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
        self.assertEqual([json.loads(line)["url"] for line in out.stdout.splitlines()],
                         [slow_base + "/file", fast_base + "/file"])
        # b's last byte was written before a's: it finished first, and its line still came second. Only the order is the
        # claim: a fixed margin between the two finishes failed on a loaded CI runner, where b started late
        # (2026-11-01, run 41257061788: about 1 ms apart, b still first).
        self.assertLess(Path("src/b.bin").stat().st_mtime_ns, Path("src/a.bin").stat().st_mtime_ns)

    def test_a_failed_file_among_concurrent_ones_does_not_stop_the_others_and_the_exit_is_1(self):
        made, group = self.hosts(5)
        for server, _ in made:
            server.pace = 0.004
        entries = [{"url": base + "/file", "dest": f"src/f{number}.bin", "sha256": SHA}
                   for number, (_, base) in enumerate(made)]
        entries[1]["sha256"] = self.REVERSED_SHA  # refused once its bytes are in: the wrong digest
        entries[2]["attempts"] = 0  # refused at once, so its place goes to the fifth file while the others run
        out = self.run_manifest(entries, segment_threshold=1 << 20, min_rate=0)
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([line["status"] for line in lines], ["fetched", "refused", "refused", "fetched", "fetched"])
        self.assertIn("does not match", lines[1]["reason"])
        for number in (0, 3, 4):
            self.assertEqual(Path(f"src/f{number}.bin").read_bytes(), BODY)
        self.assertFalse(Path("src/f1.bin").exists() or Path("src/f2.bin").exists())
        self.assertGreaterEqual(group["together"], 2)
        self.assertLessEqual(group["peak"], fetch.CONNECTIONS)

    def test_an_interrupted_concurrent_batch_is_resumed_by_a_fresh_process_with_nothing_fetched_twice(self):
        made, group = self.hosts(3)
        for server, _ in made:
            server.modes = {"segment-slow"}
        names = [f"f{number}.bin" for number in range(len(made))]
        entries = [{"url": base + "/file", "dest": f"src/{name}", "sha256": SHA} for name, (_, base) in zip(names, made)]
        command = self.manifest_command(entries, segment_threshold=1 << 20, min_rate=0)
        first = subprocess.Popen(command, cwd=self.dir, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline and sum(self.saved(name) > 0 for name in names) < 2:
            time.sleep(0.05)
        first.kill()
        printed, _ = first.communicate()
        kept = {name: self.saved(name) for name in names}
        self.assertGreaterEqual(sum(value > 0 for value in kept.values()), 2)  # two files were cut mid-transfer
        self.assertEqual(printed, "")  # none had ended
        deadline = time.monotonic() + 10
        while any(server.active for server, _ in made) and time.monotonic() < deadline:
            time.sleep(0.05)
        for server, _ in made:
            server.modes = set()
            server.served.clear()
        done = subprocess.run(command, capture_output=True, text=True, cwd=self.dir, check=False)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr[-400:])
        lines = [json.loads(line) for line in done.stdout.splitlines()]
        self.assertEqual([(line["status"], line["resumed"]) for line in lines],
                         [("fetched", kept[name] > 0) for name in names])
        for name, line, (server, _) in zip(names, lines, made):
            self.assertEqual(line["fetched"], SIZE - kept[name], name)
            self.assertEqual(sum(server.served), SIZE - kept[name], name)  # nothing the killed process saved, again
            self.assertEqual(Path(f"src/{name}").read_bytes(), BODY)
        self.assertLessEqual(group["peak"], fetch.CONNECTIONS)

    def test_a_mixed_batch_holds_four_connections_and_its_large_file_splits_once_places_free(self):
        made, _ = self.hosts(4)
        # Counted as the client's TCP connections, not as answers the hosts are still sending: once the large file
        # splits, its first range ends early and the client closes that connection mid-answer, and its host goes on
        # writing (and counting it) until the reset reaches it, a moment after the client's next connection opens
        # (five at once in CI run 41198673812, with the client holding four).
        tally = {"open": set(), "peak": 0, "lock": threading.Lock()}
        for server, _ in made:
            server.sockets = tally
        small, large = BODY[: 2 << 20], BODY * 2 + BODY[: 4 << 20]  # 2 MiB each, and 24 MiB
        for server, _ in made[:3]:
            server.body = small
        made[3][0].body = large
        for server, _ in made:
            server.pace = 0.01
        entries = [{"url": base + "/file", "dest": f"src/s{number}.bin", "sha256": hashlib.sha256(small).hexdigest()}
                   for number, (_, base) in enumerate(made[:3])]
        entries.append({"url": made[3][1] + "/file", "dest": "src/large.bin", "sha256": hashlib.sha256(large).hexdigest()})
        out = self.run_manifest(entries, segment_threshold=1 << 20, min_rate=0)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr[-400:])
        self.assertEqual([json.loads(line)["status"] for line in out.stdout.splitlines()], ["fetched"] * 4)
        for number in range(3):
            self.assertEqual(Path(f"src/s{number}.bin").read_bytes(), small)
        self.assertEqual(Path("src/large.bin").read_bytes(), large)
        self.assertGreaterEqual(tally["peak"], 3)  # the four files started together: the count saw them
        self.assertLessEqual(tally["peak"], fetch.CONNECTIONS)
        self.assertEqual(sum(server.peak for server, _ in made[:3]), 3)  # the small files: one connection each
        self.assertGreaterEqual(made[3][0].peak, 2)  # the large file split into ranges once the small ones were done

    def test_a_batch_gives_the_room_to_the_earlier_file_when_the_source_limit_binds(self):
        # The earlier file's host is slow to answer its first request (its first range, which answers for its HEAD), so
        # the later file reaches its limit check first: it waits for the earlier one to reserve its bytes, and is the
        # one refused, as one file after another would be.
        (slow, slow_base), (fast, fast_base) = self.mirror(), self.mirror()
        slow.head_pause = slow.range_pause = 0.5
        out = self.run_manifest([{"url": slow_base + "/file", "dest": "src/a.bin", "sha256": SHA},
                                 {"url": fast_base + "/file", "dest": "src/b.bin", "sha256": SHA}],
                                source_limit=SIZE * 3 // 2, segment_threshold=1 << 20)
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr[-400:])
        lines = [json.loads(line) for line in out.stdout.splitlines()]
        self.assertEqual([line["status"] for line in lines], ["fetched", "refused"])
        self.assertIn("would pass its limit", lines[1]["reason"])
        self.assertEqual(Path("src/a.bin").read_bytes(), BODY)
        # b wrote nothing: no partial and no state (its first range was closed unread).
        self.assertEqual(sorted(path.name for path in Path("src/.partial").iterdir() if path.name != ".lock"), [])

    def test_the_folder_count_skips_a_file_gone_between_the_listing_and_its_count(self):
        # A batch's other file renames its state into place while this one counts the source folder (seen as an
        # unexpected FileNotFoundError ending a file of a mixed batch).
        Path("src").mkdir()
        Path("src/kept.bin").write_bytes(b"x" * 10)
        gone = mock.Mock(is_file=lambda: True, stat=mock.Mock(side_effect=FileNotFoundError))  # there, then renamed
        listed = [Path("src/kept.bin"), gone, Path("src")]
        with mock.patch.object(fetch.Path, "rglob", lambda self, pattern: iter(listed)):
            self.assertEqual(fetch._folder_bytes(Path("src")), 10)

    def test_closing_a_connection_closes_the_answer_that_took_its_socket(self):
        # http.client hands the socket to a `Connection: close` answer and forgets it; a place in the batch's budget is
        # given back on close, so the socket must be shut then, not when the answer is collected.
        self.server.modes = {"no-length"}
        connection = fetch._connect(self.base + "/file", 5, True)
        connection.request("GET", "/file")
        answer = connection.getresponse()
        self.assertTrue(answer.will_close)
        connection.close()
        self.assertTrue(answer.isclosed())

    def test_the_rate_floor_cuts_a_stalled_https_answer(self):
        # The TLS socket takes over the plain one's descriptor: the watchdog must hold the TLS socket, or its shutdown
        # cuts nothing and a stalled HTTPS answer runs on until it resumes.
        folder = Path(tempfile.mkdtemp(prefix="tls-"))
        self.addCleanup(shutil.rmtree, folder, True)
        cert, key = folder / "c.pem", folder / "k.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
                        "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
                       check=True, capture_output=True)
        server = Server()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        # The headers, then nothing for 60 seconds: left to the socket's 10-second timeout the refusal would be a timeout,
        # so "rate floor" is the watchdog's own cut, with no wall-clock bound (2026-10-31).
        server.modes = {"stall"}
        server.stall = 60
        with self.assertRaisesRegex(fetch.Refused, "rate floor"):
            fetch.fetch(f"https://127.0.0.1:{server.server_address[1]}/file", "src/data.bin", ("sha256", SHA),
                        allow_loopback=True, ca_file=str(cert), segments=1, attempts=1, timeout=10, min_rate=1024,
                        rate_window=0.5, sleep=lambda s: None, log=lambda line: None, **ROOMY)


class PinnedFetch(unittest.TestCase):
    setUp = Fetch.setUp
    tear = Fetch.tear
    commit = 'a' * 40
    pin = 'github: fictional/corpus, ' + commit
    url = 'https://raw.githubusercontent.com/fictional/corpus/' + commit + '/data.bin'

    def pinned(self, **kwargs):
        real_connect = fetch._connect
        def connect(url, timeout, allow_loopback, watch=None, ca_file=None):
            connection = real_connect(self.base + '/file', timeout, True, watch)
            request = connection.request
            connection.request = lambda method, path, **kw: request(method, '/file', **kw)
            return connection
        with mock.patch.object(fetch, '_connect', side_effect=connect):
            return fetch.fetch(self.url, 'src/data.bin', ('pin', self.pin), **{**ROOMY, 'timeout': 2, 'sleep': lambda _: None, 'log': lambda _: None, **kwargs})

    def test_huggingface_cache_redirect_fetches_and_reuses_first_digest(self):
        pin = 'huggingface: fictional/corpus, ' + self.commit
        url = 'https://huggingface.co/datasets/fictional/corpus/resolve/' + self.commit + '/data.bin'
        cache = 'https://huggingface.co/api/resolve-cache/datasets/fictional/corpus/' + self.commit + '/data.bin'
        original_connect, original_redirect = fetch._connect, Handler.redirect
        def connect(target, timeout, allow_loopback, watch=None, ca_file=None):
            connection = original_connect(self.base + '/file', timeout, True, watch)
            request = connection.request
            connection.request = lambda method, path, **kw: request(method, '/hop' if target == url else '/file', **kw)
            return connection
        with mock.patch.object(fetch, '_connect', side_effect=connect), mock.patch.object(Handler, 'redirect', lambda handler, target: original_redirect(handler, cache)):
            args = {**ROOMY, 'segments': 1, 'timeout': 2, 'log': lambda _: None}
            first = fetch.fetch(url, 'src/data.bin', ('pin', pin), **args)
            self.assertEqual(first['sha256'], SHA)
            self.assertEqual(fetch.fetch(url, 'src/data.bin', ('pin', pin), **args)['status'], 'present')
        receipt = fetch._pin_helpers().read_pin_receipt(Path('src'), 'data.bin', pin)
        self.assertEqual(receipt['sha256'], SHA)

    def test_first_pin_fetch_and_rerun_bind_original_digest(self):
        result = self.pinned()
        self.assertEqual(result['sha256'], SHA)
        receipt = fetch._pin_helpers().read_pin_receipt(Path('src'), 'data.bin', self.pin)
        self.assertEqual(receipt['sha256'], SHA)
        self.assertEqual(self.pinned()['status'], 'present')
        Path('src/data.bin').write_bytes(b'changed')
        with self.assertRaises(fetch.Refused):
            self.pinned()

    def test_recollection_cannot_reset_original_digest(self):
        self.pinned()
        receipt = Path('src/.download-pins/data.bin.json').read_bytes()
        Path('src/data.bin').unlink()
        self.server.body = b'different bytes'
        with self.assertRaises(fetch.Refused):
            self.pinned(attempts=1)
        self.assertEqual(Path('src/.download-pins/data.bin.json').read_bytes(), receipt)
        self.assertFalse(Path('src/data.bin').exists())

    def test_existing_file_without_receipt_is_not_recertified(self):
        Path('src').mkdir()
        Path('src/data.bin').write_bytes(BODY)
        with self.assertRaises(fetch.Refused):
            self.pinned()
        self.assertEqual(self.server.requests, 0)

    def test_mirror_for_other_file_refuses_before_fetch(self):
        with self.assertRaises(fetch.Refused):
            self.pinned(mirrors=[self.url.replace('data.bin', 'other.bin')])
        self.assertEqual(self.server.requests, 0)

    def test_first_pin_segmented_download_keeps_limits(self):
        self.server.modes = {'segments'}
        result = self.pinned(segment_threshold=1, segments=4)
        self.assertEqual(result['sha256'], SHA)
        self.assertEqual(Path('src/data.bin').read_bytes(), BODY)
        self.assertLessEqual(self.server.peak, 4)

    def seed_partial(self):
        directory = Path('src/.partial')
        directory.mkdir(parents=True)
        partial = directory / 'data.bin'
        partial.write_bytes(BODY[:1234])
        state_path = directory / 'data.bin.state.json'
        state_path.write_text(json.dumps({'url': self.url, 'expected': ['pin', self.pin, fetch._pin_helpers().pin_artifact(self.pin, self.url)], 'validator': '"v1"', 'encoding': 'identity', 'total': SIZE}))
        return partial, state_path

    def test_changed_pin_preserves_interrupted_transfer(self):
        partial, state_path = self.seed_partial()
        original = (partial.read_bytes(), state_path.read_bytes())
        self.pin = self.pin.replace(self.commit, 'b' * 40)
        self.url = self.url.replace(self.commit, 'b' * 40)
        with self.assertRaises(fetch.Refused):
            self.pinned(segments=1)
        self.assertEqual((partial.read_bytes(), state_path.read_bytes()), original)
        self.assertEqual(self.server.requests, 0)

    def test_same_pin_partial_resumes_without_early_receipt(self):
        self.seed_partial()
        self.assertFalse(Path('src/.download-pins/data.bin.json').exists())
        result = self.pinned(segments=1)
        self.assertTrue(result['resumed'])
        self.assertEqual(Path('src/data.bin').read_bytes(), BODY)

    def test_failed_receipt_publication_leaves_partial_for_retry(self):
        api = fetch._pin_helpers()
        with mock.patch.object(api, 'save_pin_receipt', side_effect=OSError('synthetic failure')):
            with self.assertRaises(fetch.Refused):
                self.pinned(segments=1)
        self.assertFalse(Path('src/data.bin').exists())
        self.assertFalse(Path('src/.download-pins/data.bin.json').exists())
        self.assertEqual(Path('src/.partial/data.bin').read_bytes(), BODY)
        self.assertEqual(self.pinned(segments=1)['sha256'], SHA)

    def test_interrupted_mode_initialization_can_resume(self):
        api = fetch._pin_helpers()
        with mock.patch.object(api.os, 'link', side_effect=OSError('synthetic initialization interruption')):
            with self.assertRaises(fetch.Refused):
                self.pinned()
        self.assertTrue(Path('src/.download-pins').is_dir())
        self.assertFalse(Path('src/.download-pins/.mode.json').exists())
        self.assertEqual(self.pinned()['sha256'], SHA)

    def test_cancelled_transfer_has_no_first_digest_and_resumes(self):
        def interrupt(handle, block):
            handle.write(block)
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.pinned(segments=1, writer=interrupt)
        self.assertFalse(Path('src/.download-pins/data.bin.json').exists())
        self.assertFalse(Path('src/data.bin').exists())
        self.assertEqual(self.pinned(segments=1)['sha256'], SHA)

    def test_pinned_transfer_retains_storage_limits(self):
        for limit in ({'source_limit': 1}, {'min_free': 10**18}):
            with self.subTest(limit=limit), self.assertRaises(fetch.Refused):
                self.pinned(**limit)
            self.assertFalse(Path('src/data.bin').exists())
            self.assertFalse(Path('src/.download-pins/data.bin.json').exists())

    def test_manifest_pin_parity_and_all_lines_preflight(self):
        self.pinned()
        entry = {'url': self.url, 'dest': 'src/data.bin', 'pin': self.pin}
        manifest = Path('downloads.jsonl')
        manifest.write_text(json.dumps(entry) + '\n')
        with mock.patch('sys.stdout'):
            self.assertEqual(fetch.main(['--manifest', str(manifest), '--min-free', '0']), 0)
        bad = {**entry, 'dest': 'other/data.bin', 'pin': self.pin.replace(self.commit, 'main')}
        manifest.write_text(json.dumps(entry) + '\n' + json.dumps(bad) + '\n')
        with mock.patch.object(fetch, '_fetch_line') as download, mock.patch('sys.stdout'), mock.patch('sys.stderr'):
            self.assertEqual(fetch.main(['--manifest', str(manifest)]), 2)
            download.assert_not_called()


    def test_competing_process_cannot_publish_another_first_digest(self):
        self.seed_partial()
        # The real lock is shared with every existing digest-mode transfer.
        working = fetch._working_paths(Path('src/data.bin'))
        with working['lock'].open('a') as lock:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(fetch.Refused, 'another download'):
                self.pinned()
        self.assertFalse(Path('src/.download-pins/data.bin.json').exists())
        self.assertEqual(self.pinned(segments=1)['sha256'], SHA)



class InOrderDigest(unittest.TestCase):
    """The digest a segmented run reads in file order while ranges can still be cut back (D03 T04 §22)."""

    def setUp(self):
        self.file = tempfile.TemporaryFile()
        self.addCleanup(self.file.close)
        self.fd = self.file.fileno()
        self.old, self.new = bytes(range(16)), bytes(range(100, 108))
        os.pwrite(self.fd, self.old, 0)
        self.progress = {"end": 16}
        self.guard = threading.Lock()
        self.digest = fetch._InOrderDigest("sha256", self.fd, self.guard, lambda: self.progress["end"])

    def cut_back_to(self, end):
        with self.guard:
            self.progress["end"] = end
            self.digest.invalidate()

    def test_an_invalidation_between_reading_the_frontier_and_hashing_never_lets_old_bytes_in(self):
        stale = 16  # the frontier the hasher read, before the cut
        self.cut_back_to(8)  # bytes 8 to 15 now wait for their replacements
        self.digest.hash_up_to(stale)
        self.assertEqual(self.digest.at, 8)  # only what the cut left, not the stale frontier
        self.assertEqual(self.digest.hash.hexdigest(), hashlib.sha256(self.old[:8]).hexdigest())
        os.pwrite(self.fd, self.new, 8)  # the replacements arrive and the frontier moves on
        self.progress["end"] = 16
        self.digest.hash_up_to(16)
        self.assertEqual((self.digest.at, self.digest.hash.hexdigest()),
                         (16, hashlib.sha256(self.old[:8] + self.new).hexdigest()))  # every replacement byte is in it

    def test_a_cut_while_a_block_is_read_drops_the_block_and_goes_on_from_the_new_frontier(self):
        real, fired = os.pread, []

        def pread(descriptor, count, offset):
            block = real(descriptor, count, offset)
            if not fired:
                fired.append(True)  # the cut lands after the old bytes were read, before they were counted
                self.cut_back_to(4)
                os.pwrite(self.fd, self.new, 4)
                self.progress["end"] = 12
            return block

        with mock.patch.object(fetch.os, "pread", pread):
            self.digest.hash_up_to(16)
        self.assertEqual((self.digest.at, self.digest.hash.hexdigest()),
                         (12, hashlib.sha256(self.old[:4] + self.new).hexdigest()))


if __name__ == "__main__":
    unittest.main()
