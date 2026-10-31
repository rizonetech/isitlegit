// The model trace of one run of a case (D07 T03 §5; design/SPEC.md report page, model trace): which Meta model did what,
// how long it took and what it cost, the walkthrough agent's actions in order, and the mail the case sent, all read
// from what the pipeline stored and never typed. For a case the caller has already read in its organisation.
//
// `model_spend` and `walkthrough_actions` carry no run id, so a run's rows are those made between its own `retry` start
// in `case_events` and the next retry's start (the first run, from the beginning), the same run the report pinned its
// evidence and progress to (D07 T03 §20). A retried report shows its current attempt alone; the earlier ones are §47's.
// The totals are the run's, an estimate never added into the measured (`caseCost` in src/meta/budget.ts keeps them apart
// for the whole case).
import type { ModelTrace, TraceAction, TraceCall, TraceSend } from "./model-trace-types";

export type { ModelTrace, TraceAction, TraceCall, TraceSend } from "./model-trace-types";

const TOOLS = ["click", "double_click", "move", "scroll", "type", "keypress", "wait", "screenshot"];

// The run's window of time: from its own retry start (none for the first run) to the next retry's start (none for the
// latest). Both are `case_events.started_at` instants.
async function runWindow(db: D1Database, caseId: string, run: string): Promise<{ from: string; to: string | null }> {
  const mine = await db
    .prepare(
      "SELECT started_at FROM case_events WHERE case_id = ? AND step = 'retry' AND status = 'started' AND run_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(caseId, run)
    .first<{ started_at: string }>();
  const from = mine?.started_at ?? "";
  const next = await db
    .prepare(
      "SELECT MIN(started_at) AS at FROM case_events WHERE case_id = ? AND step = 'retry' AND status = 'started' AND started_at > ?",
    )
    .bind(caseId, from)
    .first<{ at: string | null }>();
  return { from, to: next?.at ?? null };
}

export async function readModelTrace(db: D1Database, caseId: string, run: string): Promise<ModelTrace> {
  const { from, to } = await runWindow(db, caseId, run);
  const [spent, walked, sent] = await Promise.all([
    db
      .prepare(
        `SELECT id, step, model, ms, attempt, outcome, error_class, cache, actual_usd, estimate_usd, cost_certainty
         FROM model_spend WHERE case_id = ? AND at >= ? AND (?3 IS NULL OR at < ?3) ORDER BY at, id`,
      )
      .bind(caseId, from, to)
      .all<{
        id: string;
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
        `SELECT walk_id, seq, kind, action_json, outcome, ms FROM walkthrough_actions
         WHERE case_id = ? AND at >= ? AND (?3 IS NULL OR at < ?3) ORDER BY at, seq`,
      )
      .bind(caseId, from, to)
      .all<{
        walk_id: string;
        seq: number;
        kind: TraceAction["kind"];
        action_json: string;
        outcome: TraceAction["outcome"];
        ms: number;
      }>(),
    db
      .prepare(
        `SELECT kind, status, attempts, error, updated_at FROM mail_sends
         WHERE case_id = ? AND created_at >= ? AND (?3 IS NULL OR created_at < ?3) ORDER BY created_at, id`,
      )
      .bind(caseId, from, to)
      .all<{ kind: string; status: TraceSend["status"]; attempts: number; error: string | null; updated_at: string }>(),
  ]);
  const calls = spent.results.map(
    (r): TraceCall => ({
      id: r.id,
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
      ms: a.ms,
    })),
    sends: sent.results.map((m) => ({
      kind: m.kind,
      status: m.status,
      attempts: m.attempts,
      error: m.error,
      at: m.updated_at,
    })),
  };
}
