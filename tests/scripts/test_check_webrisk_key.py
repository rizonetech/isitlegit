"""scripts/check-webrisk-key.py (D99 T01 §6): passes only for a working, Web-Risk-restricted key, never printing it."""
import http.client
import importlib.util
import io
import pathlib
import unittest
import urllib.error
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
                    with mock.patch.object(cwk.urllib.request, "urlopen", side_effect=error):
                        with self.assertRaises(cwk.Unreachable):
                            cwk.call(KEY, "https://x.test")
                        code, line = cwk.check(read=lambda: KEY)
                        self.assertEqual(code, 2)
                        self.assertNotIn(KEY, line)

    def test_an_error_body_that_is_not_json_keeps_its_status(self):
        error = urllib.error.HTTPError("https://x.test", 403, "err", {}, io.BytesIO(b"<html>denied</html>"))
        with mock.patch.object(cwk.urllib.request, "urlopen", side_effect=error):
            self.assertEqual(cwk.call(KEY, "https://x.test"), (403, {}))


if __name__ == "__main__":
    unittest.main()
