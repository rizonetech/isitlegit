// Re-delivers a verdict reply the operator settled failed (D01 T02 §8). `scripts/mail-settle.ts ... failed --resend`
// (or `resend` for one already settled) records the request on the row; the Worker's cron, which holds the bindings a
// reply needs, rebuilds each requested reply from its case and sends it through `reply()` under the same send key, so
// the allowlist, threading and the send log apply as for the first send. Each request is handled on its own: one that
// throws leaves the rest. Each run first recovers claims a stopped run left behind and retries exhaustion alerts that
// did not go, then drains every request within its time budget.
import { getCaseForPipeline } from "../db/cases";
import { getVerdict } from "../db/verdicts";
import { type ReportState, reply } from "../pipeline/analysis-workflow";
import { type MailDeps, sendMail } from "./smtp2go";

// A failed resend is tried again on the next run, three runs in all, then left exhausted for the operator to requeue.
export const RESEND_RUNS = 3;
const BATCH = 10;
// A run sends for at most this long, so it ends well inside the cron's 15 minutes (completion review, G4).
export const RUN_BUDGET_MS = 5 * 60_000;
// A claim older than this belongs to a run that stopped (completion review, G2).
export const ABANDONED_MS = 10 * 60_000;

// The case's report state, as the workflow left it: its verdict, or for a partial case the earliest analysis failure
// (never the reply step's own, as the workflow keeps the first failure as the report's cause).
export async function rebuildState(db: D1Database, caseId: string): Promise<ReportState> {
  const found = await getCaseForPipeline(db, caseId);
  if (!found.ok) throw new ResendError("ResendCaseUnreadable");
  if (found.value.status === "done") {
    const stored = await getVerdict(db, caseId);
    if (!stored?.ok) throw new ResendError("ResendVerdictUnreadable");
    return { status: "ready", verdict: stored.value.verdict };
  }
  if (found.value.status === "partial") {
    const failure = await db
      .prepare(
        "SELECT step, error FROM case_events WHERE case_id = ? AND status = 'failed' ORDER BY CASE WHEN step = 'reply' THEN 1 ELSE 0 END, id LIMIT 1",
      )
      .bind(caseId)
      .first<{ step: string; error: string | null }>();
    if (!failure) throw new ResendError("ResendFailureUnknown");
    return {
      status: "partial",
      failedStep: failure.step as Extract<ReportState, { status: "partial" }>["failedStep"],
      errorClass: failure.error ?? "Error",
    };
  }
  throw new ResendError("ResendCaseUnfinished");
}

// A rebuild that cannot be done, named for the operator's status (G6): never the case's content.
class ResendError extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

export type ResendReport = {
  done: number;
  retried: number;
  exhausted: number;
  recovered: number;
  alerted: number;
  errors: string[];
};

export async function resendRequested(env: Env, now = () => new Date()): Promise<ResendReport> {
  const report: ResendReport = { done: 0, retried: 0, exhausted: 0, recovered: 0, alerted: 0, errors: [] };
  const started = Date.now();
  await recoverAbandoned(env.DB, now(), report);
  await retryAlerts(env, report);
  // Every request in one run, a batch at a time within the run's budget (G4).
  while (Date.now() - started < RUN_BUDGET_MS) {
    const rows = await env.DB.prepare(
      `SELECT send_key, case_id, resend_runs FROM mail_sends WHERE resend_state = 'requested' AND kind = 'reply' AND status = 'failed' ORDER BY resend_at LIMIT ${BATCH}`,
    ).all<{ send_key: string; case_id: string | null; resend_runs: number }>();
    if (rows.results.length === 0) break;
    let claimedAny = false;
    for (const row of rows.results) {
      if (Date.now() - started >= RUN_BUDGET_MS) break;
      claimedAny = (await resendOne(env, row, now, report)) || claimedAny;
    }
    if (!claimedAny) break;
  }
  return report;
}

