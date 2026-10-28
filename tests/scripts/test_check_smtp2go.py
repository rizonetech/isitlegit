"""scripts/check-smtp2go.py (D99 T01 §4): passes only for a live, narrowed key and SMTP2GO's DNS, never printing the key."""
import importlib.util
import io
import pathlib
import subprocess
import unittest
import urllib.error
import urllib.request
from unittest import mock

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_smtp2go", REPO / "scripts/check-smtp2go.py")
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

KEY = "api-" + "k" * 32
DENIED = (400, {"error_code": cs.DENIED})


def smtp2go(stats=(200, {"cycle_max": 20000}), send=(400, {"error_code": cs.NOT_VALID}), activity=(200, {"events": []}),
            domain=DENIED, users=DENIED, keys=DENIED):
    answers = {"stats/email_summary": stats, "email/send": send, "activity/search": activity, "domain/view": domain,
               "users/smtp/view": users, "api_keys/view": keys}
    return lambda key, endpoint, body=b"{}": answers[endpoint]


def dns(**override):
    return lambda name: {**cs.CNAMES, **override}.get(name, "")


class Smtp2go(unittest.TestCase):
    def run_check(self, read=lambda: KEY, call=None, lookup=None):
        code, line = cs.check(read=read, call=call or smtp2go(), lookup=lookup or dns(), say=lambda text: None)
        self.assertNotIn(KEY, line)
        return code, line

    def test_a_live_narrowed_key_with_its_dns_passes(self):
        self.assertEqual(self.run_check()[0], 0)

    def test_a_placeholder_is_refused_before_any_call(self):
        calls = []
        for value in ("", "placeholder", "api-short"):
            with self.subTest(value):
                code, line = cs.check(read=lambda v=value: v, call=lambda k, e, b=b"{}": calls.append(e), lookup=dns(),
                                      say=lambda text: None)
                self.assertEqual(code, 1)
        self.assertEqual(calls, [])

    def test_a_key_that_may_not_send_is_refused(self):
        code, line = self.run_check(call=smtp2go(send=DENIED))
        self.assertEqual(code, 1)
        self.assertIn("grant the key the send permission", line)

    def test_an_activity_answer_without_an_events_list_is_refused(self):
        self.assertEqual(self.run_check(call=smtp2go(activity=(200, {"events": {}})))[0], 1)

    def test_a_key_that_cannot_search_activity_is_refused(self):
        code, line = self.run_check(call=smtp2go(activity=DENIED))
        self.assertEqual(code, 1)
        self.assertIn("grant it activity search", line)

    def test_an_invalid_or_revoked_key_is_refused(self):
        self.assertEqual(self.run_check(call=smtp2go(stats=(401, {"error": "invalid"})))[0], 1)

    def test_an_unnarrowed_key_is_refused(self):
        for over in ({"domain": (200, {"domains": []})}, {"users": (200, {"results": []})},
                     {"keys": (200, {"api_keys": []})}):
            with self.subTest(over):
                code, line = self.run_check(call=smtp2go(**over))
                self.assertEqual(code, 1)
                self.assertIn("narrow the key to sending only", line)

    def test_a_missing_or_wrong_dns_record_is_refused(self):
        self.assertEqual(self.run_check(lookup=dns(**{"em1027207.isitlegit.co.za": ""}))[0], 1)
        self.assertEqual(self.run_check(lookup=dns(**{"s1027207._domainkey.isitlegit.co.za": "evil.example."}))[0], 1)

    def test_an_unreachable_vault_smtp2go_or_dns_exits_2(self):
        def down(*args):
            raise cs.Unreachable("no answer")

        self.assertEqual(self.run_check(read=down)[0], 2)
        self.assertEqual(self.run_check(call=down)[0], 2)
        self.assertEqual(self.run_check(lookup=down)[0], 2)


class Progress(unittest.TestCase):
    def test_each_stage_is_announced_before_it_blocks(self):
        said = []

        def stalls(key, endpoint, body=b"{}"):
            if endpoint == "domain/view":
                self.assertIn("check-smtp2go: the key may send", said)
                self.assertTrue(said[-1].endswith("which a sending key must be refused"))
                raise cs.Unreachable("no answer")
            return smtp2go()(key, endpoint, body)

        code, line = cs.check(read=lambda: KEY, call=stalls, lookup=dns(), say=said.append)
        self.assertEqual(code, 2)
        self.assertEqual(said[0], "check-smtp2go: reading the key from the vault (up to 60 s)")


