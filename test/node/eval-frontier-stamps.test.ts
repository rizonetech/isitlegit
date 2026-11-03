// The stamps experiment (D08 T03 section 2): pairs, payloads, runner and scoring on stubbed outcomes, no spend.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import {
  type ArmOutcome,
  buildSet,
  chainPayload,
  checkLog,
  decideStamps,
  PROMPT,
  runStamps,
  SIGNATURE_BOX,
  STAMP_BOX,
  scoreOutcomes,
  wholePagePayload,
} from "../../eval/frontier/stamps.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("the stamps experiment", () => {
  it("builds 20 labelled pairs with tested stamp/signature alterations, a genuine reference, and label-free payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stamps-"));
    tempDirs.push(dir);
    const setDir = join(dir, "set");
    const entries = await buildSet(setDir);
    expect(entries).toHaveLength(20);
    const doctored = entries.filter((e) => e.label === "doctored");
    const genuine = entries.filter((e) => e.label === "genuine");
    expect(doctored).toHaveLength(10);
    expect(genuine).toHaveLength(10);
    expect(doctored.every((e) => e.alteration !== "none")).toBe(true);
    expect(genuine.every((e) => e.alteration === "none")).toBe(true);
    expect(new Set(doctored.map((e) => e.alteration))).toEqual(
      new Set(["stamp-date", "signature-swap", "stamp-colour"]),
    );

    const ref = readFileSync(join(setDir, "reference-stamp.png"));
    expect(ref.subarray(0, 4).toString("ascii")).toContain("PNG");

    // Verify the alterations change the intended region pixels compared with the first genuine control.
    const genPage = readFileSync(join(setDir, genuine[0]?.file ?? ""));
    const genStamp = await sharp(genPage).extract(STAMP_BOX).raw().toBuffer();
    const genSig = await sharp(genPage).extract(SIGNATURE_BOX).raw().toBuffer();

    for (const kind of ["stamp-date", "signature-swap", "stamp-colour"] as const) {
      const sample = doctored.find((e) => e.alteration === kind);
      expect(sample, kind).toBeTruthy();
      const docPage = readFileSync(join(setDir, sample?.file ?? ""));
      const docStamp = await sharp(docPage).extract(STAMP_BOX).raw().toBuffer();
      const docSig = await sharp(docPage).extract(SIGNATURE_BOX).raw().toBuffer();
      if (kind === "signature-swap") {
        expect(Buffer.compare(docSig, genSig)).not.toBe(0);
        expect(Buffer.compare(docStamp, genStamp)).toBe(0);
      } else {
        expect(Buffer.compare(docStamp, genStamp)).not.toBe(0);
        expect(Buffer.compare(docSig, genSig)).toBe(0);
      }
    }

    const page = Buffer.from("page");
    expect(JSON.stringify(wholePagePayload(page, ref))).not.toContain("doctored");
    expect(chainPayload(ref, Buffer.from("a"), Buffer.from("b"))).toHaveLength(3);
  });

  it("crops real PNG bytes in runStamps, preserves answered outcomes on resume, and stops at the budget cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stamps-run-"));
    tempDirs.push(dir);
    const setDir = join(dir, "set");
    await buildSet(setDir);

    const seenImages: Buffer[][] = [];
    let spent = 0;
    const first = await runStamps(setDir, {
      segment: async (_png, concept) => [concept === "stamp" ? STAMP_BOX : SIGNATURE_BOX],
      ask: async (images) => {
        seenImages.push(images);
        spent += 0.5;
        return { doctored: images.length === 3, usd: 0.5 };
      },
      spentUsd: () => spent,
    });
    expect(first.stopped).toMatch(/budget cap/);
    expect(seenImages.length).toBe(3);
    // The chain arm (second call) passes [reference, stampCrop, signatureCrop] as valid PNGs.
    expect(seenImages[1]).toHaveLength(3);
    for (const buf of seenImages[1] ?? []) {
      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBeGreaterThan(50);
    }

    // Resuming with headroom keeps the 3 answered outcomes without resending them and completes the rest.
    let secondCalls = 0;
    spent = 0;
    const second = await runStamps(setDir, {
      segment: async (_png, concept) => [concept === "stamp" ? STAMP_BOX : SIGNATURE_BOX],
      ask: async () => {
        secondCalls++;
        return { doctored: false, usd: 0.01 };
      },
      spentUsd: () => spent,
    });
    expect(second.stopped).toBeNull();
    expect(secondCalls).toBe(40 - 3);
    expect(second.outcomes.filter((o) => o.status === "answered")).toHaveLength(40);
  });

  it("scores both arms with failure-aware denominators, applies the decision rule, and refuses an incomplete log", () => {
    const entries = [
      { file: "a.png", label: "doctored" as const, alteration: "stamp-date" as const, sha256: "x" },
      { file: "c.png", label: "doctored" as const, alteration: "stamp-colour" as const, sha256: "z" },
      { file: "b.png", label: "genuine" as const, alteration: "none" as const, sha256: "y" },
    ];
    const outcomes: ArmOutcome[] = [
      { file: "a.png", arm: "whole", status: "answered", doctored: true, ms: 10, usd: 0.01 },
      { file: "c.png", arm: "whole", status: "refused", doctored: null, ms: 5, usd: 0 },
      { file: "b.png", arm: "whole", status: "answered", doctored: false, ms: 10, usd: 0.01 },
      { file: "a.png", arm: "chain", status: "answered", doctored: true, ms: 10, usd: 0.02 },
      { file: "c.png", arm: "chain", status: "answered", doctored: true, ms: 12, usd: 0.02 },
      { file: "b.png", arm: "chain", status: "answered", doctored: false, ms: 10, usd: 0.02 },
    ];
    const s = scoreOutcomes(entries, outcomes);
    // Failure-aware denominator: c.png refused in whole arm stays in denominator (1 of 2 = 0.5).
    expect(s.whole.detection).toBe(0.5);
    expect(s.whole.falsePositives).toBe(0);
    expect(s.chain.detection).toBe(1);
    expect(s.chain.falsePositives).toBe(0);
    expect(decideStamps(s)).toBe("feature");

    const validLog = `whole detection 50.0%, whole false positives 0.0%, whole cost US$0.0200, chain detection 100.0%, chain false positives 0.0%, chain cost US$0.0600, Decision: feature | fingerprint: ${s.fingerprint}, ${PROMPT}, D06 T02 §2`;
    expect(checkLog(validLog, entries, outcomes)).toEqual([]);
    expect(
      checkLog(validLog.replace(s.fingerprint, "wrong"), entries, outcomes).some((p) => p.includes("fingerprint")),
    ).toBe(true);
    expect(
      checkLog(validLog.replace("D06 T02 §2", "none"), entries, outcomes).some((p) => p.includes("section ref")),
    ).toBe(true);
    expect(checkLog("nothing", entries, outcomes).length).toBeGreaterThan(0);
    expect(checkLog(validLog, entries, outcomes.slice(0, 3)).some((p) => p.includes("no chain outcome"))).toBe(true);
  });
});
