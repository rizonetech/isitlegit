// The operator's settlement of one attempt of a mail send (D01 T02 §5): the SQL `scripts/mail-settle.ts` runs against
// the live database, built here so the Worker's tests can run it against the real migrations. It changes a row only
// while it is still uncertain or pending and still the attempt named by its claim time, so it never reopens a sent
// message and a repeated command never touches a newer attempt. Every value is checked, so none needs quoting.
// Send keys are what sendMail's callers and the reconciler make (`reply:<ulid>`, and an alert's
// `unresolved:reply:<ulid>@<claim time>`): nothing that needs quoting.
const SEND_KEY = /^[A-Za-z0-9:._@-]{1,200}$/;
// A claim time is an ISO instant, which needs no quoting either.
const CLAIMED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function settleStatement(sendKey: string, status: string, claimedAt: string, at: string): string {
  if (!SEND_KEY.test(sendKey)) throw new Error(`mail-settle: "${sendKey}" is not a send key`);
  if (status !== "sent" && status !== "failed") throw new Error("mail-settle: the outcome is sent or failed");
  if (!CLAIMED_AT.test(claimedAt))
    throw new Error("mail-settle: --claimed-at must be the alert's claim time, such as 2026-10-27T19:20:11.000Z");
  return `UPDATE mail_sends SET status = '${status}', error = 'settled by the operator', search_cursor = NULL, updated_at = '${at}' WHERE send_key = '${sendKey}' AND claimed_at = '${claimedAt}' AND status IN ('uncertain', 'pending')`;
}
