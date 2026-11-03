// The operator's settlement of one attempt of a mail send (D01 T02 §5): the SQL `scripts/mail-settle.ts` runs against
// the live database, built here so the Worker's tests can run it against the real migrations. It changes a row only
// while it is still uncertain or pending and still the attempt named by its claim time, so it never reopens a sent
// message and a repeated command never touches a newer attempt. Every value is checked, so none needs quoting.
// Send keys are what sendMail's callers and the reconciler make (`reply:<ulid>`, and an alert's
// `unresolved:reply:<ulid>@<claim time>`): nothing that needs quoting.
const SEND_KEY = /^[A-Za-z0-9:._@-]{1,200}$/;
// A claim time is an ISO instant, which needs no quoting either.
const CLAIMED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const checkKey = (sendKey: string) => {
  if (!SEND_KEY.test(sendKey)) throw new Error(`mail-settle: "${sendKey}" is not a send key`);
};
// A reply is the one kind that can be rebuilt from its case (D01 T02 §8), a grouped forward's reply included (D01 T01
// §12); every other kind keeps no content to send.
const isReply = (sendKey: string) => /^reply:(?:group:)?[A-Za-z0-9]{1,64}$/.test(sendKey);

// `resend` (D01 T02 §8): the same statement that settles a reply failed asks for it to be sent again, so a resend is
// never asked for a row that was not settled.
export function settleStatement(
  sendKey: string,
  status: string,
  claimedAt: string,
  at: string,
  resend = false,
): string {
  checkKey(sendKey);
  if (status !== "sent" && status !== "failed") throw new Error("mail-settle: the outcome is sent or failed");
  if (!CLAIMED_AT.test(claimedAt))
    throw new Error("mail-settle: --claimed-at must be the alert's claim time, such as 2026-10-27T19:20:11.000Z");
  if (resend && status !== "failed") throw new Error("mail-settle: --resend goes with failed, never with sent");
  if (resend && !isReply(sendKey))
    throw new Error(`mail-settle: only a reply can be sent again (${sendKey} keeps no content to rebuild it from)`);
  // A new request clears the last resend's ending and alert (final review), so status never shows a stale outcome.
  const asked = resend
    ? `, resend_state = 'requested', resend_runs = 0, resend_at = '${at}', resend_outcome = NULL, resend_alerted = 0, resend_alert_tried_at = NULL`
    : "";
  // Never under a resend the cron is sending (final review): its own outcome settles the row.
  return `UPDATE mail_sends SET status = '${status}', error = 'settled by the operator', search_cursor = NULL, updated_at = '${at}'${asked} WHERE send_key = '${sendKey}' AND claimed_at = '${claimedAt}' AND status IN ('uncertain', 'pending') AND coalesce(resend_state, '') <> 'sending'`;
}

// The operator's read of a send and its resend.
export function statusStatement(sendKey: string): string {
  checkKey(sendKey);
  return `SELECT send_key, kind, status, claimed_at, resend_state, resend_runs, resend_at, resend_outcome, resend_alerted FROM mail_sends WHERE send_key = '${sendKey}'`;
}

// A cancel before the cron claimed it: one guarded update, so a confirmed cancel can never still send.
export function cancelStatement(sendKey: string, at: string): string {
  checkKey(sendKey);
  return `UPDATE mail_sends SET resend_state = 'cancelled', resend_at = '${at}' WHERE send_key = '${sendKey}' AND resend_state = 'requested'`;
}

// A resend asked for (again): a reply settled failed without --resend (completion review, G1), one whose earlier resend
// ended uncertain and was then settled failed (round 1: `done` with the row failed), or an exhausted or cancelled one
// after a repair, its runs, outcome and alert reset.
export function requeueStatement(sendKey: string, at: string): string {
  checkKey(sendKey);
  if (!isReply(sendKey)) throw new Error(`mail-settle: only a reply can be sent again (${sendKey})`);
  return `UPDATE mail_sends SET resend_state = 'requested', resend_runs = 0, resend_at = '${at}', resend_outcome = NULL, resend_alerted = 0, resend_alert_tried_at = NULL WHERE send_key = '${sendKey}' AND kind = 'reply' AND status = 'failed' AND (resend_state IS NULL OR resend_state IN ('done', 'exhausted', 'cancelled'))`;
}
