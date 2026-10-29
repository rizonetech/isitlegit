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
    # Email Routing's public DKIM key as published (a public key, read back from DNS on 2026-10-29).
    "DKIM": ['"v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiweykoi+o48IOGuP7GR3X0MOExCUDY/BCRHoWBnh3rChl7WhdyCxW3jgq1daEjPPqoi7sJvdg5hEQVsgVRQP4DcnQDVjGMbASQtrY4WmB1VebF+RPJB2ECPsEDTpeiI5ZyUAwJaVX7r6bznU67g7LvFq35yIo4sdlmtZGV+i0H4cpYH9+3JJ78k" "m4KXwaf9xUJCWF6nxeD+qG6Fyruw1Qlbds2r85U9dkNDVAS3gioCvELryh1TxKGiVTkg4wqHTyHfWsp7KD3WQHYJn0RyfJJu6YEmL77zonn7p2SRMvTMP3ZEXibnC9gz3nnhR6wcYL8Q7zXypKTMD58bTixDSJwIDAQAB"'],
    "DEMO_MX": ["9 route2.mx.cloudflare.net.", "32 route3.mx.cloudflare.net.", "56 route1.mx.cloudflare.net."],
    "DEMO_TXT": ['"v=spf1 include:_spf.mx.cloudflare.net ~all"'],
}


