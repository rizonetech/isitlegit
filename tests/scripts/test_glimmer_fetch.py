"""scripts/glimmer/fetch.py (D03 T04 §16): a download that resumes where it stopped and accepts nothing unverified,
against a local server that can drop, lie about ranges, change the file, redirect, stall, throttle or fail."""
import errno
import fcntl
import hashlib
import re
import http.server
import importlib.util
import json
import os
import shutil
import socket
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


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.modes = set()
        self.body = BODY
        self.etag = '"v1"'
        self.served = []  # bytes sent per request for /file
        self.requests = 0
        self.lock = threading.Lock()
        self.segment_requests = 0  # ranges asked with an end: what only the segmented path sends
        self.active = 0
        self.peak = 0  # the most segment requests open at once


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    # `do_HEAD` is the name BaseHTTPRequestHandler dispatches a HEAD to.
    def do_HEAD(self):  # noqa: N802
        server, modes = self.server, self.server.modes
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
            self.send_header("Content-Length", str(len(server.body)))
        if "no-accept-ranges" not in modes:
            self.send_header("Accept-Ranges", "none, bytes" if "listed-ranges" in modes else "bytes")
        self.send_header("ETag", 'W/"v1"' if "weak-etag" in modes else server.etag)
        if "encoding" in modes:
            self.send_header("Content-Encoding", "gzip")
        self.end_headers()

    # `do_GET` is the name BaseHTTPRequestHandler dispatches a GET to.
    def do_GET(self):  # noqa: N802
        ranged = self.headers.get("Range") or ""
        if re.fullmatch(r"bytes=\d+-\d+", ranged) and self.path == "/file":
            with self.server.lock:
                self.server.segment_requests += 1
                self.server.active += 1
                self.server.peak = max(self.server.peak, self.server.active)
            try:
                return self.answer()
            finally:
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
        if "segment-403" in modes and re.fullmatch(r"bytes=\d+-\d+", self.headers.get("Range") or ""):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
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
            if "segment-corrupt" in modes and segment and start > 0:
                chunk = bytes(b ^ 0xFF for b in chunk[:16]) + chunk[16:]
            length = len(chunk) + (7 if "bad-length" in modes or ("segment-bad-length" in modes and segment) else 0)
            if "segment-huge" in modes and segment:
                self.send_header("Content-Range", f"bytes {start}-{end}/{'9' * 5000}")
            if "encoding" in modes:
                self.send_header("Content-Encoding", "gzip")
        else:
            self.send_response(200)
            chunk = body
            length = len(chunk)
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
        if ("segment-slow" in modes and segment) or ("slow-first-range" in modes and segment and start == 0):
            try:
                for at in range(0, cut, 1 << 16):
                    self.wfile.write(chunk[at:min(cut, at + (1 << 16))])
                    with server.lock:
                        server.served.append(min(cut, at + (1 << 16)) - at)
                    time.sleep(0.05)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the fetcher was killed mid-download, as the test means it to be
            return
        if "stall" in modes:
            time.sleep(3)
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
        self.assertEqual(set(line), {"status", "bytes", "fetched", "sha256", "resumed", "url", "reason"})
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
                started = time.monotonic()
                with self.assertRaisesRegex(fetch.Refused, "slower than the rate floor"):
                    self.run_fetch(path=path, min_rate=1024 * 1024, rate_window=0.5, attempts=1, timeout=5)
                # Cut within a window or two, not after the server's 10 seconds of trickle.
                self.assertLess(time.monotonic() - started, 4)

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
            self.assertEqual(len(connections), 1 if options.get("segments") == 1 else 5, options)

    # Segmented downloads (D03 T04 §20): the test file is 10 MiB, so a 1 MiB threshold makes it qualify.
    SEGMENTED = {"segment_threshold": 1 << 20}

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
        self.assertEqual(self.server.segment_requests, 4)
        self.assertGreaterEqual(self.server.peak, 2)
        self.assertLessEqual(self.server.peak, 4)

    def test_a_server_that_does_not_qualify_gets_one_stream(self):
        for modes in ({"no-accept-ranges"}, {"weak-etag"}, {"no-length"}, {"no-head"}, set()):
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.segment_requests = set(modes), 0
                # An empty mode set with segments=1 is the operator forcing one stream on a server that qualifies.
                options = {"segment_threshold": 1 << 20} if modes else {"segments": 1, "segment_threshold": 1 << 20}
                self.run_fetch(**options)
                self.assertEqual(Path("src/data.bin").read_bytes(), BODY)
                self.assertEqual(self.server.segment_requests, 0)
        shutil.rmtree("src", ignore_errors=True)
        self.server.modes, self.server.segment_requests = set(), 0
        self.run_fetch(segment_threshold=SIZE + 1)  # under the threshold
        self.assertEqual(self.server.segment_requests, 0)

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

    def test_segment_limits_hold(self):
        with self.assertRaisesRegex(fetch.Refused, "limit"):
            self.run_fetch(source_limit=SIZE // 2, **self.SEGMENTED)
        self.assertEqual(self.server.segment_requests, 0)
        with self.assertRaisesRegex(fetch.Refused, "free-space floor"):
            self.run_fetch(min_free=10**18, **self.SEGMENTED)
        # The floor crossed mid-download (another writer on the disk) ends every segment with the partial kept.
        real = fetch.shutil.disk_usage
        calls = {"n": 0}

        def filling(path):
            calls["n"] += 1
            usage = real(path)
            return usage._replace(free=0) if calls["n"] > 20 else usage

        shutil.rmtree("src", ignore_errors=True)
        with mock.patch.object(fetch.shutil, "disk_usage", filling), self.assertRaisesRegex(fetch.Refused, "free-space floor"):
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
        self.assertLess(time.monotonic() - started, 10)
        self.assertTrue(Path("src/.partial/data.bin").exists())

    def test_a_trickling_head_is_cut_by_the_rate_check_and_the_mirror_used(self):
        other, base = self.mirror()
        self.server.modes = {"head-trickle"}
        started = time.monotonic()
        result = fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True,
                             mirrors=[base + "/file"], timeout=30, sleep=lambda s: None, log=lambda line: None,
                             segment_threshold=1 << 20, rate_window=0.5, min_rate=1000, **ROOMY)
        self.assertEqual((result["status"], result["url"]), ("fetched", base + "/file"))
        self.assertLess(time.monotonic() - started, 8)
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
        real = fetch.shutil.disk_usage
        calls = {"n": 0}

        def tight(path):
            calls["n"] += 1
            usage = real(path)
            # Room for the start's checks, then only a little over the floor: the next 64 KiB write would cross it.
            return usage if calls["n"] <= 3 else usage._replace(free=10**6 + 1000)

        with mock.patch.object(fetch.shutil, "disk_usage", tight), self.assertRaisesRegex(fetch.Refused, "free-space floor"):
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

        cases = (({"segment-slow"}, True), ({"no-accept-ranges"}, False), ({"weak-etag"}, False), ({"no-length"}, False),
                 ({"encoding"}, False), ({"head-501"}, False), ({"segment-wrong-offset"}, True), ({"bad-bounds"}, True),
                 ({"segment-bad-length"}, True), ({"no-validator-on-range"}, True), ({"segment-short"}, True))
        for modes, segmented in cases:
            with self.subTest(modes=modes):
                shutil.rmtree("src", ignore_errors=True)
                self.server.modes, self.server.segment_requests = set(modes), 0
                done = cli()
                self.assertEqual(done.returncode, 0, done.stderr[-300:])
                self.assert_whole()
                self.assertEqual(self.server.segment_requests > 0, segmented)

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

    def test_a_missing_ca_file_is_refused_before_anything_connects(self):
        with self.assertRaisesRegex(fetch.Refused, "--ca-file"):
            self.run_fetch(ca_file="no-such-ca.pem")
        self.assertEqual(self.server.requests, 0)

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
        self.server.modes = {"no-length"}
        # A disk whose free space falls by exactly what the download writes, so nothing else on the host moves it.
        start = 10**12

        def disk(_path):
            written = Path("src/.partial/data.bin")
            return mock.Mock(free=start - (written.stat().st_size if written.exists() else 0))

        with mock.patch.object(fetch.shutil, "disk_usage", disk), self.assertRaisesRegex(fetch.Refused, "fell under"):
            self.run_fetch(min_free=start - 512 * 1024)
        self.assertFalse(Path("src/data.bin").exists())

    def test_a_429_waits_as_long_as_the_server_asks(self):
        self.server.modes = {"429-once"}
        waits = []
        self.assertEqual(self.run_fetch(sleep=waits.append)["status"], "fetched")
        self.assertEqual(waits, [1.0])

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


if __name__ == "__main__":
    unittest.main()
