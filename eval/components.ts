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

export type AiSummary = { injections: number; detected: number; genuine: number; falsePositives: number };
export type AttachmentsSummary = {
  valid: number;
  identified: number;
  disguised: number;
  disguisedCaught: number;
  damaged: number;
  damagedReadAsValid: number;
};

export type ComponentRecords = {
  cache?: CacheRecord[];
  providers?: ProviderRecord[];
  walkthrough?: WalkRecord[];
  floor?: FloorRecord[];
  invisible?: InvisibleSummary;
  ai?: AiSummary;
  attachments?: AttachmentsSummary;
};

export function renderComponentRows(records: ComponentRecords): string {
  const lines: string[] = [];
  const c = cacheFigures(records.cache ?? []);
  const hitText = c.hitRate === null ? "not measured" : `${(100 * c.hitRate).toFixed(1)}% hits`;
  const avoidedText = c.avoidedUsd === null ? "not measured" : `US$${c.avoidedUsd.toFixed(4)}`;
  lines.push(
    `| Result cache | ${hitText} (${c.rows} rows), hit median ${c.hitMedianMs ?? "not measured"} ms, avoided ${avoidedText} |`,
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
    `| Deterministic floor | raised ${f.raised} of ${f.rows}, added detections ${f.addedDetections}, caused false positives ${f.causedFalsePositives} |`,
  );
  const ai = records.ai;
  lines.push(
    ai
      ? `| content.ai_instructions | detected ${ai.detected} of ${ai.injections} steering texts, false positives ${ai.falsePositives} of ${ai.genuine} genuine texts |`
      : "| content.ai_instructions | not measured |",
  );
  const at = records.attachments;
  lines.push(
    at
      ? `| Attachment identification | identified ${at.identified} of ${at.valid} valid, disguised caught ${at.disguisedCaught} of ${at.disguised}, damaged read as valid ${at.damagedReadAsValid} of ${at.damaged} |`
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