class Domain(unittest.TestCase):
    def refused(self, fragment, **override):
        passed, refusals = cd.check({**GOOD, **override})
        self.assertTrue(any(fragment in r for r in refusals), refusals)
        self.assertLess(passed, cd.CHECKS)

    def test_the_recorded_setup_passes(self):
        self.assertEqual(cd.check(GOOD), (cd.CHECKS, []))

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
        self.assertEqual(cd.check(new, nameservers, ds_record), (cd.CHECKS, []))
        passed, refusals = cd.check(new)
        self.assertEqual(passed, cd.CHECKS - 2)
        passed, refusals = cd.check(GOOD, nameservers, ds_record)
        self.assertEqual(passed, cd.CHECKS - 2)
        for ns, ds in (("ns1.only.example", None), ("not a name,x", None), (None, "2371 13 2"), (None, "x y z w")):
            with self.subTest((ns, ds)):
                with self.assertRaises(ValueError):
                    cd.expected(ns, ds)

    def test_diagnose_tells_five_states_apart(self):
        def answering(plain, unchecked):
            def run_dig(args, **kwargs):
                reply = unchecked if "+cd" in args else plain
                if reply == "timeout":
                    raise subprocess.TimeoutExpired("dig", 30)
                if reply == "no-dig":
                    raise OSError(2, "No such file or directory")
                status, ad, count = reply
                out = (f";; ->>HEADER<<- opcode: QUERY, status: {status}, id: 1\n"
                       f";; flags: qr rd ra{' ad' if ad else ''}; QUERY: 1, ANSWER: {count}, AUTHORITY: 0\n")
                return subprocess.CompletedProcess(args, 0, out, "")
            return run_dig

        cases = [
            (("NOERROR", True, 1), ("NOERROR", False, 1), 0, "an authenticated answer"),
            (("NOERROR", False, 1), ("NOERROR", False, 1), 3, "not validated"),
            (("NOERROR", True, 0), ("NOERROR", False, 0), 4, "no SOA"),
            (("NXDOMAIN", False, 0), ("NXDOMAIN", False, 0), 4, "no SOA"),
            (("SERVFAIL", False, 0), ("NOERROR", False, 1), 1, "DNSSEC failure"),
            (("SERVFAIL", False, 0), ("SERVFAIL", False, 0), 2, "do not touch the DS"),
            ("timeout", "timeout", 2, "do not touch the DS"),
            ("no-dig", "no-dig", 2, "a local fault"),
        ]
        for plain, unchecked, code, words in cases:
            with self.subTest((plain, unchecked)):
                got, line = cd.diagnose(answering(plain, unchecked))
                self.assertEqual(got, code, line)
                self.assertIn(words, line)

    def test_a_truncated_or_altered_routing_key_is_refused(self):
        record = GOOD["DKIM"][0]
        key = record[record.index("p=") + 2:].rstrip('"')
        for bad in (key[:-4], key[:-1] + ("A" if key[-1] != "A" else "B"), "M" * len(key), key[:101]):
            with self.subTest(bad[-6:]):
                passed, refusals = cd.check({**GOOD, "DKIM": [record.replace(key, bad)]})
                self.assertTrue(any("DKIM key" in r for r in refusals), refusals)

    def test_an_invalid_routing_dkim_record_is_refused_though_its_key_matches(self):
        record = GOOD["DKIM"][0]
        for bad in (record.replace("v=DKIM1", "v=DKIM11"), record.replace("k=rsa", "k=ed25519"),
                    record.replace("h=sha256;", "h=sha256; h=sha1;"), record.rstrip('"') + '; p=AAAA"',
                    record.replace("v=DKIM1; ", "") .replace("h=sha256;", "h=sha256; v=DKIM1;"),
                    record.replace("h=sha256", "h=sha25"), record.replace("k=rsa;", "k=rsa; s=mail;"),
                    record.replace("; k=rsa", ";  k=rsa")):
            with self.subTest(bad[:40]):
                passed, refusals = cd.check({**GOOD, "DKIM": [bad]})
                self.assertTrue(any("DKIM key" in r for r in refusals), refusals)

    def test_the_demo_subdomain_must_route_through_email_routing(self):
        for change in ({"DEMO_MX": []}, {"DEMO_MX": GOOD["DEMO_MX"][:2]}, {"DEMO_TXT": []},
                       {"DEMO_TXT": ['"v=spf1 -all"']}):
            with self.subTest(change):
                passed, refusals = cd.check({**GOOD, **change})
                self.assertTrue(any("demo.isitlegit.co.za" in r for r in refusals), refusals)

    def test_reviewed_values_are_validated_before_any_lookup(self):
        for ns, ds in (
            ("a.example,a.example", None),
            (None, "99999 13 2 " + "AB" * 32),
            (None, "2371 999 2 " + "AB" * 32),
            (None, "2371 13 2 " + "AB" * 20),
            (None, "2371 13 1 " + "AB" * 32),
            (None, "2371 13 3 " + "AB" * 32),
        ):
            with self.subTest((ns, ds)):
                with self.assertRaises(ValueError):
                    cd.expected(ns, ds)
        self.assertEqual(cd.expected(None, "2371 13 1 " + "AB" * 20)[1][2], "1")

    def test_the_runbook_keeps_its_safety_order(self):
        text = (REPO / "docs/operations.md").read_text(encoding="utf-8")
        section = text[text.index("## Domain recovery"):]
        b = section[section.index("### (b)"):section.index("### (c)")]
        self.assertLess(b.index("--diagnose"), b.index("Pull the DS"))
        a = section[section.index("### (a)"):section.index("### (b)")]
        self.assertLess(a.index("Remove the DS"), a.index("Move the nameservers"))
        self.assertLess(a.index("Move the nameservers"), a.index("Sign the zone"))
        self.assertIn("Roll back", a)
        e = section[section.index("### (e)"):]
        self.assertLess(e.index("revoke it first"), e.index("Create a new key"))
        self.assertLess(e.index("in the vault"), e.index("secret put"))
        self.assertLess(e.index("secret put"), e.index("serving Worker"))
        # Reversal by the step reached: the old DS restored, and a new provider's DS pulled before the old delegation.
        self.assertIn("publish the old DS again", a)
        self.assertLess(a.index("pull any DS step 6 published"), a.index("then publish the old DS again"))
        # Each cache waited out before the next change: the new DS gone before the old delegation, which comes back
        # before the old DS.
        self.assertLess(a.index("wait twice the DS TTL"), a.index("set the old nameservers back"))
        self.assertLess(a.index("wait twice the NS TTL"), a.index("only then publish the old DS again"))
        # Records first, needing no key; the key's permissions include what the checker reads first.
        self.assertLess(e.index("Sender-domain records removed"), e.index("revoke it first"))
        self.assertIn("/stats/email_summary", e)
        # A records-only fault changes no credential.
        self.assertIn("changes no credential", e)
        d = section[section.index("### (d)"):section.index("### (e)")]
        self.assertIn("add", d.lower())
        for procedure in ("### (a)", "### (b)", "### (c)", "### (d)", "### (e)"):
            part = section[section.index(procedure):]
            nxt = part.find("### (", 5)
            self.assertIn("check-domain.py", part[: nxt if nxt > 0 else len(part)], procedure)

class Progress(unittest.TestCase):
    def test_each_lookup_is_announced_before_it_starts(self):
        said, asked = [], []

        def lookup(kind, name=cd.DOMAIN, flags=False):
            asked.append((len(said), kind, name))
            return ({"NS": GOOD["NS"], "MX": GOOD["MX"], "CAA": GOOD["CAA"], "DS": GOOD["DS"]}.get(kind)
                    or (GOOD["DMARC"] if name.startswith("_dmarc") else GOOD["DKIM"] if "domainkey" in name
                        else GOOD["TXT"]), GOOD["flags"])

        code, lines = cd.run(lookup, say=said.append)
        self.assertEqual(code, 0, lines)
        # One announcement for each lookup, and the n-th lookup starts after the n-th announcement.
        self.assertEqual(len(said), len(asked))
        self.assertEqual([n for n, *_ in asked], list(range(1, len(asked) + 1)))


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
