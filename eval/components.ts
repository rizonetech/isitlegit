import { COMPONENTS_HEADING, writeResultsSection } from "./results-file.ts";

// Component measurements (D08 T02 section 8): exact arithmetic over persisted measurement records.
// A record set with no eligible rows reads `not measured` (null), never zero. Records are JSON files under
// eval/components/ written by each experiment; `--check` in eval/metrics.ts refuses a RESULTS.md figure
// that differs from the records it was computed from.
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

export type InvisibleSummary = {
  payloads: number;
  detected: number;
  controls: number;
  falsePositives: number;
  p50Ms: number | null;
  p95Ms: number | null;
  peakMb: number | null;
};

export type AiSummary = {
  injections: number;
  detected: number;
  genuine: number;
  falsePositives: number;
  p50Ms?: number | null;
  p95Ms?: number | null;
};
export type AttachmentsSummary = {
  valid: number;
  identified: number;
  disguised: number;
  disguisedCaught: number;
  damaged: number;
  damagedReadAsValid: number;
  p50Ms?: number | null;
  p95Ms?: number | null;
};

export type IntakeRecord = {
  band: "small" | "near-25mib";
  bytes: number;
  ms: number | null;
  status?: "ok" | "failed";
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

export function renderComponentRows(records: ComponentRecords): string {
  const lines: string[] = [];
  const c = cacheFigures(records.cache ?? []);
  const hitText =
    c.hitRate === null ? "not measured" : `${(100 * c.hitRate).toFixed(1)}% hits (${c.hits} hits, ${c.misses} misses)`;
  const avoidedText = c.avoidedUsd === null ? "not measured" : `US$${c.avoidedUsd.toFixed(4)}`;
  lines.push(
    `| Result cache | ${hitText} (${c.rows} rows), hit median ${c.hitMedianMs ?? "not measured"} ms (p95 ${c.hitP95Ms ?? "not measured"} ms), miss median ${c.missMedianMs ?? "not measured"} ms (p95 ${c.missP95Ms ?? "not measured"} ms), avoided ${avoidedText} |`,
  );
  for (const p of providerFigures(records.providers ?? []))
    lines.push(
      `| Provider ${p.provider} | false positives ${p.falsePositiveRate === null ? "not measured" : `${(100 * p.falsePositiveRate).toFixed(1)}%`} over ${p.genuineChecked} checked genuine (${p.unchecked} unchecked) |`,
    );
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
      : `median ${b.medianMs} ms, p95 ${b.p95Ms} ms (${b.completed} of ${b.total} completed)`;
  lines.push(`| Intake time | small ${bandText(intake.small)}; near-25MiB ${bandText(intake.near25Mib)} |`);
  const retry = retryFigures(records.retry ?? []);
  const retryText =
    retry.retryCompleted === 0
      ? `not measured (0 of ${retry.retryTotal} completed; target median < 60000 ms, p95 < 180000 ms)`
      : `median ${retry.retryMedianMs} ms, p95 ${retry.retryP95Ms} ms (${retry.retryCompleted} of ${retry.retryTotal} completed, target ${retry.targetState})`;
  const settleText =
    retry.settleCompleted === 0
      ? `not measured (0 of ${retry.settleTotal} completed)`
      : `median ${retry.settleMedianMs} ms, p95 ${retry.settleP95Ms} ms (${retry.settleCompleted} of ${retry.settleTotal} completed)`;
  lines.push(`| Retry latency | retry ${retryText}; interrupted settle ${settleText} |`);
  const ai = records.ai;
  const aiTiming =
    ai?.p50Ms !== undefined && ai?.p50Ms !== null ? `, p50 ${ai.p50Ms} ms, p95 ${ai.p95Ms ?? "not measured"} ms` : "";
  lines.push(
    ai
      ? `| content.ai_instructions | detected ${ai.detected} of ${ai.injections} steering texts, false positives ${ai.falsePositives} of ${ai.genuine} genuine texts${aiTiming} |`
      : "| content.ai_instructions | not measured |",
  );
  const at = records.attachments;
  const atTiming =
    at?.p50Ms !== undefined && at?.p50Ms !== null ? `, p50 ${at.p50Ms} ms, p95 ${at.p95Ms ?? "not measured"} ms` : "";
  lines.push(
    at
      ? `| Attachment identification | identified ${at.identified} of ${at.valid} valid, disguised caught ${at.disguisedCaught} of ${at.disguised}, damaged read as valid ${at.damagedReadAsValid} of ${at.damaged}${atTiming} |`
      : "| Attachment identification | not measured |",
  );
  const inv = records.invisible;
  lines.push(
    inv
      ? `| Invisible characters | detected ${inv.detected} of ${inv.payloads} payloads, false positives ${inv.falsePositives} of ${inv.controls} controls, p50 ${inv.p50Ms ?? "not measured"} ms, p95 ${inv.p95Ms ?? "not measured"} ms, peak ${inv.peakMb ?? "not measured"} MB |`
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

// Refuse a RESULTS.md whose component rows differ from the records: the file is evidence, not prose.
export function checkComponentRows(resultsText: string, records: ComponentRecords): string[] {
  const expected = renderComponentRows(records).trim().split("\n");
  const present = resultsText.split("\n");
  return expected
    .filter((line) => !present.includes(line))
    .map((line) => `RESULTS.md differs from the records: ${line}`);
}