class Adapters(unittest.TestCase):
    """post() and cname() themselves: outages are inconclusive, never a key or record finding."""

    def answer(self, status, body):
        if status >= 400:
            return urllib.error.HTTPError("https://api.smtp2go.com/v3/x", status, "err", {}, io.BytesIO(body))
        response = mock.MagicMock(status=status)
        response.read.side_effect = io.BytesIO(body).read
        context = mock.MagicMock()
        context.__enter__.return_value = response
        return context

    def test_quota_server_and_unreadable_answers_are_unreachable(self):
        for status, body in ((429, b'{"data": {"error": "slow down"}}'), (503, b'{"data": {}}'), (500, b"<html>"),
                             (200, b"[]"), (200, b"{\"data\": 1}"), (400, b"not json")):
            with self.subTest(status=status, body=body):
                effect = self.answer(status, body)
                kwargs = {"side_effect": effect} if isinstance(effect, Exception) else {"return_value": effect}
                with mock.patch.object(cs.OPENER, "open", **kwargs):
                    with self.assertRaises(cs.Unreachable):
                        cs.post(KEY, "stats/email_summary")

    def test_a_refusal_with_a_data_object_is_returned(self):
        effect = self.answer(400, b'{"data": {"error_code": "E_ApiResponseCodes.ENDPOINT_PERMISSION_DENIED"}}')
        with mock.patch.object(cs.OPENER, "open", side_effect=effect):
            self.assertEqual(cs.post(KEY, "domain/view"), (400, {"error_code": cs.DENIED}))

    def test_a_redirect_is_refused_and_never_followed(self):
        handler = cs.NoRedirect()
        request = urllib.request.Request("https://api.smtp2go.com/v3/stats/email_summary", headers={"X-Smtp2go-Api-Key": KEY})
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(request, io.BytesIO(b""), 302, "Found", {}, "http://redirect.example/receive")
        effect = urllib.error.HTTPError("https://api.smtp2go.com/v3/x", 302, "redirect refused", {}, io.BytesIO(b""))
        with mock.patch.object(cs.OPENER, "open", side_effect=effect), self.assertRaises(cs.Unreachable):
            cs.post(KEY, "stats/email_summary")

    def test_a_trickle_past_the_deadline_is_refused(self):
        clock = iter([0.0, 0.0, 31.0])
        stream = mock.MagicMock()
        stream.read.return_value = b"{"
        with mock.patch.object(cs.time, "monotonic", side_effect=lambda: next(clock)), self.assertRaises(TimeoutError):
            cs.read_by(stream, 30.0)

    def test_a_failed_dns_lookup_is_unreachable_and_a_missing_record_is_empty(self):
        def dig(stdout, code=0):
            return mock.patch.object(cs.subprocess, "run", return_value=subprocess.CompletedProcess(["dig"], code, stdout, ""))

        with dig(";; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 1\n"), self.assertRaises(cs.Unreachable):
            cs.cname("em1027207.isitlegit.co.za")
        with dig("", 9), self.assertRaises(cs.Unreachable):
            cs.cname("em1027207.isitlegit.co.za")
        with dig(";; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 1\n"):
            self.assertEqual(cs.cname("em1027207.isitlegit.co.za"), "")
        answer = (";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\n"
                  "em1027207.isitlegit.co.za. 300 IN CNAME return.smtp2go.net.\n")
        with dig(answer):
            self.assertEqual(cs.cname("em1027207.isitlegit.co.za"), "return.smtp2go.net.")


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
        with mock.patch.object(cs, "SECONDS", 0.2), mock.patch.object(cs.OPENER, "open", return_value=context):
            started = clock.monotonic()
            with self.assertRaises(cs.Unreachable):
                cs.post(KEY, "stats/email_summary")
            self.assertLess(clock.monotonic() - started, 2)
        release.set()


if __name__ == "__main__":
    unittest.main()
