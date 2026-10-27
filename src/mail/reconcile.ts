// Settles sends left `uncertain` (no answer, an unreadable answer or a 5xx, D01 T02 §1) or `pending` (a stopped Worker)
// from SMTP2GO's own record (D01 T02 §5; https://developers.smtp2go.com/reference/search-activity.md, read 2026-10-27).
//
// Every send carries its key in `X-IsItLegit-Send`. SMTP2GO's activity search cannot filter by a header's value but
// returns it, so the reconciler pages the window around the row's latest claim (`claimed_at`, migration 0004) and
// matches the key itself. Only positive evidence settles a row: an event carrying the key means SMTP2GO took the
// message, so the row is `sent` (a later bounce or rejection is still a send, its reason kept). An empty search proves
// nothing, since SMTP2GO states no maximum delay before a message appears, so the row stays uncertain and is never made
// retryable here; an error or a page budget run out leaves it too. A row is settled only while it is the attempt and
// state the reconciler read, so a retry or another reconciler in between is never overwritten. A row still unresolved
// when it leaves the age band goes to the operator, once, by an `alert` mail; `scripts/mail-settle.ts` resolves it.
// The reconciler never sends the message it reconciles.
import { ConfigError } from "../config";
import { type MailDeps, type MailMessage, sendMail } from "./smtp2go";

export const ACTIVITY_URL = "https://api.smtp2go.com/v3/activity/search";
export const HEADER = "X-IsItLegit-Send";
// The scheduled run's band: rows whose claim is older than this many minutes and younger than this many days.
export const BOUNDS = { olderThanMinutes: 30, youngerThanDays: 3 } as const;
const BEFORE_MS = 5 * 60_000;
const AFTER_MS = 30 * 60_000;
const PAGE_BUDGET = 5;

export type ReconcileDeps = MailDeps & {
  // Where an unresolved send is reported; nothing is sent without it.
  operator: string | undefined;
  pageBudget?: number;
};
export type ReconcileReport = {
  settled: string[];
  unresolved: string[];
  handedOver: string[];
  errors: string[];
};
type Row = { send_key: string; kind: string; case_id: string | null; claimed_at: string; status: string };
type Found = { emailId: string | null; event: string; reason: string | null };

// SMTP2GO's events for the window, matched on the key; `null` when the whole window could not be read.
async function search(deps: ReconcileDeps, apiKey: string, row: Row): Promise<Found | "absent" | null> {
  const claimed = Date.parse(row.claimed_at);
  const window = {
    start_date: new Date(claimed - BEFORE_MS).toISOString(),
    end_date: new Date(claimed + AFTER_MS).toISOString(),
    custom_headers: [HEADER],
    limit: 1000,
  };
  let token: string | null = null;
  for (let page = 0; page < (deps.pageBudget ?? PAGE_BUDGET); page++) {
    let body: { data?: { events?: unknown; continue_token?: unknown } };
    try {
      const response = await (deps.fetch ?? fetch)(ACTIVITY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-smtp2go-api-key": apiKey },
        body: JSON.stringify(token ? { ...window, continue_token: token } : window),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
      });
      if (response.status !== 200) return null;
      body = await response.json();
    } catch {
      return null;
    }
    const events = Array.isArray(body?.data?.events) ? (body.data.events as Record<string, unknown>[]) : null;
    if (!events) return null;
    for (const event of events) {
      const headers = (event.custom_headers ?? {}) as Record<string, unknown>;
      const value = Object.entries(headers).find(([name]) => name.toLowerCase() === HEADER.toLowerCase())?.[1];
      if (value === row.send_key)
        return {
          emailId: typeof event.email_id === "string" ? event.email_id : null,
          event: String(event.event ?? "processed"),
          reason: typeof event.reason === "string" && event.reason ? event.reason : null,
        };
    }
    token = typeof body.data?.continue_token === "string" && body.data.continue_token ? body.data.continue_token : null;
    if (!token) return "absent";
  }
  return null;
}

export async function reconcileUncertain(
  deps: ReconcileDeps,
  bounds: { olderThanMinutes: number; youngerThanDays: number } = BOUNDS,
): Promise<ReconcileReport> {
  if (!deps.apiKey) throw new ConfigError("SMTP2GO_API_KEY is not set");
  const now = (deps.now ?? (() => new Date()))();
  const report: ReconcileReport = { settled: [], unresolved: [], handedOver: [], errors: [] };
  const settledBefore = new Date(now.getTime() - bounds.olderThanMinutes * 60_000).toISOString();
  const cutoff = new Date(now.getTime() - bounds.youngerThanDays * 86_400_000).toISOString();
  const rows = await deps.db
    .prepare(
      "SELECT send_key, kind, case_id, claimed_at, status FROM mail_sends WHERE status IN ('uncertain', 'pending') AND claimed_at <= ? AND send_key NOT LIKE 'unresolved:%' ORDER BY claimed_at",
    )
    .bind(settledBefore)
    .all<Row>();
  for (const row of rows.results) {
    if (row.claimed_at < cutoff) {
      await handOver(deps, row, report);
      continue;
    }
    const found = await search(deps, deps.apiKey, row);
    if (found === null) {
      report.errors.push(row.send_key);
      continue;
    }
    if (found === "absent") {
      report.unresolved.push(row.send_key);
      continue;
    }
    // Only the attempt and state that were read: a retry or another reconciler since then keeps its outcome.
    const note =
      found.event === "processed" || found.event === "delivered"
        ? "settled from SMTP2GO's activity"
        : `settled from SMTP2GO's activity: ${found.event}${found.reason ? `, ${found.reason}` : ""}`;
    const result = await deps.db
      .prepare(
        "UPDATE mail_sends SET status = 'sent', provider_id = COALESCE(?, provider_id), error = ?, updated_at = ? WHERE send_key = ? AND claimed_at = ? AND status = ?",
      )
      .bind(found.emailId, note.slice(0, 300), now.toISOString(), row.send_key, row.claimed_at, row.status)
      .run();
    if (result.meta.changes === 1) report.settled.push(row.send_key);
  }
  return report;
}

// A row past the age band: the operator hears of it once (the alert's own send key), never the recipient again.
async function handOver(deps: ReconcileDeps, row: Row, report: ReconcileReport): Promise<void> {
  if (!deps.operator) {
    report.errors.push(row.send_key);
    return;
  }
  const message: MailMessage = {
    sendKey: `unresolved:${row.send_key}`,
    kind: "alert",
    to: deps.operator,
    from: "IsItLegit <alerts@isitlegit.co.za>",
    subject: `A ${row.kind} mail may not have been sent (${row.send_key})`,
    text: [
      `IsItLegit could not tell whether SMTP2GO took the ${row.kind} mail with send key ${row.send_key}${row.case_id ? ` (case ${row.case_id})` : ""}, claimed at ${row.claimed_at}.`,
      "Look the send key up in SMTP2GO's activity (the X-IsItLegit-Send header), then settle it:",
      `  node scripts/mail-settle.ts ${row.send_key} sent    (SMTP2GO has it)`,
      `  node scripts/mail-settle.ts ${row.send_key} failed  (SMTP2GO has no record; the caller may send again)`,
      "docs/operations.md has the steps.",
    ].join("\n"),
  };
  const outcome = await sendMail(deps, message);
  if (outcome.status === "sent" || outcome.status === "duplicate") report.handedOver.push(row.send_key);
  else report.errors.push(row.send_key);
}
