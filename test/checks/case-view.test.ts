// The protected-identity candidate bound (D02 T01 §9): the set and each list are cut at their bounds with the
// overflow counted, duplicates by organisation removed, so a cut set never reads as an exhaustive no-match.
import { describe, expect, it } from "vitest";
import {
  boundProtectedCandidates,
  MAX_CANDIDATE_DOMAINS,
  MAX_CANDIDATE_NAMES,
  MAX_PROTECTED_CANDIDATES,
} from "../../src/checks/case-view";

const candidate = (orgId: string, names = 1, domains = 1) => ({
  orgId,
  names: Array.from({ length: names }, (_, i) => `${orgId} name ${i}`),
  domains: Array.from({ length: domains }, (_, i) => `${orgId}-${i}.example`),
  logo: null,
});

describe("the protected candidate bound", () => {
  it("keeps an in-bound set whole, with the logo reference and no omissions", () => {
    const out = boundProtectedCandidates([
      { ...candidate("org-a"), logo: { key: "ident/org-a/logo-1.png", mediaType: "image/png" } },
    ]);
    expect(out.omitted).toBe(0);
    expect(out.candidates).toEqual([
      {
        orgId: "org-a",
        names: ["org-a name 0"],
        namesOmitted: 0,
        domains: ["org-a-0.example"],
        domainsOmitted: 0,
        logo: { key: "ident/org-a/logo-1.png", mediaType: "image/png" },
      },
    ]);
    // The candidate's exact keys: nothing beyond the allowlist reaches a check.
    expect(Object.keys(out.candidates[0] as object).sort()).toEqual([
      "domains",
      "domainsOmitted",
      "logo",
      "names",
      "namesOmitted",
      "orgId",
    ]);
  });

  it("cuts an over-bound set and each over-bound list, counting every omission", () => {
    const many = Array.from({ length: MAX_PROTECTED_CANDIDATES + 3 }, (_, i) =>
      candidate(`org-${String(i).padStart(2, "0")}`, MAX_CANDIDATE_NAMES + 2, MAX_CANDIDATE_DOMAINS + 1),
    );
    const out = boundProtectedCandidates(many);
    expect(out.candidates).toHaveLength(MAX_PROTECTED_CANDIDATES);
    expect(out.omitted).toBe(3);
    expect(out.candidates[0]?.names).toHaveLength(MAX_CANDIDATE_NAMES);
    expect(out.candidates[0]?.namesOmitted).toBe(2);
    expect(out.candidates[0]?.domains).toHaveLength(MAX_CANDIDATE_DOMAINS);
    expect(out.candidates[0]?.domainsOmitted).toBe(1);
  });

  it("removes a duplicate organisation and reads an empty input as an empty set", () => {
    const out = boundProtectedCandidates([candidate("org-a"), candidate("org-a")]);
    expect(out.candidates).toHaveLength(1);
    expect(out.omitted).toBe(0);
    expect(boundProtectedCandidates([])).toEqual({ candidates: [], omitted: 0 });
  });
});
