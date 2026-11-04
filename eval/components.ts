import { renameSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { COMPONENTS_HEADING, writeResultsSection } from "./results-file.ts";

// Writes JSON to a temporary sibling file and atomically renames it into place so a failed write
// never truncates or corrupts previously persisted observations (D08 T02 §8 correction 6).
export function atomicWriteJson(
  outPath: string,
  data: unknown,
  writer: (path: string, content: string) => void = writeFileSync,
): void {
  const tmpPath = `${outPath}.${process.pid}.tmp`;
  try {
    writer(tmpPath, `${JSON.stringify(data, null, 1)}\n`);
    renameSync(tmpPath, outPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

// Component measurements (D08 T02 section 8): exact arithmetic over persisted measurement records.
// A record set with no eligible rows reads `not measured` (null), never zero. Records are JSON files under
// eval/components/ written by each experiment; `--check` in eval/metrics.ts refuses a RESULTS.md figure
// that differs from the records it was computed from, or a record file whose summary disagrees with its
// underlying observations.
export type Provenance = {
  collector: string;
  timingBoundary: string;
  repetitions: number;
  inputDescription: string;
};

export type CacheRecord = { hit: boolean; ms: number; avoidedUsd: number | null };
export type ProviderRecord = { provider: string; checked: boolean; listed: boolean; genuine: boolean };
export type WalkRecord = { completed: boolean; costUsd: number };
export type FloorRecord = { before: string; after: string; attack: boolean };

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const p95 = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] as number;
};

export function cacheFigures(records: CacheRecord[]) {
  const hits = records.filter((r) => r.hit);
  const misses = records.filter((r) => !r.hit);
  const avoided = hits.filter((r) => r.avoidedUsd !== null);
  return {
    rows: records.length,
    hits: hits.length,
    misses: misses.length,
    hitRate: records.length ? hits.length / records.length : null,
    hitMedianMs: median(hits.map((r) => r.ms)),
    hitP95Ms: p95(hits.map((r) => r.ms)),
    missMedianMs: median(misses.map((r) => r.ms)),
    missP95Ms: p95(misses.map((r) => r.ms)),
    // Avoided spend only over hits whose baseline was recorded; a zero-cost hit record is not zero avoided.
    avoidedUsd: avoided.length ? avoided.reduce((a, r) => a + (r.avoidedUsd ?? 0), 0) : null,
    avoidedRows: avoided.length,
  };
}

export function providerFigures(records: ProviderRecord[]) {
  const by = new Map<string, ProviderRecord[]>();
  for (const r of records) by.set(r.provider, [...(by.get(r.provider) ?? []), r]);
  return [...by.entries()].map(([provider, rows]) => {
    const checkedGenuine = rows.filter((r) => r.checked && r.genuine);
    return {
      provider,
      checked: rows.filter((r) => r.checked).length,
      unchecked: rows.filter((r) => !r.checked).length,
      genuineChecked: checkedGenuine.length,
      falsePositiveRate: checkedGenuine.length
        ? checkedGenuine.filter((r) => r.listed).length / checkedGenuine.length
        : null,
    };
  });
}

export function walkthroughCost(records: WalkRecord[]) {
  const done = records.filter((r) => r.completed);
  return {
    completed: done.length,
    attempted: records.length - done.length,
    medianCostUsd: median(done.map((r) => r.costUsd)),
  };
}

const DETECTED = new Set(["suspicious", "malicious"]);
export function floorFigures(records: FloorRecord[]) {
  const raised = records.filter((r) => r.before !== r.after);
  return {
    rows: records.length,
    raised: raised.length,
    addedDetections: raised.filter((r) => r.attack && !DETECTED.has(r.before) && DETECTED.has(r.after)).length,
    causedFalsePositives: raised.filter((r) => !r.attack && !DETECTED.has(r.before) && DETECTED.has(r.after)).length,
  };
}

export type InvisibleObservation = {
  name: string;
  kind: "payload" | "control" | "large-message";
  detected: boolean;
  ms: number | null;
  peakMb?: number | null;
  status: "ok" | "failed";
};

export type InvisibleSummary = {
  payloads: number;
  detected: number;
  controls: number;
  falsePositives: number;
  largeMessageRuns?: number;
  p50Ms: number | null;
  p95Ms: number | null;
  peakMb: number | null;
  largeMessageMs?: number | null;
  observations?: InvisibleObservation[];
  provenance?: Provenance;
};

export type AiObservation = {
  name: string;
  kind: "injection" | "genuine";
  detected: boolean;
  checkStepMs: number | null;
  status: "ok" | "failed";
};

export type AiSummary = {
  injections: number;
  detected: number;
  genuine: number;
  falsePositives: number;
  p50Ms?: number | null;
  p95Ms?: number | null;
  observations?: AiObservation[];
  provenance?: Provenance;
};

export type AttachmentObservation = {
  name: string;
  category: "valid" | "disguised" | "archive-risk" | "damaged" | "batch-check";
  expected?: string | undefined;
  sniffed?: string | null | undefined;
  matched: boolean;
  isArchive?: boolean | undefined;
  isBenignValid?: boolean | undefined;
  mismatchFlagged?: boolean | undefined;
  riskFlagged?: boolean | undefined;
  riskNotChecked?: string | null | undefined;
  ms?: number | null | undefined;
  status: "ok" | "failed";
};

export type AttachmentsSummary = {
  valid: number;
  identified: number;
  typeMismatchFalsePositives?: number;
  benignValid?: number;
  archiveFalsePositives?: number;
  disguised: number;
  disguisedCaught: number;
  mismatchCaught?: number;
  archiveChecks?: number;
  archiveRiskCaught?: number;
  damaged: number;
  damagedReadAsValid: number;
  damagedArchives?: number;
  damagedArchiveCaught?: number;
  p50Ms?: number | null;
  p95Ms?: number | null;
  observations?: AttachmentObservation[];
  provenance?: Provenance;
};

export type IntakeRecord = {
  band: "small" | "near-25mib";
  bytes: number;
  ms: number | null;
  status?: "ok" | "failed";
  sampleId?: string;
  expectedBandTotal?: number;
  provenance?: string;
};

export function intakeFigures(records: IntakeRecord[]) {
  const bandOf = (band: "small" | "near-25mib") => {
    const all = records.filter((r) => r.band === band);
    const ok = all.filter((r) => r.status !== "failed" && r.ms !== null);
    const times = ok.map((r) => r.ms as number);
    const expected = all.reduce((m, r) => Math.max(m, r.expectedBandTotal ?? 0), all.length);
    const total = Math.max(all.length, expected);
    return {
      total,
      completed: ok.length,
      failed: Math.max(0, total - ok.length),
      medianMs: median(times),
      p95Ms: p95(times),
    };
  };
  return {
    small: bandOf("small"),
    near25Mib: bandOf("near-25mib"),
  };
}

export const RETRY_TARGETS = {
  medianUnderMs: 60_000,
  p95UnderMs: 180_000,
} as const;

export type RetryRecord = {
  kind: "retry" | "interrupted-settle";
  ms: number | null;
  completed: boolean;
  leaseWindowMs?: number;
  expectedTotal?: number;
  provenance?: string;
};

export function retryFigures(records: RetryRecord[]) {
  const retries = records.filter((r) => r.kind === "retry");
  const retryDone = retries.filter((r) => r.completed && r.ms !== null);
  const retryTimes = retryDone.map((r) => r.ms as number);
  const retryMedianMs = median(retryTimes);
  const retryP95Ms = p95(retryTimes);
  const retryTotal = retries.reduce((m, r) => Math.max(m, r.expectedTotal ?? 0), retries.length);
  const retryIncomplete = Math.max(0, retryTotal - retryDone.length);
  const targetState: "met" | "missed" | "incomplete" | "not measured" =
    retryDone.length === 0
      ? "not measured"
      : retryIncomplete > 0
        ? "incomplete"
        : (retryMedianMs as number) < RETRY_TARGETS.medianUnderMs && (retryP95Ms as number) < RETRY_TARGETS.p95UnderMs
          ? "met"
          : "missed";

  const settles = records.filter((r) => r.kind === "interrupted-settle");
  const settleDone = settles.filter((r) => r.completed && r.ms !== null);
  const settleTimes = settleDone.map((r) => r.ms as number);
  const settleTotal = settles.reduce((m, r) => Math.max(m, r.expectedTotal ?? 0), settles.length);
  const settleIncomplete = Math.max(0, settleTotal - settleDone.length);
  const leaseWindowMs = settleDone.find((r) => r.leaseWindowMs !== undefined)?.leaseWindowMs ?? 300_000;
  return {
    retryTotal,
    retryCompleted: retryDone.length,
    retryIncomplete,
    retryMedianMs,
    retryP95Ms,
    targetState,
    settleTotal,
    settleCompleted: settleDone.length,
    settleIncomplete,
    settleMedianMs: median(settleTimes),
    settleP95Ms: p95(settleTimes),
    leaseWindowMs,
  };
}

export type ComparatorRecord = {
  name: string;
  evaluated: number;
  attacks: number;
  detected: number;
  genuine: number;
  falsePositives: number;
  medianMs: number | null;
};

export function comparatorFigures(records: ComparatorRecord[]) {
  return records.map((r) => ({
    name: r.name,
    evaluated: r.evaluated,
    detectionRate: r.attacks > 0 && r.evaluated > 0 ? r.detected / r.attacks : null,
    falsePositiveRate: r.genuine > 0 && r.evaluated > 0 ? r.falsePositives / r.genuine : null,
    detected: r.detected,
    attacks: r.attacks,
    falsePositives: r.falsePositives,
    genuine: r.genuine,
    medianMs: r.evaluated > 0 ? r.medianMs : null,
  }));
}

export type ComponentRecords = {
  cache?: CacheRecord[];
  providers?: ProviderRecord[];
  walkthrough?: WalkRecord[];
  floor?: FloorRecord[];
  comparators?: ComparatorRecord[];
  intake?: IntakeRecord[];
  retry?: RetryRecord[];
  invisible?: InvisibleSummary;
  ai?: AiSummary;
  attachments?: AttachmentsSummary;
};

const ProvenanceSchema = z.object({
  collector: z.string().min(1),
  timingBoundary: z.string().min(1),
  repetitions: z.number().int().positive(),
  inputDescription: z.string().min(1),
});

export const COMPONENT_SCHEMAS = {
  cache: z.array(z.object({ hit: z.boolean(), ms: z.number().nonnegative(), avoidedUsd: z.number().nullable() })),
  providers: z.array(
    z.object({ provider: z.string().min(1), checked: z.boolean(), listed: z.boolean(), genuine: z.boolean() }),
  ),
  walkthrough: z.array(z.object({ completed: z.boolean(), costUsd: z.number().nonnegative() })),
  floor: z.array(z.object({ before: z.string().min(1), after: z.string().min(1), attack: z.boolean() })),
  comparators: z.array(
    z.object({
      name: z.string().min(1),
      evaluated: z.number().int().nonnegative(),
      attacks: z.number().int().nonnegative(),
      detected: z.number().int().nonnegative(),
      genuine: z.number().int().nonnegative(),
      falsePositives: z.number().int().nonnegative(),
      medianMs: z.number().nonnegative().nullable(),
    }),
  ),
  intake: z.array(
    z.object({
      band: z.enum(["small", "near-25mib"]),
      bytes: z.number().int().positive(),
      ms: z.number().nonnegative().nullable(),
      status: z.enum(["ok", "failed"]).optional(),
      sampleId: z.string().optional(),
      expectedBandTotal: z.number().int().positive().optional(),
      provenance: z.string().optional(),
    }),
  ),
  retry: z.array(
    z.object({
      kind: z.enum(["retry", "interrupted-settle"]),
      ms: z.number().nonnegative().nullable(),
      completed: z.boolean(),
      leaseWindowMs: z.number().int().nonnegative().optional(),
      expectedTotal: z.number().int().positive().optional(),
      provenance: z.string().optional(),
    }),
  ),
  invisible: z.object({
    payloads: z.number().int().nonnegative(),
    detected: z.number().int().nonnegative(),
    controls: z.number().int().nonnegative(),
    falsePositives: z.number().int().nonnegative(),
    largeMessageRuns: z.number().int().nonnegative().optional(),
    p50Ms: z.number().nonnegative().nullable(),
    p95Ms: z.number().nonnegative().nullable(),
    peakMb: z.number().nonnegative().nullable(),
    largeMessageMs: z.number().nonnegative().nullable().optional(),
    observations: z
      .array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(["payload", "control", "large-message"]),
          detected: z.boolean(),
          ms: z.number().nonnegative().nullable(),
          peakMb: z.number().nonnegative().nullable().optional(),
          status: z.enum(["ok", "failed"]),
        }),
      )
      .optional(),
    provenance: ProvenanceSchema.optional(),
  }),
  ai: z.object({
    injections: z.number().int().nonnegative(),
    detected: z.number().int().nonnegative(),
    genuine: z.number().int().nonnegative(),
    falsePositives: z.number().int().nonnegative(),
    p50Ms: z.number().nonnegative().nullable().optional(),
    p95Ms: z.number().nonnegative().nullable().optional(),
    observations: z
      .array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(["injection", "genuine"]),
          detected: z.boolean(),
          checkStepMs: z.number().nonnegative().nullable(),
          status: z.enum(["ok", "failed"]),
        }),
      )
      .optional(),
    provenance: ProvenanceSchema.optional(),
  }),
  attachments: z.object({
    valid: z.number().int().nonnegative(),
    identified: z.number().int().nonnegative(),
    typeMismatchFalsePositives: z.number().int().nonnegative().optional(),
    benignValid: z.number().int().nonnegative().optional(),
    archiveFalsePositives: z.number().int().nonnegative().optional(),
    disguised: z.number().int().nonnegative(),
    disguisedCaught: z.number().int().nonnegative(),
    mismatchCaught: z.number().int().nonnegative().optional(),
    archiveChecks: z.number().int().nonnegative().optional(),
    archiveRiskCaught: z.number().int().nonnegative().optional(),
    damaged: z.number().int().nonnegative(),
    damagedReadAsValid: z.number().int().nonnegative(),
    damagedArchives: z.number().int().nonnegative().optional(),
    damagedArchiveCaught: z.number().int().nonnegative().optional(),
    p50Ms: z.number().nonnegative().nullable().optional(),
    p95Ms: z.number().nonnegative().nullable().optional(),
    observations: z
      .array(
        z.object({
          name: z.string().min(1),
          category: z.enum(["valid", "disguised", "archive-risk", "damaged", "batch-check"]),
          expected: z.string().optional(),
          sniffed: z.string().nullable().optional(),
          matched: z.boolean(),
          isArchive: z.boolean().optional(),
          isBenignValid: z.boolean().optional(),
          mismatchFlagged: z.boolean().optional(),
          riskFlagged: z.boolean().optional(),
          riskNotChecked: z.string().nullable().optional(),
          ms: z.number().nonnegative().nullable().optional(),
          status: z.enum(["ok", "failed"]),
        }),
      )
      .optional(),
    provenance: ProvenanceSchema.optional(),
  }),
} as const;

