import { type AblationRow, type HistoryRow, type Published, type PublishedReport, parseReport } from "./report";

export type { AblationRow, HistoryRow, Published, PublishedReport };

// The latest published full report, or null when none is published.
export async function latestFull(db: D1Database): Promise<Published | null> {
  const row = await db
    .prepare(
      "SELECT report_json, published_at FROM eval_published WHERE mode = 'full' ORDER BY published_at DESC, run_id DESC LIMIT 1",
    )
    .first<{ report_json: string; published_at: string }>();
  return row ? { report: parseReport(row.report_json), publishedAt: row.published_at } : null;
}

// Every published full run, newest first (D08 T02 §10): each comparable with the page's headline run (the
// baseline the caller passes, so one request can never mix two baselines when a publication lands mid-read)
// only on the same set version, the same selection and the same deployed commit, else marked with the
// reason, never compared.
export async function publishedHistory(db: D1Database, baseline: PublishedReport): Promise<HistoryRow[]> {
  const rows = (
    await db
      .prepare(
        "SELECT report_json, published_at FROM eval_published WHERE mode = 'full' ORDER BY published_at DESC, run_id DESC",
      )
      .all<{ report_json: string; published_at: string }>()
  ).results;
  return rows.map((r): HistoryRow => {
    const row = { report: parseReport(r.report_json), publishedAt: r.published_at };
    if (row.report.run.id === baseline.run.id) return { ...row, comparable: true, reason: null };
    const reason =
      row.report.run.setVersion !== baseline.run.setVersion
        ? "another dataset version than the latest run"
        : row.report.run.sets.join(",") !== baseline.run.sets.join(",") ||
            row.report.run.sampleLimit !== baseline.run.sampleLimit
          ? "another selection than the latest run"
          : row.report.run.commit !== baseline.run.commit
            ? "another deployed commit than the latest run"
            : !row.report.complete
              ? "the run is not complete"
              : null;
    return { ...row, comparable: reason === null, reason };
  });
}

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
