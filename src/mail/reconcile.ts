// Settles sends left `uncertain` (no answer, an unreadable answer or a 5xx, D01 T02 §1) or `pending` (a stopped Worker)
// from SMTP2GO's own record (D01 T02 §5; https://developers.smtp2go.com/reference/search-activity.md, read 2026-10-27).
//
// Every send carries its key in `X-IsItLegit-Send`. SMTP2GO's activity search cannot filter by a header's value but
// returns it, so the reconciler pages the window around the row's latest claim (`claimed_at`, migration 0004) and
// matches the key itself, keeping its place (`search_cursor`, migration 0005) so a long window is read across runs.
// Requests are paced under SMTP2GO's 60 a minute and capped per run.
//
// Only complete positive evidence settles a row: an event that is an object with a string `email_id` and `event` and
// carries the key means SMTP2GO took the message, so the row is `sent` (a later bounce or rejection is still a send;
// its event type and SMTP code are kept, never its text, which can name the recipient). An empty search proves
// nothing, since SMTP2GO states no maximum delay before a message appears, so the row stays uncertain and is never made
// retryable here; an error, a malformed answer or a run budget spent leaves it too. A row is settled only while it is
// the attempt and state the reconciler read, so a retry or another reconciler in between is never overwritten.
//
// A row still unresolved when it leaves the age band goes to the operator by an `alert` mail, keyed by that attempt (a
// later attempt that ages out gets its own). It counts as handed over only once that alert is known sent, and a failed
// alert makes the run degraded; an alert that is itself uncertain is reconciled like
// any send and reported unresolved until it is settled, and an alert is never raised about an alert. The run's outcome
// (settled, unresolved, handed over, errors, and whether it was disabled or degraded) is returned for the scheduled
// entrypoint to log. `scripts/mail-settle.ts` resolves a handed-over row. The reconciler never sends the message it
// reconciles.
import { ConfigError } from "../config";
import { type MailDeps, type MailMessage, sendMail } from "./smtp2go";

export const ACTIVITY_URL = "https://api.smtp2go.com/v3/activity/search";
export const HEADER = "X-IsItLegit-Send";
// The scheduled run's band: rows whose claim is older than this many minutes and younger than this many days.
export const BOUNDS = { olderThanMinutes: 30, youngerThanDays: 3 } as const;
const BEFORE_MS = 5 * 60_000;
const AFTER_MS = 30 * 60_000;
// Pages read for one row in one run, and requests in one run; the pace keeps under SMTP2GO's 60 a minute.
const PAGE_BUDGET = 5;
const RUN_BUDGET = 50;
const PACE_MS = 1_100;
const ALERT_PREFIX = "unresolved:";

export type ReconcileDeps = MailDeps & {
  // Where an unresolved send is reported; nothing is sent without it.
  operator: string | undefined;
  pageBudget?: number;
  runBudget?: number;
  paceMs?: number;
};
export type ReconcileReport = {
  state: "ok" | "degraded";
  settled: string[];
  unresolved: string[];
  handedOver: string[];
  errors: string[];
  requests: number;
};
type Row = {
  send_key: string;
  kind: string;
  case_id: string | null;
  claimed_at: string;
  status: string;
  search_cursor: string | null;
};
type Found = { emailId: string; event: string; code: string | null };
type Search = { found: Found } | { absent: true } | { more: string } | { error: string };

// An SMTP code from a bounce or rejection ("550", "5.1.1"), never its text, which can quote the recipient.
const smtpCode = (event: Record<string, unknown>) => {
  const text = [event.smtp_response, event.reason].find((v) => typeof v === "string") as string | undefined;
  const codes = text?.match(/\b[245]\d\d\b|\b[245]\.\d{1,3}\.\d{1,3}\b/g);
  return codes ? [...new Set(codes)].slice(0, 2).join(" ") : null;
};

// One run's reading of a row's window, from its saved place: a match, a whole window read with none, a place to
// resume next time, or an error. `null` events, non-objects and a match missing its id or type are not evidence.
async function search(deps: ReconcileDeps, apiKey: string, row: Row, spend: () => boolean): Promise<Search> {
  const claimed = Date.parse(row.claimed_at);
  const window = {
    start_date: new Date(claimed - BEFORE_MS).toISOString(),
    end_date: new Date(claimed + AFTER_MS).toISOString(),
    custom_headers: [HEADER],
    limit: 1000,
  };
  let token = row.search_cursor;
  for (let page = 0; page < (deps.pageBudget ?? PAGE_BUDGET); page++) {
    if (!spend()) return token ? { more: token } : { error: "the run's request budget was spent" };
    let body: unknown;
    try {
      const response = await (deps.fetch ?? fetch)(ACTIVITY_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-smtp2go-api-key": apiKey },
        body: JSON.stringify(token ? { ...window, continue_token: token } : window),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
      });
      if (response.status === 401 || response.status === 403)
        return { error: `SMTP2GO refused the activity search (HTTP ${response.status})` };
      if (response.status !== 200) return { error: `SMTP2GO answered HTTP ${response.status}` };
      body = await response.json();
    } catch (error) {
      return { error: `no readable answer from SMTP2GO (${(error as Error).name})` };
    }
    const data = (body as { data?: { events?: unknown; continue_token?: unknown } } | null)?.data;
    if (!data || !Array.isArray(data.events)) return { error: "SMTP2GO's answer had no list of events" };
    for (const event of data.events) {
      if (!event || typeof event !== "object") continue;
      const record = event as Record<string, unknown>;
      const headers = record.custom_headers && typeof record.custom_headers === "object" ? record.custom_headers : {};
      const value = Object.entries(headers).find(([name]) => name.toLowerCase() === HEADER.toLowerCase())?.[1];
      if (value !== row.send_key) continue;
      if (typeof record.email_id !== "string" || !record.email_id || typeof record.event !== "string")
        return { error: "SMTP2GO's event for this send has no email id or type" };
      return { found: { emailId: record.email_id, event: record.event, code: smtpCode(record) } };
    }
    token = typeof data.continue_token === "string" && data.continue_token ? data.continue_token : null;
    if (!token) return { absent: true };
  }
  return { more: token as string };
}

