// Outbound mail through SMTP2GO's HTTP API (D01 T02 §1; stack doc; https://developers.smtp2go.com/reference/send-standard-email,
// read 2026-10-27). One module owns delivery, and every logical send is one `mail_sends` row (migration 0003):
//
//   1. The caller names the send with a stable key (`reply:<caseId>`). Its `pending` row is written before any network
//      call; a key that already has a row is not sent again (a `pending` row left by a stopped Worker is reported
//      uncertain), except a `failed` one, which is tried again on the same row.
//   2. The message goes to SMTP2GO with the key in `X-Smtp2go-Api-Key`. SMTP2GO answers 200 even when sending failed, so
//      only a body with `data.succeeded` at least 1, `data.failed` 0 and a string `data.email_id` is `sent`. A 429 or
//      5xx is tried again, 3 attempts in all; a 4xx or a reported failure is `failed` at once; no answer, or an answer
//      that cannot be read, is `uncertain` and never tried again, since the message may have been delivered.
//   3. The outcome is written to the row. If that write fails, the row stays `pending`, so a retry by the caller still
//      sends nothing.
//
// The caller always gets a typed outcome. Nothing stored holds the address (only a SHA-256 of it), a body or the key.
import { ConfigError } from "../config";
import { ulid } from "../db/ulid";

export const SMTP2GO_URL = "https://api.smtp2go.com/v3/email/send";
export const MAX_ATTEMPTS = 3;
const KINDS = ["reply", "signin", "verify", "alert", "notice", "renewal"] as const;
export type MailKind = (typeof KINDS)[number];
// Headers SMTP2GO refuses in custom_headers.
const FORBIDDEN_HEADERS = new Set(["content-type", "content-transfer-encoding", "mime-version"]);

export type MailMessage = {
  sendKey: string;
  kind: MailKind;
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  headers?: Record<string, string>;
  caseId?: string;
};
export type SendOutcome =
  | { status: "sent"; providerId: string; attempts: number }
  | { status: "failed"; reason: string; attempts: number }
  | { status: "uncertain"; reason: string; attempts: number }
  | { status: "duplicate"; previous: "sent" | "uncertain" | "refused"; providerId: string | null };
export type MailDeps = {
  db: D1Database;
  apiKey: string | undefined;
  fetch?: typeof fetch;
  pause?: (ms: number) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
};

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const recipientHash = async (to: string) =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(to.trim().toLowerCase())));
const oneLine = (value: string) => !/[\r\n]/.test(value);

// A message the client will not send: a caller's mistake, thrown before anything is written or sent.
function checkMessage(message: MailMessage): void {
  const { sendKey, kind, to, from, subject, text, headers = {} } = message;
  if (!sendKey || sendKey.length > 200) throw new Error("sendMail: the send key is 1 to 200 characters");
  if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`sendMail: unknown kind ${kind}`);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to.trim()))
    throw new Error("sendMail: the recipient is not one address");
  if (![from, subject].every(oneLine)) throw new Error("sendMail: the sender and subject are one line each");
  if (!text.trim()) throw new Error("sendMail: a message needs a text body");
  for (const [name, value] of Object.entries(headers)) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new Error(`sendMail: SMTP2GO refuses the ${name} header`);
    if (!/^[A-Za-z0-9-]+$/.test(name) || !oneLine(value)) throw new Error(`sendMail: the ${name} header is malformed`);
  }
}

type Attempt = { kind: "sent"; providerId: string } | { kind: "failed" | "uncertain" | "retry"; reason: string };

