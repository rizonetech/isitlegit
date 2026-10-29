// The budget's statements (D03 T01 §2), one source for the Worker (src/meta/budget.ts, bound parameters on D1) and the
// local callers (scripts/lib/meta-budget.ts, the same statement through `wrangler d1 execute`, which takes no bound
// parameters, so `inline` writes the values in after checking each one's shape).
//
// The reservation is one INSERT ... SELECT ... WHERE: the row is added only if the day's counted spend plus the
// estimate stays within the day cap and the total plus the estimate within the total limit for that day. D1 runs one
// statement at a time on a database, so no other reservation can land between the check and the insert.

// What a row counts against the caps: its reported cost once settled, its estimate until then (a lost answer included).
const COUNTED = "CASE WHEN state = 'settled' THEN actual_usd ELSE estimate_usd END";

export type Reservation = {
  id: string;
  at: string;
  day: string;
  source: "worker" | "local";
  caller: string;
  model: string;
  caseId: string | null;
  attempt: number;
  estimateUsd: number;
  // The call it belongs to and who it is for (D03 T01 §3); absent for a row with no client call (an import).
  callId?: string | null;
  owner?: "case" | "monitor" | "script" | null;
  monitorRun?: string | null;
  host?: string | null;
  step?: string | null;
};

// An attempt's record at its end (D03 T01 §3): counts, ids, the outcome and the cost's certainty, never content.
export type Ended = {
  ms: number;
  inputTokens?: number | undefined;
  cachedTokens?: number | undefined;
  outputTokens?: number | undefined;
  images?: number | undefined;
  audioSeconds?: number | undefined;
  logId?: string | null | undefined;
  requestId?: string | null | undefined;
  outcome: "ok" | "error" | "refused";
  errorClass?: string | undefined;
  certainty: "measured" | "estimated" | "none";
  source: "meta-usage" | "estimate";
};

const whole = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
const endedParams = (e: Ended | undefined) => [
  e ? Math.round(e.ms) : null,
  whole(e?.inputTokens),
  whole(e?.cachedTokens),
  whole(e?.outputTokens),
  e?.logId ?? null,
  e?.requestId ?? null,
  e?.outcome ?? null,
  e?.errorClass ?? null,
  e?.certainty ?? null,
  e?.source ?? null,
  whole(e?.images),
  typeof e?.audioSeconds === "number" && Number.isFinite(e.audioSeconds) && e.audioSeconds >= 0 ? e.audioSeconds : null,
];
const ENDED_SET =
  "ms = coalesce(?4, ms), input_tokens = ?5, cached_tokens = ?6, output_tokens = ?7, log_id = ?8, request_id = ?9, outcome = ?10, error_class = ?11, cost_certainty = ?12, cost_source = ?13, images = ?14, audio_seconds = ?15";

export type Statement = { sql: string; params: (string | number | null)[] };

// A call's owner as its row's columns (D03 T01 §3).
export function ownerColumns(call: { callId: string; owner: OwnerLike } | undefined) {
  const o = call?.owner;
  return {
    callId: call?.callId ?? null,
    owner: o?.kind ?? null,
    caseId: o?.kind === "case" ? o.caseId : null,
    monitorRun: o?.kind === "monitor" ? o.run : null,
    host: o?.kind === "monitor" ? o.host : null,
    step: o && "step" in o ? o.step : null,
  };
}
type OwnerLike =
  | { kind: "case"; caseId: string; step: string }
  | { kind: "monitor"; run: string; host: string; step: string }
  | { kind: "script"; name: string };

export function reserveStatement(r: Reservation, dayCap: number, totalLimit: number): Statement {
  return {
    sql: `INSERT INTO model_spend (id, at, day, source, caller, model, case_id, attempt, estimate_usd, state, call_id, owner, monitor_run, host, step, cost_certainty, cost_source)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'reserved', ?12, ?13, ?14, ?15, ?16, 'estimated', 'estimate'
WHERE (SELECT coalesce(sum(${COUNTED}), 0) FROM model_spend WHERE day = ?3) + ?9 <= ?10
  AND (SELECT coalesce(sum(${COUNTED}), 0) FROM model_spend) + ?9 <= ?11`,
    params: [
      r.id,
      r.at,
      r.day,
      r.source,
      r.caller,
      r.model,
      r.caseId,
      r.attempt,
      r.estimateUsd,
      dayCap,
      totalLimit,
      r.callId ?? null,
      r.owner ?? null,
      r.monitorRun ?? null,
      r.host ?? null,
      r.step ?? null,
    ],
  };
}

