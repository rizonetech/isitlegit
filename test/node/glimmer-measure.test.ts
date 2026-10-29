import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { burstMinutes, minutesUsed, readBursts, sastDay, startSession } from "../../scripts/glimmer/measure.ts";

// scripts/glimmer/measure.ts (D03 T04 §13): bursts count from first request to last answer plus the 5-minute tail, on
// the South African day, and a session that would pass 30 minutes refuses to start.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glimmer-runtime-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the runtime ledger", () => {
  it("counts each burst to its last answer plus 5 minutes, on the SAST day", () => {
    expect(sastDay(new Date("2026-10-29T22:30:00Z"))).toBe("2026-10-30");
    const burst = { day: "2026-10-29", start: "2026-10-29T08:00:00Z", lastAnswer: "2026-10-29T08:04:00Z" };
    expect(burstMinutes(burst, new Date("2026-10-29T09:00:00Z"))).toBe(9);
    expect(burstMinutes({ ...burst, lastAnswer: null }, new Date("2026-10-29T08:02:00Z"))).toBe(7);
    expect(minutesUsed([burst, { ...burst, day: "2026-10-28" }], "2026-10-29", new Date())).toBe(9);
  });

  it("records a session and refuses the one that would pass 30 minutes", () => {
    const file = join(dir, "runtime.json");
    const now = new Date("2026-10-29T08:00:00Z");
    const first = startSession(10, { now, file });
    expect("answered" in first).toBe(true);
    if ("answered" in first) first.answered(new Date("2026-10-29T08:12:00Z")); // 12 + 5 = 17 minutes
    expect(readBursts(file)).toHaveLength(1);
    const later = new Date("2026-10-29T10:00:00Z");
    // 17 used + 9 + the 5-minute tail = 31: refused; exactly 30 is allowed.
    expect(startSession(9, { now: later, file })).toEqual({
      refused: "today has 17.0 of 30 minutes used; this session needs 14.0 more",
    });
    expect("answered" in startSession(7, { now: later, file })).toBe(true); // 17 + 7 + 5 = 29
  });
});
