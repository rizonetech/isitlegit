// Loupe's daily runtime ledger (D03 T04 §14): every caller that wakes the dedicated deployment reserves its minutes in
// `glimmer_runtime` before its first request, and settles them after its last. One ledger for the Worker (bound
// parameters on D1) and the local scripts (scripts/glimmer/deploy.ts, the same statements through `wrangler d1 execute`,
// written in by `inline`).
//
// A reservation is split by the SAST day each part falls in. A row counts its used minutes once settled and its
// reserved minutes until then, so an interrupted caller, a timed-out request or a lost answer is never counted less than
// it reserved. Admission and reservation are one INSERT ... SELECT ... WHERE: D1 runs one statement at a time, so two
// callers can never both take the last minutes of a day.

import type { Statement } from "../meta/budget-sql.ts";
import { sastDay } from "../meta/day.ts";
import {
  dayLimitMinutes,
  hourlyRateUsd,
  MAX_WARMUP_SECONDS,
  TAIL_MINUTES,
  totalLimitMinutes,
  WARMUP_MARGIN_SECONDS,
} from "./glimmer-caps.ts";

export type Part = { day: string; minutes: number };

const DAY_MS = 86_400_000;
const SAST_MS = 2 * 3_600_000;

// A span of minutes from `at`, by the SAST day each part falls in: a burst from 23:59 that runs 15 minutes is 1 minute
// of one day and 14 of the next.
export function minutesByDay(at: Date, minutes: number): Part[] {
  const parts: Part[] = [];
  let from = at.getTime();
  let left = minutes;
  while (left > 1e-9) {
    const day = sastDay(new Date(from));
    // The next SAST midnight (22:00 UTC; South Africa keeps no daylight saving).
    const next = (Math.floor((from + SAST_MS) / DAY_MS) + 1) * DAY_MS - SAST_MS;
    const part = Math.min(left, (next - from) / 60_000);
    parts.push({ day, minutes: part });
    left -= part;
    from = next;
  }
  return parts;
}

export type Row = { day: string; reserved_minutes: number; used_minutes: number | null };
// What a row counts: its used minutes once settled, its reserve until then.
export const counted = (row: Row) => row.used_minutes ?? row.reserved_minutes;
export const minutesUsed = (rows: Row[], day: string) =>
  rows.filter((row) => row.day === day).reduce((sum, row) => sum + counted(row), 0);

// The minutes a burst reserves: a cold one waits up to the longest measured warm-up and its margin before Spark takes
// the page (§15), then its calls, then the tail until the deployment is at 0 replicas.
export function burstMinutes(calls: number, callSeconds: number, cold = true): number {
  const warmup = cold ? (MAX_WARMUP_SECONDS + WARMUP_MARGIN_SECONDS) / 60 : 0;
  return warmup + (calls * callSeconds) / 60 + TAIL_MINUTES;
}

// What a settled burst used: from its wake to the later of its last answer and its last request's deadline (a request
// cut at its deadline may have kept the deployment up until then), plus the tail; or, when the deployment was read at
// 0 replicas, to that moment. Nothing sent is nothing used.
export type Activity = { lastAnswerAt?: Date | null; lastDeadlineAt?: Date | null; zeroAt?: Date | null };
export function usedMinutes(wakeAt: Date, activity: Activity): number {
  if (activity.zeroAt instanceof Date) return Math.max(0, (activity.zeroAt.getTime() - wakeAt.getTime()) / 60_000);
  const ends = [activity.lastAnswerAt, activity.lastDeadlineAt].filter((d): d is Date => d instanceof Date);
  if (!ends.length) return 0;
  const end = Math.max(...ends.map((d) => d.getTime()));
  return Math.max(0, (end - wakeAt.getTime()) / 60_000) + TAIL_MINUTES;
}

export type Refused = {
  ok: false;
  reason: "day-minutes" | "total-usd" | "ledger-unavailable";
  day?: string;
  detail: string;
};
export type Reserved = { ok: true; id: string; wakeAt: string; parts: Part[]; repeated: boolean };

export type Ledger = { days: Record<string, number>; total: number };

// The pure rule: may `minutes` from `at` be reserved on a ledger holding `ledger`?
export function mayCall(ledger: Ledger, at: Date, minutes: number, rate = hourlyRateUsd()): { ok: true } | Refused {
  const dayLimit = dayLimitMinutes(rate);
  for (const part of minutesByDay(at, minutes)) {
    const after = (ledger.days[part.day] ?? 0) + part.minutes;
    if (after > dayLimit + 1e-9)
      return {
        ok: false,
        reason: "day-minutes",
        day: part.day,
        detail: `${part.day} would hold ${tenth(after)} of its ${tenth(dayLimit)} minutes`,
      };
  }
  const total = ledger.total + minutes;
  if (total > totalLimitMinutes(rate) + 1e-9)
    return {
      ok: false,
      reason: "total-usd",
      detail: `the deployment would reach US$${((total * rate) / 60).toFixed(2)} of its total cap`,
    };
  return { ok: true };
}

