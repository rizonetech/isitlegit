// The model trace of one run of a case (D07 T03 §5; design/SPEC.md report page, model trace): which Meta model did what,
// how long it took and what it cost, the walkthrough agent's actions in order, and the mail the case sent, all read
// from what the pipeline stored and never typed. For a case the caller has already read in its organisation.
//
// `model_spend` and `walkthrough_actions` carry no run id, so a run's rows are those made between its own `retry` start
// in `case_events` and the next retry's start (the first run, from the beginning), the bounds read inside each
// statement that uses them, the same run the report pinned its evidence and progress to (D07 T03 §20). A retried report shows its current attempt alone; the earlier ones are §47's.
// The totals are the run's, an estimate never added into the measured (`caseCost` in src/meta/budget.ts keeps them apart
// for the whole case).
import type { ModelTrace, TraceAction, TraceCall, TraceSend } from "./model-trace-types";

export type { ModelTrace, TraceAction, TraceCall, TraceSend } from "./model-trace-types";

const TOOLS = ["click", "double_click", "move", "scroll", "type", "keypress", "wait", "screenshot"];

// A run's window of time, inside each statement that reads it (so a retry landing between two reads cannot move one
// read's bound and not another's): from the run's own `retry` start in `case_events` (none for the first run) to the
// next retry's start (none for the latest). `?1` is the case, `?2` the run.
const WINDOW = `WITH w AS (SELECT COALESCE((SELECT started_at FROM case_events WHERE case_id = ?1 AND step = 'retry'
  AND status = 'started' AND run_id = ?2 ORDER BY id DESC LIMIT 1), '') AS lo)`;
const within = (col: string) =>
  `${col} >= (SELECT lo FROM w) AND ${col} < COALESCE((SELECT MIN(started_at) FROM case_events WHERE case_id = ?1
    AND step = 'retry' AND status = 'started' AND started_at > (SELECT lo FROM w)), '9999-12-31')`;

// The case's mail for a run, never an address: the run's reply by its own send key (`reply:<run id>`, the case id for the
// first run, as src/pipeline/analysis-workflow.ts names it), every other kind by the run's window.
async function sendsOf(db: D1Database, caseId: string, run: string): Promise<TraceSend[]> {
  const sent = await db
    .prepare(
      `${WINDOW} SELECT kind, status, attempts, error, updated_at FROM mail_sends WHERE case_id = ?1
       AND ((kind = 'reply' AND send_key = 'reply:' || ?2) OR (kind != 'reply' AND ${within("created_at")}))
       ORDER BY created_at, id`,
    )
    .bind(caseId, run)
    .all<{ kind: string; status: TraceSend["status"]; attempts: number; error: string | null; updated_at: string }>();
  return sent.results.map((m) => ({
    kind: m.kind,
    status: m.status,
    attempts: m.attempts,
    error: m.error,
    at: m.updated_at,
  }));
}

// Just the run's mail, for the trace's own mail section refreshing itself while a send is unsettled.
export async function readTraceSends(db: D1Database, caseId: string, run: string): Promise<TraceSend[]> {
  return sendsOf(db, caseId, run);
}

export async function readModelTrace(db: D1Database, caseId: string, run: string): Promise<ModelTrace> {
  const [spent, walked, sends] = await Promise.all([
    db
      .prepare(
        `${WINDOW} SELECT id, at, step, model, ms, attempt, outcome, error_class, cache, actual_usd, estimate_usd, cost_certainty
         FROM model_spend WHERE case_id = ?1 AND ${within("at")} ORDER BY at, id`,
      )
      .bind(caseId, run)
      .all<{
        id: string;
        at: string;
        step: string | null;
        model: string;
        ms: number | null;
        attempt: number;
        outcome: TraceCall["outcome"];
        error_class: string | null;
        cache: string | null;
        actual_usd: number | null;
        estimate_usd: number;
        cost_certainty: string | null;
      }>(),
    db
      .prepare(
        `${WINDOW} SELECT walk_id, seq, kind, action_json, outcome, reason, ms, at FROM walkthrough_actions
         WHERE case_id = ?1 AND ${within("at")} ORDER BY at, seq`,
      )
      .bind(caseId, run)
      .all<{
        walk_id: string;
        seq: number;
        kind: TraceAction["kind"];
        action_json: string;
        outcome: TraceAction["outcome"];
        reason: string | null;
        ms: number;
        at: string;
      }>(),
    sendsOf(db, caseId, run),
  ]);
  const calls = spent.results.map(
    (r): TraceCall => ({
      id: r.id,
      at: r.at,
      step: r.step,
      model: r.model,
      ms: r.ms,
      attempt: r.attempt,
      outcome: r.outcome,
      errorClass: r.error_class,
      cached: r.cache === "hit",
      usd: r.actual_usd ?? r.estimate_usd,
      // Measured only once settled with a reported cost; a call never settled counts at its estimate.
      certainty: r.actual_usd !== null && (r.cost_certainty ?? "measured") === "measured" ? "measured" : "estimated",
    }),
  );
  const total = calls.reduce(
    (t, c) => ({
      ms: t.ms + (c.ms ?? 0),
      unknownTime: t.unknownTime + (c.ms === null ? 1 : 0),
      measuredUsd: t.measuredUsd + (c.certainty === "measured" ? c.usd : 0),
      estimatedUsd: t.estimatedUsd + (c.certainty === "estimated" ? c.usd : 0),
      estimatedCalls: t.estimatedCalls + (c.certainty === "estimated" ? 1 : 0),
    }),
    { ms: 0, unknownTime: 0, measuredUsd: 0, estimatedUsd: 0, estimatedCalls: 0 },
  );
  const toolOf = (json: string): string | null => {
    try {
      const tool = (JSON.parse(json) as { tool?: unknown }).tool;
      return typeof tool === "string" && TOOLS.includes(tool) ? tool : null;
    } catch {
      return null;
    }
  };
  return {
    calls,
    total,
    actions: walked.results.map((a) => ({
      walk: a.walk_id,
      seq: a.seq,
      kind: a.kind,
      tool: toolOf(a.action_json),
      outcome: a.outcome,
      reason: a.reason,
      at: a.at,
      ms: a.ms,
    })),
    sends,
  };
}
