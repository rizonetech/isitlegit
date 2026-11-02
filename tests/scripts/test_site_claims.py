"""site/src/lib/claims.ts: every product claim on the marketing site names at least one owning section, and every owner is
a real section of the plan (D07 T06 §3). It reads the graph in-process, once, in the Project script tests job, which has
the full history the graph validates stamps against; the site's own test checks the claims' content on the pages."""
import pathlib
import re
import sys
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "lib"))
import todo_graph as tg  # noqa: E402

CLAIMS = REPO / "site" / "src" / "lib" / "claims.ts"
REF = re.compile(r"D\d{2} T\d{2} §[1-9]\d*")


def owners(source):
    """{claim id: [owner refs]} from the registry's source, refusing an entry whose owners list is missing or not refs."""
    found = {}
    for match in re.finditer(r'^\s+"([\w.]+)":\s*\{(.*?)\},?$', source, re.M | re.S):
        claim_id, body = match.group(1), match.group(2)
        listed = re.search(r"owners:\s*\[([^\]]*)\]", body)
        if not listed:
            raise ValueError(f"claim {claim_id} has no owners list")
        refs = re.findall(r'"([^"]*)"', listed.group(1))
        bad = [ref for ref in refs if not REF.fullmatch(ref)]
        if bad:
            raise ValueError(f"claim {claim_id} names a malformed owner: {bad}")
        found[claim_id] = refs
    return found


def problems(claims, sections):
    """Every claim with no owner, and every owner that is not a section of the plan."""
    out = [f"{claim_id} names no owner" for claim_id, refs in claims.items() if not refs]
    out += [f"{claim_id}: {ref} is not a section" for claim_id, refs in claims.items() for ref in refs if ref not in sections]
    return out


# The sections each privacy claim must name, so an unrelated valid owner cannot stand in (D07 T06 §5).
REQUIRED = {
    "privacy.summary": {"D00 T01 §5", "D01 T01 §2", "D03 T01 §1"},
    "privacy.what.mail": {"D01 T01 §3", "D01 T03 §1"},
    "privacy.what.account": {"D07 T02 §3"},
    "privacy.closure": {"D07 T02 §9"},
    "privacy.what.ledger": {"D06 T01 §1", "D06 T01 §3", "D06 T01 §4"},
    "privacy.what.feedback": {"D07 T03 §6"},
    "privacy.what.security": {"D07 T02 §6"},
    "privacy.what.members": {"D01 T01 §3"},
    "privacy.training": {"D03 T04 §11", "D03 T04 §7"},
    "privacy.screening": {"D05 T04 §3"},
    "privacy.keep.raw": {"D00 T01 §5", "D01 T01 §2"},
    "privacy.keep.derived": {"D01 T01 §2"},
    "privacy.keep.case": {"D01 T01 §2", "D07 T02 §9"},
    "privacy.keep.links": {"D01 T01 §8"},
    "privacy.keep.security": {"D07 T02 §6"},
    "privacy.keep.account": {"D07 T02 §9", "D06 T01 §4"},
    "privacy.p.cloudflare": {"D01 T01 §2"},
    "privacy.p.meta": {"D03 T01 §1"},
    "privacy.p.smtp2go": {"D01 T02 §1"},
    "privacy.p.webrisk": {"D02 T06 §1"},
    "privacy.p.fireworks": {"D03 T04 §11", "D03 T04 §7"},
    "privacy.protected": {"D05 T01 §2", "D05 T02 §1"},
    "protect.answer": {"D05 T01 §1", "D05 T02 §2", "D05 T02 §3", "D05 T02 §4", "D05 T04 §2"},
    "protect.identity": {"D05 T01 §1", "D05 T01 §2", "D05 T01 §3", "D05 T02 §2", "D05 T02 §3", "D05 T02 §4"},
    "protect.seal": {"D05 T02 §6", "D05 T02 §9"},
    "protect.badge": {"D05 T02 §7", "D05 T02 §8"},
    "protect.monitor": {"D05 T04 §1", "D05 T04 §2", "D05 T04 §3", "D05 T04 §5"},
    "protect.bank": {"D05 T03 §1", "D05 T01 §2", "D05 T02 §1"},
    "terms.service": {"D01 T01 §3", "D01 T03 §1", "D01 T03 §4", "D04 T01 §4", "D05 T01 §1", "D05 T01 §2", "D05 T01 §3"},
    "terms.you.mail": {"D01 T01 §3", "D01 T03 §1", "D07 T02 §5"},
    "terms.you.authority": {"D05 T01 §1", "D05 T01 §2", "D05 T01 §3"},
    "terms.you.limits": {"D07 T02 §4", "D07 T08 §8"},
    "terms.protect.bank": {"D05 T01 §2", "D05 T02 §1", "D05 T03 §1"},
    "terms.limits.partial": {"D03 T01 §2", "D04 T01 §5", "D07 T02 §4", "D07 T08 §8"},
    "security.safeguards.untrusted": {"D01 T02 §2", "D02 T05 §1", "D03 T01 §6"},
    "security.safeguards.floor": {"D04 T01 §1"},
    "security.safeguards.citations": {"D04 T01 §2", "D04 T01 §5"},
    "security.safeguards.walkthrough": {"D04 T02 §2", "D04 T02 §3", "D04 T02 §4"},
    "security.safeguards.zod": {"D03 T01 §5", "D04 T01 §3", "D04 T01 §4"},
    "security.safeguards.store": {"D03 T01 §1"},
    "security.intro": {"D03 T01 §6", "D04 T01 §1", "D04 T02 §2"},
    "about.purpose": {"D05 T01 §2", "D05 T02 §2", "D01 T03 §1"},
    "security.data.bank": {"D05 T01 §2", "D05 T02 §1"},
    "security.data.reports": {"D01 T01 §8"},
    "security.data.tenancy": {"D01 T01 §2", "D05 T01 §1", "D06 T01 §4", "D07 T02 §3"},
    "security.data.retention": {"D00 T01 §5", "D01 T01 §2"},
    "security.data.auth": {"D07 T02 §1", "D07 T02 §2"},
    "about.built.models": {"D01 T03 §4", "D03 T02 §3", "D03 T03 §3", "D03 T04 §11", "D04 T01 §4", "D04 T02 §4", "D05 T04 §3"},
}


