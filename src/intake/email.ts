// The email front door (D01 T01 §3; spec 4.1): a forward to check@ becomes a case only when its envelope sender belongs
// to an organisation (`memberOfSender`: a verified domain, or a single verified address) and the mail proves it at that
// level (./sender: a pass for the domain, or for the one mailbox); anything else is dropped with no reply, so the
// service sends no backscatter.
//
// A forward is admitted through ./admit.ts (claimed by its Message-ID, or its SHA-256 without one): the claim, the case
// under the daily cap, the raw message stored, the Workflow started, each step undone on failure. A capped forward
// sends its forwarder one notice a day.

import { memberOfSender } from "../auth/senders";
import { DEFAULT_DAILY_CASES } from "../db/cases";
import { withoutComments } from "../mail/rfc5322";
import { sendMail } from "../mail/smtp2go";
import { admitDelivery, sha256Hex } from "./admit";
import { authenticationSummary, senderAuthenticated } from "./sender";
import { putRaw, type Store } from "./store";

export { CLAIM_LEASE_MS, DUPLICATE_WINDOW_MS, RetryDelivery, sweepIntake } from "./admit";

// Email Routing's inbound limit (stack doc); a larger message is refused before it is read.
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
export const NOTICE_FROM = "IsItLegit <check@isitlegit.co.za>";
const SAST_OFFSET_MS = 2 * 60 * 60_000;

export type IntakeOutcome =
  | { kind: "too-large" }
  | { kind: "dropped" }
  // A message a machine sent on its own (an auto-reply, an out-of-office): RFC 3834's Auto-Submitted, any value but
  // "no". It is never a member's forward, and answering it is how two responders loop (D01 T02 §3, round 1).
  | { kind: "automatic" }
  | { kind: "duplicate" }
  | { kind: "capped" }
  | { kind: "admitted"; caseId: string };

// RFC 3834 section 5: Auto-Submitted is a keyword, comments allowed around it and parameters after a ";". Only the
// keyword "no" marks a person's message; any other (auto-replied, auto-generated, no-reply) is a machine's.
export function isAutomatic(value: string | null): boolean {
  if (value === null) return false;
  const keyword = withoutComments(value).split(";")[0]?.trim().toLowerCase() ?? "";
  return keyword !== "no";
}

// Every delivery logs one line naming its outcome (D01 T01 §9), so a forward that made no case can be told apart on the
// live service: for a drop, whether a member matched and what the topmost Authentication-Results says (authserv-id,
// each method's result and domain). No address, local part or Message-ID is logged.
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  now = new Date(),
  log: (line: string) => void = console.log,
): Promise<IntakeOutcome> {
  const detail: Record<string, unknown> = {};
  const outcome = await intake(message, env, now, detail);
  const caseId = outcome.kind === "admitted" ? { caseId: outcome.caseId } : {};
  log(JSON.stringify({ event: "intake", outcome: outcome.kind, ...caseId, ...detail }));
  return outcome;
}

async function intake(
  message: ForwardableEmailMessage,
  env: Env,
  now: Date,
  detail: Record<string, unknown>,
): Promise<IntakeOutcome> {
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    message.setReject("Message too large");
    return { kind: "too-large" };
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (raw.byteLength > MAX_MESSAGE_BYTES) {
    message.setReject("Message too large");
    return { kind: "too-large" };
  }
  if (isAutomatic(message.headers.get("Auto-Submitted"))) return { kind: "automatic" };
  const from = message.from.trim().toLowerCase();
  // What the organisation verified decides what the mail must prove: its domain, or this one mailbox.
  const member = await memberOfSender(env.DB, from);
  if (!member || !(await senderAuthenticated(raw, from, member.by))) {
    detail.member = member ? member.by : null;
    detail.auth = await authenticationSummary(raw);
    return { kind: "dropped" };
  }
  const orgId = member.orgId;

  const messageId = headerValue(message.headers.get("Message-ID"));
  const admitted = await admitDelivery(
    env,
    {
      orgId,
      // The two forms kept apart: a Message-ID reading "sha256:..." cannot stand in for another message's hash.
      key: messageId ? `id:${messageId}` : `sha256:${await sha256Hex(raw)}`,
      channel: "email",
      sourceKind: "mail",
      headersAvailable: false,
      forwardedBy: from,
      messageId,
      store: (caseId) => putRaw(store(env), caseId, raw).then(() => {}),
    },
    now,
  );
  if (admitted.kind === "duplicate") return { kind: "duplicate" };
  if (admitted.kind === "capped") {
    await sendCapNotice(env, orgId, from, now);
    return { kind: "capped" };
  }
  return admitted;
}

// One notice a day to a forwarder whose organisation reached its daily cap. Its outcome never fails the delivery: a
// failed send is retried by the next capped forward that day (a failed send key can be claimed again), an uncertain one
// is settled by the reconciler (D01 T02 §5), and a refused one (an address the allowlist does not admit) sends nothing.
async function sendCapNotice(env: Env, orgId: string, to: string, now: Date) {
  // The organisation's own cap, never a default in its place: unreadable, no notice is sent now, and the next capped
  // forward that day sends it (its send key was not used).
  let cap: number;
  try {
    const row = await env.DB.prepare("SELECT daily_cases FROM org_limits WHERE org_id = ?")
      .bind(orgId)
      .first<{ daily_cases: number }>();
    cap = row?.daily_cases ?? DEFAULT_DAILY_CASES;
  } catch {
    return;
  }
  await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    {
      // The organisation, the SAST day and the forwarder by one digest: an address can be 254 characters and an
      // organisation id 200, a send key at most 200.
      sendKey: `cap:${(await sha256Hex(new TextEncoder().encode(`${orgId}\n${sastDate(now)}\n${to}`))).slice(0, 48)}`,
      kind: "notice",
      to,
      from: NOTICE_FROM,
      subject: "Today's IsItLegit checks are used up",
      text: `Today's limit of ${cap} checks is reached; it resets at midnight. Forward the message again tomorrow and we will check it then.`,
    },
  ).catch(() => null);
}

const store = (env: Env): Store => ({ bucket: env.ARTEFACTS, db: env.DB });

// A header's value as stored, or null when absent, empty or longer than RFC 5322's line limit.
const headerValue = (value: string | null) => {
  const v = value?.trim();
  return v && v.length <= 998 ? v : null;
};

const sastDate = (now: Date) => new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
