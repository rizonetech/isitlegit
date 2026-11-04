// Outbound mail through SMTP2GO's HTTP API (D01 T02 §1; stack doc; https://developers.smtp2go.com/reference/send-standard-email,
// read 2026-10-27). One module owns delivery, and every logical send is one `mail_sends` row (migration 0003):
//
//   1. The caller names the send with a stable key (`reply:<caseId>`). Its `pending` row is written before any network
//      call; a key that already has a row is not sent again (a `pending` row left by a stopped Worker is reported
//      uncertain), except a `failed` one, which is tried again on the same row.
//   2. The message goes to SMTP2GO with the key in `X-Smtp2go-Api-Key` and the send key in an `X-IsItLegit-Send` header
//      (so an uncertain send can later be matched to SMTP2GO's record). SMTP2GO answers 200 even when sending failed,
//      so only a body with `data.succeeded` at least 1, `data.failed` 0 and a string `data.email_id` is `sent`. Only a
//      429 (rate-limited: the message was not taken) is tried again, 3 attempts in all, each attempt counted on the row
//      as it ends. A 5xx, no answer, or an answer that cannot be read is `uncertain` and never tried again: SMTP2GO
//      takes no idempotency key, and a gateway error can follow acceptance, so a retry could send twice. A 4xx or a
//      reported failure is `failed` at once.
//   3. The outcome is written to the row, keeping the last retry's reason. If that write fails, the row stays
//      `pending`, so a retry by the caller still sends nothing.
//
// The caller always gets a typed outcome. Nothing stored holds the address (only a SHA-256 of it), a body or the key.
import { ConfigError } from "../config";
import { ulid } from "../db/ulid";
import { isAllowedRecipient } from "./allowlist";

export const SMTP2GO_URL = "https://api.smtp2go.com/v3/email/send";
export const MAX_ATTEMPTS = 3;
const KINDS = ["reply", "signin", "verify", "alert", "notice", "renewal", "claim"] as const;
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
  | { status: "failed"; reason: string; attempts: number; storageFailure?: "allowlist" | "claim" | "refusal" }
  | { status: "uncertain"; reason: string; attempts: number }
  | { status: "duplicate"; previous: "sent" | "uncertain" | "refused"; providerId: string | null }
  // The recipient is not on the allowlist (src/mail/allowlist.ts): nothing was sent, now or ever, under this key.
  | { status: "refused"; reason: string };
export type MailDeps = {
  db: D1Database;
  apiKey: string | undefined;
  fetch?: typeof fetch;
  pause?: (ms: number) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  // OPERATOR_EMAIL, the one outside address the allowlist admits.
  operator?: string | readonly string[] | undefined;
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
  // The product sends as isitlegit.co.za and nothing else, no subdomain either (stack doc: the key is "sender restricted
  // to isitlegit.co.za"; the only verified sender domain): SMTP2GO refuses unverified domains account-wide, but the key
  // cannot show which domains the account has verified.
  const address = /<([^<>\s]+)>\s*$/.exec(from)?.[1] ?? from.trim();
  if (!/^[^\s@<>]+@isitlegit\.co\.za$/i.test(address))
    throw new Error("sendMail: the sender must be an isitlegit.co.za address");
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
      // Never followed: a redirect would carry the key's header to wherever it points, and its answer be read as
      // SMTP2GO's. A 3xx stays a 3xx here and is judged below as no confirmed send.
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    });
  } catch (error) {
    return { kind: "uncertain", reason: `no answer from SMTP2GO (${(error as Error).name})` };
  }
  if (response.status === 429 || response.status >= 500) {
    // Discarding the body can itself fail on a broken stream; the answer's status has already said what happened.
    try {
      await response.body?.cancel();
    } catch {
      // nothing more to read
    }
    return response.status === 429
      ? { kind: "retry", reason: "SMTP2GO answered HTTP 429" }
      : { kind: "uncertain", reason: `SMTP2GO answered HTTP ${response.status}, which may follow acceptance` };
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
  // Only SMTP2GO's documented success, a 200, confirms the send; any other 2xx is not a known answer.
  if (
    response.status === 200 &&
    typeof data.succeeded === "number" &&
    data.succeeded >= 1 &&
    data.failed === 0 &&
    typeof data.email_id === "string"
  )
    return { kind: "sent", providerId: data.email_id };
  return { kind: "uncertain", reason: `SMTP2GO answered HTTP ${response.status} without confirming the message` };
}

// Sign-in mail to one address: at most this many in this window.
export const SIGNIN_PER_ADDRESS = 5;
export const SIGNIN_WINDOW_MS = 10 * 60_000;

