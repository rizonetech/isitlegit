// Re-delivers a verdict reply the operator settled failed (D01 T02 §8). `scripts/mail-settle.ts ... failed --resend`
// records the request on the row; the Worker's cron, which holds the bindings a reply needs, rebuilds each requested
// reply from its case and sends it through `reply()` under the same send key, so the allowlist, threading and the send
// log apply as for the first send. Each request is handled on its own: one that throws leaves the rest.
import { getCaseForPipeline } from "../db/cases";
import { getVerdict } from "../db/verdicts";
import { type ReportState, reply } from "../pipeline/analysis-workflow";
import { type MailDeps, sendMail } from "./smtp2go";

// A failed resend is tried again on the next run, three runs in all, then left exhausted for the operator to requeue.
export const RESEND_RUNS = 3;
const BATCH = 10;

// The case's report state, as the workflow left it: its verdict, or for a partial case the earliest analysis failure
// (never the reply step's own, as the workflow keeps the first failure as the report's cause).
export async function rebuildState(db: D1Database, caseId: string): Promise<ReportState> {
  const found = await getCaseForPipeline(db, caseId);
  if (!found.ok) throw new Error("ResendCaseUnreadable");
  if (found.value.status === "done") {
    const stored = await getVerdict(db, caseId);
    if (!stored?.ok) throw new Error("ResendVerdictUnreadable");
    return { status: "ready", verdict: stored.value.verdict };
  }
  if (found.value.status === "partial") {
    const failure = await db
      .prepare(
        "SELECT step, error FROM case_events WHERE case_id = ? AND status = 'failed' ORDER BY CASE WHEN step = 'reply' THEN 1 ELSE 0 END, id LIMIT 1",
      )
      .bind(caseId)
      .first<{ step: string; error: string | null }>();
    if (!failure) throw new Error("ResendFailureUnknown");
    return {
      status: "partial",
      failedStep: failure.step as Extract<ReportState, { status: "partial" }>["failedStep"],
      errorClass: failure.error ?? "Error",
    };
  }
  throw new Error("ResendCaseUnfinished");
}

export type ResendReport = { done: number; retried: number; exhausted: number; errors: string[] };

export async function resendRequested(env: Env, now = () => new Date()): Promise<ResendReport> {
  const report: ResendReport = { done: 0, retried: 0, exhausted: 0, errors: [] };
  const rows = await env.DB.prepare(
    `SELECT send_key, case_id, resend_runs FROM mail_sends WHERE resend_state = 'requested' AND kind = 'reply' AND status = 'failed' ORDER BY resend_at LIMIT ${BATCH}`,
  ).all<{ send_key: string; case_id: string | null; resend_runs: number }>();
  for (const row of rows.results) {
    // Claimed in one guarded update, so two runs cannot both send it and a cancel after this is refused.
    const claimed = await env.DB.prepare(
      "UPDATE mail_sends SET resend_state = 'sending', resend_at = ? WHERE send_key = ? AND resend_state = 'requested' RETURNING send_key",
    )
      .bind(now().toISOString(), row.send_key)
      .first();
    if (!claimed) continue;
    const finish = (state: "done" | "requested" | "exhausted", runs: number) =>
      env.DB.prepare("UPDATE mail_sends SET resend_state = ?, resend_runs = ?, resend_at = ? WHERE send_key = ?")
        .bind(state, runs, now().toISOString(), row.send_key)
        .run();
    try {
      if (!row.case_id) throw new Error("ResendNoCase");
      // Sent, refused (the allowlist), a duplicate, no forwarder, or uncertain: final here, an uncertain or pending send
      // settled by the reconciler and never sent again here. A failed send throws (ReplyNotSent) and is tried again.
      await reply(env, row.case_id, await rebuildState(env.DB, row.case_id));
      await finish("done", row.resend_runs + 1);
      report.done += 1;
    } catch (error) {
      const runs = row.resend_runs + 1;
      const name = (error as Error).message === "ReplyNotSent" ? "ReplyNotSent" : (error as Error).name;
      if (runs >= RESEND_RUNS) {
        await finish("exhausted", runs);
        report.exhausted += 1;
        await alertExhausted(env, row.send_key, now()).catch((alertError: unknown) =>
          report.errors.push(
            `${row.send_key}: the exhausted resend's alert was not sent (${(alertError as Error).name})`,
          ),
        );
      } else {
        await finish("requested", runs);
        report.retried += 1;
      }
      report.errors.push(`${row.send_key}: resend run ${runs} did not send (${name})`);
    }
  }
  return report;
}

async function alertExhausted(env: Env, sendKey: string, at: Date) {
  if (!env.OPERATOR_EMAIL) throw new Error("NoOperatorAddress");
  const deps: MailDeps = { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL };
  await sendMail(deps, {
    sendKey: `resend-exhausted:${sendKey}@${at.toISOString()}`,
    kind: "alert",
    to: env.OPERATOR_EMAIL,
    from: "IsItLegit <alerts@isitlegit.co.za>",
    subject: `A reply could not be sent again (${sendKey})`,
    text: [
      `IsItLegit tried ${RESEND_RUNS} times to send the reply with send key ${sendKey} again, and each send failed.`,
      "Once SMTP2GO is sending again (python3 scripts/check-smtp2go.py), ask for it once more:",
      `  node scripts/mail-settle.ts ${sendKey} requeue`,
      "docs/operations.md has the steps.",
    ].join("\n"),
  });
}
