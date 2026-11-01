// The published eval reports the public results page shows (D08 T02 §4). A run is published once (`eval_published`,
// eval/publish.ts): its report holds figures, counts and denominators only. The headline is the latest published report of
// mode `full`; an ablation row is compared only with a baseline of the same selection and deployed commit, else it is
// `not comparable`. A stored report is checked before it is shown, so a damaged row is an error, never a blank figure.
import { z } from "zod";

const Rate = z.strictObject({
  n: z.number().int().min(0),
  hits: z.number().int().min(0),
  rate: z.number().min(0).max(1).nullable(),
});
const Spread = z.strictObject({
  n: z.number().int().min(0),
  median: z.number().min(0).nullable(),
  p95: z.number().min(0).nullable(),
});
const Category = z.strictObject({
  attacks: z.number().int().min(0),
  detected: z.number().int().min(0),
  genuine: z.number().int().min(0),
  measuredGenuine: z.number().int().min(0),
  falsePositives: z.number().int().min(0),
});
const Population = z.object({
  attacks: z.number().int().min(0),
  genuine: z.number().int().min(0),
  measuredGenuine: z.number().int().min(0),
  detection: Rate,
  falsePositives: Rate,
  byCategory: z.record(z.string(), Category),
  modelBasis: Rate,
  checksBasis: Rate,
  analysisMs: Spread,
  costUsd: z.object({ n: z.number().int().min(0), median: z.number().min(0).nullable(), total: z.number().min(0) }),
});
const Target = z.object({
  name: z.string(),
  figure: z.number().nullable(),
  figureText: z.string(),
  threshold: z.string(),
  denominator: z.number().int().min(0),
  state: z.enum(["met", "missed", "not measured", "incomplete"]),
  note: z.string().optional(),
});
export const PublishedReport = z.object({
  run: z.object({
    id: z.string(),
    mode: z.string(),
    commit: z.string(),
    setVersion: z.string(),
    sets: z.array(z.string()),
    sampleLimit: z.number().nullable(),
    status: z.string(),
    selected: z.number().int(),
    stored: z.number().int(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  }),
  complete: z.boolean(),
  main: Population,
  targets: z.array(Target),
});
export type PublishedReport = z.infer<typeof PublishedReport>;
export type Published = { report: PublishedReport; publishedAt: string };

export const parseReport = (json: string): PublishedReport => PublishedReport.parse(JSON.parse(json));

// The latest published full report, or null when none is published.
export async function latestFull(db: D1Database): Promise<Published | null> {
  const row = await db
    .prepare(
      "SELECT report_json, published_at FROM eval_published WHERE mode = 'full' ORDER BY published_at DESC, run_id DESC LIMIT 1",
    )
    .first<{ report_json: string; published_at: string }>();
  return row ? { report: parseReport(row.report_json), publishedAt: row.published_at } : null;
}

export type AblationRow =
  | {
      mode: string;
      runId: string;
      comparable: true;
      detection: Rate2;
      falsePositives: Rate2;
      medianMs: number | null;
      medianUsd: number | null;
      detectionDelta: number | null;
      falsePositiveDelta: number | null;
      msDelta: number | null;
      usdDelta: number | null;
    }
  | { mode: string; runId: string; comparable: false; reason: string };
type Rate2 = { n: number; hits: number; rate: number | null };

// The latest published report of each ablation mode, compared with the baseline: the same set version, the same
// selection and the same deployed commit, else `not comparable` with the reason.
export async function ablations(db: D1Database, baseline: PublishedReport): Promise<AblationRow[]> {
  const rows = (
    await db
      .prepare(
        "SELECT mode, report_json FROM eval_published p WHERE mode <> 'full' AND published_at = (SELECT max(published_at) FROM eval_published WHERE mode = p.mode) ORDER BY mode",
      )
      .all<{ mode: string; report_json: string }>()
  ).results;
  return rows.map((r): AblationRow => {
    const a = parseReport(r.report_json);
    const reason =
      a.run.setVersion !== baseline.run.setVersion
        ? "another dataset or selection than the full run"
        : a.run.commit !== baseline.run.commit
          ? "another deployed commit than the full run"
          : !a.complete
            ? "the run is not complete"
            : null;
    if (reason) return { mode: a.run.mode, runId: a.run.id, comparable: false, reason };
    const delta = (x: number | null, y: number | null) => (x === null || y === null ? null : x - y);
    return {
      mode: a.run.mode,
      runId: a.run.id,
      comparable: true,
      detection: a.main.detection,
      falsePositives: a.main.falsePositives,
      medianMs: a.main.analysisMs.median,
      medianUsd: a.main.costUsd.median,
      detectionDelta: delta(a.main.detection.rate, baseline.main.detection.rate),
      falsePositiveDelta: delta(a.main.falsePositives.rate, baseline.main.falsePositives.rate),
      msDelta: delta(a.main.analysisMs.median, baseline.main.analysisMs.median),
      usdDelta: delta(a.main.costUsd.median, baseline.main.costUsd.median),
    };
  });
}