def missing_required(claims, required=REQUIRED):
    """Every required owner a claim does not name, as 'claim: ref'."""
    return [f"{claim_id}: {ref}" for claim_id, refs in required.items() for ref in sorted(refs - set(claims.get(claim_id, [])))]


class Repository(unittest.TestCase):
    def test_every_claim_owner_is_a_section_of_the_plan(self):
        claims = owners(CLAIMS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(claims), 20, "the registry was not read")
        self.assertEqual(problems(claims, tg.graph(REPO)), [])

    def test_the_privacy_claims_name_the_sections_that_make_them_true(self):
        self.assertEqual(missing_required(owners(CLAIMS.read_text(encoding="utf-8"))), [])

    def test_the_invoice_closing_names_extraction_matching_and_the_ledger(self):
        # Proven-only (D07 T06 §20, review round 4): the automatic-comparison promise needs extraction (§1) and
        # matching (§3), not only the ledger page (§4); reverting either owner must fail.
        claims = owners(CLAIMS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(set(claims.get("invoice.closing", [])), {"D06 T01 §1", "D06 T01 §3", "D06 T01 §4"})

    def test_every_privacy_claim_has_a_required_owner_set(self):
        privacy = {
            claim_id
            for claim_id in owners(CLAIMS.read_text(encoding="utf-8"))
            if claim_id.startswith(("privacy.", "protect.", "terms.", "security.", "about."))
        }
        self.assertEqual(sorted(privacy - set(REQUIRED)), [], "a privacy claim with no required owner set")
        self.assertEqual(sorted(set(REQUIRED) - privacy), [], "a required owner set for a claim that is not in the registry")


class Defects(unittest.TestCase):
    SOURCE = '''export const claims = {
  "a.one": { text: "One.", owners: ["D01 T01 §1"] },
  "a.two": {
    text: "Two.",
    owners: ["D01 T01 §1", "D02 T03 §4"],
  },
} as const;
'''

    def test_the_registry_is_read_with_every_owner(self):
        self.assertEqual(owners(self.SOURCE), {"a.one": ["D01 T01 §1"], "a.two": ["D01 T01 §1", "D02 T03 §4"]})

    def test_an_unknown_section_is_caught(self):
        self.assertEqual(problems({"a.one": ["D01 T01 §99"]}, {"D01 T01 §1": {}}), ["a.one: D01 T01 §99 is not a section"])

    def test_a_claim_with_no_owner_is_caught(self):
        self.assertEqual(problems({"a.one": []}, {}), ["a.one names no owner"])

    def test_an_unrelated_owner_in_place_of_a_required_one_is_caught(self):
        self.assertEqual(missing_required({"privacy.keep.raw": ["D01 T01 §2", "D99 T01 §1"]}, {"privacy.keep.raw": {"D00 T01 §5", "D01 T01 §2"}}),
                         ["privacy.keep.raw: D00 T01 §5"])
        self.assertEqual(missing_required({}, {"privacy.keep.raw": {"D01 T01 §2"}}), ["privacy.keep.raw: D01 T01 §2"])

    def test_a_privacy_claim_without_a_required_set_is_caught(self):
        privacy = {"privacy.new", "privacy.keep.raw"}
        self.assertEqual(sorted(privacy - set(REQUIRED)), ["privacy.new"])

    def test_a_missing_or_malformed_owner_list_refuses(self):
        with self.assertRaisesRegex(ValueError, "no owners list"):
            owners('  "a.one": { text: "One." },\n')
        with self.assertRaisesRegex(ValueError, "malformed owner"):
            owners('  "a.one": { text: "One.", owners: ["D1 T1 §1"] },\n')


if __name__ == "__main__":
    unittest.main()
