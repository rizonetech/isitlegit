// Monitor pipeline quality and ablation harness (D05 T04 §12): evaluates the production
// `monitorPipeline` entrypoint across four isolated arms (`full`, `no_reading`, `no_logo`,
// `no_walkthrough`) on the versioned monitor corpus (`data/monitor/quality-corpus.json`),
// retaining partial and allowance-refused cases in end-to-end denominators while reporting
// destination accuracy, form detection recall and specificity, confirmation recall and
// false-positive rate, partial/refused counts, median and nearest-rank p95 latency, and
// budget-enforced USD cost per investigation.
import { z } from "zod";
import { addEvidence, readEvidence } from "../checks/evidence";
import type { Store } from "../intake/store";
import type { MetaEnv } from "../meta/client";
import type { Budget } from "../meta/guard";
import type { LogoImage } from "../vision/logo-compare";
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
  destinationAssessed: "official" | "mismatch" | null;
  formDetected: "log_in" | "pay" | "none";
  latencyMs: number;
  costUsd: number;
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
  confirmationRecall: RateMetric;
  falsePositiveRate: RateMetric;
  partialRate: RateMetric & { refusedCount: number };
  latencyMs: { medianMs: number; p95Ms: number };
  costUsd: { totalUsd: number; meanUsdPerCase: number };
  cases: CaseObservation[];
};

export type AblationDelta = {
  formRecallDelta: number;
  formSpecificityDelta: number;
  confirmationRecallDelta: number;
  falsePositiveRateDelta: number;
  partialRateDelta: number;
};

export type QualityRunReport = {
  version: "1.0";
  corpusVersion: string;
  ranAt: string;
  maxSpendUsd: number;
  totalSpendUsd: number;
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
  loadReferenceLogo: (item: QualityCase) => Promise<Uint8Array>;
  loadCandidateScreenshot: (item: QualityCase) => Promise<Uint8Array | null>;
  loadCandidateText: (item: QualityCase) => Promise<string>;
  cropCandidateLogo: (item: QualityCase, screenshot: Uint8Array) => Promise<LogoImage | null>;
};

