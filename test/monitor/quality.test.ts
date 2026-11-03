// Tests for the monitor pipeline quality and ablation harness (D05 T04 §12): metric calculations,
// ablation substitutions (`full`, `no_reading`, `no_logo`, `no_walkthrough`), unavailable and
// allowance-refused cases in denominators, label schema validation, interrupted runs, and budget
// exhaustion.
import { env } from "cloudflare:test";
import puppeteer from "@cloudflare/puppeteer";
import { describe, expect, it } from "vitest";
import corpusJson from "../../data/monitor/quality-corpus.json";
import runJson from "../../data/monitor/quality-run.json";
import { createCase, MONITOR_CASES_PER_DAY } from "../../src/db/cases";
import {
  computeAblationDeltas,
  computeArmMetrics,
  evaluateMonitorArm,
  evaluateMonitorCorpus,
  median,
  percentileNearestRank,
  type QualityCase,
  QualityCorpusSchema,
  type QualityEvalDeps,
  type QualityRunReport,
} from "../../src/monitor/quality";
import { fakeJpeg } from "../fixtures/jpeg";
import { db } from "./world";

const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };

const answer = (body: unknown) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(body) }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

const MINI_CASES: QualityCase[] = [
  {
    id: "mini-lure-login",
    orgKey: "fynbos",
    protectedBrand: "Fynbos Freight",
    verifiedDomain: "fynbosfreight.example",
    referenceScreenPath: "eval/glimmer/monitor-pages/screens/benign-01.jpg",
    host: "fynbos-login-lure.example",
    captureUrl: "https://fynbos-login-lure.example/login",
    screenshotPath: "eval/glimmer/monitor-pages/screens/lure-01.jpg",
    textPath: "eval/glimmer/monitor-pages/texts/lure-01.txt",
    htmlPath: "eval/glimmer/monitor-pages/pages/lure-01.html",
    signals: { passwords: 0, forms: 0 },
    groundTruth: { destination: "mismatch", form: "log_in", expectedState: "confirmed", lure: true },
  },
  {
    id: "mini-lure-impersonation",
    orgKey: "karoo",
    protectedBrand: "Karoo Mutual Bank",
    verifiedDomain: "karoomutual.example",
    referenceScreenPath: "eval/glimmer/monitor-pages/screens/benign-02.jpg",
    host: "karoo-giveaway-lure.example",
    captureUrl: "https://karoo-giveaway-lure.example/",
    screenshotPath: "eval/glimmer/monitor-pages/screens/lure-19.jpg",
    textPath: "eval/glimmer/monitor-pages/texts/lure-19.txt",
    htmlPath: "eval/glimmer/monitor-pages/pages/lure-19.html",
    signals: { passwords: 0, forms: 0 },
    groundTruth: { destination: "mismatch", form: "none", expectedState: "confirmed", lure: true },
  },
  {
    id: "mini-benign-official",
    orgKey: "fynbos",
    protectedBrand: "Fynbos Freight",
    verifiedDomain: "fynbosfreight.example",
    referenceScreenPath: "eval/glimmer/monitor-pages/screens/benign-01.jpg",
    host: "fynbosfreight.example",
    captureUrl: "https://fynbosfreight.example/login",
    screenshotPath: "eval/glimmer/monitor-pages/screens/benign-01.jpg",
    textPath: "eval/glimmer/monitor-pages/texts/benign-01.txt",
    htmlPath: "eval/glimmer/monitor-pages/pages/benign-17.html",
    signals: { passwords: 1, forms: 1 },
    groundTruth: { destination: "official", form: "log_in", expectedState: "unconfirmed", lure: false },
  },
  {
    id: "mini-benign-other",
    orgKey: "fynbos",
    protectedBrand: "Fynbos Freight",
    verifiedDomain: "fynbosfreight.example",
    referenceScreenPath: "eval/glimmer/monitor-pages/screens/benign-01.jpg",
    host: "capeherald-news.example",
    captureUrl: "https://capeherald-news.example/",
    screenshotPath: "eval/glimmer/monitor-pages/screens/benign-11.jpg",
    textPath: "eval/glimmer/monitor-pages/texts/benign-11.txt",
    htmlPath: "eval/glimmer/monitor-pages/pages/benign-11.html",
    signals: { passwords: 0, forms: 0 },
    groundTruth: { destination: "mismatch", form: "none", expectedState: "unconfirmed", lure: false },
  },
];

