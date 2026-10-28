"""scripts/check-partner-credits.py (D99 T01 §7): every malformed record the reviews found is refused, the real file passes."""
import importlib.util
import pathlib
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("check_partner_credits", REPO / "scripts/check-partner-credits.py")
cpc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpc)

GOOD = {
    "Fireworks": "Partner credit Fireworks: granted, 2026-10-28 (US$100 loaded; used: operator decision, Loupe screens pages)",
    "Baseten": "Partner credit Baseten: granted, 2026-10-27 (US$100 of Spark Open; not used: operator decision, closed)",
    "Modal": "Partner credit Modal: granted, 2026-10-28 (US$30 a month; not used: operator decision, Modal stays closed)",
}


def text(**override):
    lines = {**GOOD, **override}
    return "# Records\n\n" + "\n".join(line for line in lines.values() if line is not None) + "\n"


class PartnerCredits(unittest.TestCase):
    def refused(self, fragment, **override):
        found, refusals = cpc.check(text(**override))
        self.assertTrue(any(fragment in r for r in refusals), refusals)
        self.assertLess(len(found), 3)

    def test_the_three_good_records_pass(self):
        self.assertEqual(cpc.check(text()), ({name: line for name, line in GOOD.items()}, []))

    def test_the_repository_records_pass(self):
        found, refusals = cpc.check(cpc.RECORDS.read_text(encoding="utf-8"))
        self.assertEqual((len(found), refusals), (3, []))

    def test_an_impossible_date_is_refused(self):
        self.refused("is not a calendar date", Modal=GOOD["Modal"].replace("2026-10-28", "2026-99-99"))
        self.refused("is not a calendar date", Modal=GOOD["Modal"].replace("2026-10-28", "2026-02-30"))

    def test_two_usage_decisions_are_refused_however_spelled(self):
        for extra in ("; used: to use it", "; not used : closed it", "; Not Used: closed"):
            with self.subTest(extra):
                self.refused("usage decisions", Fireworks=GOOD["Fireworks"][:-1] + extra + ")")

    def test_placeholder_coverage_or_decision_is_refused(self):
        self.refused("must say something", Baseten="Partner credit Baseten: granted, 2026-10-27 (-; not used: x)")
        self.refused("must say something", Modal="Partner credit Modal: granted, 2026-10-28 ( ; not used:  )")

    def test_the_wrong_usage_is_refused(self):
        self.refused("must be used", Fireworks=GOOD["Fireworks"].replace("; used:", "; not used:"))
        self.refused("must be not used", Modal=GOOD["Modal"].replace("; not used:", "; used:"))

    def test_a_missing_duplicate_or_unknown_record_is_refused(self):
        self.refused("no record for Baseten", Baseten=None)
        found, refusals = cpc.check(text() + GOOD["Fireworks"] + "\n")
        self.assertTrue(any("a second record for Fireworks" in r for r in refusals))
        found, refusals = cpc.check(text() + "Partner credit Acme: granted, 2026-10-28 (x; used: y)\n")
        self.assertTrue(any("not a partner provider" in r for r in refusals))

    def test_an_unknown_outcome_is_refused(self):
        self.refused("the outcome must be one of", Modal=GOOD["Modal"].replace("granted,", "maybe,"))


if __name__ == "__main__":
    unittest.main()
