import { describe, expect, it } from "vitest";
import { excludedInFiles, type JudgeRecord, judgeDecision } from "../../scripts/glimmer/build-dataset.ts";
import type { PageAnswer } from "../../src/vision/page-screen.ts";

// The 1.1 label rule (coordinator, 2026-11-01 23:55): Astra and source agree, the label stands; they
// disagree, or Astra called a lure capture invalid, Wonder decides; unsettled or invalid-benign pages drop.
const answer: PageAnswer = {
  brand: null,
  has_login_form: false,
  has_payment_form: false,
  lure: true,
  lure_type: "credential",
  confidence: 0.95,
};
const rec = (over: Partial<JudgeRecord>): JudgeRecord => ({
  lure: true,
  lure_type: "credential",
  capture_valid: true,
  ...over,
});

describe("judgeDecision", () => {
  it("stands when there is no Astra record or Astra agrees", () => {
    expect(judgeDecision(answer, undefined, undefined).kind).toBe("stand");
    expect(judgeDecision(answer, rec({}), undefined).kind).toBe("stand");
  });

  it("lets Wonder decide a disagreement", () => {
    const judged = judgeDecision(
      answer,
      rec({ lure: false, lure_type: "none" }),
      rec({ lure: false, lure_type: "none" }),
    );
    expect(judged.kind).toBe("judged");
    if (judged.kind === "judged") expect(judged.answer.lure).toBe(false);
  });

  it("drops an unsettled disagreement and an invalid benign capture", () => {
    expect(judgeDecision(answer, rec({ lure: false, lure_type: "none" }), undefined)).toEqual({
      kind: "drop",
      reason: "unresolved",
    });
    expect(
      judgeDecision({ ...answer, lure: false, lure_type: "none" }, rec({ lure: false, capture_valid: false }), rec({})),
    ).toEqual({
      kind: "drop",
      reason: "invalid-capture",
    });
  });

  it("names a barred page planted in a file's pages, and none when there is none", () => {
    const barred = new Map([["p-leak", "flagged by the sample leak check"]]);
    // This is the planting the build refuses on: an excluded id among the written files' page ids.
    expect(excludedInFiles(barred, ["p-ok", "p-leak"])).toEqual(["p-leak"]);
    expect(excludedInFiles(barred, ["p-ok", "p-other"])).toEqual([]);
  });

  it("lets Wonder decide an invalid lure capture only when its own capture is valid", () => {
    expect(judgeDecision(answer, rec({ capture_valid: false }), rec({})).kind).toBe("judged");
    expect(judgeDecision(answer, rec({ capture_valid: false }), rec({ capture_valid: false })).kind).toBe("drop");
  });
});
