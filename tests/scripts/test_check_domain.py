"""scripts/check-domain.py (D99 T01 §2): the live setup passes; each weakened record and each failed lookup is refused."""
import importlib.util
import pathlib
import subprocess
import unittest
from unittest import mock

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_domain", REPO / "scripts/check-domain.py")
cd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cd)

GOOD = {
    "NS": ["carmelo.ns.cloudflare.com.", "paris.ns.cloudflare.com."],
    "MX": ["32 route3.mx.cloudflare.net.", "56 route1.mx.cloudflare.net.", "9 route2.mx.cloudflare.net."],
    "TXT": ['"v=spf1 include:_spf.mx.cloudflare.net ~all"', '"some-site-verification=abc"'],
    "DMARC": ['"v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; fo=1; rua=mailto:dmarc@isitlegit.co.za"'],
    "CAA": ['0 issue "letsencrypt.org"', '0 issue "pki.goog; cansignhttpexchanges=yes"', '0 issue "ssl.com"',
            '0 issue "comodoca.com"', '0 issue "digicert.com; cansignhttpexchanges=yes"', '0 issuewild "letsencrypt.org"'],
    "DS": ["2371 13 2 360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B7239 28504665"],
    "flags": ";; flags: qr rd ra ad; QUERY: 1, ANSWER: 0, AUTHORITY: 4, ADDITIONAL: 1",
}


class Domain(unittest.TestCase):
    def refused(self, fragment, **override):
        passed, refusals = cd.check({**GOOD, **override})
        self.assertTrue(any(fragment in r for r in refusals), refusals)
        self.assertLess(passed, cd.CHECKS)

    def test_the_recorded_setup_passes(self):
        self.assertEqual(cd.check(GOOD), (7, []))

    def test_wrong_nameservers_or_mx_are_refused(self):
        self.refused("nameservers", NS=["ns1.example.net."])
        self.refused("MX hosts", MX=[])

    def test_spf_must_be_one_record_reaching_the_include(self):
        self.refused("SPF", TXT=['"v=spf1 -all"'])
        self.refused("SPF", TXT=['"v=spf1 -all include:_spf.mx.cloudflare.net"'])
        self.refused("2 SPF records", TXT=GOOD["TXT"] + ['"v=spf1 include:_spf.mx.cloudflare.net -all"'])
        self.refused("SPF", TXT=['"v=spf1 include:_spf.mx.cloudflare.net ip4:203.0.113.0/24 ~all"'])
        for closing in ("+all", "?all", "all", ""):
            with self.subTest(closing):
                self.refused("SPF", TXT=[f'"v=spf1 include:_spf.mx.cloudflare.net {closing}"'.replace(" \"", "\"")])
        self.assertEqual(cd.check({**GOOD, "TXT": ['"v=spf1 include:_spf.mx" ".cloudflare.net ~all"']})[1], [])
        self.refused("SPF", TXT=['"v=spf1  include:_spf.mx.cloudflare.net ~all"'])

    def test_dmarc_must_be_one_reject_record_reporting_only_to_dmarc_at(self):
        self.refused("DMARC", DMARC=['"v=DMARC1; p=none; sp=reject; rua=mailto:dmarc@isitlegit.co.za"'])
        self.refused("2 DMARC records", DMARC=GOOD["DMARC"] * 2)
        self.refused("DMARC", DMARC=['"v=DMARC1; p=reject; rua=mailto:dmarc@isitlegit.co.za.example.net"'])
        self.refused("DMARC", DMARC=['"v=DMARC1; p=reject; rua=mailto:dmarc@isitlegit.co.za,mailto:x@example.net"'])
        self.refused("DMARC", DMARC=[])
        self.refused("DMARC", DMARC=['"v=DMARC11; p=reject; rua=mailto:dmarc@isitlegit.co.za"'])
        self.refused("DMARC", DMARC=['"v=DMARC1; p=reject; pct=0; rua=mailto:dmarc@isitlegit.co.za"'])
        self.refused("DMARC", DMARC=['"v=DMARC1; p=reject; pct=50; rua=mailto:dmarc@isitlegit.co.za"'])
        self.refused("DMARC", DMARC=[GOOD["DMARC"][0][:-1] + '; ruf=mailto:hello@isitlegit.co.za"'])
        self.refused("DMARC", DMARC=[GOOD["DMARC"][0][:-1] + '; pct=100"'])
        self.refused("DMARC", DMARC=[GOOD["DMARC"][0].replace("sp=reject", "sp=none")])
        self.refused("DMARC", DMARC=[GOOD["DMARC"][0][:-1] + '; p=none"'])
        self.refused("DMARC", DMARC=['"v=DMARC1; sp=reject; p=reject; adkim=r; aspf=r; fo=1; rua=mailto:dmarc@isitlegit.co.za"'])
        self.refused("DMARC", DMARC=['"p=reject; v=DMARC1; sp=reject; adkim=r; aspf=r; fo=1; rua=mailto:dmarc@isitlegit.co.za"'])
        self.assertEqual(cd.check({**GOOD, "DMARC": [GOOD["DMARC"][0][:-1] + ';"']})[1], [])
        for bad in ("v=DMARC1;; p=reject", "v=DMARC1; =; p=reject", "v=DMARC1;  p=reject", "V=DMARC1; p=reject"):
            with self.subTest(bad):
                self.refused("DMARC", DMARC=[GOOD["DMARC"][0].replace("v=DMARC1; p=reject", bad)])

    def test_caa_issue_not_issuewild_from_universal_ssl_only(self):
        self.refused("CAA", CAA=[line.replace(" issue ", " issuewild ") for line in GOOD["CAA"]])
        self.refused("CAA", CAA=GOOD["CAA"] + ['0 issue "evil-ca.example"'])
        self.refused("CAA", CAA=['0 issue "comodoca.com"'])
        self.refused("CAA", CAA=GOOD["CAA"] + ['0 issuewild "amazon.com"'])

    def test_a_missing_or_different_ds_or_unvalidated_zone_is_refused(self):
        self.refused("DS record", DS=[])
        self.refused("DS record", DS=["2371 13 2 00"])
        self.refused("ad flag", flags=";; flags: qr rd ra; QUERY: 1")
        self.refused("ad flag", flags=";; flags: qr rd ra; QUERY: 1, ANSWER: 0, ADDITIONAL: 1 (ad)")

    def test_a_failed_lookup_is_reported_as_one_not_as_wrong_records(self):
        for reason in ("dig exited 9 (connection refused)", "the resolver answered SERVFAIL", "no answer within 30 s"):
            with self.subTest(reason):
                def lookup(*args, reason=reason):
                    raise cd.LookupFailed(reason)

                code, lines = cd.run(lookup)
                self.assertEqual(code, 2)
                self.assertEqual(len(lines), 1)
                self.assertIn("a lookup failed, so nothing was judged", lines[0])


