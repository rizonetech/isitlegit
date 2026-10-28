// A case's step events (D01 T01 §7): the audit trail and the model trace's source (`case_events`, migration 0001).
// Each Workflow step records `started` and `done`, and a failed one `failed` with its error class; the `error` column
// never holds message content. A typed write like the case helpers: a failure is a `database` refusal, which the step
// turns into a retry.
import type { CaseResult } from "../db/cases";

export type EventStatus = "started" | "done" | "failed";
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
  extra: { startedAt?: string; ms?: number; errorClass?: string } = {},
): Promise<CaseResult<CaseEvent>> {
  const event: CaseEvent = {
    caseId,
    step,
    status,
    startedAt: extra.startedAt ?? new Date().toISOString(),
    ms: extra.ms ?? null,
    // An error's class only (a name such as ParseError), never its message, which can quote the message analysed: a
    // value that is not an identifier is recorded as "Error".
    error: extra.errorClass
      ? /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(extra.errorClass)
        ? extra.errorClass
        : "Error"
      : null,
  };
  try {
    await db
      .prepare("INSERT INTO case_events (case_id, step, status, started_at, ms, error) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(event.caseId, event.step, event.status, event.startedAt, event.ms, event.error)
      .run();
    return { ok: true, value: event };
  } catch (error) {
    return { ok: false, error: { code: "database", message: (error as Error).message } };
  }
}