async function resendOne(
  env: Env,
  row: { send_key: string; case_id: string | null; resend_runs: number },
  now: () => Date,
  report: ResendReport,
): Promise<boolean> {
  // Claimed in one guarded update, so two runs cannot both send it and a cancel after this is refused.
  const claimed = await env.DB.prepare(
    "UPDATE mail_sends SET resend_state = 'sending', resend_at = ? WHERE send_key = ? AND resend_state = 'requested' RETURNING send_key",
  )
    .bind(now().toISOString(), row.send_key)
    .first();
  if (!claimed) return false;
  const finish = (state: "done" | "requested" | "exhausted", runs: number, outcome: string) =>
    env.DB.prepare(
      "UPDATE mail_sends SET resend_state = ?, resend_runs = ?, resend_at = ?, resend_outcome = ? WHERE send_key = ?",
    )
      .bind(state, runs, now().toISOString(), outcome, row.send_key)
      .run();
  const runs = row.resend_runs + 1;
  try {
    if (!row.case_id) throw new ResendError("ResendNoCase");
    // Sent, refused (the allowlist), a duplicate, no forwarder, or uncertain: final here, an uncertain or pending send
    // settled by the reconciler and never sent again here. A failed send throws (ReplyNotSent) and is tried again.
    const result = await reply(env, row.case_id, await rebuildState(env.DB, row.case_id));
    const outcome =
      result.mail === "none"
        ? "with no one to reply to (no forwarder)"
        : result.outcome.status === "refused"
          ? `refused (${result.outcome.reason})`
          : result.outcome.status === "uncertain"
            ? "uncertain, left to the reconciler"
            : result.outcome.status === "duplicate"
              ? `a duplicate of an earlier ${result.outcome.previous} send`
              : "sent";
    await finish("done", runs, outcome);
    report.done += 1;
  } catch (error) {
    const name = (error as Error).message === "ReplyNotSent" ? "ReplyNotSent" : (error as Error).name;
    if (runs >= RESEND_RUNS) {
      await finish("exhausted", runs, `not sent after ${runs} runs (${name})`);
      report.exhausted += 1;
      await retryAlerts(env, report);
    } else {
      await finish("requested", runs, `run ${runs} not sent (${name})`);
      report.retried += 1;
    }
    report.errors.push(`${row.send_key}: resend run ${runs} did not send (${name})`);
  }
  return true;
}

// A claim a stopped run left behind (G2), by the send's own status: still failed means the reply never left (sendMail
// moves a reclaimed row to pending before it sends), so it is asked for again with the run counted; pending or uncertain
// may have gone, so it is the reconciler's; sent or refused is final.
async function recoverAbandoned(db: D1Database, at: Date, report: ResendReport) {
  const before = new Date(at.getTime() - ABANDONED_MS).toISOString();
  const rows = await db
    .prepare(
      `SELECT send_key, status, resend_runs FROM mail_sends WHERE resend_state = 'sending' AND resend_at < ? LIMIT ${BATCH * 10}`,
    )
    .bind(before)
    .all<{ send_key: string; status: string; resend_runs: number }>();
  for (const row of rows.results) {
    const again = row.status === "failed";
    const changed = await db
      .prepare(
        "UPDATE mail_sends SET resend_state = ?, resend_runs = ?, resend_at = ?, resend_outcome = ? WHERE send_key = ? AND resend_state = 'sending' AND resend_at < ?",
      )
      .bind(
        again ? "requested" : "done",
        again ? row.resend_runs + 1 : row.resend_runs,
        at.toISOString(),
        again ? "a run stopped before sending; asked for again" : "a run stopped while sending; left to the reconciler",
        row.send_key,
        before,
      )
      .run();
    if ((changed.meta.changes ?? 0) === 1) report.recovered += 1;
  }
}

// Each exhausted resend's operator alert, until it has gone (G3): under one send key for that exhaustion, so a retry
// never sends a second alert for it.
async function retryAlerts(env: Env, report: ResendReport) {
  if (!env.OPERATOR_EMAIL) return;
  const deps: MailDeps = { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL };
  const rows = await env.DB.prepare(
    `SELECT send_key, resend_at FROM mail_sends WHERE resend_state = 'exhausted' AND resend_alerted = 0 LIMIT ${BATCH}`,
  ).all<{ send_key: string; resend_at: string }>();
  for (const row of rows.results) {
    const outcome = await sendMail(deps, {
      sendKey: `resend-exhausted:${row.send_key}@${row.resend_at}`,
      kind: "alert",
      to: env.OPERATOR_EMAIL,
      from: "IsItLegit <alerts@isitlegit.co.za>",
      subject: `A reply could not be sent again (${row.send_key})`,
      text: [
        `IsItLegit tried ${RESEND_RUNS} times to send the reply with send key ${row.send_key} again, and it did not go.`,
        `Read why: node scripts/mail-settle.ts ${row.send_key} status`,
        "Once the cause is repaired (SMTP2GO sending again: python3 scripts/check-smtp2go.py), ask for it once more:",
        `  node scripts/mail-settle.ts ${row.send_key} requeue`,
        "docs/operations.md has the steps.",
      ].join("\n"),
    }).catch(() => null);
    const went = outcome?.status === "sent" || (outcome?.status === "duplicate" && outcome.previous === "sent");
    if (went) {
      await env.DB.prepare("UPDATE mail_sends SET resend_alerted = 1 WHERE send_key = ? AND resend_state = 'exhausted'")
        .bind(row.send_key)
        .run();
      report.alerted += 1;
    } else report.errors.push(`${row.send_key}: the exhausted resend's alert did not go; tried again next run`);
  }
}