export function parseComponentFile<K extends keyof ComponentRecords>(
  name: K,
  raw: unknown,
): { ok: true; value: NonNullable<ComponentRecords[K]> } | { ok: false; error: string } {
  const schema = COMPONENT_SCHEMAS[name];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: `${name}.json schema invalid: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  }
  return { ok: true, value: parsed.data as unknown as NonNullable<ComponentRecords[K]> };
}

// Recomputes summary counts and timings from raw observations whenever observations are present,
// refusing a summary that disagrees with its underlying observations or drops expected repetitions.
export function validateComponentRecords(records: ComponentRecords): string[] {
  const problems: string[] = [];
  if (records.ai?.observations) {
    const obs = records.ai.observations;
    const inj = obs.filter((o) => o.kind === "injection");
    const gen = obs.filter((o) => o.kind === "genuine");
    const det = inj.filter((o) => o.status === "ok" && o.detected).length;
    const fp = gen.filter((o) => o.status === "ok" && o.detected).length;
    const expectedTotal = Math.max(
      records.ai.injections + records.ai.genuine,
      records.ai.provenance?.repetitions ?? 0,
    );
    if (records.ai.injections === 0 || records.ai.genuine === 0) {
      problems.push(`ai.json is missing required steering or genuine denominator (${records.ai.injections} injections, ${records.ai.genuine} genuine)`);
    }
    if (records.ai.provenance && records.ai.injections + records.ai.genuine !== records.ai.provenance.repetitions) {
      problems.push(`ai.json denominators (${records.ai.injections} + ${records.ai.genuine}) disagree with provenance.repetitions (${records.ai.provenance.repetitions})`);
    }
    if (obs.length < expectedTotal && obs.filter((o) => o.status === "failed").length === 0) {
      problems.push(`ai.json observations (${obs.length}) are fewer than expected (${expectedTotal}) without recording failed/interrupted status`);
    }
    if (inj.length !== records.ai.injections || det !== records.ai.detected) {
      problems.push(`ai.json summary (${records.ai.detected}/${records.ai.injections}) disagrees with observations (${det}/${inj.length})`);
    }
    if (gen.length !== records.ai.genuine || fp !== records.ai.falsePositives) {
      problems.push(`ai.json falsePositives (${records.ai.falsePositives}/${records.ai.genuine}) disagrees with observations (${fp}/${gen.length})`);
    }
  }
  if (records.attachments?.observations) {
    const obs = records.attachments.observations;
    const valid = obs.filter((o) => o.category === "valid");
    const idOk = valid.filter((o) => o.status === "ok" && o.matched).length;
    const mismatchFp = valid.filter((o) => o.status === "ok" && o.mismatchFlagged).length;
    const benignValid = valid.filter((o) => o.isBenignValid);
    const archiveFp = benignValid.filter((o) => o.status === "ok" && o.riskFlagged).length;
    const disg = obs.filter((o) => o.category === "disguised");
    const disgOk = disg.filter((o) => o.status === "ok" && o.matched).length;
    const mismatchOk = disg.filter((o) => o.status === "ok" && o.mismatchFlagged).length;
    const arch = obs.filter((o) => o.category === "archive-risk");
    const archOk = arch.filter((o) => o.status === "ok" && o.riskFlagged).length;
    const dam = obs.filter((o) => o.category === "damaged");
    const damRead = dam.filter((o) => o.status === "ok" && o.matched).length;
    const damArch = dam.filter((o) => o.isArchive);
    const damArchCaught = damArch.filter((o) => o.status === "ok" && Boolean(o.riskNotChecked)).length;
    const expectedTotal = Math.max(
      records.attachments.valid +
        records.attachments.disguised +
        records.attachments.damaged +
        (records.attachments.archiveChecks ?? 0),
      records.attachments.provenance?.repetitions ?? 0,
    );
    if (obs.length < expectedTotal && obs.filter((o) => o.status === "failed").length === 0) {
      problems.push(`attachments.json observations (${obs.length}) are fewer than expected (${expectedTotal}) without recording failed/interrupted status`);
    }
    if (valid.length !== records.attachments.valid || idOk !== records.attachments.identified) {
      problems.push(`attachments.json valid summary (${records.attachments.identified}/${records.attachments.valid}) disagrees with observations (${idOk}/${valid.length})`);
    }
    if (
      records.attachments.typeMismatchFalsePositives !== undefined &&
      mismatchFp !== records.attachments.typeMismatchFalsePositives
    ) {
      problems.push(`attachments.json typeMismatchFalsePositives disagrees with observations`);
    }
    if (
      records.attachments.archiveFalsePositives !== undefined &&
      archiveFp !== records.attachments.archiveFalsePositives
    ) {
      problems.push(`attachments.json archiveFalsePositives disagrees with observations`);
    }
    if (disg.length !== records.attachments.disguised || disgOk !== records.attachments.disguisedCaught) {
      problems.push(`attachments.json disguised summary disagrees with observations`);
    }
    if (records.attachments.mismatchCaught !== undefined && mismatchOk !== records.attachments.mismatchCaught) {
      problems.push(`attachments.json mismatchCaught disagrees with observations`);
    }
    if (records.attachments.archiveRiskCaught !== undefined && archOk !== records.attachments.archiveRiskCaught) {
      problems.push(`attachments.json archiveRiskCaught disagrees with observations`);
    }
    if (dam.length !== records.attachments.damaged || damRead !== records.attachments.damagedReadAsValid) {
      problems.push(`attachments.json damaged summary disagrees with observations`);
    }
    if (
      records.attachments.damagedArchiveCaught !== undefined &&
      damArchCaught !== records.attachments.damagedArchiveCaught
    ) {
      problems.push(`attachments.json damagedArchiveCaught (${records.attachments.damagedArchiveCaught}) disagrees with archive observations (${damArchCaught}/${damArch.length})`);
    }
  }
  if (records.invisible?.observations) {
    const obs = records.invisible.observations;
    const pay = obs.filter((o) => o.kind === "payload");
    const ctl = obs.filter((o) => o.kind === "control");
    const large = obs.filter((o) => o.kind === "large-message");
    const det = pay.filter((o) => o.status === "ok" && o.detected).length;
    const fp = ctl.filter((o) => o.status === "ok" && o.detected).length;
    const expectedTotal = Math.max(
      records.invisible.payloads + records.invisible.controls + (records.invisible.largeMessageRuns ?? 0),
      records.invisible.provenance?.repetitions ?? 0,
    );
    if (records.invisible.payloads === 0 || records.invisible.controls === 0) {
      problems.push(`invisible.json is missing payload or control denominator`);
    }
    if (obs.length < expectedTotal && obs.filter((o) => o.status === "failed").length === 0) {
      problems.push(`invisible.json observations (${obs.length}) are fewer than expected (${expectedTotal}) without recording failed/interrupted status`);
    }
    if (pay.length !== records.invisible.payloads || det !== records.invisible.detected) {
      problems.push(`invisible.json payload summary (${records.invisible.detected}/${records.invisible.payloads}) disagrees with observations (${det}/${pay.length})`);
    }
    if (ctl.length !== records.invisible.controls || fp !== records.invisible.falsePositives) {
      problems.push(`invisible.json control summary disagrees with observations`);
    }
    if (large.length > 0) {
      const largeOk = large.filter((o) => o.status === "ok" && o.ms !== null);
      const times = largeOk.map((o) => o.ms as number).sort((a, b) => a - b);
      const at = (q: number) =>
        times.length ? (times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)] as number) : null;
      if (at(0.5) !== records.invisible.p50Ms || at(0.95) !== records.invisible.p95Ms) {
        problems.push(`invisible.json 1 MiB timing (p50 ${records.invisible.p50Ms}, p95 ${records.invisible.p95Ms}) disagrees with large-message observations`);
      }
      const peaks = largeOk.map((o) => o.peakMb).filter((x): x is number => typeof x === "number");
      const maxPeak = peaks.length ? Math.max(...peaks) : null;
      if (maxPeak !== records.invisible.peakMb) {
        problems.push(`invisible.json peakMb (${records.invisible.peakMb}) disagrees with large-message observations (${maxPeak})`);
      }
    }
  }
  return problems;
}

export function renderComponentRows(records: ComponentRecords): string {
  const lines: string[] = [];
  const c = cacheFigures(records.cache ?? []);
  const hitText =
    c.hitRate === null ? "not measured" : `${(100 * c.hitRate).toFixed(1)}% hits (${c.hits} hits, ${c.misses} misses)`;
  const avoidedText = c.avoidedUsd === null ? "not measured" : `US$${c.avoidedUsd.toFixed(4)}`;
  lines.push(
    `| Result cache | ${hitText} (${c.rows} rows), hit median ${c.hitMedianMs ?? "not measured"} ms (p95 ${c.hitP95Ms ?? "not measured"} ms), miss median ${c.missMedianMs ?? "not measured"} ms (p95 ${c.missP95Ms ?? "not measured"} ms), avoided ${avoidedText} |`,
  );
  const provs = providerFigures(records.providers ?? []);
  if (provs.length === 0) {
    lines.push(
      "| Reputation providers | not measured (0 rows; per-provider checked/unchecked rates populate from reputation_results) |",
    );
  } else {
    for (const p of provs)
      lines.push(
        `| Provider ${p.provider} | false positives ${p.falsePositiveRate === null ? "not measured" : `${(100 * p.falsePositiveRate).toFixed(1)}%`} over ${p.genuineChecked} checked genuine (${p.unchecked} unchecked) |`,
      );
  }
  const w = walkthroughCost(records.walkthrough ?? []);
  lines.push(
    `| Walkthrough cost | median ${w.medianCostUsd === null ? "not measured" : `US$${w.medianCostUsd.toFixed(4)}`} over ${w.completed} completed (${w.attempted} attempted or failed) |`,
  );
  const f = floorFigures(records.floor ?? []);
  lines.push(
    f.rows === 0
      ? "| Deterministic floor | not measured (0 rows; pre-floor verdict persistence pending D04 agent owner) |"
      : `| Deterministic floor | raised ${f.raised} of ${f.rows}, added detections ${f.addedDetections}, caused false positives ${f.causedFalsePositives} |`,
  );
  const comps = comparatorFigures(records.comparators ?? []);
  if (comps.length === 0) {
    lines.push(
      "| Comparator Microsoft Defender for Office 365 | absent (not measured; no licensed comparator tenant available, no figures invented) |",
    );
  } else {
    for (const comp of comps) {
      lines.push(
        comp.evaluated === 0
          ? `| Comparator ${comp.name} | absent (not measured; no figures invented) |`
          : `| Comparator ${comp.name} | detection ${comp.detectionRate === null ? "not measured" : `${(100 * comp.detectionRate).toFixed(1)}%`} (${comp.detected} of ${comp.attacks}), false positives ${comp.falsePositiveRate === null ? "not measured" : `${(100 * comp.falsePositiveRate).toFixed(1)}%`} (${comp.falsePositives} of ${comp.genuine}), median ${comp.medianMs ?? "not measured"} ms (${comp.evaluated} evaluated) |`,
      );
    }
  }
  const intake = intakeFigures(records.intake ?? []);
  const bandText = (b: ReturnType<typeof intakeFigures>["small"]) =>
    b.completed === 0
      ? `not measured (0 of ${b.total} completed)`
      : `median ${b.medianMs} ms, p95 ${b.p95Ms} ms (${b.completed} of ${b.total} completed${b.failed > 0 ? `, incomplete: ${b.failed} failed` : ""})`;
  lines.push(`| Intake time | small ${bandText(intake.small)}; near-25MiB ${bandText(intake.near25Mib)} |`);
  const retry = retryFigures(records.retry ?? []);
  const retryText =
    retry.retryCompleted === 0
      ? `not measured (0 of ${retry.retryTotal} completed; target median < 60000 ms, p95 < 180000 ms)`
      : `median ${retry.retryMedianMs} ms, p95 ${retry.retryP95Ms} ms (${retry.retryCompleted} of ${retry.retryTotal} completed, target ${retry.targetState})`;
  const settleText =
    retry.settleCompleted === 0
      ? `not measured (0 of ${retry.settleTotal} completed)`
      : `local sweep microbenchmark median ${retry.settleMedianMs} ms, p95 ${retry.settleP95Ms} ms (injected clock across ${retry.leaseWindowMs} ms lease; ${retry.settleCompleted} of ${retry.settleTotal} completed${retry.settleIncomplete > 0 ? `, incomplete: ${retry.settleIncomplete} failed` : ""})`;
  lines.push(`| Retry latency | retry ${retryText}; interrupted settle ${settleText} |`);
  const ai = records.ai;
  const aiExpected = ai ? Math.max(ai.injections + ai.genuine, ai.provenance?.repetitions ?? 0) : 0;
  const aiOk = ai?.observations ? ai.observations.filter((o) => o.status === "ok").length : aiExpected;
  const aiMissingCat = ai && (ai.injections === 0 || ai.genuine === 0) ? 1 : 0;
  const aiFailed = ai?.observations
    ? Math.max(
        ai.observations.filter((o) => o.status === "failed").length,
        aiExpected - aiOk,
        aiMissingCat,
      )
    : aiMissingCat;
  const aiTiming =
    ai?.p50Ms !== undefined && ai?.p50Ms !== null ? `, p50 ${ai.p50Ms} ms, p95 ${ai.p95Ms ?? "not measured"} ms` : "";
  lines.push(
    ai
      ? `| content.ai_instructions | detected ${ai.detected} of ${ai.injections} steering texts, false positives ${ai.falsePositives} of ${ai.genuine} genuine texts${aiTiming}${aiFailed > 0 ? ` (incomplete: ${aiFailed} failed)` : ""} |`
      : "| content.ai_instructions | not measured |",
  );
  const at = records.attachments;
  const atExpected = at
    ? Math.max(
        at.valid + at.disguised + at.damaged + (at.archiveChecks ?? 0),
        at.provenance?.repetitions ?? 0,
      )
    : 0;
  const atOk = at?.observations ? at.observations.filter((o) => o.status === "ok").length : atExpected;
  const atFailed = at?.observations
    ? Math.max(at.observations.filter((o) => o.status === "failed").length, atExpected - atOk)
    : 0;
  const atChecks =
    at?.mismatchCaught !== undefined
      ? `, type_mismatch caught ${at.mismatchCaught} of ${at.disguised} (false positives ${at.typeMismatchFalsePositives ?? 0} of ${at.valid}), archive risks caught ${at.archiveRiskCaught ?? 0} of ${at.archiveChecks ?? 0} (false positives ${at.archiveFalsePositives ?? 0} of ${at.benignValid ?? at.valid}), damaged archives caught ${at.damagedArchiveCaught ?? 0} of ${at.damagedArchives ?? 1}`
      : "";
  const atTiming =
    at?.p50Ms !== undefined && at?.p50Ms !== null ? `, p50 ${at.p50Ms} ms, p95 ${at.p95Ms ?? "not measured"} ms` : "";
  lines.push(
    at
      ? `| Attachment identification | identified ${at.identified} of ${at.valid} valid, disguised caught ${at.disguisedCaught} of ${at.disguised}, damaged read as valid ${at.damagedReadAsValid} of ${at.damaged}${atChecks}${atTiming}${atFailed > 0 ? ` (incomplete: ${atFailed} failed)` : ""} |`
      : "| Attachment identification | not measured |",
  );
  const inv = records.invisible;
  const invExpected = inv
    ? Math.max(inv.payloads + inv.controls + (inv.largeMessageRuns ?? 0), inv.provenance?.repetitions ?? 0)
    : 0;
  const invOk = inv?.observations ? inv.observations.filter((o) => o.status === "ok").length : invExpected;
  const invMissingCat = inv && (inv.payloads === 0 || inv.controls === 0) ? 1 : 0;
  const invFailed = inv?.observations
    ? Math.max(
        inv.observations.filter((o) => o.status === "failed").length,
        invExpected - invOk,
        invMissingCat,
      )
    : invMissingCat;
  lines.push(
    inv
      ? `| Invisible characters | detected ${inv.detected} of ${inv.payloads} payloads, false positives ${inv.falsePositives} of ${inv.controls} controls, 1 MiB message p50 ${inv.p50Ms ?? "not measured"} ms, p95 ${inv.p95Ms ?? "not measured"} ms, peak ${inv.peakMb ?? "not measured"} MB${invFailed > 0 ? ` (incomplete: ${invFailed} failed)` : ""} |`
      : "| Invisible characters | not measured |",
  );
  return `${lines.join("\n")}\n`;
}

// Merged under its own heading, never replacing another section's rows (the RESULTS.md merge contract).
export function writeComponentResults(dir: string, records: ComponentRecords): string {
  return writeResultsSection(
    dir,
    COMPONENTS_HEADING,
    `| Component | Measurement |\n| --- | --- |\n${renderComponentRows(records)}`,
  );
}

// Refuse a RESULTS.md whose component rows differ from the records, or records whose summary disagrees with raw observations.
export function checkComponentRows(resultsText: string, records: ComponentRecords): string[] {
  const recordProblems = validateComponentRecords(records);
  const expected = renderComponentRows(records).trim().split("\n");

  let sectionText = resultsText;
  const headingIdx = resultsText.indexOf(COMPONENTS_HEADING);
  if (headingIdx >= 0) {
    const afterHeading = resultsText.slice(headingIdx + COMPONENTS_HEADING.length);
    const nextHeading = afterHeading.search(/^## /m);
    sectionText = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  }
  const actualRows = sectionText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l !== "| Component | Measurement |" && l !== "| --- | --- |");

  const rowProblems: string[] = [];
  for (const line of expected) {
    if (!actualRows.includes(line)) {
      rowProblems.push(`RESULTS.md differs from the records: ${line}`);
    }
  }
  if (actualRows.length !== expected.length && rowProblems.length === 0) {
    rowProblems.push(`RESULTS.md component row count (${actualRows.length}) differs from expected (${expected.length})`);
  }
  return [...recordProblems, ...rowProblems];
}
