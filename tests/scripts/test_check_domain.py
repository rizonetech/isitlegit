"""scripts/check-domain.py (D99 T01 §2): the live setup passes, and each missing or wrong record is refused."""
import importlib.util
import pathlib
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_domain", REPO / "scripts/check-domain.py")
cd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cd)

GOOD = {
    "NS": ["carmelo.ns.cloudflare.com.", "paris.ns.cloudflare.com."],
    "MX": ["32 route3.mx.cloudflare.net.", "56 route1.mx.cloudflare.net.", "9 route2.mx.cloudflare.net."],
    "SPF": ['"v=spf1 include:_spf.mx.cloudflare.net ~all"'],
    "DMARC": ['"v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; fo=1; rua=mailto:dmarc@isitlegit.co.za"'],
    "CAA": ['0 issue "letsencrypt.org"', '0 issue "pki.goog; cansignhttpexchanges=yes"', '0 issue "ssl.com"',
            '0 issue "comodoca.com"', '0 issue "digicert.com; cansignhttpexchanges=yes"'],
    "DS": ["2371 13 2 360CD8AC177997F22F9239EF3EB686AAAEDF101C211B330C684B7239 28504665"],
    "flags": ";; flags: qr rd ra ad; QUERY: 1, ANSWER: 0, AUTHORITY: 4, ADDITIONAL: 1",
}


class Domain(unittest.TestCase):
    def refused(self, fragment, **override):
        passed, refusals = cd.check({**GOOD, **override})
        self.assertTrue(any(fragment in r for r in refusals), refusals)
        self.assertLess(passed, 7)

    def test_the_recorded_setup_passes(self):
        self.assertEqual(cd.check(GOOD), (7, []))

    def test_wrong_nameservers_or_missing_mail_records_are_refused(self):
        self.refused("nameservers", NS=["ns1.example.net."])
        self.refused("MX hosts", MX=[])
        self.refused("SPF", SPF=['"v=spf1 -all"'])

    def test_a_weaker_dmarc_is_refused(self):
        self.refused("DMARC", DMARC=['"v=DMARC1; p=none; rua=mailto:dmarc@isitlegit.co.za"'])
        self.refused("DMARC", DMARC=[])

    def test_caa_outside_universal_ssl_or_without_its_three_is_refused(self):
        self.refused("CAA", CAA=GOOD["CAA"] + ['0 issue "evil-ca.example"'])
        self.refused("CAA", CAA=['0 issue "comodoca.com"'])
        self.refused("CAA", CAA=[])

    def test_a_missing_or_different_ds_or_unvalidated_zone_is_refused(self):
        self.refused("DS record", DS=[])
        self.refused("DS record", DS=["2371 13 2 00"])
        self.refused("ad flag", flags=";; flags: qr rd ra; QUERY: 1")


if __name__ == "__main__":
    unittest.main()
