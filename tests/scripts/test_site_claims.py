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


class Repository(unittest.TestCase):
    def test_every_claim_owner_is_a_section_of_the_plan(self):
        claims = owners(CLAIMS.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(claims), 20, "the registry was not read")
        self.assertEqual(problems(claims, tg.graph(REPO)), [])


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

    def test_a_missing_or_malformed_owner_list_refuses(self):
        with self.assertRaisesRegex(ValueError, "no owners list"):
            owners('  "a.one": { text: "One." },\n')
        with self.assertRaisesRegex(ValueError, "malformed owner"):
            owners('  "a.one": { text: "One.", owners: ["D1 T1 §1"] },\n')


if __name__ == "__main__":
    unittest.main()