class Dig(unittest.TestCase):
    """dig() itself: what the subprocess reports becomes LookupFailed, and run() exits 2 on it."""

    def lookup_fails(self, effect, fragment):
        with mock.patch.object(cd.subprocess, "run", side_effect=effect):
            with self.assertRaises(cd.LookupFailed) as ctx:
                cd.dig("NS")
            self.assertIn(fragment, str(ctx.exception))
            code, lines = cd.run()
            self.assertEqual(code, 2)
            self.assertIn("a lookup failed", lines[0])

    def test_a_timeout_a_failed_dig_and_a_servfail_are_lookup_failures(self):
        self.lookup_fails(subprocess.TimeoutExpired("dig", 30), "no answer within 30 s")
        self.lookup_fails(lambda *a, **k: subprocess.CompletedProcess(a[0], 9, "", ";; connection refused"),
                          "dig exited 9")
        servfail = ";; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 1\n;; flags: qr rd ra; QUERY: 1\n"
        self.lookup_fails(lambda *a, **k: subprocess.CompletedProcess(a[0], 0, servfail, ""), "SERVFAIL")
        self.lookup_fails(lambda *a, **k: subprocess.CompletedProcess(a[0], 0, "", ""), "no DNS response header")
        self.lookup_fails(OSError(2, "No such file or directory"), "dig could not run")

    def test_an_answer_is_read_from_the_answer_section(self):
        out = (";; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\n;; flags: qr rd ra ad; QUERY: 1, ANSWER: 2\n"
               "isitlegit.co.za. 300 IN NS carmelo.ns.cloudflare.com.\nisitlegit.co.za. 300 IN NS paris.ns.cloudflare.com.\n")
        with mock.patch.object(cd.subprocess, "run", return_value=subprocess.CompletedProcess(["dig"], 0, out, "")):
            rdata, flags = cd.dig("NS")
        self.assertEqual(rdata, ["carmelo.ns.cloudflare.com.", "paris.ns.cloudflare.com."])
        self.assertIn(" ad;", flags)


if __name__ == "__main__":
    unittest.main()
