// Attachment identification measurement (D08 T02 section 8).
import { describe, expect, it } from "vitest";
import { scoreAttachments } from "../eval/attachments.ts";

describe("attachment identification measurement", () => {
  it("identifies valid, disguised and damaged samples through the real sniff", () => {
    const s = scoreAttachments();
    expect(s.valid).toBe(27);
    // Exact measured outcome on this corpus (2026-11-02), asserted as measured.
    expect(s.missed).toEqual([]);
    expect(s.identified).toBe(27);
    expect(s.undetected).toEqual([]);
    // Signature-only identification: a 10-byte truncated zip still reads as zip. Integrity of the package
    // is the archive checks' measurement, not this one; the row records the distinction.
    expect(s.readAsValid).toEqual(["truncated zip"]);
  });
});
