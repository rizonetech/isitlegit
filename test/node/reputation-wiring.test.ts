import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// D02 T06 §5: the Workflow's own checks call supplies the reputation deps, so production cases are asked. A pin on
// the call site: removing the argument leaves the deps null and no case is ever asked, which no stubbed test sees.
describe("the Workflow's reputation wiring", () => {
  it("passes reputationDeps at the checks call in AnalysisWorkflow.run", () => {
    const text = readFileSync(new URL("../../src/pipeline/analysis-workflow.ts", import.meta.url), "utf8");
    expect(text).toContain("reputationDeps(this.env, caseId, orgId)");
  });
});
