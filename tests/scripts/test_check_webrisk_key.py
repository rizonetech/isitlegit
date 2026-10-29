"""scripts/check-webrisk-key.py (D99 T01 §6): passes only for a working, Web-Risk-restricted key, never printing it."""
import http.client
import importlib.util
import io
import pathlib
import unittest
import urllib.error
import urllib.request
from unittest import mock

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_webrisk_key", REPO / "scripts/check-webrisk-key.py")
cwk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cwk)

KEY = "AIza" + "x" * 35
LURE = (200, {"threat": {"threatTypes": ["SOCIAL_ENGINEERING"]}})
CLEAN = (200, {})
BLOCKED = (403, {"error": {"status": "PERMISSION_DENIED", "details": [{"reason": "API_KEY_SERVICE_BLOCKED"}]}})
DISABLED = (403, {"error": {"status": "PERMISSION_DENIED", "details": [{"reason": "SERVICE_DISABLED"}]}})


def google(lure=LURE, clean=CLEAN, other=BLOCKED, seen=None, others=None):
    """A stub Google: `others` maps an API's host to its answer; every other API answers `other`."""
    def get(key, url):
        if seen is not None:
            seen.append(url)
        if url.startswith(cwk.SEARCH):
            return lure if "testsafebrowsing" in url else clean
        for host, answer in (others or {}).items():
            if host in url:
                return answer
        return other
    return get


class WebRiskKey(unittest.TestCase):
    def outcome(self, read=lambda: KEY, get=None):
        code, line = cwk.check(read=read, get=get or google())
        self.assertNotIn(KEY, line)
        return code, line

    def test_a_working_restricted_key_passes(self):
        seen = []
        code, line = self.outcome(get=google(seen=seen))
        self.assertEqual(code, 0)
        self.assertTrue(all(KEY not in url for url in seen))  # the key never goes in a URL

    def test_a_placeholder_is_refused_before_any_call(self):
        seen = []
        for value in ("", "placeholder", "AIza-too-short", "sk-" + "x" * 40):
            with self.subTest(value):
                code, line = cwk.check(read=lambda v=value: v, get=google(seen=seen))
                self.assertEqual(code, 1)
                self.assertIn("does not hold a Google API key", line)
        self.assertEqual(seen, [])

    def test_an_invalid_or_revoked_key_is_refused(self):
        self.assertEqual(self.outcome(get=google(lure=(400, {"error": {"status": "INVALID_ARGUMENT"}})))[0], 1)
        self.assertEqual(self.outcome(get=google(lure=(403, {})))[0], 1)

    def test_a_lookup_that_misses_the_lure_or_flags_the_clean_page_is_refused(self):
        self.assertEqual(self.outcome(get=google(lure=(200, {})))[0], 1)
        self.assertEqual(self.outcome(get=google(clean=LURE))[0], 1)

    def test_a_key_allowed_another_api_is_refused(self):
        # Web Risk plus Generative Language allowed: the extra service answers, so the key fails.
        code, line = self.outcome(get=google(others={"generativelanguage": (200, {"models": []})}))
        self.assertEqual(code, 1)
        self.assertIn("generativelanguage.googleapis.com accepted the key", line)
        code, line = self.outcome(get=google(others={"youtube": (404, {})}))
        self.assertEqual(code, 1)

    def test_a_key_with_no_restriction_is_refused(self):
        code, line = self.outcome(get=google(other=DISABLED))
        self.assertEqual(code, 1)
        self.assertIn("no API restriction", line)

    def test_disabled_services_count_as_refusals_beside_a_blocked_one(self):
        self.assertEqual(self.outcome(get=google(others={"translation": DISABLED, "vision": DISABLED}))[0], 0)

    def test_quota_and_server_errors_are_inconclusive_at_every_step(self):
        for busy in ((429, {}), (503, {}), (500, {})):
            for stage in ("lure", "clean", "other"):
                with self.subTest(status=busy[0], stage=stage):
                    stub = google(**{stage: busy}) if stage != "other" else google(others={"kgsearch": busy})
                    code, line = self.outcome(get=stub)
                    self.assertEqual(code, 2)
                    self.assertIn("nothing was judged", line)

    def test_an_unreachable_vault_or_google_exits_2(self):
        def stalled():
            raise cwk.Unreachable("the vault did not answer within 60 s")

        self.assertEqual(self.outcome(read=stalled)[0], 2)

        def down(key, url):
            raise cwk.Unreachable("Google could not be reached (URLError)")

        self.assertEqual(self.outcome(get=down)[0], 2)