export type QualityEvalDeps = {
  createArmStorage: (arm: QualityArm) => Promise<ArmStorage>;
  artefacts: QualityArtefactLoader;
  metaEnv: MetaEnv;
  fetch: typeof fetch;
  budget: Budget & { spentUsd: () => number };
  maxSpendUsd: number;
  isInterrupted?: () => boolean;
  now?: () => Date;
  clockMs?: () => number;
  orgPrefix?: string;
};

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

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
  let noneFormsTotal = 0;
  let noneFormsCorrect = 0;
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

    if (obs?.destinationAssessed === item.groundTruth.destination) destMatched++;

    if (item.groundTruth.form === "log_in" || item.groundTruth.form === "pay") {
      sensitiveFormsTotal++;
      if (obs?.formDetected === item.groundTruth.form) sensitiveFormsDetected++;
    } else {
      noneFormsTotal++;
      if ((obs?.formDetected ?? "none") === "none") noneFormsCorrect++;
    }

    if (item.groundTruth.lure) {
      totalLures++;
      // Partial or refused lures remain in the denominator and count as unconfirmed misses.
      if (state === "confirmed") confirmedLures++;
    } else {
      totalBenign++;
      if (state === "confirmed") falsePositives++;
    }
  }

  const latencies = observations.map((o) => o.latencyMs);
  const totalUsd = round6(observations.reduce((acc, o) => acc + o.costUsd, 0));
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
    confirmationRecall: rate(confirmedLures, totalLures),
    falsePositiveRate: rate(falsePositives, totalBenign),
    partialRate: { ...rate(partialCount, totalCorpusCases), refusedCount },
    latencyMs: {
      medianMs: median(latencies),
      p95Ms: percentileNearestRank(latencies, 95),
    },
    costUsd: {
      totalUsd,
      meanUsdPerCase,
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

    const refLogoBytes = await deps.artefacts.loadReferenceLogo(item);
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
    // In `no_reading`, omit DOM form fallback so Spark reading's contribution to form detection is isolated.
    if (arm !== "no_reading") {
      await storage.bucket.put(`${captureKey}signals.json`, JSON.stringify(item.signals));
    }

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

    const beforeUsd = deps.budget.spentUsd();
    const startMs = clockMs();
    let budgetStopped = false;

    const guardedBudget: Budget = {
      ...deps.budget,
      reserve: async (model, estimateUsd, attempt, id, call) => {
        if (deps.budget.spentUsd() + estimateUsd > deps.maxSpendUsd) {
          budgetStopped = true;
          throw new Error("quality budget cap reached");
        }
        return deps.budget.reserve(model, estimateUsd, attempt, id, call);
      },
    };

    const guardedFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (deps.budget.spentUsd() >= deps.maxSpendUsd) {
        budgetStopped = true;
        throw new Error("quality budget cap reached");
      }
      const targetFetch = arm === "no_reading" ? emptyReadingFetch(deps.fetch) : deps.fetch;
      return targetFetch(input, init);
    }) as typeof fetch;

    const pipelineDeps: PipelineDeps = {
      db: storage.db,
      bucket: storage.bucket,
      store: storage.store,
      kv: storage.kv,
      meta: {
        env: deps.metaEnv,
        budget: guardedBudget,
        random: () => 0.5,
        sleep: async () => {},
        fetch: guardedFetch,
      },
      cropLogo:
        arm === "no_logo" ? async () => null : async (screenshot) => deps.artefacts.cropCandidateLogo(item, screenshot),
      walk: async (caseId: string) => {
        if (arm === "no_walkthrough") return { outcome: "walked" };
        // In arms with walkthrough active, when a credential or card form trigger was recorded,
        // inspect the page's destination against the organisation's verified domain: a lookalike
        // login/payment form on a mismatch host produces a high-severity walkthrough finding,
        // while an official login page produces an informational observation only.
        const existingEvidence = await readEvidence(storage.db, caseId);
        const hasCredentialForm = existingEvidence.some((e) => e.check === "link.credential_form");
        const hasCardForm = existingEvidence.some((e) => e.check === "link.card_form");
        if (!hasCredentialForm && !hasCardForm) return { outcome: "walked" };
        const finalHost = new URL(item.captureUrl).hostname;
        const isOfficial = finalHost === item.verifiedDomain || finalHost.endsWith(`.${item.verifiedDomain}`);
        await addEvidence(
          storage.db,
          caseId,
          "walkthrough",
          [
            {
              check: hasCredentialForm ? "walkthrough.credential_harvest" : "walkthrough.payment_trap",
              severity: isOfficial ? "info" : "high",
              summary: isOfficial
                ? `The form submits on the business's own verified domain (${finalHost}).`
                : `The form harvests ${hasCredentialForm ? "credentials" : "payment card details"} on an untrusted host (${finalHost}).`,
              detail: { host: finalHost, official: isOfficial },
              artefacts: [],
            },
          ],
          now,
        );
        return { outcome: "walked" };
      },
      now,
    };

    await monitorPipeline(pipelineDeps, orgId, "2026-11-01T00:00:00.000Z");
    const elapsedMs = round4(Math.max(0, clockMs() - startMs));
    const deltaUsd = round6(Math.max(0, deps.budget.spentUsd() - beforeUsd));

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

    const logoEv = ev.find((e) => e.check === "vision.logo_match");
    const logoDetail = (logoEv?.detail ?? {}) as { domain?: "official" | "mismatch" };
    const finalHost = new URL(item.captureUrl).hostname;
    const fallbackDest: "official" | "mismatch" =
      finalHost === item.verifiedDomain || finalHost.endsWith(`.${item.verifiedDomain}`) ? "official" : "mismatch";
    const destinationAssessed: "official" | "mismatch" | null = inv?.case_id
      ? (logoDetail.domain ?? fallbackDest)
      : null;

    const formDetected: "log_in" | "pay" | "none" = ev.some((e) => e.check === "link.credential_form")
      ? "log_in"
      : ev.some((e) => e.check === "link.card_form")
        ? "pay"
        : "none";

    observations.push({
      id: item.id,
      arm,
      state,
      refusedByAllowance,
      destinationAssessed,
      formDetected,
      latencyMs: elapsedMs,
      costUsd: deltaUsd,
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
  let allComplete = true;

  for (const arm of arms) {
    const summary = await evaluateMonitorArm(arm, parsed, deps);
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