// One request to SMTP2GO, judged by what it answered.
async function attempt(deps: MailDeps, apiKey: string, payload: string): Promise<Attempt> {
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(SMTP2GO_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-smtp2go-api-key": apiKey },
      body: payload,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
  } catch (error) {
    return { kind: "uncertain", reason: `no answer from SMTP2GO (${(error as Error).name})` };
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    return { kind: "retry", reason: `SMTP2GO answered HTTP ${response.status}` };
  }
  let body: { data?: Record<string, unknown> } | null = null;
  try {
    body = JSON.parse(await response.text());
  } catch {
    // unreadable: judged below
  }
  const data = body && typeof body === "object" ? body.data : undefined;
  if (response.status >= 400) {
    // The error code only: SMTP2GO's message can quote the recipient.
    const code = typeof data?.error_code === "string" ? `: ${data.error_code.slice(0, 120)}` : "";
    return { kind: "failed", reason: `SMTP2GO refused the message (HTTP ${response.status}${code})` };
  }
  if (!data || typeof data !== "object")
    return { kind: "uncertain", reason: `SMTP2GO answered HTTP ${response.status} with no readable result` };
  const failures = Array.isArray(data.failures) ? data.failures.length : 0;
  if ((typeof data.failed === "number" && data.failed > 0) || failures > 0)
    return { kind: "failed", reason: "SMTP2GO accepted the request but reported the message failed" };
  if (
    typeof data.succeeded === "number" &&
    data.succeeded >= 1 &&
    data.failed === 0 &&
    typeof data.email_id === "string"
  )
    return { kind: "sent", providerId: data.email_id };
  return { kind: "uncertain", reason: `SMTP2GO answered HTTP ${response.status} without confirming the message` };
}

export async function sendMail(deps: MailDeps, message: MailMessage): Promise<SendOutcome> {
  if (!deps.apiKey) throw new ConfigError("SMTP2GO_API_KEY is not set");
  checkMessage(message);
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const pause = deps.pause ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { db } = deps;

  // 1. The intent, durable before any network call.
  const toHash = await recipientHash(message.to);
  let claimed: boolean;
  try {
    const at = now();
    const inserted = await db
      .prepare(
        "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT (send_key) DO NOTHING",
      )
      .bind(ulid(), message.sendKey, message.caseId ?? null, message.kind, toHash, at, at)
      .run();
    claimed = inserted.meta.changes === 1;
    if (!claimed) {
      // Only a failed send may be tried again, and only by one caller at a time.
      const retried = await db
        .prepare(
          "UPDATE mail_sends SET status = 'pending', error = NULL, updated_at = ? WHERE send_key = ? AND status = 'failed'",
        )
        .bind(now(), message.sendKey)
        .run();
      claimed = retried.meta.changes === 1;
    }
    if (!claimed) {
      const row = await db
        .prepare("SELECT status, provider_id FROM mail_sends WHERE send_key = ?")
        .bind(message.sendKey)
        .first<{ status: string; provider_id: string | null }>();
      const previous = row?.status === "sent" || row?.status === "refused" ? row.status : "uncertain";
      return { status: "duplicate", previous, providerId: row?.provider_id ?? null };
    }
  } catch (error) {
    return {
      status: "failed",
      reason: `the send log could not be written, so nothing was sent (${(error as Error).name})`,
      attempts: 0,
    };
  }

  // 2. The message, tried up to MAX_ATTEMPTS times on a 429 or 5xx.
  const payload = JSON.stringify({
    sender: message.from,
    to: [message.to.trim()],
    subject: message.subject,
    text_body: message.text,
    ...(message.html ? { html_body: message.html } : {}),
    ...(message.headers && Object.keys(message.headers).length
      ? { custom_headers: Object.entries(message.headers).map(([header, value]) => ({ header, value })) }
      : {}),
  });
  let attempts = 0;
  let result: Attempt;
  for (;;) {
    attempts++;
    result = await attempt(deps, deps.apiKey, payload);
    if (result.kind !== "retry") break;
    if (attempts >= MAX_ATTEMPTS) {
      result = { kind: "failed", reason: `${result.reason} ${attempts} times; gave up` };
      break;
    }
    await pause(1000 * 2 ** (attempts - 1));
  }
  const outcome: Exclude<SendOutcome, { status: "duplicate" }> =
    result.kind === "sent"
      ? { status: "sent", providerId: result.providerId, attempts }
      : { status: result.kind === "failed" ? "failed" : "uncertain", reason: result.reason, attempts };

  // 3. The outcome. A failed write leaves the row pending, which still stops a second send.
  try {
    await db
      .prepare(
        "UPDATE mail_sends SET status = ?, provider_id = ?, attempts = attempts + ?, error = ?, updated_at = ? WHERE send_key = ?",
      )
      .bind(
        outcome.status,
        outcome.status === "sent" ? outcome.providerId : null,
        attempts,
        outcome.status === "sent" ? null : outcome.reason.slice(0, 300),
        now(),
        message.sendKey,
      )
      .run();
  } catch {
    // The row stays pending: a retry is answered as a duplicate, uncertain, and nothing is sent twice.
  }
  return outcome;
}
