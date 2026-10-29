"""scripts/glimmer/fetch.py (D03 T04 §16): a download that resumes where it stopped and accepts nothing unverified,
against a local server that can drop, lie about ranges, change the file, redirect, stall or fail."""
import errno
import hashlib
import http.server
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "fetch.py"
spec = importlib.util.spec_from_file_location("fetch", SCRIPT)
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)

SIZE = 10 * 1024 * 1024
BODY = bytes((i * 7 + 3) % 251 for i in range(SIZE))
SHA = hashlib.sha256(BODY).hexdigest()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.mode = "normal"
        self.body = BODY
        self.etag = '"v1"'
        self.served = []  # bytes sent per request
        self.requests = 0


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    # `do_GET` is the name BaseHTTPRequestHandler dispatches a GET to.
    def do_GET(self):  # noqa: N802
        server = self.server
        server.requests += 1
        mode = server.mode
        body = server.body
        if self.path.startswith("/hop"):
            target = "/loop" if mode == "loop" else "https://10.0.0.1/x" if mode == "private" else "/file"
            if self.path == "/loop":
                target = "/loop"
            self.send_response(302)
            self.send_header("Location", target)
            self.end_headers()
            return
        if self.path == "/loop":
            self.send_response(302)
            self.send_header("Location", "/loop")
            self.end_headers()
            return
        if mode == "fail":
            self.send_response(503)
            self.end_headers()
            return
        start = 0
        ranged = self.headers.get("Range")
        honour = ranged and mode not in ("ignore-range",) and self.headers.get("If-Range") in (None, server.etag)
        if honour:
            start = int(ranged.split("=")[1].split("-")[0])
            if start >= len(body):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(body)}")
                self.end_headers()
                return
            offset = start + 1000 if mode == "wrong-offset" else start
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {offset}-{len(body) - 1}/{len(body)}")
            if mode == "encoding":
                self.send_header("Content-Encoding", "gzip")
            chunk = body[start:]
        else:
            self.send_response(200)
            chunk = body
        self.send_header("ETag", server.etag)
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        cut = len(chunk)
        if mode == "drop-once" and server.requests == 1:
            cut = int(len(chunk) * 0.9)
        if mode == "truncate" and honour:
            cut = len(chunk) // 2
        if mode == "stall":
            import time

            time.sleep(3)
        try:
            self.wfile.write(chunk[:cut])
        except (BrokenPipeError, ConnectionResetError):
            pass  # the fetcher gave up on this response on purpose (a limit or a timeout case)
        server.served.append(cut)
        if cut < len(chunk):
            self.close_connection = True
            self.connection.shutdown(2)


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

    def run_fetch(self, path="/file", sha=SHA, **kw):
        return fetch.fetch(self.base + path, "src/data.bin", ("sha256", sha) if sha else None, allow_loopback=True, timeout=2, **kw)

    def test_the_exact_command_fetches_and_reports_from_a_store_folder(self):
        out = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin", "--sha256", SHA, "--allow-loopback"],
            capture_output=True, text=True, cwd=self.dir, check=False)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        line = json.loads(out.stdout)
        self.assertEqual((line["status"], line["sha256"], line["verified"]), ("fetched", SHA, True))
        self.assertEqual((self.dir / "src/data.bin").read_bytes(), BODY)
        self.assertFalse((self.dir / "src/.partial/data.bin").exists())

    def test_refuses_a_missing_or_malformed_digest(self):
        for args in ([], ["--sha256", "abc"], ["--md5", "z" * 32]):
            out = subprocess.run([sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/x", *args],
                                 capture_output=True, text=True, cwd=self.dir, check=False)
            self.assertNotEqual(out.returncode, 0, args)
        self.assertFalse((self.dir / "src/x").exists())

    def test_an_interrupted_transfer_resumes_with_the_last_tenth_only(self):
        self.server.mode = "drop-once"
        line = self.run_fetch()
        self.assertEqual(line["status"], "fetched")
        self.assertTrue(line["resumed"])
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)
        self.assertLessEqual(self.server.served[1], SIZE // 10 + 64 * 1024)

    def test_a_server_that_ignores_ranges_is_fetched_whole(self):
        self.server.mode = "drop-once"
        self.server.requests = 0
        # The first request drops at 90 percent; the server then ignores ranges and sends the whole file again.
        original = Handler.do_GET

        def ignoring(handler):
            if handler.server.requests >= 1:
                handler.server.mode = "ignore-range"
            original(handler)

        Handler.do_GET = ignoring
        self.addCleanup(setattr, Handler, "do_GET", original)
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", False))
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_mismatch_is_refused_and_removed_and_a_clean_attempt_then_succeeds(self):
        with self.assertRaises(fetch.Refused):
            self.run_fetch(sha="0" * 64)
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.assertFalse(Path("src/data.bin").exists())
        # A resumed mismatch too: a partial whose bytes are wrong.
        Path("src/.partial").mkdir(parents=True, exist_ok=True)
        Path("src/.partial/data.bin").write_bytes(b"\0" * (SIZE // 2))
        Path("src/.partial/data.bin.state.json").write_text(json.dumps(
            {"url": self.base + "/file", "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE}))
        with self.assertRaises(fetch.Refused):
            self.run_fetch()
        self.assertFalse(Path("src/.partial/data.bin").exists())
        self.assertEqual(self.run_fetch()["status"], "fetched")

    def test_a_wrong_offset_or_a_changed_encoding_is_never_appended(self):
        for mode in ("wrong-offset", "encoding"):
            with self.subTest(mode=mode):
                shutil.rmtree("src", ignore_errors=True)
                self.server.mode = "normal"
                Path("src/.partial").mkdir(parents=True)
                Path("src/.partial/data.bin").write_bytes(BODY[: SIZE // 2])
                Path("src/.partial/data.bin.state.json").write_text(json.dumps(
                    {"url": self.base + "/file", "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE}))
                self.server.mode = mode
                original = Handler.do_GET

                def then_normal(handler, original=original):
                    original(handler)
                    handler.server.mode = "normal"

                Handler.do_GET = then_normal
                try:
                    line = self.run_fetch()
                finally:
                    Handler.do_GET = original
                self.assertEqual(line["status"], "fetched")
                self.assertFalse(line["resumed"])
                self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_truncated_range_is_tried_again_and_completes(self):
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(BODY[: SIZE // 2])
        Path("src/.partial/data.bin.state.json").write_text(json.dumps(
            {"url": self.base + "/file", "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE}))
        self.server.mode = "truncate"
        original = Handler.do_GET

        def once(handler):
            original(handler)
            handler.server.mode = "normal"

        Handler.do_GET = once
        self.addCleanup(setattr, Handler, "do_GET", original)
        self.assertEqual(self.run_fetch()["status"], "fetched")
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_whole_partial_answered_416_is_verified_and_an_oversized_one_restarted(self):
        state = {"url": self.base + "/file", "expected": ["sha256", SHA], "validator": '"v1"', "encoding": "identity", "total": SIZE}
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(BODY)
        Path("src/.partial/data.bin.state.json").write_text(json.dumps(state))
        line = self.run_fetch()
        self.assertEqual((line["status"], line["fetched"]), ("fetched", 0))
        shutil.rmtree("src")
        Path("src/.partial").mkdir(parents=True)
        Path("src/.partial/data.bin").write_bytes(BODY + b"extra")
        Path("src/.partial/data.bin.state.json").write_text(json.dumps(state))
        self.assertEqual(self.run_fetch()["status"], "fetched")
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_changed_file_starts_again_and_state_carries_across_processes(self):
        self.server.mode = "drop-once"
        with self.assertRaises(fetch.Refused):
            self.run_fetch(attempts=1)
        self.assertTrue(Path("src/.partial/data.bin.state.json").exists())
        # The server's file changes between runs: a new validator, so If-Range sends it whole.
        self.server.body = BODY[::-1]
        self.server.etag = '"v2"'
        self.server.mode = "normal"
        out = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--url", self.base + "/file", "--dest", "src/data.bin",
             "--sha256", hashlib.sha256(BODY[::-1]).hexdigest(), "--allow-loopback"],
            capture_output=True, text=True, cwd=self.dir, check=False)
        self.assertEqual(out.returncode, 0, out.stdout)
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY[::-1])

    def test_redirects_are_followed_within_bounds_and_refused_beyond_them(self):
        self.assertEqual(self.run_fetch(path="/hop")["status"], "fetched")
        shutil.rmtree("src")
        self.server.mode = "loop"
        with self.assertRaisesRegex(fetch.Refused, "redirects"):
            self.run_fetch(path="/loop")
        self.server.mode = "private"
        with self.assertRaisesRegex(fetch.Refused, "non-public"):
            self.run_fetch(path="/hop")

    def test_limits_and_failures_end_bounded_with_the_partial_kept(self):
        with self.assertRaisesRegex(fetch.Refused, "over"):
            self.run_fetch(max_bytes=SIZE // 2)
        shutil.rmtree("src", ignore_errors=True)
        self.server.mode = "fail"
        with self.assertRaisesRegex(fetch.Refused, "3 attempts"):
            self.run_fetch()
        self.server.mode = "drop-once"
        self.server.requests = 0
        with self.assertRaisesRegex(fetch.Refused, "incomplete"):
            self.run_fetch(attempts=1)
        self.assertTrue(Path("src/.partial/data.bin").exists())

    def test_a_stalled_server_times_out_within_its_attempts(self):
        self.server.mode = "stall"
        with self.assertRaisesRegex(fetch.Refused, "2 attempts"):
            fetch.fetch(self.base + "/file", "src/data.bin", ("sha256", SHA), allow_loopback=True, timeout=1, attempts=2)

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
        self.assertFalse(Path("src/data.bin").exists())
        line = self.run_fetch()
        self.assertEqual((line["status"], line["resumed"]), ("fetched", True))
        self.assertEqual(Path("src/data.bin").read_bytes(), BODY)

    def test_a_file_in_place_is_rehashed_and_reused(self):
        self.run_fetch()
        served = len(self.server.served)
        line = self.run_fetch()
        self.assertEqual((line["status"], line["fetched"]), ("present", 0))
        self.assertEqual(len(self.server.served), served)
        Path("src/data.bin").write_bytes(b"changed")
        with self.assertRaisesRegex(fetch.Refused, "differs"):
            self.run_fetch()

    def test_unpublished_digest_is_computed_and_marked_unverified(self):
        line = self.run_fetch(sha=None)
        self.assertEqual((line["verified"], line["sha256"]), (False, SHA))


if __name__ == "__main__":
    unittest.main()
