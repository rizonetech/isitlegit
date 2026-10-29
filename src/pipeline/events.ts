// A case's step events (D01 T01 §7): the audit trail and the model trace's source (`case_events`, migration 0001).
// Each attempt of a Workflow step records `started`, then `done` or `error` (with its error class), so a retried step's
// attempts are each balanced; a step that failed after its last attempt records `failed` once. The `error` column never
// holds message content. A typed write like the case helpers: a failure is a `database` refusal, which the step
// turns into a retry.
import type { CaseResult } from "../db/cases";

export type EventStatus = "started" | "done" | "error" | "failed";
export type CaseEvent = {
  caseId: string;
  step: string;
  status: EventStatus;
  startedAt: string;
  ms: number | null;
  error: string | null;
};

export async function recordEvent(
  db: D1Database,
  caseId: string,
  step: string,
  status: EventStatus,
  // `once`: write nothing when this step already has an event of this status (a retried failure record).
  extra: { startedAt?: string; ms?: number; errorClass?: string; once?: boolean } = {},
): Promise<CaseResult<CaseEvent>> {
  const event: CaseEvent = {
    caseId,
    step,
    status,
    startedAt: extra.startedAt ?? new Date().toISOString(),
    ms: extra.ms ?? null,
    // An error's class only (a name such as ParseError), never its message, which can quote the message analysed: a
    // value that is not an identifier is recorded as "Error". A Meta cap's class (`budget:<cap>:<model>`, D03 T01 §2) is
    // kept whole, so a reply rebuilt from the event gives the same advice as the first (D01 T02 §8).
    error: extra.errorClass
      ? /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(extra.errorClass) ||
        /^budget:(day|reserve|total):[a-z0-9][a-z0-9.-]{0,40}$/.test(extra.errorClass)
        ? extra.errorClass
        : "Error"
      : null,
  };
  try {
    const values = [event.caseId, event.step, event.status, event.startedAt, event.ms, event.error];
    await (extra.once
      ? db
          .prepare(
            "INSERT INTO case_events (case_id, step, status, started_at, ms, error) SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM case_events WHERE case_id = ? AND step = ? AND status = ?)",
          )
          .bind(...values, event.caseId, event.step, event.status)
      : db
          .prepare("INSERT INTO case_events (case_id, step, status, started_at, ms, error) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(...values)
    ).run();
    return { ok: true, value: event };
  } catch (error) {
    return { ok: false, error: { code: "database", message: (error as Error).message } };
  }
}