export async function sendMail(deps: MailDeps, message: MailMessage): Promise<SendOutcome> {
  if (!deps.apiKey) throw new ConfigError("SMTP2GO_API_KEY is not set");
  checkMessage(message);
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const pause = deps.pause ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { db } = deps;
  const toHash = await recipientHash(message.to);

  // 0. The allowlist, before anything else. A refusal is recorded under its key without touching a key already on
  // record (sent, pending, uncertain, failed or refused keep their row and evidence), and nothing is sent.
  let allowed: boolean;
  try {
    allowed = await isAllowedRecipient(db, message.to, message.kind, deps.operator, new Date(), {
      caseId: message.caseId,
      sendKey: message.sendKey,
    });
  } catch {
    // The allowlist cannot be read (D1 unreachable): nothing is sent, and nothing could be recorded either.
    return {
      status: "failed",
      reason: "the recipient allowlist could not be checked, so nothing was sent",
      storageFailure: "allowlist",
      attempts: 0,
    };
  }
  if (!allowed) {
    // A refused sign-in is a stranger's request, anonymous input: not recorded, so it cannot grow the table. A refusal
    // of any other kind is the system's own send and is recorded under its key.
    if (message.kind === "signin") return { status: "refused", reason: "the recipient is not on the allowlist" };
    const at = now();
    try {
      await db
        .prepare(
          "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'refused', 0, ?, ?) ON CONFLICT (send_key) DO NOTHING",
        )
        .bind(ulid(), message.sendKey, message.caseId ?? null, message.kind, toHash, at, at)
        .run();
    } catch {
      // The recipient remains denied, but callers must retry the missing durable refusal.
      return {
        status: "failed",
        reason: "the recipient is not on the allowlist (the refusal could not be recorded)",
        storageFailure: "refusal",
        attempts: 0,
      };
    }
    return { status: "refused", reason: "the recipient is not on the allowlist" };
  }

  // 1. The intent, durable before any network call.
  let claimed: boolean;
  // The attempts the row held when this send claimed it (a failed send tried again keeps its earlier ones).
  let base = 0;
  try {
    const at = now();
    // Sign-in mail is asked for by anyone: at most SIGNIN_PER_ADDRESS to one address in SIGNIN_WINDOW_MS. The count
    // and the claim are one statement, so concurrent requests cannot each read room and all send (D07 T02 §6 adds the
    // per-IP limit and the audit trail).
    const limited = message.kind === "signin";
    const since = new Date(Date.parse(at) - SIGNIN_WINDOW_MS).toISOString();
    const inserted = await (limited
      ? db
          .prepare(
            "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at, claimed_at) SELECT ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ? WHERE (SELECT COUNT(*) FROM mail_sends WHERE kind = 'signin' AND to_hash = ? AND created_at > ?) < ? ON CONFLICT (send_key) DO NOTHING",
          )
          .bind(
            ulid(),
            message.sendKey,
            message.caseId ?? null,
            message.kind,
            toHash,
            at,
            at,
            at,
            toHash,
            since,
            SIGNIN_PER_ADDRESS,
          )
      : db
          .prepare(
            "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at, claimed_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?) ON CONFLICT (send_key) DO NOTHING",
          )
          .bind(ulid(), message.sendKey, message.caseId ?? null, message.kind, toHash, at, at, at)
    ).run();
    claimed = inserted.meta.changes === 1;
    if (!claimed) {
      // Only a failed send may be tried again, and only by one caller at a time.
      const retried = await db
        .prepare(
          "UPDATE mail_sends SET status = 'pending', error = NULL, updated_at = ?, claimed_at = ?, search_cursor = NULL WHERE send_key = ? AND status = 'failed' RETURNING attempts",
        )
        .bind(at, at, message.sendKey)
        .first<{ attempts: number }>();
      claimed = retried !== null;
      base = retried?.attempts ?? 0;
    }
    if (!claimed) {
      const row = await db
        .prepare("SELECT status, provider_id FROM mail_sends WHERE send_key = ?")
        .bind(message.sendKey)
        .first<{ status: string; provider_id: string | null }>();
      // No row under this key: the sign-in limit held the claim back.
      if (!row && limited)
        return { status: "refused", reason: "too many sign-in links to this address; try again later" };
      const previous = row?.status === "sent" || row?.status === "refused" ? row.status : "uncertain";
      return { status: "duplicate", previous, providerId: row?.provider_id ?? null };
    }
  } catch (error) {
    return {
      status: "failed",
      reason: `the send log could not be written, so nothing was sent (${(error as Error).name})`,
      storageFailure: "claim",
      attempts: 0,
    };
  }

  // 2. The message, tried up to MAX_ATTEMPTS times on a 429.
  const payload = JSON.stringify({
    sender: message.from,
    to: [message.to.trim()],
    subject: message.subject,
    text_body: message.text,
    ...(message.html ? { html_body: message.html } : {}),
    custom_headers: [
      ...Object.entries(message.headers ?? {}).map(([header, value]) => ({ header, value })),
      { header: "X-IsItLegit-Send", value: message.sendKey },
    ],
  });
  // Each attempt is counted, with its reason, as it ends, so a Worker stopped during the backoff leaves the evidence.
  // Counts are written as totals (`MAX`, never `+ 1`), so a write whose acknowledgement was lost after it committed, or
  // written twice, cannot count an attempt twice (Cloudflare: D1 writes must be safe to repeat after a network error).
  const counted = async (total: number, reason: string | null) => {
    try {
      await db
        .prepare("UPDATE mail_sends SET attempts = MAX(attempts, ?), error = ?, updated_at = ? WHERE send_key = ?")
        .bind(total, reason?.slice(0, 300) ?? null, now(), message.sendKey)
        .run();
    } catch {
      // the outcome write below carries the same total
    }
  };
  let attempts = 0;
  let lastRetry: string | null = null;
  let result: Attempt;
  for (;;) {
    attempts++;
    result = await attempt(deps, deps.apiKey, payload);
    if (result.kind !== "retry") break;
    lastRetry = result.reason;
    await counted(base + attempts, result.reason);
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
        "UPDATE mail_sends SET status = ?, provider_id = ?, attempts = MAX(attempts, ?), error = ?, updated_at = ? WHERE send_key = ?",
      )
      .bind(
        outcome.status,
        outcome.status === "sent" ? outcome.providerId : null,
        base + attempts,
        // A send that went through after a retry keeps the reason it was retried.
        (outcome.status === "sent" ? lastRetry && `sent after: ${lastRetry}` : outcome.reason)?.slice(0, 300) ?? null,
        now(),
        message.sendKey,
      )
      .run();
  } catch {
    // The row stays pending: a retry is answered as a duplicate, uncertain, and nothing is sent twice.
  }
  return outcome;
}