export async function reconcileUncertain(
  deps: ReconcileDeps,
  bounds: { olderThanMinutes: number; youngerThanDays: number } = BOUNDS,
): Promise<ReconcileReport> {
  if (!deps.apiKey) throw new ConfigError("SMTP2GO_API_KEY is not set");
  const now = (deps.now ?? (() => new Date()))();
  const pause = deps.pause ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const report: ReconcileReport = { state: "ok", settled: [], unresolved: [], handedOver: [], errors: [], requests: 0 };
  const settledBefore = new Date(now.getTime() - bounds.olderThanMinutes * 60_000).toISOString();
  const cutoff = new Date(now.getTime() - bounds.youngerThanDays * 86_400_000).toISOString();
  const rows = await deps.db
    .prepare(
      "SELECT send_key, kind, case_id, claimed_at, status, search_cursor FROM mail_sends WHERE status IN ('uncertain', 'pending') AND claimed_at <= ? ORDER BY searched_at IS NOT NULL, searched_at, claimed_at",
    )
    .bind(settledBefore)
    .all<Row>();
  let spent = 0;
  const spend = () => {
    if (spent >= (deps.runBudget ?? RUN_BUDGET)) return false;
    spent++;
    return true;
  };
  for (const row of rows.results) {
    const isAlert = row.send_key.startsWith(ALERT_PREFIX);
    if (row.claimed_at < cutoff) {
      if (isAlert) report.unresolved.push(row.send_key);
      else await handOver(deps, row, report);
      continue;
    }
    if (spent > 0) await pause(deps.paceMs ?? PACE_MS);
    const before = spent;
    const result = await search(deps, deps.apiKey, row, spend);
    // Searched this run (a request was made): it goes behind the rows not yet searched, so a run budget smaller than
    // the backlog reaches every row across runs.
    if (spent > before)
      await deps.db
        .prepare("UPDATE mail_sends SET searched_at = ? WHERE send_key = ? AND claimed_at = ?")
        .bind(now.toISOString(), row.send_key, row.claimed_at)
        .run();
    if ("error" in result) {
      report.errors.push(`${row.send_key}: ${result.error}`);
      continue;
    }
    if ("absent" in result || "more" in result) {
      // Where to resume, for this attempt only; the whole window read with no match starts again next time.
      await deps.db
        .prepare("UPDATE mail_sends SET search_cursor = ? WHERE send_key = ? AND claimed_at = ?")
        .bind("more" in result ? result.more : null, row.send_key, row.claimed_at)
        .run();
      report.unresolved.push(row.send_key);
      continue;
    }
    const { emailId, event, code } = result.found;
    const note =
      event === "processed" || event === "delivered"
        ? "settled from SMTP2GO's activity"
        : `settled from SMTP2GO's activity: ${event}${code ? ` (${code})` : ""}`;
    // Only the attempt and state that were read: a retry or another reconciler since then keeps its outcome.
    const settled = await deps.db
      .prepare(
        "UPDATE mail_sends SET status = 'sent', provider_id = ?, error = ?, search_cursor = NULL, updated_at = ? WHERE send_key = ? AND claimed_at = ? AND status = ?",
      )
      .bind(emailId, note, now.toISOString(), row.send_key, row.claimed_at, row.status)
      .run();
    if (settled.meta.changes === 1) report.settled.push(row.send_key);
  }
  report.requests = spent;
  if (report.errors.length) report.state = "degraded";
  return report;
}

// A row past the age band: the operator hears of it once, under the alert's own send key, never the recipient again.
async function handOver(deps: ReconcileDeps, row: Row, report: ReconcileReport): Promise<void> {
  if (!deps.operator) {
    report.errors.push(`${row.send_key}: no operator address (OPERATOR_EMAIL) to hand it to`);
    return;
  }
  const message: MailMessage = {
    // One alert per attempt: a later attempt that ages out too is a new handover, with its own claim time.
    sendKey: `${ALERT_PREFIX}${row.send_key}@${row.claimed_at}`,
    kind: "alert",
    to: deps.operator,
    from: "IsItLegit <alerts@isitlegit.co.za>",
    subject: `A ${row.kind} mail may not have been sent (${row.send_key})`,
    text: [
      `IsItLegit could not tell whether SMTP2GO took the ${row.kind} mail with send key ${row.send_key}${row.case_id ? ` (case ${row.case_id})` : ""}, claimed at ${row.claimed_at}.`,
      "Look the send key up in SMTP2GO's activity (the X-IsItLegit-Send header), then settle that attempt:",
      `  node scripts/mail-settle.ts ${row.send_key} sent --claimed-at ${row.claimed_at}    (SMTP2GO has it)`,
      `  node scripts/mail-settle.ts ${row.send_key} failed --claimed-at ${row.claimed_at}  (SMTP2GO has no record; the caller may send again)`,
      "docs/operations.md has the steps.",
    ].join("\n"),
  };
  const outcome = await sendMail(deps, message);
  // Handed over only when the alert is known to have gone; an uncertain alert is reconciled as a send of its own.
  if (outcome.status === "sent" || (outcome.status === "duplicate" && outcome.previous === "sent"))
    report.handedOver.push(row.send_key);
  else if (outcome.status === "failed")
    report.errors.push(`${row.send_key}: the operator alert failed (${outcome.reason})`);
  else report.unresolved.push(row.send_key);
}
