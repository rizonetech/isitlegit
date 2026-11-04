import { z } from "zod";
import { COMPONENTS_HEADING, writeResultsSection } from "./results-file.ts";

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
  kind: "payload" | "control";
  detected: boolean;
  ms: number | null;
  status: "ok" | "failed";
};

export type InvisibleSummary = {
  payloads: number;
  detected: number;
  controls: number;
  falsePositives: number;
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
  category: "valid" | "disguised" | "damaged" | "batch-check";
  expected?: string;
  sniffed?: string | null;
  matched: boolean;
  mismatchFlagged?: boolean;
  riskNotChecked?: string | null;
  ms?: number | null;
  status: "ok" | "failed";
};

export type AttachmentsSummary = {
  valid: number;
  identified: number;
  disguised: number;
  disguisedCaught: number;
  damaged: number;
  damagedReadAsValid: number;
  mismatchCaught?: number;
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
  provenance?: string;
};

export function intakeFigures(records: IntakeRecord[]) {
  const bandOf = (band: "small" | "near-25mib") => {
    const all = records.filter((r) => r.band === band);
    const ok = all.filter((r) => r.status !== "failed" && r.ms !== null);
    const times = ok.map((r) => r.ms as number);
    return {
      total: all.length,
      completed: ok.length,
      failed: all.length - ok.length,
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
  provenance?: string;
};

export function retryFigures(records: RetryRecord[]) {
  const retries = records.filter((r) => r.kind === "retry");
  const retryDone = retries.filter((r) => r.completed && r.ms !== null);
  const retryTimes = retryDone.map((r) => r.ms as number);
  const retryMedianMs = median(retryTimes);
  const retryP95Ms = p95(retryTimes);
  const retryIncomplete = retries.length - retryDone.length;
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
  const leaseWindowMs = settleDone.find((r) => r.leaseWindowMs !== undefined)?.leaseWindowMs ?? 300_000;
  return {
    retryTotal: retries.length,
    retryCompleted: retryDone.length,
    retryIncomplete,
    retryMedianMs,
    retryP95Ms,
    targetState,
    settleTotal: settles.length,
    settleCompleted: settleDone.length,
    settleIncomplete: settles.length - settleDone.length,
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
      provenance: z.string().optional(),
    }),
  ),
  retry: z.array(
    z.object({
      kind: z.enum(["retry", "interrupted-settle"]),
      ms: z.number().nonnegative().nullable(),
      completed: z.boolean(),
      leaseWindowMs: z.number().int().nonnegative().optional(),
      provenance: z.string().optional(),
    }),
  ),
  invisible: z.object({
    payloads: z.number().int().nonnegative(),
    detected: z.number().int().nonnegative(),
    controls: z.number().int().nonnegative(),
    falsePositives: z.number().int().nonnegative(),
    p50Ms: z.number().nonnegative().nullable(),
    p95Ms: z.number().nonnegative().nullable(),
    peakMb: z.number().nonnegative().nullable(),
    largeMessageMs: z.number().nonnegative().nullable().optional(),
    observations: z
      .array(
        z.object({
          name: z.string().min(1),
          kind: z.enum(["payload", "control"]),
          detected: z.boolean(),
          ms: z.number().nonnegative().nullable(),
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
    disguised: z.number().int().nonnegative(),
    disguisedCaught: z.number().int().nonnegative(),
    damaged: z.number().int().nonnegative(),
    damagedReadAsValid: z.number().int().nonnegative(),
    mismatchCaught: z.number().int().nonnegative().optional(),
    damagedArchiveCaught: z.number().int().nonnegative().optional(),
    p50Ms: z.number().nonnegative().nullable().optional(),
    p95Ms: z.number().nonnegative().nullable().optional(),
    observations: z
      .array(
        z.object({
          name: z.string().min(1),
          category: z.enum(["valid", "disguised", "damaged", "batch-check"]),
          expected: z.string().optional(),
          sniffed: z.string().nullable().optional(),
          matched: z.boolean(),
          mismatchFlagged: z.boolean().optional(),
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
// refusing a summary that disagrees with its underlying observations.
export function validateComponentRecords(records: ComponentRecords): string[] {
  const problems: string[] = [];
  if (records.ai?.observations) {
    const obs = records.ai.observations;
    const inj = obs.filter((o) => o.kind === "injection");
    const gen = obs.filter((o) => o.kind === "genuine");
    const det = inj.filter((o) => o.status === "ok" && o.detected).length;
    const fp = gen.filter((o) => o.status === "ok" && o.detected).length;
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
    const disg = obs.filter((o) => o.category === "disguised");
    const disgOk = disg.filter((o) => o.status === "ok" && o.matched).length;
    const dam = obs.filter((o) => o.category === "damaged");
    const damRead = dam.filter((o) => o.status === "ok" && o.matched).length;
    if (valid.length !== records.attachments.valid || idOk !== records.attachments.identified) {
      problems.push(`attachments.json valid summary (${records.attachments.identified}/${records.attachments.valid}) disagrees with observations (${idOk}/${valid.length})`);
    }
    if (disg.length !== records.attachments.disguised || disgOk !== records.attachments.disguisedCaught) {
      problems.push(`attachments.json disguised summary disagrees with observations`);
    }
    if (dam.length !== records.attachments.damaged || damRead !== records.attachments.damagedReadAsValid) {
      problems.push(`attachments.json damaged summary disagrees with observations`);
    }
  }
  if (records.invisible?.observations) {
    const obs = records.invisible.observations;
    const pay = obs.filter((o) => o.kind === "payload");
    const ctl = obs.filter((o) => o.kind === "control");
    const det = pay.filter((o) => o.status === "ok" && o.detected).length;
    const fp = ctl.filter((o) => o.status === "ok" && o.detected).length;
    if (pay.length !== records.invisible.payloads || det !== records.invisible.detected) {
      problems.push(`invisible.json payload summary (${records.invisible.detected}/${records.invisible.payloads}) disagrees with observations (${det}/${pay.length})`);
    }
    if (ctl.length !== records.invisible.controls || fp !== records.invisible.falsePositives) {
      problems.push(`invisible.json control summary disagrees with observations`);
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
      : `sweep median ${retry.settleMedianMs} ms, p95 ${retry.settleP95Ms} ms after ${retry.leaseWindowMs} ms lease (${retry.settleCompleted} of ${retry.settleTotal} completed${retry.settleIncomplete > 0 ? `, incomplete: ${retry.settleIncomplete} failed` : ""})`;
  lines.push(`| Retry latency | retry ${retryText}; interrupted settle ${settleText} |`);
  const ai = records.ai;
  const aiFailed = ai?.observations?.filter((o) => o.status === "failed").length ?? 0;
  const aiTiming =
    ai?.p50Ms !== undefined && ai?.p50Ms !== null ? `, p50 ${ai.p50Ms} ms, p95 ${ai.p95Ms ?? "not measured"} ms` : "";
  lines.push(
    ai
      ? `| content.ai_instructions | detected ${ai.detected} of ${ai.injections} steering texts, false positives ${ai.falsePositives} of ${ai.genuine} genuine texts${aiTiming}${aiFailed > 0 ? ` (incomplete: ${aiFailed} failed)` : ""} |`
      : "| content.ai_instructions | not measured |",
  );
  const at = records.attachments;
  const atFailed = at?.observations?.filter((o) => o.status === "failed").length ?? 0;
  const atChecks =
    at?.mismatchCaught !== undefined
      ? `, mismatch caught ${at.mismatchCaught} of ${at.disguised}, damaged archive caught ${at.damagedArchiveCaught ?? 0} of ${at.damaged}`
      : "";
  const atTiming =
    at?.p50Ms !== undefined && at?.p50Ms !== null ? `, p50 ${at.p50Ms} ms, p95 ${at.p95Ms ?? "not measured"} ms` : "";
  lines.push(
    at
      ? `| Attachment identification | identified ${at.identified} of ${at.valid} valid, disguised caught ${at.disguisedCaught} of ${at.disguised}, damaged read as valid ${at.damagedReadAsValid} of ${at.damaged}${atChecks}${atTiming}${atFailed > 0 ? ` (incomplete: ${atFailed} failed)` : ""} |`
      : "| Attachment identification | not measured |",
  );
  const inv = records.invisible;
  const invFailed = inv?.observations?.filter((o) => o.status === "failed").length ?? 0;
  lines.push(
    inv
      ? `| Invisible characters | detected ${inv.detected} of ${inv.payloads} payloads, false positives ${inv.falsePositives} of ${inv.controls} controls, p50 ${inv.p50Ms ?? "not measured"} ms, p95 ${inv.p95Ms ?? "not measured"} ms, peak ${inv.peakMb ?? "not measured"} MB${invFailed > 0 ? ` (incomplete: ${invFailed} failed)` : ""} |`
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
