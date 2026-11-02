// The stamps experiment (D08 T03 section 2): pairs, payloads and scoring on stubbed outcomes, no spend.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ArmOutcome,
  buildSet,
  chainPayload,
  checkLog,
  scoreOutcomes,
  wholePagePayload,
} from "../../eval/frontier/stamps.ts";

describe("the stamps experiment", () => {
  it("builds 20 labelled pairs with a reference, and payloads carry no label", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stamps-"));
    const entries = await buildSet(join(dir, "set"));
    expect(entries).toHaveLength(20);
    expect(entries.filter((e) => e.label === "doctored")).toHaveLength(10);
    expect(entries.filter((e) => e.label === "genuine")).toHaveLength(10);
    expect(readFileSync(join(dir, "set", "reference-stamp.png")).length).toBeGreaterThan(100);
    const page = Buffer.from("page");
    const ref = Buffer.from("ref");
    expect(JSON.stringify(wholePagePayload(page, ref))).not.toContain("doctored");
    expect(chainPayload(ref, Buffer.from("a"), Buffer.from("b"))).toHaveLength(3);
  });

  it("scores both arms apart and refuses an incomplete log", () => {
    const entries = [
      { file: "a.png", label: "doctored" as const, alteration: "stamp-date", sha256: "x" },
      { file: "b.png", label: "genuine" as const, alteration: "none", sha256: "y" },
    ];
    const outcomes: ArmOutcome[] = [
      { file: "a.png", arm: "whole", status: "answered", doctored: true, ms: 10, usd: 0.01 },
      { file: "b.png", arm: "whole", status: "answered", doctored: false, ms: 10, usd: 0.01 },
      { file: "a.png", arm: "chain", status: "answered", doctored: false, ms: 10, usd: 0.02 },
      { file: "b.png", arm: "chain", status: "refused", doctored: null, ms: null, usd: 0 },
    ];
    const s = scoreOutcomes(entries, outcomes);
    expect(s.whole.detection).toBe(1);
    expect(s.chain.detection).toBe(0);
    expect(
      checkLog(
        "whole detection 100.0%, whole cost US$0.0200, chain detection 0.0%, chain cost US$0.0200",
        entries,
        outcomes,
      ),
    ).toEqual([]);
    expect(checkLog("nothing", entries, outcomes).length).toBeGreaterThan(0);
    expect(checkLog("x", entries, outcomes.slice(0, 2)).some((p) => p.includes("no chain outcome"))).toBe(true);
  });
});