class Call(unittest.TestCase):
    """call() itself: an error answer whose body is cut off is Google unreachable (exit 2), never a judgement."""

    def test_a_cut_off_error_body_is_unreachable(self):
        for status in (403, 429, 503):
            for cut in (TimeoutError("read timed out"), http.client.IncompleteRead(b"{"), ConnectionResetError()):
                with self.subTest(status=status, cut=type(cut).__name__):
                    error = urllib.error.HTTPError("https://x.test", status, "err", {}, io.BytesIO(b""))
                    error.read = mock.Mock(side_effect=cut)
                    with mock.patch.object(cwk.OPENER, "open", side_effect=error):
                        with self.assertRaises(cwk.Unreachable):
                            cwk.call(KEY, "https://x.test")
                        code, line = cwk.check(read=lambda: KEY)
                        self.assertEqual(code, 2)
                        self.assertNotIn(KEY, line)

    def test_a_truncated_or_unreadable_error_body_is_unreachable(self):
        # A real HTTP response that promises 100 bytes and closes after 9: read() returns them without raising.
        class Sock:
            def __init__(self, data):
                self.data = data

            def makefile(self, *args, **kwargs):
                return io.BytesIO(self.data)

        raw = b"HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n" + b'{"error":'
        response = http.client.HTTPResponse(Sock(raw))
        response.begin()
        truncated = urllib.error.HTTPError("https://x.test", 403, "Forbidden", response.headers, response)
        html = urllib.error.HTTPError("https://x.test", 403, "err", {}, io.BytesIO(b"<html>denied</html>"))
        # And on a success status: HTTP 200, chunked, the connection closing mid-chunk.
        chunked = (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
                   b"40\r\n{\"threat\": {\"threatTypes\"")
        ok = http.client.HTTPResponse(Sock(chunked))
        ok.begin()
        context = mock.MagicMock()
        context.__enter__.return_value = ok
        with mock.patch.object(cwk.OPENER, "open", return_value=context):
            with self.assertRaises(cwk.Unreachable):
                cwk.call(KEY, "https://x.test")
            code, line = cwk.check(read=lambda: KEY)
            self.assertEqual(code, 2)
        # An empty or short body on a success status: never read as `{}`, the clean answer.
        for raw in (b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n",
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n"):
            empty = http.client.HTTPResponse(Sock(raw))
            empty.begin()
            context = mock.MagicMock()
            context.__enter__.return_value = empty
            with self.subTest(raw[-30:]), mock.patch.object(cwk.OPENER, "open", return_value=context):
                with self.assertRaises(cwk.Unreachable):
                    cwk.call(KEY, "https://x.test")
        whole = http.client.HTTPResponse(Sock(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"))
        whole.begin()
        context = mock.MagicMock()
        context.__enter__.return_value = whole
        with mock.patch.object(cwk.OPENER, "open", return_value=context):
            self.assertEqual(cwk.call(KEY, "https://x.test"), (200, {}))
        for error in (truncated, html):
            with self.subTest(error.fp.__class__.__name__):
                with mock.patch.object(cwk.OPENER, "open", side_effect=error):
                    with self.assertRaises(cwk.Unreachable):
                        cwk.call(KEY, "https://x.test")


class Shapes(unittest.TestCase):
    """A whole answer in the wrong shape is unreadable (exit 2), never a crash or a substring match."""

    def test_wrong_shapes_are_unreadable(self):
        for lure in ((200, {"threat": "SOCIAL_ENGINEERING"}), (200, {"threat": {"threatTypes": "SOCIAL_ENGINEERING"}}),
                     (200, {"threat": {"threatTypes": [1]}})):
            with self.subTest(lure=lure):
                self.assertEqual(cwk.check(read=lambda: KEY, get=google(lure=lure))[0], 2)
        for other in ((403, {"error": "denied"}), (403, {"error": {"details": "x"}})):
            with self.subTest(other=other):
                self.assertEqual(cwk.check(read=lambda: KEY, get=google(others={"kgsearch": other}))[0], 2)

    def test_a_non_object_answer_is_unreadable(self):
        body = io.BytesIO(b"[]")
        response = mock.MagicMock(status=200, headers={"Content-Length": "2"})
        response.read.side_effect = body.read
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with mock.patch.object(cwk.OPENER, "open", return_value=context):
            with self.assertRaises(cwk.Unreachable):
                cwk.call(KEY, "https://x.test")

    def test_the_older_refusal_shape_counts(self):
        legacy = (403, {"error": {"errors": [{"reason": "accessNotConfigured"}]}})
        self.assertEqual(cwk.check(read=lambda: KEY, get=google(others={"books": legacy}))[0], 0)


class Request(unittest.TestCase):
    """The real request: the key only in its header, redirects refused, a deadline over the whole answer."""

    def test_the_key_travels_only_in_the_header(self):
        sent = []
        response = mock.MagicMock(status=200, headers={"Content-Length": "2"})
        response.read.side_effect = io.BytesIO(b"{}").read
        context = mock.MagicMock()
        context.__enter__.return_value = response

        def open_(request, timeout):
            sent.append(request)
            return context

        with mock.patch.object(cwk.OPENER, "open", side_effect=open_):
            cwk.call(KEY, cwk.SEARCH + "x")
        self.assertEqual(sent[0].get_header("X-goog-api-key"), KEY)
        self.assertNotIn(KEY, sent[0].full_url)

    def test_a_redirect_is_refused(self):
        handler = cwk.NoRedirect()
        request = urllib.request.Request("https://webrisk.googleapis.com/v1/uris:search")
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(request, io.BytesIO(b""), 302, "Found", {}, "https://example.invalid/collect")
        error = urllib.error.HTTPError("https://x.test", 302, "redirect refused", {}, io.BytesIO(b""))
        with mock.patch.object(cwk.OPENER, "open", side_effect=error):
            with self.assertRaises(cwk.Unreachable):
                cwk.call(KEY, "https://x.test")

    def test_a_trickle_past_the_deadline_is_unreachable(self):
        clock = iter([0.0, 0.0, 31.0, 31.0])
        stream = mock.MagicMock()
        stream.read.return_value = b"{"
        with mock.patch.object(cwk.time, "monotonic", side_effect=lambda: next(clock)):
            with self.assertRaises(TimeoutError):
                cwk.read_by(stream, 30.0)


class Deadline(unittest.TestCase):
    """A read that blocks while bytes trickle in cannot hold the call past its deadline."""

    def test_a_blocking_slow_read_ends_at_the_deadline(self):
        import threading
        import time as clock

        release = threading.Event()
        response = mock.MagicMock(status=200, headers={})
        response.read.side_effect = lambda *args: release.wait(5) and b""
        context = mock.MagicMock()
        context.__enter__.return_value = response
        with mock.patch.object(cwk, "HTTP_SECONDS", 0.2), mock.patch.object(cwk.OPENER, "open", return_value=context):
            started = clock.monotonic()
            with self.assertRaises(cwk.Unreachable):
                cwk.call(KEY, "https://x.test")
            self.assertLess(clock.monotonic() - started, 2)
        release.set()


if __name__ == "__main__":
    unittest.main()
