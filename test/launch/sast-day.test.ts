// D09 T01 §1: the limits script counts the cap's day exactly as the Worker does.
import { describe, expect, it } from "vitest";
import { sastDayStart } from "../../eval/launch/sast-day.ts";
import { sastDayStart as casesSastDayStart } from "../../src/db/cases";

describe("the limits script's SAST day", () => {
  it("starts where src/db/cases.ts starts the cap's day", () => {
    for (const at of [
      "2026-11-02T21:59:59.999Z",
      "2026-11-02T22:00:00Z",
      "2026-11-03T05:00:00Z",
      "2026-12-31T23:30:00Z",
    ])
      expect(sastDayStart(new Date(at))).toBe(casesSastDayStart(new Date(at)));
  });
});
