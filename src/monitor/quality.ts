// Monitor pipeline quality and ablation harness (D05 T04 §12): evaluates the production
// `monitorPipeline` entrypoint across four isolated arms (`full`, `no_reading`, `no_logo`,
// `no_walkthrough`) on the versioned monitor corpus (`data/monitor/quality-corpus.json`),
// retaining partial, unavailable and allowance-refused cases in end-to-end denominators while
// reporting destination accuracy, form detection recall and specificity (both end-to-end trigger
// and isolated Spark reading), confirmation recall and false-positive rate, partial/refused counts,
// median and nearest-rank p95 latency, and budget-enforced USD cost per investigation.
import type { Browser } from "@cloudflare/puppeteer";
import { z } from "zod";
import { type BrandTable, bundled } from "../checks/brands";
import { readEvidence } from "../checks/evidence";
import type { Store } from "../intake/store";
import type { MetaEnv } from "../meta/client";
import type { Budget } from "../meta/guard";
import type { LogoImage } from "../vision/logo-compare";
import { kvCache, walkthroughStep } from "../walkthrough/trigger";
import { type WalkResult, walk } from "../walkthrough/wonder";
import { monitorPipeline, type PipelineDeps, parseAllowanceRefusal } from "./pipeline";

export const QualityCaseSchema = z.object({
  id: z.string().min(1),
  orgKey: z.string().min(1),
  protectedBrand: z.string().min(1),
  verifiedDomain: z.string().min(1),
  referenceScreenPath: z.string().min(1),
  host: z.string().min(1),
  captureUrl: z.string().url(),
  screenshotPath: z.string().min(1),
  textPath: z.string().min(1),
  htmlPath: z.string().min(1),
  signals: z.object({
    passwords: z.number().int().nonnegative(),
    forms: z.number().int().nonnegative(),
  }),
  groundTruth: z.object({
    destination: z.enum(["official", "mismatch"]),
    form: z.enum(["log_in", "pay", "none"]),
    expectedState: z.enum(["confirmed", "unconfirmed", "partial"]),
    lure: z.boolean(),
  }),
});

export const QualityCorpusSchema = z.object({
  version: z.literal("1.0"),
  licence: z.string().min(1),
  cases: z.array(QualityCaseSchema).min(1),
});

export type QualityCase = z.infer<typeof QualityCaseSchema>;
export type QualityCorpus = z.infer<typeof QualityCorpusSchema>;
export type QualityArm = "full" | "no_reading" | "no_logo" | "no_walkthrough";

export type CaseObservation = {
  id: string;
  arm: QualityArm;
  state: "confirmed" | "unconfirmed" | "partial";
  refusedByAllowance: boolean;
  destinationAssessed: "official" | "mismatch" | "unavailable";
  formDetected: "log_in" | "pay" | "none" | "unavailable";
  readingFormDetected: "log_in" | "pay" | "none" | "unavailable";
  latencyMs: number;
  reconstructedLatencyMs: number;
  costUsd: number;
  paidCostUsd: number;
  replayedCostUsd: number;
};

export type RateMetric = {
  numerator: number;
  denominator: number;
  rate: number;
};

export type ArmSummary = {
  arm: QualityArm;
  complete: boolean;
  stopReason: "completed" | "budget_exhausted" | "interrupted";
  evaluatedCases: number;
  totalCorpusCases: number;
  destinationAccuracy: RateMetric;
  formRecall: RateMetric;
  formSpecificity: RateMetric;
  readingFormRecall: RateMetric;
  readingFormSpecificity: RateMetric;
  confirmationRecall: RateMetric;
  falsePositiveRate: RateMetric;
  partialRate: RateMetric & { refusedCount: number };
  latencyMs: { medianMs: number; p95Ms: number };
  reconstructedLatencyMs: { medianMs: number; p95Ms: number };
  costUsd: { totalUsd: number; meanUsdPerCase: number; paidUsd: number; replayedUsd: number };
  cases: CaseObservation[];
};

