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

// The time of [start, end] (ms) outside every interval in `covered`, as segments.
export function uncovered(start: number, end: number, covered: [number, number][]): [number, number][] {
  let segments: [number, number][] = end > start ? [[start, end]] : [];
  for (const [from, to] of covered) {
    const next: [number, number][] = [];
    for (const [a, b] of segments) {
      if (to <= a || from >= b) next.push([a, b]);
      else {
        if (from > a) next.push([a, from]);
        if (to < b) next.push([to, b]);
      }
    }
    segments = next;
  }
  return segments;
}

// The minutes each SAST day takes of some segments of time.
export function partsOf(segments: [number, number][]): Part[] {
  const days = new Map<string, number>();
  for (const [a, b] of segments)
    for (const part of minutesByDay(new Date(a), (b - a) / 60_000))
      days.set(part.day, (days.get(part.day) ?? 0) + part.minutes);
  return [...days].map(([day, minutes]) => ({ day, minutes }));
}

// The settled bursts before this one that overlap [start, end], each as its interval. "Before" is the order the
// database settled them in (`settled_at` from its own clock, ties broken by id), so every pair of overlapping bursts
// agrees which of them carries the shared time, however their settlements interleave.
export const predecessorsStatement = (id: string, settledAt: string, start: Date, end: Date): Statement => ({
  sql:
    "SELECT min(wake_at) AS wake_at, max(ended_at) AS ended_at FROM glimmer_runtime WHERE reservation_id != ?1 " +
    "AND settled_at IS NOT NULL AND ended_at IS NOT NULL AND wake_at < ?4 AND ended_at > ?3 " +
    "AND (settled_at < ?2 OR (settled_at = ?2 AND reservation_id < ?1)) GROUP BY reservation_id",
  params: [id, settledAt, start.toISOString(), end.toISOString()],
});

const DB_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// The per-day statement both steps of a settlement use: every day the reservation reserved or used is written with its
// minutes (0 for a reserved day it never reached), and a used day it did not reserve is added. One statement, so each
// step lands whole or not at all.
function daysStatement(id: string, days: Part[], extra: (string | number | null)[], conflict: string): Statement {
  const params: (string | number | null)[] = [id, ...extra];
  const values = days.map((part) => {
    params.push(part.day, part.minutes);
    return `(?${params.length - 1}, ?${params.length})`;
  });
  return {
    sql:
      `WITH parts(day, minutes) AS (VALUES ${values.join(", ")}), ` +
      "first AS (SELECT source, caller, purpose, wake_at FROM glimmer_runtime WHERE reservation_id = ?1 LIMIT 1) " +
      "INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, last_answer_at, ended_at, settled_at) " +
      `SELECT ?1 || ':' || p.day, ?1, p.day, f.source, f.caller, f.purpose, f.wake_at, 0, p.minutes, ${conflict} ` +
      "FROM parts p, first f WHERE true ON CONFLICT (id) DO UPDATE SET used_minutes = excluded.used_minutes",
    params,
  };
}

// Step 1: the burst settled at its whole interval (never less than it used), with its end and the database's time.
export function settleStatement(id: string, days: Part[], lastAnswerAt: Date | null, endedAt: Date): Statement {
  const s = daysStatement(id, days, [lastAnswerAt?.toISOString() ?? null, endedAt.toISOString()], `?2, ?3, ${DB_NOW}`);
  return {
    sql:
      `${s.sql}, last_answer_at = excluded.last_answer_at, ended_at = excluded.ended_at, settled_at = excluded.settled_at ` +
      "WHERE glimmer_runtime.settled_at IS NULL",
    params: s.params,
  };
}

