import { describe, expect, it } from "vitest";
import { validateCitations } from "../../src/agent/citations";

// D04 T01 §5: the citation validator. A five-item case (E1 to E5); accepting a verdict that cites E99 fails it.
const CASE = new Set(["E1", "E2", "E3", "E4", "E5"]);

describe("validateCitations", () => {
  it("accepts a valid answer and refuses missing, uncited and mismatched citations", () => {
    expect(
      validateCitations(
        {
          cited_evidence_ids: ["E1", "E2"],
          explanation: "The link leads to a sign-in page [E1]. The domain was registered recently [E2].",
        },
        CASE,
      ),
    ).toEqual([]);
    // A declared citation the case does not have.
    expect(validateCitations({ cited_evidence_ids: ["E99"], explanation: "It is a scam [E99]." }, CASE)).toContain(
      "cited E99 is not on the case",
    );
    // No citations at all.
    expect(validateCitations({ cited_evidence_ids: [], explanation: "It is a scam." }, CASE)).toContain(
      "no evidence is cited",
    );
    // A sentence stating a claim with no marker.
    const uncited = validateCitations(
      { cited_evidence_ids: ["E1"], explanation: "The link leads to a sign-in page. It asks for card details [E1]." },
      CASE,
    );
    expect(uncited.some((f) => f.startsWith("a sentence has no citation"))).toBe(true);
    // An inline marker naming no case ID, beside a valid declared citation.
    expect(
      validateCitations({ cited_evidence_ids: ["E1"], explanation: "The bank details changed [E99]." }, CASE),
    ).toContain("the explanation cites E99, which is not on the case");
    // An inline marker the answer never declared.
    expect(
      validateCitations({ cited_evidence_ids: ["E1"], explanation: "The bank details changed [E2]." }, CASE),
    ).toContain("the explanation cites E2, which is not among the declared citations");
  });
});