export type AblationDelta = {
  formRecallDelta: number;
  formSpecificityDelta: number;
  readingFormRecallDelta: number;
  readingFormSpecificityDelta: number;
  confirmationRecallDelta: number;
  falsePositiveRateDelta: number;
  partialRateDelta: number;
};

export type QualityRunProvenance = {
  liveRunId: string;
  d1ReservationId: string;
  requestedCapUsd: number;
  baselineFullSpendUsd: number;
  uncachedAblationSpendUsd: number;
  ledgerSettledSpendUsd: number;
  settledCalls: number;
  uncertainCalls: number;
  note: string;
};

export type QualityRunReport = {
  version: "1.0";
  corpusVersion: string;
  ranAt: string;
  maxSpendUsd: number;
  totalSpendUsd: number;
  provenance?: QualityRunProvenance;
  complete: boolean;
  arms: Record<QualityArm, ArmSummary>;
  ablationDeltas?: Partial<Record<Exclude<QualityArm, "full">, AblationDelta>>;
};

export type ArmStorage = {
  db: D1Database;
  bucket: R2Bucket;
  store: Store;
  kv: KVNamespace;
};

export type QualityArtefactLoader = {
  loadReferenceLogo: (item: QualityCase, meta?: PipelineDeps["meta"]) => Promise<Uint8Array>;
  loadCandidateScreenshot: (item: QualityCase) => Promise<Uint8Array | null>;
  loadCandidateText: (item: QualityCase) => Promise<string>;
  loadCandidateHtml: (item: QualityCase) => Promise<string>;
  cropCandidateLogo: (
    item: QualityCase,
    screenshot: Uint8Array,
    dataUrl: string,
    meta: PipelineDeps["meta"],
  ) => Promise<LogoImage | null>;
};

export type StageCacheEntry = {
  reading?: { body: string; status: number; costUsd: number; ms: number };
  crop?: { result: LogoImage | null; costUsd: number; ms: number };
  logoCompare?: { body: string; status: number; costUsd: number; ms: number };
  walk?: { result: WalkResult; costUsd: number; ms: number };
};

export type QualityEvalDeps = {
  createArmStorage: (arm: QualityArm) => Promise<ArmStorage>;
  artefacts: QualityArtefactLoader;
  launchBrowser: () => Promise<Browser>;
  metaEnv: MetaEnv;
  fetch: typeof fetch;
  budget: Budget & { spentUsd: () => number };
  maxSpendUsd: number;
  isInterrupted?: () => boolean;
  now?: () => Date;
  clockMs?: () => number;
  orgPrefix?: string;
  stageCache?: Map<string, StageCacheEntry>;
};

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

// Prepares a corpus HTML page so the contained walkthrough driver (`Driver.open`) can execute
// form submissions over HTTP POST with named fields and receive a realistic post-submit response.
export function executableCorpusHtml(rawHtml: string): string {
  let idx = 0;
  const withForm = rawHtml
    .replace(/<form\b[^>]*>/i, '<form action="/submit" method="post">')
    .replace(/<label>[^<]*<\/label>\s*<input\b([^>]*)>/gi, (full, attrs: string) => {
      idx++;
      const nameAttr = ` name="field_${idx}"`;
      if (idx === 1) return full.replace(/<input\b/i, `<input${nameAttr} autofocus`);
      if (idx === 2) {
        const withType = /type=/i.test(attrs) ? attrs : `${attrs} type="password"`;
        return full.replace(/<input\b[^>]*>/i, `<input${nameAttr}${withType}>`);
      }
      return `<input type="hidden"${nameAttr} value="1">`;
    });
  if (idx > 0) return withForm;
  return withForm.replace(
    /<button>([^<]+)<\/button>/gi,
    '<form action="/submit" method="get"><button type="submit">$1</button></form>',
  );
}

