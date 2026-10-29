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
    "DKIM": ['"v=DKIM1; h=sha256; k=rsa; p=' + "M" * 120 + '"'],
}


class Domain(unittest.TestCase):
    def refused(self, fragment, **override):
        passed, refusals = cd.check({**GOOD, **override})
        self.assertTrue(any(fragment in r for r in refusals), refusals)
        self.assertLess(passed, cd.CHECKS)

    def test_the_recorded_setup_passes(self):
        self.assertEqual(cd.check(GOOD), (8, []))

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
        self.refused("CAA", CAA=GOOD["CAA"] + ['0 issue "sectigo.com"'])

    def test_a_missing_or_different_ds_or_unvalidated_zone_is_refused(self):
        self.refused("DS set", DS=[])
        self.refused("DS set", DS=["2371 13 2 00"])
        self.refused("DS set", DS=GOOD["DS"] + ["9999 13 2 AAAA"])
        self.refused("DS set", DS=GOOD["DS"] + ["2371 13 1 0123456789ABCDEF0123456789ABCDEF01234567"])
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


class Recovery(unittest.TestCase):
    """D99 T01 §9: the runbook's states as check-domain reads them."""

    def test_email_routing_dkim_must_be_one_published_key(self):
        for dkim in ([], ['"v=DKIM1; p="'], GOOD["DKIM"] * 2, ['"not a key"']):
            with self.subTest(dkim):
                passed, refusals = cd.check({**GOOD, "DKIM": dkim})
                self.assertTrue(any("DKIM key" in r for r in refusals), refusals)

    def test_a_move_in_progress_is_named_not_passed(self):
        # The DS pulled at the registry, the zone unsigned: two named refusals, never a pass.
        passed, refusals = cd.check({**GOOD, "DS": [], "flags": ";; flags: qr rd ra; QUERY: 1"})
        self.assertEqual(passed, cd.CHECKS - 2)
        self.assertTrue(any("unsigned at the registry" in r for r in refusals), refusals)
        self.assertTrue(any("ad flag" in r for r in refusals), refusals)

    def test_a_planned_move_is_checked_against_its_reviewed_values_and_stale_ones_refused(self):
        new = {**GOOD, "NS": ["ns1.newdns.example.", "ns2.newdns.example."], "DS": ["4242 13 2 " + "AB" * 32]}
        nameservers, ds_record = cd.expected("ns1.newdns.example,ns2.newdns.example", "4242 13 2 " + "ab" * 32)
        self.assertEqual(cd.check(new, nameservers, ds_record), (8, []))
        passed, refusals = cd.check(new)
        self.assertEqual(passed, 6)
        passed, refusals = cd.check(GOOD, nameservers, ds_record)
        self.assertEqual(passed, 6)
        for ns, ds in (("ns1.only.example", None), ("not a name,x", None), (None, "2371 13 2"), (None, "x y z w")):
            with self.subTest((ns, ds)):
                with self.assertRaises(ValueError):
                    cd.expected(ns, ds)

    def test_diagnose_tells_a_dnssec_failure_from_an_outage(self):
        def answering(plain, unchecked):
            def run_dig(args, **kwargs):
                status = unchecked if "+cd" in args else plain
                if status is None:
                    raise subprocess.TimeoutExpired("dig", 30)
                return subprocess.CompletedProcess(args, 0, f";; ->>HEADER<<- opcode: QUERY, status: {status}, id: 1\n", "")
            return run_dig

        self.assertEqual(cd.diagnose(answering("NOERROR", "NOERROR"))[0], 0)
        code, line = cd.diagnose(answering("SERVFAIL", "NOERROR"))
        self.assertEqual(code, 1)
        self.assertIn("DNSSEC failure", line)
        for plain, unchecked in (("SERVFAIL", "SERVFAIL"), (None, None), ("SERVFAIL", None)):
            with self.subTest((plain, unchecked)):
                code, line = cd.diagnose(answering(plain, unchecked))
                self.assertEqual(code, 2)
                self.assertIn("do not touch the DS", line)


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
