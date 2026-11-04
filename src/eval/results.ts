import {
  type AblationRow as BaseAblationRow,
  type HistoryRow,
  type Published,
  type PublishedReport,
  parseReport,
} from "./report";

export type { HistoryRow, Published, PublishedReport };
export type AblationRow = BaseAblationRow & { baselineRunId?: string };

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
export async function ablations(db: D1Database, baseline: PublishedReport | null): Promise<AblationRow[]> {
  const rows = (
    await db
      .prepare(
        "SELECT mode, report_json FROM eval_published p WHERE mode NOT IN ('full', 'ablate:full') AND run_id = (SELECT run_id FROM eval_published WHERE mode = p.mode ORDER BY published_at DESC, run_id DESC LIMIT 1) ORDER BY mode",
      )
      .all<{ mode: string; report_json: string }>()
  ).results;
  return Promise.all(
    rows.map(async (r): Promise<AblationRow> => {
      const a = parseReport(r.report_json);
      let matched = baseline;
      if (r.mode.startsWith("ablate:")) {
        const bindings = (
          await db
            .prepare(`SELECT e.manifest_digest, e.deployment, a.arm, b.replay_run_id AS baseline_id, p.mode AS baseline_mode, p.report_json
        FROM eval_experiment_arms a
        JOIN eval_experiments e ON e.org_id = a.org_id AND e.experiment_id = a.experiment_id
        JOIN eval_experiment_arms b ON b.org_id = a.org_id AND b.experiment_id = a.experiment_id AND b.arm = 'full'
        JOIN eval_published p ON p.run_id = b.replay_run_id
        WHERE a.replay_run_id = ?1`)
            .bind(a.run.id)
            .all<{
              manifest_digest: string;
              deployment: string;
              arm: string;
              baseline_id: string;
              baseline_mode: string;
              report_json: string;
            }>()
        ).results;
        const binding = bindings.length === 1 ? bindings[0] : undefined;
        matched = binding ? parseReport(binding.report_json) : null;
        if (
          !binding ||
          !matched ||
          binding.baseline_mode !== "ablate:full" ||
          matched.run.mode !== "ablate:full" ||
          matched.run.id !== binding.baseline_id ||
          r.mode !== a.run.mode ||
          r.mode !== `ablate:${binding.arm}` ||
          a.run.setVersion !== binding.manifest_digest ||
          a.run.commit !== binding.deployment
        )
          return {
            mode: r.mode,
            runId: a.run.id,
            comparable: false,
            reason: "matching experiment full baseline not measured or not published",
          };
      }
      if (!matched) return { mode: r.mode, runId: a.run.id, comparable: false, reason: "full baseline not measured" };
      const reason =
        a.run.setVersion !== matched.run.setVersion
          ? "another dataset or selection than the full run"
          : a.run.commit !== matched.run.commit
            ? "another deployed commit than the full run"
            : a.run.sets.join() !== matched.run.sets.join() ||
                a.run.sampleLimit !== matched.run.sampleLimit ||
                a.run.selected !== matched.run.selected
              ? "another selection than the full run"
              : !a.complete || !matched.complete
                ? "the run is not complete"
                : null;
      if (reason) return { mode: a.run.mode, runId: a.run.id, comparable: false, reason };
      const delta = (x: number | null, y: number | null) => (x === null || y === null ? null : x - y);
      return {
        mode: a.run.mode,
        runId: a.run.id,
        comparable: true,
        baselineRunId: matched.run.id,
        detection: a.main.detection,
        falsePositives: a.main.falsePositives,
        medianMs: a.main.analysisMs.median,
        medianUsd: a.main.costUsd.median,
        detectionDelta: delta(a.main.detection.rate, matched.main.detection.rate),
        falsePositiveDelta: delta(a.main.falsePositives.rate, matched.main.falsePositives.rate),
        msDelta: delta(a.main.analysisMs.median, matched.main.analysisMs.median),
        usdDelta: delta(a.main.costUsd.median, matched.main.costUsd.median),
      };
    }),
  );
}