// The day's and the total's counted spend, read after a refused reservation to say which cap refused it.
export function spentStatement(day: string): Statement {
  return {
    sql: `SELECT (SELECT coalesce(sum(${COUNTED}), 0) FROM model_spend WHERE day = ?1) AS day_usd,
  (SELECT coalesce(sum(${COUNTED}), 0) FROM model_spend) AS total_usd`,
    params: [day],
  };
}

// Settled once, with the attempt's record when there is one: a replayed settlement changes nothing.
export function settleStatement(id: string, actualUsd: number, at: string, ended?: Ended): Statement {
  return ended
    ? {
        sql: `UPDATE model_spend SET actual_usd = ?2, state = 'settled', settled_at = ?3, ${ENDED_SET} WHERE id = ?1 AND state <> 'settled'`,
        params: [id, actualUsd, at, ...endedParams(ended)],
      }
    : {
        sql: "UPDATE model_spend SET actual_usd = ?2, state = 'settled', settled_at = ?3 WHERE id = ?1 AND state <> 'settled'",
        params: [id, actualUsd, at],
      };
}

// An attempt whose answer was lost: still counted at its estimate, marked so it is never mistaken for one in flight.
export function uncertainStatement(id: string, ended?: Ended): Statement {
  return ended
    ? {
        sql: `UPDATE model_spend SET state = 'uncertain', ${ENDED_SET.replace(/\?(\d+)/g, (_, n: string) => `?${Number(n) - 2}`)} WHERE id = ?1 AND state = 'reserved'`,
        params: [id, ...endedParams(ended)],
      }
    : { sql: "UPDATE model_spend SET state = 'uncertain' WHERE id = ?1 AND state = 'reserved'", params: [id] };
}

// The cron's mark for a reservation whose settlement was never written (D03 T01 §3): still counted at its estimate,
// shown as an unsettled error, so an incomplete record is visible and never lost.
export function unsettledStatement(before: string): Statement {
  return {
    sql: "UPDATE model_spend SET state = 'uncertain', outcome = 'error', error_class = 'unsettled', cost_certainty = 'estimated', cost_source = 'estimate' WHERE state = 'reserved' AND at < ?1",
    params: [before],
  };
}

// A case's or a monitor run's cost, its three parts apart: measured, estimated, and attempts with no known cost.
export function costStatement(owner: { caseId: string } | { monitorRun: string }): Statement {
  const where = "caseId" in owner ? "case_id = ?1" : "monitor_run = ?1";
  return {
    sql: `SELECT
  coalesce(sum(CASE WHEN cost_certainty = 'measured' THEN actual_usd END), 0) AS measured_usd,
  coalesce(sum(CASE WHEN cost_certainty = 'estimated' THEN coalesce(actual_usd, estimate_usd) END), 0) AS estimated_usd,
  count(CASE WHEN cost_certainty = 'estimated' THEN 1 END) AS estimated_calls,
  count(*) AS attempts
FROM model_spend WHERE ${where}`,
    params: ["caseId" in owner ? owner.caseId : owner.monitorRun],
  };
}

// A cap's refusal, recorded once per event (src/meta/caps.ts `capEvent`) for the operator's alert.
export function capEventStatement(event: string, cap: string, model: string, day: string, at: string): Statement {
  return {
    sql: "INSERT OR IGNORE INTO budget_events (event, cap, model, day, at) VALUES (?1, ?2, ?3, ?4, ?5)",
    params: [event, cap, model, day, at],
  };
}

// Values written into the SQL for wrangler: numbers must be finite, strings plain printable text with no NUL (quotes
// doubled), and nothing else, so a value can never end its literal.
const literal = (value: string | number | null): string => {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("budget: a number in a statement must be finite");
    return String(value);
  }
  if (!/^[\x20-\x7e]*$/.test(value) || value.length > 200)
    throw new Error("budget: a text value must be short printable ASCII");
  return `'${value.replace(/'/g, "''")}'`;
};

export function inline(statement: Statement): string {
  return statement.sql.replace(/\?(\d+)/g, (_, n: string) => {
    const index = Number(n) - 1;
    if (index < 0 || index >= statement.params.length) throw new Error(`budget: no value for ?${n}`);
    return literal(statement.params[index] as string | number | null);
  });
}
