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
};

export type Statement = { sql: string; params: (string | number | null)[] };

export function reserveStatement(r: Reservation, dayCap: number, totalLimit: number): Statement {
  return {
    sql: `INSERT INTO model_spend (id, at, day, source, caller, model, case_id, attempt, estimate_usd, state)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'reserved'
WHERE (SELECT coalesce(sum(${COUNTED}), 0) FROM model_spend WHERE day = ?3) + ?9 <= ?10
  AND (SELECT coalesce(sum(${COUNTED}), 0) FROM model_spend) + ?9 <= ?11`,
    params: [r.id, r.at, r.day, r.source, r.caller, r.model, r.caseId, r.attempt, r.estimateUsd, dayCap, totalLimit],
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

// Settled once: a replayed settlement changes nothing.
export function settleStatement(id: string, actualUsd: number, at: string): Statement {
  return {
    sql: "UPDATE model_spend SET actual_usd = ?2, state = 'settled', settled_at = ?3 WHERE id = ?1 AND state <> 'settled'",
    params: [id, actualUsd, at],
  };
}

// An attempt whose answer was lost: still counted at its estimate, marked so it is never mistaken for one in flight.
export function uncertainStatement(id: string): Statement {
  return { sql: "UPDATE model_spend SET state = 'uncertain' WHERE id = ?1 AND state = 'reserved'", params: [id] };
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
