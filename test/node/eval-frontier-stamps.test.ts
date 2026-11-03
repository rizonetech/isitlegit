// The stamps experiment (D08 T03 section 2): pairs, payloads, runner and scoring on stubbed outcomes, no spend.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { sharedLedger } from "../../eval/frontier/digits.ts";
import {
  type ArmOutcome,
  buildSet,
  chainPayload,
  checkLog,
  createBudgetedStampDeps,
  decideStamps,
  ESTIMATE_USD,
  experimentFingerprint,
  main,
  PROMPT,
  runStamps,
  SIGNATURE_BOX,
  STAMP_BOX,
  scoreOutcomes,
  wholePagePayload,
} from "../../eval/frontier/stamps.ts";
import type { Budget } from "../../src/meta/guard.ts";

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

describe("the stamps experiment", () => {
  it("builds 20 labelled pairs (40 pages) with tested stamp/signature alterations, a genuine reference, and label-free payloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stamps-"));
    tempDirs.push(dir);
    const setDir = join(dir, "set");
    const entries = await buildSet(setDir);
    expect(entries).toHaveLength(40);
    const doctored = entries.filter((e) => e.label === "doctored");
    const genuine = entries.filter((e) => e.label === "genuine");
    expect(doctored).toHaveLength(20);
    expect(genuine).toHaveLength(20);
    expect(new Set(entries.map((e) => e.pairId)).size).toBe(20);
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

  it("crops real PNG bytes in runStamps, records empty-segmentation without coordinate substitution, does not resend failed calls without --retry-failed, and binds results to fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stamps-run-"));
    tempDirs.push(dir);
    const setDir = join(dir, "set");
    const entries = await buildSet(setDir);

    const seenImages: Buffer[][] = [];
    let spent = 0;
    let askCalls = 0;
    const first = await runStamps(setDir, {
      segment: async (_png, concept) => {
        // Return 0 boxes on the second page (pop-01-doctored.png) to prove empty-segmentation without fallback.
        if (seenImages.length >= 2) return [];
        return [concept === "stamp" ? STAMP_BOX : SIGNATURE_BOX];
      },
      ask: async (images) => {
        seenImages.push(images);
        askCalls++;
        if (askCalls === 3) {
          spent += 2.5;
          throw new Error("provider refused request");
        }
        return { doctored: images.length === 3, usd: 0.02 };
      },
      spentUsd: () => spent,
    });
    expect(first.stopped).toMatch(/budget cap/);
    // First page whole (answered), first page chain (answered, 3 PNGs), second page whole (refused, cost includes seg + spark), second page chain (empty-segmentation, no ask call).
    expect(seenImages[1]).toHaveLength(3);
    for (const buf of seenImages[1] ?? []) {
      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe("png");
      expect(meta.width).toBeGreaterThan(50);
    }
    const refusedRow = first.outcomes.find((o) => o.file === "pop-01-doctored.png" && o.arm === "whole");
    expect(refusedRow?.status).toBe("refused");
    expect(refusedRow?.usd).toBeCloseTo(ESTIMATE_USD.spark);
    expect(refusedRow?.attempts).toBe(1);

    // Resuming without retryFailed does NOT resend the refused row, only finishes the budget-stopped rows.
    spent = 0;
    let resumeAskCalls = 0;
    const second = await runStamps(setDir, {
      segment: async () => [],
      ask: async () => {
        resumeAskCalls++;
        return { doctored: false, usd: 0.02 };
      },
      spentUsd: () => spent,
    });
    expect(second.stopped).toBeNull();
    // 40 pages: page 1 whole & chain were answered, page 2 whole was refused (skipped!), leaving 38 whole calls.
    // All remaining 39 chain calls had empty-segmentation (0 ask calls).
    expect(resumeAskCalls).toBe(38);
    expect(second.outcomes.find((o) => o.file === "pop-01-doctored.png" && o.arm === "whole")?.status).toBe("refused");
    expect(second.outcomes.find((o) => o.file === "pop-01-doctored.png" && o.arm === "chain")?.status).toBe(
      "empty-segmentation",
    );

    // Retrying with retryFailed: true resends only the refused row and accumulates its prior attempt cost and count.
    let retryCalls = 0;
    const third = await runStamps(
      setDir,
      {
        segment: async () => [],
        ask: async () => {
          retryCalls++;
          return { doctored: true, usd: 0.02 };
        },
        spentUsd: () => 0,
      },
      { retryFailed: true },
    );
    expect(retryCalls).toBe(1);
    const recovered = third.outcomes.find((o) => o.file === "pop-01-doctored.png" && o.arm === "whole");
    expect(recovered?.status).toBe("answered");
    expect(recovered?.attempts).toBe(2);
    expect(recovered?.usd).toBeCloseTo(ESTIMATE_USD.spark + 0.02);

    // Tampering with an input hash in manifest.json causes runStamps and checkLog to refuse the stored outcomes.
    const manifestPath = join(setDir, "manifest.json");
    const tampered = entries.map((e, idx) => (idx === 0 ? { ...e, sha256: "0000" } : e));
    writeFileSync(manifestPath, JSON.stringify(tampered));
    await expect(
      runStamps(setDir, {
        segment: async () => [],
        ask: async () => ({ doctored: false }),
        spentUsd: () => 0,
      }),
    ).rejects.toThrow(/differs from manifest/);
  });

  it("scores both arms with failure-aware denominators, enforces the 2% FP and 2x cost decision rules, and verifies logs", () => {
    const entries = [
      { file: "a.png", pairId: "pair-01", label: "doctored" as const, alteration: "stamp-date" as const, sha256: "x" },
      {
        file: "c.png",
        pairId: "pair-02",
        label: "doctored" as const,
        alteration: "stamp-colour" as const,
        sha256: "z",
      },
      { file: "b.png", pairId: "pair-01", label: "genuine" as const, alteration: "none" as const, sha256: "y" },
    ];
    const fp = experimentFingerprint(entries, "ref");
    const outcomes: ArmOutcome[] = [
      {
        file: "a.png",
        arm: "whole",
        status: "answered",
        doctored: true,
        ms: 10,
        usd: 0.02,
        attempts: 1,
        fileSha256: "x",
        fingerprint: fp,
      },
      {
        file: "c.png",
        arm: "whole",
        status: "answered",
        doctored: false,
        ms: 5,
        usd: 0.02,
        attempts: 1,
        fileSha256: "z",
        fingerprint: fp,
      },
      {
        file: "b.png",
        arm: "whole",
        status: "answered",
        doctored: false,
        ms: 10,
        usd: 0.02,
        attempts: 1,
        fileSha256: "y",
        fingerprint: fp,
      },
      {
        file: "a.png",
        arm: "chain",
        status: "answered",
        doctored: true,
        ms: 10,
        usd: 0.025,
        attempts: 1,
        fileSha256: "x",
        fingerprint: fp,
      },
      {
        file: "c.png",
        arm: "chain",
        status: "answered",
        doctored: true,
        ms: 12,
        usd: 0.025,
        attempts: 1,
        fileSha256: "z",
        fingerprint: fp,
      },
      {
        file: "b.png",
        arm: "chain",
        status: "answered",
        doctored: false,
        ms: 10,
        usd: 0.025,
        attempts: 1,
        fileSha256: "y",
        fingerprint: fp,
      },
    ];
    const s = scoreOutcomes(entries, outcomes, "ref");
    expect(s.whole.detection).toBe(0.5);
    expect(s.whole.falsePositives).toBe(0);
    expect(s.chain.detection).toBe(1);
    expect(s.chain.falsePositives).toBe(0);
    expect(decideStamps(s)).toBe("feature");

    // Probe: > 2% false positives or > 2x whole-page cost returns "cut", never "feature".
    expect(decideStamps({ ...s, chain: { ...s.chain, falsePositives: 0.1 } })).toBe("cut");
    expect(decideStamps({ ...s, chain: { ...s.chain, totalUsd: 200 } })).toBe("cut");

    const validLog = `whole detection 50.0%, whole false positives 0.0%, whole cost US$0.0600, median 10 ms, worst 10 ms, chain detection 100.0%, chain false positives 0.0%, chain cost US$0.0750, median 10 ms, worst 12 ms, Decision: feature | fingerprint: ${s.fingerprint}, ${PROMPT}, Adopted in D06 T02 §2`;
    expect(checkLog(validLog, entries, outcomes, { referenceSha256: "ref" })).toEqual([]);
    expect(
      checkLog(validLog.replace(s.fingerprint, "wrong"), entries, outcomes, { referenceSha256: "ref" }).some((p) =>
        p.includes("fingerprint"),
      ),
    ).toBe(true);
    expect(
      checkLog(validLog.replace("Adopted in D06 T02 §2", "none"), entries, outcomes, { referenceSha256: "ref" }).some(
        (p) => p.includes("Adopted in"),
      ),
    ).toBe(true);
    expect(
      checkLog(validLog.replace("D06 T02 §2", "D06 T02 §99"), entries, outcomes, { referenceSha256: "ref" }).some((p) =>
        p.includes("does not exist"),
      ),
    ).toBe(true);

    // Terminal empty-segmentation timings are included in end-to-end medianMs and maxMs.
    const emptyChainOutcomes = outcomes.map((o) =>
      o.arm === "chain"
        ? { ...o, status: "empty-segmentation" as const, doctored: null, ms: o.file === "c.png" ? 42 : 18 }
        : o,
    );
    const emptyScore = scoreOutcomes(entries, emptyChainOutcomes, "ref");
    expect(emptyScore.chain.medianMs).toBe(18);
    expect(emptyScore.chain.maxMs).toBe(42);
    expect(emptyScore.chain.answeredMedianMs).toBeNull();

    // Standalone scoreOutcomes throws on stale fingerprint or wrong fileSha256.
    expect(() =>
      scoreOutcomes(
        entries,
        outcomes.map((o) => ({ ...o, fingerprint: "stale" })),
        "ref",
      ),
    ).toThrow(/fingerprint/);
    expect(() =>
      scoreOutcomes(
        entries,
        outcomes.map((o) => ({ ...o, fileSha256: "wrong" })),
        "ref",
      ),
    ).toThrow(/fileSha256/);
  });

  it("rejects stale results in standalone score CLI without --check and persists settled charges + retry attempts through localBudget + sharedLedger", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stamps-budget-"));
    tempDirs.push(dir);
    const setDir = join(dir, "set");
    const entries = await buildSet(setDir);
    const ledgerFile = join(dir, "ledger.json");
    const ledger = sharedLedger(ledgerFile, "stamps-test", { capUsd: 2.0 });

    const guardReserved: string[] = [];
    const guardSettled: Array<{ id: string; actualUsd: number }> = [];
    const guard: Budget = {
      reserve: async (_model, _est, _attempt, id) => {
        const gid = id ?? "g";
        guardReserved.push(gid);
        return gid;
      },
      settle: async (id, actualUsd) => {
        guardSettled.push({ id, actualUsd });
      },
      uncertain: async () => {},
      refused: async () => {},
      outputFailed: async () => {},
      cached: async () => {},
    };

    const deps = await createBudgetedStampDeps({
      env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://example.test" },
      guard,
      ledger,
      segmentFn: async (ctx: unknown) => {
        const b = (ctx as { budget: Budget }).budget;
        const id = await b.reserve("sam-3.1", ESTIMATE_USD.segment, 1);
        await b.settle(id, 0.0025, { ms: 10, outcome: "ok", certainty: "none", source: "estimate" });
        return [];
      },
      structuredFn: (async (_schema: unknown, _req: unknown, ctx: unknown) => {
        const b = (ctx as { budget: Budget }).budget;
        // Simulate 2 internal attempts (initial + repair) settling at actual token costs 0.0031 and 0.0014.
        const id1 = await b.reserve("muse-spark-1.3", ESTIMATE_USD.spark, 1);
        await b.settle(id1, 0.0031, {
          ms: 20,
          outcome: "ok",
          certainty: "measured",
          source: "meta-usage",
          inputTokens: 100,
          outputTokens: 20,
        });
        const id2 = await b.reserve("muse-spark-1.3", ESTIMATE_USD.spark, 2);
        await b.settle(id2, 0.0014, {
          ms: 15,
          outcome: "ok",
          certainty: "measured",
          source: "meta-usage",
          inputTokens: 50,
          outputTokens: 10,
        });
        return { value: { doctored: true, reason: "altered" }, callId: id2, attempts: 2 };
      }) as never,
    });

    const out = await runStamps(setDir, deps);
    expect(out.stopped).toBeNull();
    // 40 pages: each whole page made 2 Spark attempts (80), each chain page made 2 SAM attempts (80) = 160 reservations in both sharedLedger and localBudget guard.
    expect(guardReserved).toHaveLength(160);
    expect(guardSettled).toHaveLength(160);

    const firstWhole = out.outcomes.find((o) => o.file === entries[0]?.file && o.arm === "whole");
    expect(firstWhole?.usd).toBeCloseTo(0.0045, 6);
    expect(firstWhole?.attempts).toBe(2);

    const firstChain = out.outcomes.find((o) => o.file === entries[0]?.file && o.arm === "chain");
    expect(firstChain?.status).toBe("empty-segmentation");
    expect(firstChain?.usd).toBeCloseTo(0.005, 6);
    expect(firstChain?.attempts).toBe(2);

    // Standalone score CLI exits 0 on valid results and exits 1 when results have stale fingerprints or wrong file hashes.
    expect(await main(["score", "--dir", setDir])).toBe(0);
    const stalePath = join(dir, "stale-results.json");
    writeFileSync(
      stalePath,
      JSON.stringify(out.outcomes.map((o) => ({ ...o, fingerprint: "stale", fileSha256: "wrong" }))),
    );
    expect(await main(["score", "--dir", setDir, "--results", stalePath])).toBe(1);

    // Restarting on the same persistent ledger does not misattribute prior calls to later outcomes, and stops immediately on accounting failure.
    const resumeResults = join(dir, "resume-results.json");
    const resumeLedger = sharedLedger(join(dir, "resume-ledger.json"), "stamps-resume", { capUsd: 2.0 });
    let failSettle = false;
    let callsSent = 0;
    const makeResumeDeps = () =>
      createBudgetedStampDeps({
        env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://example.test" },
        guard: {
          ...guard,
          settle: async (id, actualUsd) => {
            if (failSettle) throw new Error("D1 settlement write failed");
            guardSettled.push({ id, actualUsd });
          },
        },
        ledger: resumeLedger,
        segmentFn: async (ctx: unknown) => {
          callsSent++;
          const b = (ctx as { budget: Budget }).budget;
          const id = await b.reserve("sam-3.1", ESTIMATE_USD.segment, 1);
          await b.settle(id, 0.0025, { ms: 5, outcome: "ok", certainty: "none", source: "estimate" });
          return [];
        },
        structuredFn: (async (_schema: unknown, _req: unknown, ctx: unknown) => {
          callsSent++;
          const b = (ctx as { budget: Budget }).budget;
          const id = await b.reserve("muse-spark-1.3", ESTIMATE_USD.spark, 1);
          await b.settle(id, 0.003, {
            ms: 10,
            outcome: "ok",
            certainty: "measured",
            source: "meta-usage",
            inputTokens: 80,
            outputTokens: 15,
          });
          return { value: { doctored: false, reason: "clean" }, callId: id, attempts: 1 };
        }) as never,
      });

    // Invocation 1: run one whole outcome ($0.003 / 1 attempt), then mark the rest budget-stopped to simulate an interrupted run.
    const deps1 = await makeResumeDeps();
    const fp = out.outcomes[0]?.fingerprint ?? "";
    const firstEntry = entries[0];
    const secondEntry = entries[1];
    expect(firstEntry && secondEntry).toBeTruthy();
    const firstAsk = await deps1.ask([Buffer.from("a")], {
      file: firstEntry?.file ?? "",
      arm: "whole",
      fingerprint: fp,
    });
    expect(firstAsk).toEqual({ doctored: false, usd: 0.003, attempts: 1 });

    // Invocation 2 (fresh deps on same persistent ledger): single $0.003 call for a different file returns $0.003 / 1 attempt, never $0.006 / 2.
    const deps2 = await makeResumeDeps();
    const secondAsk = await deps2.ask([Buffer.from("b")], {
      file: secondEntry?.file ?? "",
      arm: "whole",
      fingerprint: fp,
    });
    expect(secondAsk).toEqual({ doctored: false, usd: 0.003, attempts: 1 });

    // Accounting failure stops runStamps immediately without sending subsequent calls or double-counting spentUsd.
    failSettle = true;
    callsSent = 0;
    const deps3 = await makeResumeDeps();
    const stoppedRun = await runStamps(setDir, deps3, { resultsFile: resumeResults });
    expect(stoppedRun.stopped).toMatch(/accounting:/);
    expect(callsSent).toBe(1);
    expect(deps3.spentUsd()).toBeCloseTo(0.003, 6);
  });
});
