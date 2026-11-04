import { describe, expect, it, vi } from "vitest";

// Exercise the caller's complete Technique contract without expanding the candidate generator.
// The current single-character generator need not naturally produce a three-accent variant.
vi.mock("../../src/checks/domain-lookalike", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/checks/domain-lookalike")>();
  return {
    ...actual,
    techniqueOf: (
      candidate: Parameters<typeof actual.techniqueOf>[0],
      target: Parameters<typeof actual.techniqueOf>[1],
    ) => (candidate.domain === "abcdef-payments.co.za" ? "accent-fold" : actual.techniqueOf(candidate, target)),
  };
});

import { split, techniqueOf } from "../../src/checks/domain-lookalike";
import { candidatesFor, MAX_CANDIDATES } from "../../src/monitor/candidates";

describe("monitor caller technique contract", () => {
  it("ranks accent folding after every existing technique without changing generation or the cap", () => {
    const target = split("abcdef.co.za");
    if (!target) throw new Error("Invalid test target");
    const candidates = candidatesFor("abcdef.co.za");
    expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(candidates).toContain("abcdef-payments.co.za");
    expect(candidates.at(-1)).toBe("abcdef-payments.co.za");
    const ranks = { "different-tld": 0, "added-word": 1, skeleton: 2, edit: 3, "accent-fold": 4 };
    const observed = candidates.map((domain) => {
      const candidate = split(domain);
      if (!candidate) throw new Error("Invalid generated candidate");
      const technique = techniqueOf(candidate, target);
      if (!technique) throw new Error("Unrecognized generated candidate");
      return ranks[technique];
    });
    expect(observed).toContain(3);
    expect(observed).toEqual([...observed].sort((a, b) => a - b));
    expect(candidatesFor("abcdef.co.za")).toEqual(candidates);
  });
});