export function executableCorpusPageFetch(item: QualityCase, rawHtml: string): typeof fetch {
  const html = executableCorpusHtml(rawHtml);
  const isOfficial = item.groundTruth.destination === "official";
  const hasForm = /<form\b/i.test(rawHtml);
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/submit") {
      if (!hasForm) {
        return new Response(
          '<!doctype html><html><body style="font-family:Arial,sans-serif;margin:0;background:#f5f5f5;color:#222"><main style="max-width:760px;margin:40px auto;background:#fff;padding:32px 40px;border-radius:6px"><h1>Order summary</h1><p>Online card payment and sign-in are not available on this site. All orders are settled offline only. Nothing further is needed.</p></main></body></html>',
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (isOfficial) {
        return new Response(
          '<!doctype html><html><body style="font-family:Arial,sans-serif;margin:0;background:#f5f5f5;color:#222"><main style="max-width:760px;margin:40px auto;background:#fff;padding:32px 40px;border-radius:6px"><h1>Sign in failed</h1><p>Incorrect username or password. Those credentials were not recognised.</p></main></body></html>',
          { status: 401, headers: { "content-type": "text/html" } },
        );
      }
      return new Response(
        '<!doctype html><html><body style="font-family:Arial,sans-serif;margin:0;background:#f5f5f5;color:#222"><main style="max-width:760px;margin:40px auto;background:#fff;padding:32px 40px;border-radius:6px"><h1>Thank you</h1><p>Your details have been submitted and received. Nothing further is needed.</p></main></body></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
}

export function percentileNearestRank(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return round4(sorted[rank - 1] ?? 0);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return round4(sorted[mid] ?? 0);
  return round4(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

export function computeArmMetrics(
  arm: QualityArm,
  corpusCases: QualityCase[],
  observations: CaseObservation[],
  complete: boolean,
  stopReason: ArmSummary["stopReason"],
): ArmSummary {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const totalCorpusCases = corpusCases.length;

  let destMatched = 0;
  let sensitiveFormsTotal = 0;
  let sensitiveFormsDetected = 0;
  let readingSensitiveFormsDetected = 0;
  let noneFormsTotal = 0;
  let noneFormsCorrect = 0;
  let readingNoneFormsCorrect = 0;
  let totalLures = 0;
  let confirmedLures = 0;
  let totalBenign = 0;
  let falsePositives = 0;
  let partialCount = 0;
  let refusedCount = 0;

  for (const item of corpusCases) {
    const obs = byId.get(item.id);
    const state = obs?.state ?? "partial";
    if (state === "partial") partialCount++;
    if (obs?.refusedByAllowance) refusedCount++;

    // Unavailable or unevaluated cases receive no accuracy credit while remaining in denominators.
    if (obs?.destinationAssessed === item.groundTruth.destination) destMatched++;

    if (item.groundTruth.form === "log_in" || item.groundTruth.form === "pay") {
      sensitiveFormsTotal++;
      if (obs?.formDetected === item.groundTruth.form) sensitiveFormsDetected++;
      if (obs?.readingFormDetected === item.groundTruth.form) readingSensitiveFormsDetected++;
    } else {
      noneFormsTotal++;
      if (obs?.formDetected === "none") noneFormsCorrect++;
      if (obs?.readingFormDetected === "none") readingNoneFormsCorrect++;
    }

    if (item.groundTruth.lure) {
      totalLures++;
      // Partial, unavailable, or refused lures remain in the denominator and count as unconfirmed misses.
      if (state === "confirmed") confirmedLures++;
    } else {
      totalBenign++;
      if (state === "confirmed") falsePositives++;
    }
  }

  const latencies = observations.map((o) => o.latencyMs);
  const reconstructedLatencies = observations.map((o) => o.reconstructedLatencyMs);
  const totalUsd = round6(observations.reduce((acc, o) => acc + o.costUsd, 0));
  const paidUsd = round6(observations.reduce((acc, o) => acc + o.paidCostUsd, 0));
  const replayedUsd = round6(observations.reduce((acc, o) => acc + o.replayedCostUsd, 0));
  const meanUsdPerCase = observations.length > 0 ? round6(totalUsd / observations.length) : 0;

  const rate = (num: number, den: number): RateMetric => ({
    numerator: num,
    denominator: den,
    rate: den > 0 ? round4(num / den) : 0,
  });

  return {
    arm,
    complete,
    stopReason,
    evaluatedCases: observations.length,
    totalCorpusCases,
    destinationAccuracy: rate(destMatched, totalCorpusCases),
    formRecall: rate(sensitiveFormsDetected, sensitiveFormsTotal),
    formSpecificity: rate(noneFormsCorrect, noneFormsTotal),
    readingFormRecall: rate(readingSensitiveFormsDetected, sensitiveFormsTotal),
    readingFormSpecificity: rate(readingNoneFormsCorrect, noneFormsTotal),
    confirmationRecall: rate(confirmedLures, totalLures),
    falsePositiveRate: rate(falsePositives, totalBenign),
    partialRate: { ...rate(partialCount, totalCorpusCases), refusedCount },
    latencyMs: {
      medianMs: median(latencies),
      p95Ms: percentileNearestRank(latencies, 95),
    },
    reconstructedLatencyMs: {
      medianMs: median(reconstructedLatencies),
      p95Ms: percentileNearestRank(reconstructedLatencies, 95),
    },
    costUsd: {
      totalUsd,
      meanUsdPerCase,
      paidUsd,
      replayedUsd,
    },
    cases: observations,
  };
}

function emptyReadingFetch(underlyingFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if (body.includes("mail_reading")) {
      return new Response(
        JSON.stringify({
          id: "ablated-reading",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    readings: [
                      {
                        image: "P1",
                        claimed_brand: null,
                        requested_action: "none",
                        urgency_cues: [],
                        visible_sender: null,
                        payment_request: false,
                        confidence: 0,
                      },
                    ],
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
        { headers: { "content-type": "application/json", "cf-aig-log-id": "ablated", "x-request-id": "ablated" } },
      );
    }
    return underlyingFetch(input, init);
  }) as typeof fetch;
}

export async function evaluateMonitorArm(
  arm: QualityArm,
  corpus: QualityCorpus,
  deps: QualityEvalDeps,
): Promise<ArmSummary> {
  const parsed = QualityCorpusSchema.parse(corpus);
  const storage = await deps.createArmStorage(arm);
  const now = deps.now ?? (() => new Date("2026-11-02T12:00:00.000Z"));
  const clockMs = deps.clockMs ?? (() => performance.now());
  const observations: CaseObservation[] = [];

  for (const item of parsed.cases) {
    if (deps.isInterrupted?.()) {
      return computeArmMetrics(arm, parsed.cases, observations, false, "interrupted");
    }
    if (deps.budget.spentUsd() >= deps.maxSpendUsd) {
      return computeArmMetrics(arm, parsed.cases, observations, false, "budget_exhausted");
    }

    const prefix = deps.orgPrefix ?? "qual";
    const orgId = `${prefix}-${arm}-${item.orgKey}`;
    const atIso = now().toISOString();
    await storage.db
      .prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, item.protectedBrand, orgId, atIso)
      .run();
    await storage.db
      .prepare("DELETE FROM org_domains WHERE domain = ? AND org_id != ?")
      .bind(item.verifiedDomain, orgId)
      .run();
    await storage.db
      .prepare(
        "INSERT OR IGNORE INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
      )
      .bind(`dom-${orgId}`, orgId, item.verifiedDomain, "t".repeat(32), atIso, atIso)
      .run();
    await storage.db
      .prepare(
        "INSERT OR IGNORE INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)",
      )
      .bind(`addr-${orgId}`, orgId, `accounts@${item.verifiedDomain}`, atIso, atIso)
      .run();

    const beforeUsd = deps.budget.spentUsd();
    const startMs = clockMs();
    let budgetStopped = false;
    let replayedUsd = 0;
    let replayedMs = 0;
    const cacheEntry = deps.stageCache ? (deps.stageCache.get(item.id) ?? {}) : undefined;
    if (deps.stageCache && cacheEntry) {
      deps.stageCache.set(item.id, cacheEntry);
    }
    let nextPipelineStage: "reading" | "logoCompare" = "reading";
    let pendingSettleStage: "reading" | "logoCompare" | null = null;
    const localReservations = new Set<string>();

    const guardedBudget: Budget = {
      ...deps.budget,
      reserve: async (model, estimateUsd, attempt, id, call) => {
        const step = (call?.owner as { step?: string } | undefined)?.step;
        const isLocalReading =
          step === "pipeline" &&
          nextPipelineStage === "reading" &&
          (arm === "no_reading" || Boolean(cacheEntry?.reading));
        const isLocalLogoCompare =
          step === "pipeline" &&
          nextPipelineStage === "logoCompare" &&
          arm !== "no_logo" &&
          Boolean(cacheEntry?.logoCompare);
        if (isLocalReading || isLocalLogoCompare) {
          const reservationId = id ?? "local-res";
          localReservations.add(reservationId);
          return reservationId;
        }
        if (deps.budget.spentUsd() + estimateUsd > deps.maxSpendUsd) {
          budgetStopped = true;
          throw new Error("quality budget cap reached");
        }
        return deps.budget.reserve(model, estimateUsd, attempt, id, call);
      },
      settle: async (id, actualUsd, meta) => {
        if (localReservations.delete(id)) return;
        if (cacheEntry && arm === "full" && pendingSettleStage) {
          const target = cacheEntry[pendingSettleStage];
          if (target) target.costUsd = round6(target.costUsd + actualUsd);
          pendingSettleStage = null;
        }
        return deps.budget.settle(id, actualUsd, meta);
      },
      uncertain: async (id, meta) => {
        if (localReservations.delete(id)) return;
        return deps.budget.uncertain(id, meta);
      },
      outputFailed: async (id, meta) => {
        if (localReservations.delete(id)) return;
        return deps.budget.outputFailed(id, meta);
      },
    };

    const guardedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : "";
      const isReadingCall = rawBody.includes("mail_reading");
      const isLogoCompareCall = rawBody.includes("logo_comparison");
      if (isReadingCall) {
        nextPipelineStage = "logoCompare";
      }
      if (arm !== "no_reading" && isReadingCall && cacheEntry?.reading) {
        replayedUsd += cacheEntry.reading.costUsd;
        replayedMs += cacheEntry.reading.ms;
        return new Response(cacheEntry.reading.body, {
          status: cacheEntry.reading.status,
          headers: { "content-type": "application/json", "cf-aig-log-id": "log-cached", "x-request-id": "req-cached" },
        });
      }
      if (arm !== "no_logo" && isLogoCompareCall && cacheEntry?.logoCompare) {
        replayedUsd += cacheEntry.logoCompare.costUsd;
        replayedMs += cacheEntry.logoCompare.ms;
        return new Response(cacheEntry.logoCompare.body, {
          status: cacheEntry.logoCompare.status,
          headers: { "content-type": "application/json", "cf-aig-log-id": "log-cached", "x-request-id": "req-cached" },
        });
      }
      if (deps.budget.spentUsd() >= deps.maxSpendUsd) {
        budgetStopped = true;
        throw new Error("quality budget cap reached");
      }
      const callBeforeUsd = deps.budget.spentUsd();
      const callStartMs = clockMs();
      const targetFetch = arm === "no_reading" ? emptyReadingFetch(deps.fetch) : deps.fetch;
      const res = await targetFetch(input, init);
      if (cacheEntry && arm === "full" && (isReadingCall || isLogoCompareCall)) {
        const cloned = await res.clone().text();
        const stageRecord = {
          body: cloned,
          status: res.status,
          costUsd: Math.max(0, deps.budget.spentUsd() - callBeforeUsd),
          ms: Math.max(0.001, clockMs() - callStartMs),
        };
        if (isReadingCall) {
          cacheEntry.reading = stageRecord;
          pendingSettleStage = "reading";
        }
        if (isLogoCompareCall) {
          cacheEntry.logoCompare = stageRecord;
          pendingSettleStage = "logoCompare";
        }
      }
      return res;
    }) as typeof fetch;

    const metaCtx: PipelineDeps["meta"] = {
      env: deps.metaEnv,
      budget: guardedBudget,
      random: () => 0.5,
      sleep: async () => {},
      fetch: guardedFetch,
    };

    const refLogoBytes = await deps.artefacts.loadReferenceLogo(item, metaCtx);
    const refLogoKey = `ident/${orgId}/logo.png`;
    await storage.bucket.put(refLogoKey, refLogoBytes);
    await storage.db
      .prepare(
        `INSERT OR REPLACE INTO identities (org_id, display_names_json, finance_contact_email, logo_r2_key, logo_media_type, protected, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, 'image/png', 1, 1, ?, 'system')`,
      )
      .bind(orgId, JSON.stringify([item.protectedBrand]), `accounts@${item.verifiedDomain}`, refLogoKey, atIso)
      .run();

    const moment = `2026-11-02T00:00:${String(observations.length).padStart(2, "0")}.000Z`;
    const captureKey = `monitor/${orgId}/${item.host}/${moment}/`;
    const candidateShot = await deps.artefacts.loadCandidateScreenshot(item);
    if (candidateShot) {
      await storage.bucket.put(`${captureKey}screenshot.jpg`, candidateShot);
    }
    const candidateText = await deps.artefacts.loadCandidateText(item);
    await storage.bucket.put(`${captureKey}text.txt`, candidateText);
    // Preserve identical capture signals across all arms so `no_reading` isolates Spark reading alone.
    await storage.bucket.put(`${captureKey}signals.json`, JSON.stringify(item.signals));

    await storage.db
      .prepare(
        `INSERT OR REPLACE INTO monitor_hosts (org_id, domain, resolves, captured_at, capture_key, capture_url, first_seen, last_seen)
         VALUES (?, ?, 1, ?, ?, ?, '2026-11-01T00:00:00.000Z', ?)`,
      )
      .bind(orgId, item.host, moment, captureKey, item.captureUrl, moment)
      .run();
    await storage.db
      .prepare(
        `INSERT OR REPLACE INTO monitor_screens (org_id, domain, capture_key, outcome, screener, brand, has_login_form,
           has_payment_form, lure, lure_type, confidence, screened_at, second_look, second_look_lure, second_look_type)
         VALUES (?, ?, ?, 'screened', 'glimmer', ?, ?, ?, 1, 'credential', 0.9, ?, 'confirmed', 1, 'credential')`,
      )
      .bind(
        orgId,
        item.host,
        captureKey,
        item.protectedBrand,
        item.signals.passwords > 0 ? 1 : 0,
        item.signals.forms > 0 && item.signals.passwords === 0 ? 1 : 0,
        moment,
      )
      .run();

    const candidateHtml = await deps.artefacts.loadCandidateHtml(item);
    const pageFetch = executableCorpusPageFetch(item, candidateHtml);

    const pipelineDeps: PipelineDeps = {
      db: storage.db,
      bucket: storage.bucket,
      store: storage.store,
      kv: storage.kv,
      meta: metaCtx,
      cropLogo:
        arm === "no_logo"
          ? async () => null
          : async (screenshot, dataUrl) => {
              if (cacheEntry?.crop) {
                replayedUsd += cacheEntry.crop.costUsd;
                replayedMs += cacheEntry.crop.ms;
                return cacheEntry.crop.result;
              }
              const cropBeforeUsd = deps.budget.spentUsd();
              const cropStartMs = clockMs();
              const result = await deps.artefacts.cropCandidateLogo(item, screenshot, dataUrl, metaCtx);
              if (cacheEntry && arm === "full") {
                cacheEntry.crop = {
                  result,
                  costUsd: Math.max(0, deps.budget.spentUsd() - cropBeforeUsd),
                  ms: Math.max(0, clockMs() - cropStartMs),
                };
              }
              return result;
            },
      walk: async (caseId: string) => {
        if (arm === "no_walkthrough") return { outcome: "walked" };
        const walkTable: BrandTable = {
          ...bundled,
          brands: [
            ...bundled.brands.filter((b) => b.name.toLowerCase() !== item.protectedBrand.toLowerCase()),
            {
              name: item.protectedBrand,
              display_names: [item.protectedBrand, item.verifiedDomain],
              domains: [item.verifiedDomain],
              user_content: [],
              sources: [
                {
                  url: `https://${item.verifiedDomain}/`,
                  read: "2026-11-02",
                  names: [item.verifiedDomain],
                  evidence: "Verified organisation domain",
                },
              ],
            },
          ],
        };
        const hasCachedWalk = Boolean(cacheEntry?.walk);
        return walkthroughStep(
          {
            db: storage.db,
            store: storage.store,
            cache: kvCache(storage.kv),
            launch: hasCachedWalk ? async () => ({ close: async () => {} }) as unknown as Browser : deps.launchBrowser,
            walk: async (browser, options) => {
              if (cacheEntry?.walk) {
                replayedUsd += cacheEntry.walk.costUsd;
                replayedMs += cacheEntry.walk.ms;
                return cacheEntry.walk.result;
              }
              const walkBeforeUsd = deps.budget.spentUsd();
              const walkStartMs = clockMs();
              const res = await walk(browser, options);
              if (cacheEntry && arm === "full") {
                cacheEntry.walk = {
                  result: {
                    ...res,
                    record: {
                      ...res.record,
                      pages: res.record.pages.map((p) => ({ ...p, screenshotKey: null })),
                      hidden: res.record.hidden.map((h) => ({ ...h, key: "" })),
                    },
                  },
                  costUsd: Math.max(0, deps.budget.spentUsd() - walkBeforeUsd),
                  ms: Math.max(0, clockMs() - walkStartMs),
                };
              }
              return res;
            },
            fetch: pageFetch,
            resolve: async () => ["93.184.215.14"],
            meta: metaCtx,
            table: walkTable,
            revision: null,
            walkId: () => `walk-${arm}-${item.id}`,
          },
          caseId,
        );
      },
      now,
    };

    await monitorPipeline(pipelineDeps, orgId, "2026-11-01T00:00:00.000Z");
    const rawElapsedMs = Math.max(0, clockMs() - startMs);
    const elapsedMs = round4(rawElapsedMs);
    const reconstructedLatencyMs = round4(rawElapsedMs + replayedMs);
    const paidCostUsd = round6(Math.max(0, deps.budget.spentUsd() - beforeUsd));
    const replayedCostUsd = round6(replayedUsd);
    const deltaUsd = round6(paidCostUsd + replayedCostUsd);

    if (budgetStopped) {
      return computeArmMetrics(arm, parsed.cases, observations, false, "budget_exhausted");
    }

    const inv = await storage.db
      .prepare("SELECT state, case_id, evidence_refs FROM monitor_investigations WHERE org_id = ? AND capture_key = ?")
      .bind(orgId, captureKey)
      .first<{
        state: "confirmed" | "unconfirmed" | "partial";
        case_id: string | null;
        evidence_refs: string | null;
      }>();

    const state = inv?.state ?? "partial";
    const refusedByAllowance = parseAllowanceRefusal(inv?.evidence_refs ?? null) !== null;
    const ev = inv?.case_id ? await readEvidence(storage.db, inv.case_id) : [];

    // Destination and form assessments are read strictly from persisted case evidence; unavailable
    // investigations (refused by allowance, missing screenshot, failed reading) remain "unavailable".
    const logoEv = ev.find((e) => e.check === "vision.logo_match");
    const logoDetail = (logoEv?.detail ?? {}) as { domain?: "official" | "mismatch" };
    const lookalikeEv = ev.find((e) => e.check === "domain.lookalike");
    const lookalikeDetail = (lookalikeEv?.detail ?? {}) as { judgement?: "official" | "mismatch" };
    const destinationAssessed: "official" | "mismatch" | "unavailable" =
      logoDetail.domain ?? lookalikeDetail.judgement ?? "unavailable";

    const assessmentUnavailable =
      refusedByAllowance || !inv?.case_id || ev.some((e) => e.check === "vision.not_checked");

    const formDetected: "log_in" | "pay" | "none" | "unavailable" = assessmentUnavailable
      ? "unavailable"
      : ev.some((e) => e.check === "link.credential_form")
        ? "log_in"
        : ev.some((e) => e.check === "link.card_form")
          ? "pay"
          : "none";

    const readingAction = (
      ev.find((e) => e.check === "vision.requested_action")?.detail as { action?: string } | undefined
    )?.action;
    const readingFormDetected: "log_in" | "pay" | "none" | "unavailable" = assessmentUnavailable
      ? "unavailable"
      : readingAction === "log_in"
        ? "log_in"
        : readingAction === "pay"
          ? "pay"
          : "none";

    observations.push({
      id: item.id,
      arm,
      state,
      refusedByAllowance,
      destinationAssessed,
      formDetected,
      readingFormDetected,
      latencyMs: elapsedMs,
      reconstructedLatencyMs,
      costUsd: deltaUsd,
      paidCostUsd,
      replayedCostUsd,
    });
  }

  return computeArmMetrics(arm, parsed.cases, observations, true, "completed");
}

export function computeAblationDeltas(
  arms: Partial<Record<QualityArm, ArmSummary>>,
): Partial<Record<Exclude<QualityArm, "full">, AblationDelta>> {
  const full = arms.full;
  if (!full) return {};
  const out: Partial<Record<Exclude<QualityArm, "full">, AblationDelta>> = {};
  for (const arm of ["no_reading", "no_logo", "no_walkthrough"] as const) {
    const sub = arms[arm];
    if (!sub) continue;
    out[arm] = {
      formRecallDelta: round4(sub.formRecall.rate - full.formRecall.rate),
      formSpecificityDelta: round4(sub.formSpecificity.rate - full.formSpecificity.rate),
      readingFormRecallDelta: round4(sub.readingFormRecall.rate - full.readingFormRecall.rate),
      readingFormSpecificityDelta: round4(sub.readingFormSpecificity.rate - full.readingFormSpecificity.rate),
      confirmationRecallDelta: round4(sub.confirmationRecall.rate - full.confirmationRecall.rate),
      falsePositiveRateDelta: round4(sub.falsePositiveRate.rate - full.falsePositiveRate.rate),
      partialRateDelta: round4(sub.partialRate.rate - full.partialRate.rate),
    };
  }
  return out;
}

export async function evaluateMonitorCorpus(
  corpus: QualityCorpus,
  deps: QualityEvalDeps,
  arms: QualityArm[] = ["full", "no_reading", "no_logo", "no_walkthrough"],
): Promise<QualityRunReport> {
  const parsed = QualityCorpusSchema.parse(corpus);
  const results = {} as Record<QualityArm, ArmSummary>;
  const stageCache = deps.stageCache ?? new Map<string, StageCacheEntry>();
  let allComplete = true;

  for (const arm of arms) {
    const summary = await evaluateMonitorArm(arm, parsed, { ...deps, stageCache });
    results[arm] = summary;
    if (!summary.complete) {
      allComplete = false;
      break;
    }
  }

  return {
    version: "1.0",
    corpusVersion: parsed.version,
    ranAt: (deps.now ?? (() => new Date()))().toISOString(),
    maxSpendUsd: deps.maxSpendUsd,
    totalSpendUsd: round6(deps.budget.spentUsd()),
    complete: allComplete && arms.every((a) => results[a]?.complete === true),
    arms: results,
    ablationDeltas: computeAblationDeltas(results),
  };
}
