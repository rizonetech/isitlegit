"""scripts/check-smtp2go.py (D99 T01 §4): passes only for a live, narrowed key and SMTP2GO's DNS, never printing the key."""
import importlib.util
import pathlib
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_smtp2go", REPO / "scripts/check-smtp2go.py")
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

KEY = "api-" + "k" * 32
DENIED = (400, {"error_code": cs.DENIED})


def smtp2go(stats=(200, {"cycle_max": 20000}), domain=DENIED, users=DENIED):
    answers = {"stats/email_summary": stats, "domain/view": domain, "users/smtp/view": users}
    return lambda key, endpoint: answers[endpoint]


def dns(**override):
    return lambda name: {**cs.CNAMES, **override}.get(name, "")


class Smtp2go(unittest.TestCase):
    def run_check(self, read=lambda: KEY, call=None, lookup=None):
        code, line = cs.check(read=read, call=call or smtp2go(), lookup=lookup or dns())
        self.assertNotIn(KEY, line)
        return code, line

    def test_a_live_narrowed_key_with_its_dns_passes(self):
        self.assertEqual(self.run_check()[0], 0)

    def test_a_placeholder_is_refused_before_any_call(self):
        calls = []
        for value in ("", "placeholder", "api-short"):
            with self.subTest(value):
                code, line = cs.check(read=lambda v=value: v, call=lambda k, e: calls.append(e), lookup=dns())
                self.assertEqual(code, 1)
        self.assertEqual(calls, [])

    def test_an_invalid_or_revoked_key_is_refused(self):
        self.assertEqual(self.run_check(call=smtp2go(stats=(401, {"error": "invalid"})))[0], 1)

    def test_an_unnarrowed_key_is_refused(self):
        for over in ({"domain": (200, {"domains": []})}, {"users": (200, {"results": []})}):
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


if __name__ == "__main__":
    unittest.main()
