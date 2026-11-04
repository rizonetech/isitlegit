// Invisible-character measurement (D08 T02 section 8): the reproducible set against the real check.
import { describe, expect, it } from "vitest";
import { INVISIBLE_CONTROLS, INVISIBLE_PAYLOADS, scoreInvisible } from "../../eval/invisible.ts";

describe("invisible-character measurement", () => {
  it("detects every payload (including malformed flag and chunk-boundary split) and flags no control, with timings and peakMb recorded", () => {
    const s = scoreInvisible();
    expect(INVISIBLE_PAYLOADS.map((p) => p.name)).toEqual([
      "tag-word",
      "tag-sentence",
      "ignorable-run",
      "mixed-run",
      "malformed-flag-run",
      "chunk-boundary-tag",
    ]);
    expect(INVISIBLE_CONTROLS).toHaveLength(5);
    expect(s.missed).toEqual([]);
    expect(s.flagged).toEqual([]);
    expect(s.detected).toBe(6);
    expect(s.falsePositives).toBe(0);
    expect(s.p50Ms).not.toBeNull();
    expect(s.p95Ms).not.toBeNull();
    expect(s.peakMb).not.toBeNull();
    expect(s.peakMb).toBeGreaterThan(0);
    expect(s.timesMs).toHaveLength(11);
    expect(s.observations).toHaveLength(11);
  });
});
