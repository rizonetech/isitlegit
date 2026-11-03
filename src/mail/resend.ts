// Re-delivers a verdict reply the operator settled failed (D01 T02 §8). `scripts/mail-settle.ts ... failed --resend`
// (or `resend` for one already settled) records the request on the row; the Worker's cron, which holds the bindings a
// reply needs, rebuilds each requested reply from its case and sends it through `reply()` under the same send key, so
// the allowlist, threading and the send log apply as for the first send. Each request is handled on its own: one that
// throws leaves the rest. Each run first recovers claims a stopped run left behind and retries exhaustion alerts that
// did not go, then drains every request within its time budget.
import { CURRENT_RUN, completeStored, getCaseForPipeline } from "../db/cases";
import { getVerdict } from "../db/verdicts";
import { childrenOf } from "../intake/children";
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
    // A stored verdict means the analysis finished: whatever failed after it (delivering the reply, finishing the
    // case), the reply is that verdict (rounds 1 and 2). Without one, the earliest failure before it is the report's
    // cause, as the workflow keeps it, never the reply step's own.
    const stored = await getVerdict(db, caseId);
    if (stored?.ok) return { status: "ready", verdict: stored.value.verdict };
    const failure = await db
      .prepare(
        // The current run's earliest failure (D01 T01 §17).
        `SELECT step, error FROM case_events WHERE case_id = ? AND status = 'failed' AND step NOT IN ('reply', 'finish') AND ${CURRENT_RUN} ORDER BY id LIMIT 1`,
      )
      .bind(caseId, caseId)
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
  // Each request is tried once a run (round 1), by its key: one put back for the next run is not selected again, and a
  // request asked for in the same instant the run began is still taken (a time stamp could not tell the two apart). A
  // claim that throws is tried once more in the run, never a third time.
  const tried = new Set<string>();
  const threw = new Set<string>();
  const inBudget = () => Date.now() - started < RUN_BUDGET_MS;
  // Each pass on its own (final review): one that fails is logged and the next still runs.
  await recoverAbandoned(env.DB, now(), report).catch((error: unknown) =>
    report.errors.push(`recovering abandoned claims failed (${(error as Error).name})`),
  );
  await retryAlerts(env, report, inBudget).catch((error: unknown) =>
    report.errors.push(`retrying exhaustion alerts failed (${(error as Error).name})`),
  );
  // Every request in one run, a batch at a time within the run's budget (G4).
  while (Date.now() - started < RUN_BUDGET_MS) {
    const rows = await env.DB.prepare(
      "SELECT send_key, case_id, resend_runs FROM mail_sends WHERE resend_state = 'requested' AND kind = 'reply' AND status = 'failed' ORDER BY resend_at LIMIT ?",
    )
      .bind(BATCH + tried.size)
      .all<{ send_key: string; case_id: string | null; resend_runs: number }>();
    const fresh = rows.results.filter((row) => !tried.has(row.send_key));
    if (fresh.length === 0) break;
    for (const row of fresh.slice(0, BATCH)) {
      if (!inBudget()) break;
      // One request's failure (its claim included) never ends the run for the rest (final review).
      try {
        await resendOne(env, row, now, report);
        tried.add(row.send_key);
      } catch (error) {
        report.errors.push(`${row.send_key}: its resend could not be handled (${(error as Error).name})`);
        if (threw.has(row.send_key)) tried.add(row.send_key);
        else threw.add(row.send_key);
      }
    }
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
  const claimAt = now().toISOString();
  const claimed = await env.DB.prepare(
    "UPDATE mail_sends SET resend_state = 'sending', resend_at = ? WHERE send_key = ? AND resend_state = 'requested' RETURNING send_key",
  )
    .bind(claimAt, row.send_key)
    .first();
  if (!claimed) return false;
  // Fenced by this claim (final review): a run whose claim was recovered and taken by a later run never overwrites it.
  const finish = (state: "done" | "requested" | "exhausted", runs: number, outcome: string) =>
    env.DB.prepare(
      "UPDATE mail_sends SET resend_state = ?, resend_runs = ?, resend_at = ?, resend_outcome = ? WHERE send_key = ? AND resend_state = 'sending' AND resend_at = ?",
    )
      .bind(state, runs, now().toISOString(), outcome, row.send_key, claimAt)
      .run();
  const runs = row.resend_runs + 1;
  // The delivery and the bookkeeping after it are apart (round 3): only a delivery that did not go counts against the
  // request. A bookkeeping write that fails is logged and leaves the claim in `sending`, which the next runs' recovery
  // settles by the send's own status (sent or refused: done; failed: asked for again), never as a failed delivery.
  let outcome: string;
  try {
    if (!row.case_id) throw new ResendError("ResendNoCase");
    // A reply for a run the case has since retried is not sent again: the retried run sends its own, under its own key,
    // and this one's content would be the old run's (D01 T01 §17's completion review).
    const current = await getCaseForPipeline(env.DB, row.case_id);
    if (!current.ok) throw new ResendError("ResendCaseUnreadable");
    const isGroup = row.send_key === `reply:group:${row.case_id}`;
    if (!isGroup && row.send_key !== `reply:${current.value.runId ?? row.case_id}`) {
      // While the retry's start is unresolved (`received`), it may yet be rolled back and this run be current again:
      // the request waits, its count unchanged (round 2).
      if (current.value.status === "received") {
        await finish("requested", row.resend_runs, "waiting: the check's retry has not started yet");
        return true;
      }
      await finish("done", runs, "superseded: the check was retried, and its own run replies");
      report.done += 1;
      return true;
    }
    if (isGroup && current.value.status === "received") {
      await finish("requested", row.resend_runs, "waiting: the check's retry has not started yet");
      return true;
    }
    // Sent, refused (the allowlist), a duplicate, no forwarder, or uncertain: final here, an uncertain or pending send
    // settled by the reconciler and never sent again here. A failed send throws (ReplyNotSent) and is tried again.
    const state = isGroup
      ? await rebuildState(env.DB, row.case_id).catch(() => ({
          status: "partial" as const,
          failedStep: "reply" as const,
          errorClass: "ReplyNotSent",
        }))
      : await rebuildState(env.DB, row.case_id);
    const result = await reply(env, row.case_id, state, row.send_key);
    if (result.mail === "waiting") {
      await finish("requested", row.resend_runs, "waiting: the forward's other cases have not finished yet");
      return true;
    }
    // A partial case whose verdict has now reached the member is finished, as the workflow's own finish step would have
    // done (final review); a failure here leaves it as it was and is logged.
    const delivered =
      result.mail !== "none" &&
      (result.outcome.status === "sent" ||
        (result.outcome.status === "duplicate" && result.outcome.previous === "sent"));
    if (delivered) {
      if (isGroup) {
        await finishCase(env.DB, row.case_id, report);
        for (const child of await childrenOf(env.DB, row.case_id)) await finishCase(env.DB, child.childCaseId, report);
      } else if (state.status === "ready") {
        await finishCase(env.DB, row.case_id, report);
      }
    }
    outcome =
      result.mail === "none"
        ? "with no one to reply to (no forwarder)"
        : result.outcome.status === "refused"
          ? `refused (${result.outcome.reason})`
          : result.outcome.status === "uncertain"
            ? "uncertain, left to the reconciler"
            : result.outcome.status === "duplicate"
              ? `a duplicate of an earlier ${result.outcome.previous} send`
              : "sent";
  } catch (error) {
    const name = (error as Error).message === "ReplyNotSent" ? "ReplyNotSent" : (error as Error).name;
    report.errors.push(`${row.send_key}: resend run ${runs} did not send (${name})`);
    try {
      if (runs >= RESEND_RUNS) {
        // Its alert goes from the next run's alert pass, within that run's budget (final review).
        await finish("exhausted", runs, `not sent after ${runs} runs (${name})`);
        report.exhausted += 1;
      } else {
        await finish("requested", runs, `run ${runs} not sent (${name})`);
        report.retried += 1;
      }
    } catch {
      report.errors.push(`${row.send_key}: its resend state could not be written; recovered by a later run`);
    }
    return true;
  }
  try {
    await finish("done", runs, outcome);
    report.done += 1;
  } catch {
    report.errors.push(`${row.send_key}: sent, but its resend state could not be written; recovered by a later run`);
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
        // Stamped before this run began, so an unsent one recovered here is tried in this same run.
        again ? before : at.toISOString(),
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
async function retryAlerts(env: Env, report: ResendReport, inBudget: () => boolean) {
  if (!env.OPERATOR_EMAIL) return;
  const deps: MailDeps = { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL };
  // The least recently tried first, each try stamped, so an alert left uncertain never holds the others back (round 1).
  const rows = await env.DB.prepare(
    `SELECT send_key, resend_at FROM mail_sends WHERE resend_state = 'exhausted' AND resend_alerted = 0 ORDER BY coalesce(resend_alert_tried_at, '') LIMIT ${BATCH}`,
  ).all<{ send_key: string; resend_at: string }>();
  for (const row of rows.results) {
    if (!inBudget()) break;
    await env.DB.prepare("UPDATE mail_sends SET resend_alert_tried_at = ? WHERE send_key = ?")
      .bind(new Date().toISOString(), row.send_key)
      .run();
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

// The workflow's finish step, done for a partial case whose verdict a resend delivered.
async function finishCase(db: D1Database, caseId: string, report: ResendReport) {
  const found = await getCaseForPipeline(db, caseId);
  if (!found.ok || found.value.status !== "partial") return;
  const set = await completeStored(db, found.value.orgId, caseId);
  if (!set.ok) report.errors.push(`case ${caseId}: its verdict was resent but the case could not be finished`);
}
