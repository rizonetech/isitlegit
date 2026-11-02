import { describe, expect, it } from "vitest";
import labelsJson from "../../eval/sets/logo-variants/labels.json";
import resultsJson from "../../eval/sets/logo-variants/results.json";

// D03 T03 §5: the variant decision's numbers, recomputed from the saved per-sample judgements.
// If the runner's scoring drifts from this recomputation, or a saved judgement is missing, the
// published rates fail here.
type Judgement = { same: boolean; failed: string | null };
type Row = {
  file: string;
  brand: string;
  shown: string;
  expected_same: boolean;
  wordmark: Judgement;
  icon: Judgement;
};

const rows = resultsJson.results as Row[];

function rates(pick: (row: Row) => boolean) {
  const same = rows.filter((r) => r.expected_same);
  const different = rows.filter((r) => !r.expected_same);
  return {
    trueMatch: same.filter((r) => pick(r)).length,
    trueTotal: same.length,
    falseMatch: different.filter((r) => pick(r)).length,
    falseTotal: different.length,
  };
}

describe("the recorded variant measurement", () => {
  it("holds one saved judgement pair per labelled sample", () => {
    expect(rows).toHaveLength(labelsJson.samples.length);
    for (const label of labelsJson.samples) {
      const row = rows.find((r) => r.file === label.file);
      expect(row, label.file).toBeDefined();
      expect(row?.expected_same).toBe(label.expected_same);
    }
  });

  it("recomputes both policies' rates from the saved judgements", () => {
    const one = rates((r) => r.wordmark.same);
    const two = rates((r) => r.wordmark.same || r.icon.same);
    // The decision rule stated before the run: variants are adopted only when the second
    // reference raises true matches without raising false matches.
    const adopts = two.trueMatch > one.trueMatch && two.falseMatch <= one.falseMatch;
    expect({ one, two, adopts }).toEqual({
      one: { trueMatch: 7, trueTotal: 12, falseMatch: 0, falseTotal: 8 },
      two: { trueMatch: 9, trueTotal: 12, falseMatch: 0, falseTotal: 8 },
      adopts: true,
    });
  });
});
