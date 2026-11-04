// The ai_instructions and RESULTS merge measurements (D08 T02 sections 8 and 3/5/8).
import { describe, expect, it } from "vitest";
import { scoreAiInstructions } from "../../eval/ai-instructions.ts";
import { ABLATION_HEADING, COMPONENTS_HEADING, mergeResultsSection } from "../../eval/results-file.ts";

describe("ai_instructions measurement", () => {
  it("scores the reproducible corpus through the real phrase scanner", () => {
    const s = scoreAiInstructions();
    expect(s.injections).toBe(4);
    expect(s.genuine).toBe(4);
    expect(s.missed).toEqual([]);
    expect(s.flagged).toEqual([]);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });
});

describe("the RESULTS.md merge contract", () => {
  it("merges keyed sections without replacing another section's rows", () => {
    const start = mergeResultsSection("", COMPONENTS_HEADING, "| Result cache | x |");
    const both = mergeResultsSection(start, ABLATION_HEADING, "| Model removed | y |");
    expect(both).toContain("| Result cache | x |");
    expect(both).toContain("| Model removed | y |");
    const updated = mergeResultsSection(both, COMPONENTS_HEADING, "| Result cache | z |");
    expect(updated).toContain("| Result cache | z |");
    expect(updated).not.toContain("| Result cache | x |");
    expect(updated).toContain("| Model removed | y |");
  });
});