const tenth = (n: number) => Math.round(n * 10) / 10;

export type Reservation = {
  id: string;
  at: Date;
  source: "worker" | "local" | "import";
  caller: string;
  purpose: string;
  minutes: number;
};

const COUNTED_SQL = "coalesce(used_minutes, reserved_minutes)";

// The reservation as one statement: every day part is inserted, or none, and only when no part takes its day past the
// day's limit and the whole ledger stays within the total; a reservation id already present inserts nothing.
export function reserveStatement(r: Reservation, rate = hourlyRateUsd()): Statement {
  const parts = minutesByDay(r.at, r.minutes);
  if (!parts.length) parts.push({ day: sastDay(r.at), minutes: 0 });
  const params: (string | number | null)[] = [
    r.id,
    r.source,
    r.caller,
    r.purpose,
    r.at.toISOString(),
    dayLimitMinutes(rate),
    totalLimitMinutes(rate) - r.minutes,
  ];
  const values = parts.map((part) => {
    params.push(part.day, part.minutes);
    return `(?${params.length - 1}, ?${params.length})`;
  });
  return {
    sql:
      `WITH parts(day, minutes) AS (VALUES ${values.join(", ")}) ` +
      "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes) " +
      "SELECT ?1 || ':' || day, ?1, day, ?2, ?3, ?4, ?5, minutes FROM parts " +
      "WHERE NOT EXISTS (SELECT 1 FROM glimmer_runtime WHERE reservation_id = ?1) " +
      `AND NOT EXISTS (SELECT 1 FROM parts p WHERE (SELECT coalesce(sum(${COUNTED_SQL}), 0) FROM glimmer_runtime g ` +
      "WHERE g.day = p.day) + p.minutes > ?6 + 1e-9) " +
      `AND (SELECT coalesce(sum(${COUNTED_SQL}), 0) FROM glimmer_runtime) <= ?7 + 1e-9`,
    params,
  };
}

export const rowsStatement = (id: string): Statement => ({
  sql: "SELECT day, wake_at, reserved_minutes, used_minutes, settled_at FROM glimmer_runtime WHERE reservation_id = ?1 ORDER BY day",
  params: [id],
});

// The days a reservation touches and the whole total, so a refusal is named from what refused it.
export const ledgerStatement = (days: string[]): Statement => ({
  sql:
    `SELECT day, sum(${COUNTED_SQL}) AS minutes FROM glimmer_runtime GROUP BY day HAVING day IN (${days.map((_, i) => `?${i + 1}`).join(", ") || "NULL"}) ` +
    `UNION ALL SELECT '*', coalesce(sum(${COUNTED_SQL}), 0) FROM glimmer_runtime`,
  params: days,
});

// Settling: each reserved day takes its part of what was used (0 for a day it never reached), once; a used day that
// was not reserved (a caller that ran past its reserve across midnight) is added, once.
export function settleStatements(
  id: string,
  wakeAt: Date,
  used: number,
  at: Date,
  lastAnswerAt: Date | null,
): Statement[] {
  const parts = minutesByDay(wakeAt, used);
  const params: (string | number | null)[] = [id, at.toISOString(), lastAnswerAt?.toISOString() ?? null];
  const cases = parts.map((part) => {
    params.push(part.day, part.minutes);
    return `WHEN ?${params.length - 1} THEN ?${params.length}`;
  });
  const update: Statement = {
    sql:
      `UPDATE glimmer_runtime SET used_minutes = ${cases.length ? `CASE day ${cases.join(" ")} ELSE 0 END` : "0"}, ` +
      "settled_at = ?2, last_answer_at = ?3 WHERE reservation_id = ?1 AND settled_at IS NULL",
    params,
  };
  const extra = parts.map(
    (part): Statement => ({
      sql:
        "INSERT OR IGNORE INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, last_answer_at, settled_at) " +
        "SELECT ?1 || ':' || ?2, ?1, ?2, source, caller, purpose, wake_at, 0, ?3, ?4, ?5 FROM glimmer_runtime " +
        "WHERE reservation_id = ?1 AND NOT EXISTS (SELECT 1 FROM glimmer_runtime WHERE reservation_id = ?1 AND day = ?2) LIMIT 1",
      params: [id, part.day, part.minutes, lastAnswerAt?.toISOString() ?? null, at.toISOString()],
    }),
  );
  return [update, ...extra];
}

// How a statement reaches D1: bound on the Worker, through wrangler for a local script.
export type Exec = (s: Statement) => Promise<{ rows: Record<string, unknown>[]; changes: number }>;

// The D1 binding as this module uses it (structural, so the local scripts compile without the Worker's types).
type D1Like = {
  prepare(sql: string): {
    bind(...values: unknown[]): { all(): Promise<{ results?: unknown[]; meta?: { changes?: number } }> };
  };
};

