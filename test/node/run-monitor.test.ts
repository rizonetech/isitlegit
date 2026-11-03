// The production monitor runner's mechanics (D05 T04 §6), without paid calls: instance ids
// and the finding proof an old finding cannot satisfy.
import { describe, expect, it } from "vitest";
import { findingSatisfied, instanceIdFor } from "../../scripts/run-monitor";

describe("run-monitor mechanics", () => {
  it("names the instance for the organisation and day", () => {
    expect(instanceIdFor("org-1", "2026-11-03")).toBe("monitor-org-1-2026-11-03");
  });

  it("accepts only a confirmed investigation settled after the run started", () => {
    const start = "2026-11-03T01:00:00.000Z";
    expect(
      findingSatisfied(
        { host: "fixtures.isitlegit.co.za" },
        { state: "confirmed", updated_at: "2026-11-03T01:05:00.000Z" },
        start,
      ),
    ).toBe(true);
    // An old finding from an earlier run does not satisfy this one.
    expect(
      findingSatisfied(
        { host: "fixtures.isitlegit.co.za" },
        { state: "confirmed", updated_at: "2026-11-02T01:05:00.000Z" },
        start,
      ),
    ).toBe(false);
    expect(
      findingSatisfied(
        { host: "other.example" },
        { state: "confirmed", updated_at: "2026-11-03T01:05:00.000Z" },
        start,
      ),
    ).toBe(false);
    expect(
      findingSatisfied(
        { host: "fixtures.isitlegit.co.za" },
        { state: "partial", updated_at: "2026-11-03T01:05:00.000Z" },
        start,
      ),
    ).toBe(false);
    expect(findingSatisfied(null, null, start)).toBe(false);
  });
});
