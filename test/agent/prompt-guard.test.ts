import { describe, expect, it } from "vitest";
import { allChecks } from "../../src/checks/index";

// D04 T01 §7: Prompt Guard as a second classifier takes its documented unavailable branch.
// The Workers AI catalogue hosts Llama Guard 3 and no Prompt Guard model (recorded in
// docs/frontier-log.md, 2026-11-02), so content.prompt_guard is not registered and no AI
// binding joins the product. This suite holds that line: a registration appearing without a
// new measured decision in the frontier log fails here first.
describe("prompt guard availability", () => {
  it("does not register content.prompt_guard while Prompt Guard is unavailable on Workers AI", () => {
    const names = allChecks().map((check) => check.name);
    expect(names).not.toContain("content.prompt_guard");
    // The existing independent injection signal is untouched.
    expect(names).toContain("content.ai_instructions");
  });
});