export const d1Exec =
  (db: D1Like): Exec =>
  async (s) => {
    const answer = await db
      .prepare(s.sql)
      .bind(...s.params)
      .all();
    return { rows: (answer.results ?? []) as Record<string, unknown>[], changes: answer.meta?.changes ?? 0 };
  };

type HeldRow = {
  day: string;
  wake_at: string;
  reserved_minutes: number;
  used_minutes: number | null;
  settled_at: string | null;
};

async function held(exec: Exec, id: string): Promise<HeldRow[]> {
  return (await exec(rowsStatement(id))).rows as HeldRow[];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
// A ledger that cannot be read or written refuses (fail closed); a failed read-back is named next to the first error.
const unavailable = (error: unknown, readBack?: unknown): Refused => ({
  ok: false,
  reason: "ledger-unavailable",
  detail: `the runtime ledger could not be read or written (${message(error)}${readBack === undefined ? "" : `; reading it back failed too: ${message(readBack)}`}); nothing was sent`,
});

// Reserves a burst, or says what refused it. A repeated id is answered from its first rows and never charged again;
// an error whose write may have landed is read back by id before it is called a refusal.
export async function reserveBurst(exec: Exec, r: Reservation, rate = hourlyRateUsd()): Promise<Reserved | Refused> {
  const statement = reserveStatement(r, rate);
  let inserted = 0;
  try {
    inserted = (await exec(statement)).changes;
  } catch (error) {
    try {
      const rows = await held(exec, r.id);
      if (rows.length) return reservedFrom(r.id, rows, true);
      return unavailable(error);
    } catch (readBack) {
      return unavailable(error, readBack);
    }
  }
  try {
    const rows = await held(exec, r.id);
    if (rows.length) return reservedFrom(r.id, rows, inserted === 0);
    const days = minutesByDay(r.at, r.minutes).map((part) => part.day);
    const answer = (await exec(ledgerStatement(days))).rows as { day: string; minutes: number }[];
    const ledger: Ledger = { days: {}, total: 0 };
    for (const row of answer) {
      if (row.day === "*") ledger.total = Number(row.minutes);
      else ledger.days[row.day] = Number(row.minutes);
    }
    const why = mayCall(ledger, r.at, r.minutes, rate);
    // The statement refused, so a cap did; when the second read no longer shows one (a settlement landed in between),
    // the day is still named, never a success.
    return why.ok
      ? {
          ok: false,
          reason: "day-minutes",
          day: days[0] ?? sastDay(r.at),
          detail: "the ledger refused the reservation",
        }
      : why;
  } catch (error) {
    return unavailable(error);
  }
}

function reservedFrom(id: string, rows: HeldRow[], repeated: boolean): Reserved {
  return {
    ok: true,
    id,
    wakeAt: (rows[0] as HeldRow).wake_at,
    parts: rows.map((row) => ({ day: row.day, minutes: Number(row.reserved_minutes) })),
    repeated,
  };
}

// The burst a reservation id holds, for a caller re-entering after a restart: its wake time, and whether it is settled.
export async function findBurst(exec: Exec, id: string): Promise<{ wakeAt: string; settled: boolean } | null> {
  const rows = await held(exec, id);
  if (!rows.length) return null;
  return { wakeAt: (rows[0] as HeldRow).wake_at, settled: rows.every((row) => row.settled_at !== null) };
}

// Settles a burst at what it used (see `usedMinutes`), once. A failed write leaves the reserve counted, which is never
// less than the burst used, and is reported so the caller can log it.
export async function settleBurst(
  exec: Exec,
  id: string,
  activity: Activity,
  at: Date = new Date(),
): Promise<{ ok: true; used: number } | Refused> {
  try {
    const rows = await held(exec, id);
    if (!rows.length)
      return { ok: false, reason: "ledger-unavailable", detail: `no reservation ${id} in the runtime ledger` };
    if (rows.every((row) => row.settled_at !== null))
      return { ok: true, used: rows.reduce((sum, row) => sum + Number(row.used_minutes ?? 0), 0) };
    const wakeAt = new Date((rows[0] as HeldRow).wake_at);
    const used = usedMinutes(wakeAt, activity);
    for (const statement of settleStatements(id, wakeAt, used, at, activity.lastAnswerAt ?? null))
      await exec(statement);
    return { ok: true, used };
  } catch (error) {
    try {
      const rows = await held(exec, id);
      if (rows.length && rows.every((row) => row.settled_at !== null))
        return { ok: true, used: rows.reduce((sum, row) => sum + Number(row.used_minutes ?? 0), 0) };
      return unavailable(error);
    } catch (readBack) {
      return unavailable(error, readBack);
    }
  }
}

// A day's counted minutes, for status and the admin overview.
export async function dayMinutes(exec: Exec, day: string): Promise<number> {
  const rows = (await exec(ledgerStatement([day]))).rows as { day: string; minutes: number }[];
  return Number(rows.find((row) => row.day === day)?.minutes ?? 0);
}
