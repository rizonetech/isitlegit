// The email front door (D01 T01 §3; spec 4.1): a forward to check@ becomes a case only when its envelope sender belongs
// to an organisation (`memberOfSender`: a verified domain, or a single verified address) and the mail proves it at that
// level (./sender: a pass for the domain, or for the one mailbox); anything else is dropped with no reply, so the
// service sends no backscatter.
//
// A forward is admitted through ./admit.ts (claimed by its Message-ID, or its SHA-256 without one): the claim, the case
// under the daily cap, the raw message stored, the Workflow started; a case once made is never deleted (D01 T03 §12). A capped forward
// sends its forwarder one notice a day.

import { dailyCapBinds, dailyCapSql } from "../auth/plan-sql";
import { memberOfSender, registrable } from "../auth/senders";
import { DEFAULT_DAILY_CASES } from "../db/cases";
import { withoutComments } from "../mail/rfc5322";
import { sendMail } from "../mail/smtp2go";
import { findIdentityByClaim } from "../trust/identity";
import { admitDelivery, sha256Hex } from "./admit";
import { extractOriginal } from "./forward";
import { parseMsg } from "./msg";
import { originalHeaderOf } from "./original-header";
import { parseMessage } from "./parse";
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
  | { kind: "admitted"; caseId: string; counterparty?: true };

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
  let outcome: IntakeOutcome;
  try {
    outcome = await intake(message, env, now, detail);
  } catch (error) {
    // Thrown for a retry (RetryDelivery, the admission undone): logged, then handed to Email Routing.
    log(JSON.stringify({ event: "intake", outcome: "retry", error: (error as Error).name }));
    throw error;
  }
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
  const messageId = headerValue(message.headers.get("Message-ID"));
  if (!member) return counterparty(env, raw, from, messageId, now, detail);
  if (!(await senderAuthenticated(raw, from, member.by))) {
    detail.member = member.by;
    detail.auth = await authenticationSummary(raw);
    return { kind: "dropped" };
  }
  const orgId = member.orgId;

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

// A forward from someone who is not a member (D05 T02 §1; spec 2a): a case only when the forwarder proves its own
// mailbox and the attached original claims exactly one protected business by its From's display name or domain; the case
// is that business's, marked counterparty, and held by the counterparty limits. Anything else, and anything past a
// limit, is dropped with no reply, as any stranger's mail is, so the gate can neither be enumerated nor used to send
// backscatter. Only a name or domain claim is read here, before admission: a logo, signature, voice or badge claim
// needs the analysed case (§2, §8), so a forward claiming only by those is not admitted.
async function counterparty(
  env: Env,
  raw: Uint8Array,
  from: string,
  messageId: string | null,
  now: Date,
  detail: Record<string, unknown>,
): Promise<IntakeOutcome> {
  detail.member = null;
  // Every drop logs why and what the topmost Authentication-Results says, as a member's drop does (D01 T01 §9).
  const drop = async (reason: string): Promise<IntakeOutcome> => {
    detail.counterparty = reason;
    detail.auth = await authenticationSummary(raw);
    return { kind: "dropped" };
  };
  // The forwarder's own mailbox, not only its domain: at a shared provider a valid signature for the domain would
  // otherwise let anyone name another mailbox there as the forwarder, spending its quota and sending it the reply
  // (completion review). The signed From must be this envelope sender, as an address-verified member's must.
  if (!(await senderAuthenticated(raw, from, "address"))) return drop("unauthenticated");
  const claim = await originalClaim(raw);
  if (!claim) return drop("no-claim");
  const matches = await findIdentityByClaim(env.DB, claim);
  const orgs = [...new Set(matches.map((m) => m.orgId))];
  if (orgs.length !== 1) return drop(orgs.length === 0 ? "no-match" : "ambiguous");
  const orgId = orgs[0] as string;
  const admitted = await admitDelivery(
    env,
    {
      orgId,
      key: messageId ? `id:${messageId}` : `sha256:${await sha256Hex(raw)}`,
      channel: "email",
      sourceKind: "mail",
      headersAvailable: false,
      forwardedBy: from,
      messageId,
      origin: "counterparty",
      store: (caseId) => putRaw(store(env), caseId, raw).then(() => {}),
    },
    now,
  );
  if (admitted.kind === "duplicate") return { kind: "duplicate" };
  // Past a counterparty limit: dropped silently, no notice, so the limit cannot be probed.
  if (admitted.kind === "capped") return drop("limited");
  return { ...admitted, counterparty: true };
}

// The claim an attached original makes, read the way the pipeline reads it (src/pipeline/analysis-workflow.ts): the
// original's From, its display name and its domain. An inline forward has no original's From (its From is the
// forwarder's), so it claims nothing; nor does an original whose From is not one plain mailbox.
export async function originalClaim(
  raw: Uint8Array,
): Promise<{ displayName: string | null; domain: string | null } | null> {
  let forward: Awaited<ReturnType<typeof extractOriginal>>;
  try {
    forward = await extractOriginal(raw);
  } catch {
    return null;
  }
  if (forward.path === "inline") return null;
  let header: ReturnType<typeof originalHeaderOf>;
  try {
    const { parsed, sender } =
      forward.format === "msg"
        ? await parseMsg(forward.original)
        : { parsed: await parseMessage(forward.original), sender: undefined };
    header = originalHeaderOf(parsed.headers, sender);
  } catch {
    return null;
  }
  const address = header.fromAddress;
  const domain = address && address.includes("@") ? registrable(address.slice(address.lastIndexOf("@") + 1)) : null;
  const displayName = header.fromName?.trim() || null;
  if (!displayName && !domain) return null;
  return { displayName, domain };
}

// One notice a day to a forwarder whose organisation reached its daily cap. Its outcome never fails the delivery: a
// failed send is retried by the next capped forward that day (a failed send key can be claimed again), an uncertain one
// is settled by the reconciler (D01 T02 §5), and a refused one (an address the allowlist does not admit) sends nothing.
async function sendCapNotice(env: Env, orgId: string, to: string, now: Date) {
  // The organisation's own cap, never a default in its place: unreadable, no notice is sent now, and the next capped
  // forward that day sends it (its send key was not used).
  let cap: number;
  try {
    // The cap that refused the forward, by the organisation's plan (D07 T08 §8), never the old column.
    const row = await env.DB.prepare(`SELECT ${dailyCapSql()} AS cap`)
      .bind(...dailyCapBinds(orgId, now))
      .first<{ cap: number }>();
    cap = row?.cap ?? DEFAULT_DAILY_CASES;
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
      // A cap of 0 is an operator's pause (D07 T08 §8): no reset is promised while it lasts.
      text:
        cap === 0
          ? "Checks are paused for your organisation; we will not check forwarded mail until IsItLegit turns them back on."
          : `Today's limit of ${cap} checks is reached; it resets at 00:00 SAST. Forward the message again after that and we will check it then.`,
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