// Step 2: the same burst's minutes less the time its predecessors already carry; only its own settled rows change.
export function reconcileStatement(id: string, days: Part[], settledAt: string): Statement {
  const s = daysStatement(id, days, [settledAt], "NULL, NULL, ?2");
  return { sql: `${s.sql} WHERE glimmer_runtime.settled_at = ?2`, params: s.params };
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
): Promise<{ ok: true; used: number } | Refused> {
  const total = (rows: HeldRow[]) => rows.reduce((sum, row) => sum + Number(row.used_minutes ?? 0), 0);
  const dayParts = (rows: HeldRow[], used: Part[]) => {
    const days = new Map(rows.map((row) => [row.day, 0]));
    for (const part of used) days.set(part.day, part.minutes);
    return [...days].map(([day, minutes]) => ({ day, minutes }));
  };
  try {
    const rows = await held(exec, id);
    if (!rows.length)
      return { ok: false, reason: "ledger-unavailable", detail: `no reservation ${id} in the runtime ledger` };
    if (rows.every((row) => row.settled_at !== null)) return { ok: true, used: total(rows) };
    const wakeAt = new Date((rows[0] as HeldRow).wake_at);
    const full = usedMinutes(wakeAt, activity);
    const end = new Date(wakeAt.getTime() + full * 60_000);
    // Step 1: the whole interval, so a failure after it leaves the burst charged at least what it used.
    const whole = dayParts(rows, partsOf(uncovered(wakeAt.getTime(), end.getTime(), [])));
    await exec(settleStatement(id, whole, activity.lastAnswerAt ?? null, end));
    const settled = await held(exec, id);
    const settledAt = (settled[0] as HeldRow).settled_at;
    if (settledAt === null) throw new Error(`the settlement of ${id} did not land`);
    // Step 2: time a burst settled before this one already carries is charged once, to it.
    const before = (await exec(predecessorsStatement(id, settledAt, wakeAt, end))).rows as {
      wake_at: string;
      ended_at: string;
    }[];
    const covered = before.map((b): [number, number] => [Date.parse(b.wake_at), Date.parse(b.ended_at)]);
    const parts = dayParts(settled, partsOf(uncovered(wakeAt.getTime(), end.getTime(), covered)));
    if (covered.length) await exec(reconcileStatement(id, parts, settledAt));
    return { ok: true, used: parts.reduce((sum, part) => sum + part.minutes, 0) };
  } catch (error) {
    try {
      const rows = await held(exec, id);
      if (rows.length && rows.every((row) => row.settled_at !== null)) return { ok: true, used: total(rows) };
      return unavailable(error);
    } catch (readBack) {
      return unavailable(error, readBack);
    }
  }
}

// The ledger for the operator (`deploy.ts minutes`): a day's settled and outstanding minutes, each outstanding
// reservation with its id and age (an interrupted caller's stays counted at its reserve until it is settled), and the
// headroom left in the day and in the total.
export async function ledgerStatus(exec: Exec, now: Date, rate = hourlyRateUsd()) {
  const day = sastDay(now);
  const rows = (
    await exec({
      sql:
        "SELECT reservation_id, purpose, source, wake_at, day, reserved_minutes, used_minutes, settled_at FROM glimmer_runtime " +
        "WHERE day = ?1 OR settled_at IS NULL ORDER BY wake_at",
      params: [day],
    })
  ).rows as (HeldRow & { reservation_id: string; purpose: string; source: string })[];
  const total = Number(((await exec(ledgerStatement([]))).rows[0] as { minutes: number } | undefined)?.minutes ?? 0);
  const today = rows.filter((row) => row.day === day);
  const settled = today
    .filter((row) => row.settled_at !== null)
    .reduce((sum, row) => sum + Number(row.used_minutes), 0);
  const outstanding = rows.filter((row) => row.settled_at === null);
  const held = today
    .filter((row) => row.settled_at === null)
    .reduce((sum, row) => sum + Number(row.reserved_minutes), 0);
  return {
    day,
    settled: tenth(settled),
    outstanding: outstanding.map((row) => ({
      id: row.reservation_id,
      purpose: row.purpose,
      source: row.source,
      day: row.day,
      reserved: tenth(Number(row.reserved_minutes)),
      age_minutes: Math.round((now.getTime() - Date.parse(row.wake_at)) / 60_000),
    })),
    day_left: tenth(dayLimitMinutes(rate) - settled - held),
    total_usd: Math.round(((total * rate) / 60) * 100) / 100,
    total_left_usd: Math.round((((totalLimitMinutes(rate) - total) * rate) / 60) * 100) / 100,
  };
}

// A day's counted minutes, for status and the admin overview.
export async function dayMinutes(exec: Exec, day: string): Promise<number> {
  const rows = (await exec(ledgerStatement([day]))).rows as { day: string; minutes: number }[];
  return Number(rows.find((row) => row.day === day)?.minutes ?? 0);
}