const FORM_HTML =
  '<!doctype html><html><body><form><label>Email</label><input type="text"><label>Password</label><input type="password"><button>Sign in</button></form></body></html>';
const PLAIN_HTML = "<!doctype html><html><body><p>Welcome</p></body></html>";

function makeDeps(overrides: Partial<QualityEvalDeps> = {}): QualityEvalDeps {
  let spent = 0;
  let tick = 100;
  const kvMap = new Map<string, string>();
  const freshKv = () => {
    const store = new Map<string, string>();
    return {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    } as unknown as KVNamespace;
  };
  void kvMap;
  return {
    createArmStorage: async () => ({
      db,
      bucket: env.ARTEFACTS,
      store: { bucket: env.ARTEFACTS, db },
      kv: freshKv(),
    }),
    artefacts: {
      loadReferenceLogo: async () => fakeJpeg(200, 80, 4_000),
      loadCandidateScreenshot: async () => fakeJpeg(1280, 800, 20_000),
      loadCandidateText: async (item) =>
        item.id === "mini-benign-other"
          ? "Cape Herald local news report."
          : `${item.protectedBrand} portal at ${item.host}.`,
      loadCandidateHtml: async (item) => (item.groundTruth.form === "none" ? PLAIN_HTML : FORM_HTML),
      cropCandidateLogo: async (item) => ({
        bytes: fakeJpeg(160, 60, item.id === "mini-benign-other" ? 5_000 : 2_000),
        mediaType: "image/jpeg",
        label: `crop-${item.id}`,
      }),
    },
    launchBrowser: () => puppeteer.launch(env.BROWSER),
    metaEnv: META,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      if (body.includes("muse-wonder-1.0")) {
        const userMatch = body.match(/Test username:\s*([^\n\\"]+)/);
        const canaryUser = userMatch?.[1]?.trim() ?? "canary@canary.isitlegit.co.za";
        const outputsCount = (body.match(/function_call_output/g) ?? []).length;
        const output =
          outputsCount === 0
            ? [{ type: "function_call", name: "type", call_id: "c1", arguments: JSON.stringify({ text: canaryUser }) }]
            : outputsCount === 1
              ? [
                  {
                    type: "function_call",
                    name: "keypress",
                    call_id: "c2",
                    arguments: JSON.stringify({ key: "Enter" }),
                  },
                ]
              : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Submitted." }] }];
        return new Response(
          JSON.stringify({
            id: "r-wonder",
            object: "response",
            status: "completed",
            output,
            usage: { input_tokens: 150, output_tokens: 25 },
          }),
          { headers: { "content-type": "application/json", "cf-aig-log-id": "log-w", "x-request-id": "req-w" } },
        );
      }
      if (body.includes("logo_comparison")) {
        const isOtherBrand = body.length > 10_000;
        return answer({
          same_brand: !isOtherBrand,
          brand_seen: isOtherBrand ? "Cape Herald" : "Fynbos Freight",
          differences: isOtherBrand ? ["different brand mark"] : [],
          confidence: 0.94,
        });
      }
      const isLogin = body.includes("login-lure") || body.includes("fynbosfreight.example");
      const isOther = body.includes("Cape Herald");
      return answer({
        readings: [
          {
            image: "P1",
            claimed_brand: isOther ? "Cape Herald" : "Fynbos Freight",
            requested_action: isLogin ? "log_in" : "none",
            urgency_cues: isLogin ? ["Sign in now"] : [],
            visible_sender: null,
            payment_request: false,
            confidence: 0.92,
          },
        ],
      });
    }) as typeof fetch,
    budget: (() => {
      const reservations = new Map<string, number>();
      return {
        reserve: async (_model, estimateUsd) => {
          const id = `res-${reservations.size + 1}`;
          reservations.set(id, estimateUsd);
          return id;
        },
        settle: async (id, actualUsd) => {
          reservations.delete(id);
          spent += actualUsd;
        },
        uncertain: async (id) => {
          const est = reservations.get(id) ?? 0;
          reservations.delete(id);
          spent += est;
        },
        refused: async () => {},
        outputFailed: async () => {},
        cached: async () => {},
        spentUsd: () => spent,
      };
    })(),
    maxSpendUsd: 1.5,
    clockMs: () => {
      tick += 25;
      return tick;
    },
    ...overrides,
  };
}

describe("monitor pipeline quality and ablation harness (D05 T04 §12)", () => {
  it("validates the committed 40-page quality corpus and rejects missing or invalid labels", () => {
    const parsed = QualityCorpusSchema.parse(corpusJson);
    expect(parsed.cases).toHaveLength(40);
    expect(parsed.cases.filter((c) => c.groundTruth.lure)).toHaveLength(20);
    expect(parsed.cases.filter((c) => !c.groundTruth.lure)).toHaveLength(20);
    expect(parsed.cases.some((c) => c.groundTruth.destination === "official")).toBe(true);
    expect(parsed.cases.some((c) => c.groundTruth.destination === "mismatch")).toBe(true);
    expect(parsed.cases.some((c) => c.groundTruth.form === "log_in")).toBe(true);
    expect(parsed.cases.some((c) => c.groundTruth.form === "pay")).toBe(true);
    expect(parsed.cases.some((c) => c.groundTruth.form === "none")).toBe(true);

    expect(() =>
      QualityCorpusSchema.parse({
        version: "1.0",
        licence: "CC0-1.0",
        cases: [{ ...MINI_CASES[0], groundTruth: { destination: "invalid" } }],
      }),
    ).toThrow();

    const committedRun = runJson as unknown as QualityRunReport;
    expect(committedRun.complete).toBe(true);
    expect(committedRun.totalSpendUsd).toBeGreaterThan(0);
    expect(committedRun.totalSpendUsd).toBeLessThanOrEqual(committedRun.maxSpendUsd);
    for (const arm of ["full", "no_reading", "no_logo", "no_walkthrough"] as const) {
      const recorded = committedRun.arms[arm];
      const recomputed = computeArmMetrics(arm, parsed.cases, recorded.cases, recorded.complete, recorded.stopReason);
      expect(recomputed).toEqual(recorded);
    }
    expect(computeAblationDeltas(committedRun.arms)).toEqual(committedRun.ablationDeltas);
  });

  it("evaluates all four arms with isolated KV state, measuring ablation drops, latency percentiles, and cost", {
    timeout: 45_000,
  }, async () => {
    const report = await evaluateMonitorCorpus({ version: "1.0", licence: "CC0-1.0", cases: MINI_CASES }, makeDeps());
    expect(report.complete).toBe(true);
    expect(report.arms.full.destinationAccuracy).toEqual({ numerator: 4, denominator: 4, rate: 1 });
    expect(report.arms.full.formRecall).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(report.arms.full.formSpecificity).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(report.arms.full.readingFormRecall).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(report.arms.full.readingFormSpecificity).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(report.arms.full.confirmationRecall).toEqual({ numerator: 2, denominator: 2, rate: 1 });
    expect(report.arms.full.falsePositiveRate).toEqual({ numerator: 0, denominator: 2, rate: 0 });
    expect(report.arms.full.partialRate).toEqual({ numerator: 0, denominator: 4, rate: 0, refusedCount: 0 });
    expect(report.arms.full.latencyMs.medianMs).toBeGreaterThan(0);
    expect(report.arms.full.latencyMs.p95Ms).toBeGreaterThan(0);
    expect(report.arms.full.costUsd.totalUsd).toBeGreaterThan(0);
    expect(report.arms.full.costUsd.paidUsd).toBe(report.arms.full.costUsd.totalUsd);
    expect(report.arms.full.costUsd.replayedUsd).toBe(0);
    expect(report.totalSpendUsd).toBe(report.arms.full.costUsd.paidUsd);

    // Replayed ablation arms leave actual paid spend unchanged (paidUsd = 0) while recording replayedUsd and reconstructedLatencyMs separately from actual wall-clock latencyMs.
    for (const arm of ["no_reading", "no_logo", "no_walkthrough"] as const) {
      expect(report.arms[arm].costUsd.paidUsd).toBe(0);
      expect(report.arms[arm].costUsd.replayedUsd).toBeGreaterThan(0);
      expect(report.arms[arm].costUsd.totalUsd).toBe(report.arms[arm].costUsd.replayedUsd);
      expect(report.arms[arm].reconstructedLatencyMs.medianMs).toBeGreaterThan(report.arms[arm].latencyMs.medianMs);
    }

    // Without Spark reading (`no_reading`), isolated reading form recall drops to 0 while `signals.json` remains intact.
    expect(report.arms.no_reading.readingFormRecall.rate).toBe(0);
    expect(report.arms.no_reading.formRecall.rate).toBe(0.5);
    // Without logo comparison (`no_logo`), the non-form impersonation lure (`mini-lure-impersonation`) is missed.
    expect(report.arms.no_logo.confirmationRecall).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(report.arms.no_logo.partialRate.numerator).toBeGreaterThan(0);

    expect(median([10, 20, 30, 40])).toBe(25);
    expect(percentileNearestRank([10, 20, 30, 40, 100], 95)).toBe(100);
  });

  it("retains unavailable and allowance-refused cases in denominators with zero credit and stops cleanly on interruption or budget exhaustion", async () => {
    const now = new Date("2026-11-02T12:00:00.000Z");
    const orgId = "qual-unavail-full-fynbos";
    await db
      .prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Fynbos', ?, ?)`)
      .bind(orgId, orgId, now.toISOString())
      .run();
    for (let i = 0; i < MONITOR_CASES_PER_DAY; i++) {
      await createCase(
        db,
        {
          orgId,
          channel: "upload",
          headersAvailable: false,
          uploadedBy: "monitor",
          sourceKind: "image",
          uploadName: `cap-${i}@x`,
          uploadMediaType: "image/jpeg",
        },
        now,
      );
    }

    const unavailableDeps = makeDeps({
      now: () => now,
      orgPrefix: "qual-unavail",
      artefacts: {
        loadReferenceLogo: async () => fakeJpeg(200, 80, 4_000),
        loadCandidateScreenshot: async (item) =>
          item.id === "mini-lure-impersonation" ? null : fakeJpeg(1280, 800, 20_000),
        loadCandidateText: async () => "Fynbos text",
        loadCandidateHtml: async () => FORM_HTML,
        cropCandidateLogo: async () => ({ bytes: fakeJpeg(160, 60, 2_000), mediaType: "image/jpeg", label: "crop" }),
      },
    });
    const partialSummary = await evaluateMonitorArm(
      "full",
      { version: "1.0", licence: "CC0-1.0", cases: MINI_CASES.slice(0, 2) },
      unavailableDeps,
    );
    // Case 1 is refused by allowance; Case 2 is missing its screenshot. Both settle partial and receive zero credit across all metrics.
    expect(partialSummary.partialRate).toEqual({ numerator: 2, denominator: 2, rate: 1, refusedCount: 1 });
    expect(partialSummary.confirmationRecall).toEqual({ numerator: 0, denominator: 2, rate: 0 });
    expect(partialSummary.destinationAccuracy).toEqual({ numerator: 0, denominator: 2, rate: 0 });
    expect(partialSummary.formRecall).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(partialSummary.formSpecificity).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(partialSummary.readingFormRecall).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(partialSummary.readingFormSpecificity).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(partialSummary.cases.every((c) => c.destinationAssessed === "unavailable")).toBe(true);
    expect(partialSummary.cases.every((c) => c.formDetected === "unavailable")).toBe(true);
    expect(partialSummary.cases.every((c) => c.readingFormDetected === "unavailable")).toBe(true);

    const interrupted = await evaluateMonitorArm(
      "full",
      { version: "1.0", licence: "CC0-1.0", cases: MINI_CASES },
      makeDeps({ orgPrefix: "qual-interrupted", isInterrupted: () => true }),
    );
    expect(interrupted.complete).toBe(false);
    expect(interrupted.stopReason).toBe("interrupted");
    expect(interrupted.destinationAccuracy).toEqual({ numerator: 0, denominator: 4, rate: 0 });
    expect(interrupted.formRecall).toEqual({ numerator: 0, denominator: 2, rate: 0 });
    expect(interrupted.formSpecificity).toEqual({ numerator: 0, denominator: 2, rate: 0 });

    const exhausted = await evaluateMonitorArm(
      "full",
      { version: "1.0", licence: "CC0-1.0", cases: MINI_CASES },
      makeDeps({ orgPrefix: "qual-exhausted", maxSpendUsd: 0.00001 }),
    );
    expect(exhausted.complete).toBe(false);
    expect(exhausted.stopReason).toBe("budget_exhausted");

    // Schema-repair retry regression: if a cached reading response is invalid, attempt 1 consumes it locally (0 paid reservations/settlements) and attempt 2 repairs it via exactly 1 paid reservation, 1 transport request, and 1 settlement without replaying the broken response again.
    let repairReserves = 0;
    let repairSettles = 0;
    let repairTransportCalls = 0;
    let repairSpent = 0;
    const baseDeps = makeDeps({ orgPrefix: "qual-repair" });
    const repairCase = MINI_CASES[1];
    if (!repairCase) throw new Error("missing repair case");
    const stageCache = new Map([
      [
        repairCase.id,
        {
          reading: {
            body: JSON.stringify({
              id: "r-bad-cached",
              object: "response",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: '{"readings":"broken"}' }],
                },
              ],
              usage: { input_tokens: 100, output_tokens: 10 },
            }),
            status: 200,
            costUsd: 0.003,
            ms: 12,
          },
        },
      ],
    ]);
    const repairedSummary = await evaluateMonitorArm(
      "no_logo",
      { version: "1.0", licence: "CC0-1.0", cases: [repairCase] },
      {
        ...baseDeps,
        stageCache,
        fetch: (async (input, init) => {
          repairTransportCalls++;
          return baseDeps.fetch(input, init);
        }) as typeof fetch,
        budget: {
          reserve: async (_model, _est) => {
            repairReserves++;
            return `rep-${repairReserves}`;
          },
          settle: async (_id, actual) => {
            repairSettles++;
            repairSpent += actual;
          },
          uncertain: async () => {},
          refused: async () => {},
          outputFailed: async () => {},
          cached: async () => {},
          spentUsd: () => repairSpent,
        },
      },
    );
    expect(repairedSummary.complete).toBe(true);
    expect(repairTransportCalls).toBe(1);
    expect(repairReserves).toBe(1);
    expect(repairSettles).toBe(1);
    expect(repairedSummary.cases[0]?.destinationAssessed).toBe("mismatch");
    expect(repairedSummary.cases[0]?.readingFormDetected).toBe("none");
  });
});
