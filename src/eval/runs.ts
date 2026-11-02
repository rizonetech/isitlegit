// Every eval run for the operator's page (D08 T02 §9): the runs table in `eval_runs`, each joined to its own
// published report when one exists. A run that was never published carries no figures, never the latest run's;
// a damaged published report throws here so the page answers with its error page instead of a figure.
import { type EvalRunRow, parseReport } from "./report";

export type { EvalRunRow };

type Row = {
  id: string;
  mode: string;
  status: string;
  commit_sha: string;
  set_version: string;
  sets: string;
  sample_limit: number | null;
  selected: number;
  cap_usd: number;
  cost_usd: number;
  started_at: string;
  finished_at: string | null;
  report_json: string | null;
  published_at: string | null;
};

export async function evalRuns(db: D1Database): Promise<EvalRunRow[]> {
  const rows = (
    await db
      .prepare(
        `SELECT r.id, r.mode, r.status, r.commit_sha, r.set_version, r.sets, r.sample_limit, r.selected,
                r.cap_usd, r.cost_usd, r.started_at, r.finished_at, p.report_json, p.published_at
         FROM eval_runs r LEFT JOIN eval_published p ON p.run_id = r.id
         ORDER BY r.started_at DESC, r.id DESC`,
      )
      .all<Row>()
  ).results;
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    status: r.status,
    commit: r.commit_sha,
    setVersion: r.set_version,
    sets: r.sets,
    sampleLimit: r.sample_limit,
    selected: r.selected,
    capUsd: r.cap_usd,
    costUsd: r.cost_usd,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    published:
      r.report_json === null || r.published_at === null
        ? null
        : { report: parseReport(r.report_json), publishedAt: r.published_at },
  }));
}
