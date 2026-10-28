// The email front door (D01 T01 §3; spec 4.1): a forward to check@ becomes a case only when its envelope sender is
// authenticated (./sender) and belongs to an organisation (`findMemberBySender`); anything else is dropped with no
// reply, so the service sends no backscatter.
//
// A delivery is claimed in `intake_messages` before anything else is written (keyed by organisation and Message-ID, or
// the raw message's SHA-256 without one), then processed in the only order that works: write the new case's id to the
// claim, admit the case under that id and the daily cap, store the raw message (its artefact row names the case), start
// the Workflow (instance id = case id), mark the claim done. So a delivery that stops anywhere leaves a claim naming its
// case. A failed step is undone and the delivery thrown, so Email Routing's retry starts clean; when it is unknown
// whether the Workflow started, the claim is left pending with its case and whoever next reaches it (the same message's
// retry after five minutes, or the scheduled sweep) settles it by asking the Workflow.
import { findMemberBySender } from "../auth/senders";
import { admitCase, DEFAULT_DAILY_CASES } from "../db/cases";
import { ulid } from "../db/ulid";
import { sendMail } from "../mail/smtp2go";
import { senderAuthenticated } from "./sender";
import { putRaw, rawKey, type Store } from "./store";

// Email Routing's inbound limit (stack doc); a larger message is refused before it is read.
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
// A pending claim younger than this belongs to a delivery still being processed; an older one to a delivery that
// stopped. Well above a handler's run time.
export const CLAIM_LEASE_MS = 5 * 60_000;
// A done claim marks the same message as a duplicate for a day.
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60_000;
export const NOTICE_FROM = "IsItLegit <check@isitlegit.co.za>";
const SAST_OFFSET_MS = 2 * 60 * 60_000;

// Thrown when a delivery should be retried rather than dropped: a step failed and was undone, or the same message is
// being processed by another delivery right now.
export class RetryDelivery extends Error {
  override name = "RetryDelivery";
}

export type IntakeOutcome =
  | { kind: "too-large" }
  | { kind: "dropped" }
  | { kind: "duplicate" }
  | { kind: "capped" }
  | { kind: "admitted"; caseId: string };

type Claim = { orgId: string; key: string; claimedAt: string };

export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  now = new Date(),
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
  const from = message.from.trim().toLowerCase();
  if (!senderAuthenticated(raw, from)) return { kind: "dropped" };
  const orgId = await findMemberBySender(env.DB, from);
  if (!orgId) return { kind: "dropped" };

  const messageId = headerValue(message.headers.get("Message-ID"));
  const key = messageId ?? `sha256:${await sha256Hex(raw)}`;
  const claim = await claimDelivery(env, orgId, key, now);
  if (claim === "duplicate") return { kind: "duplicate" };

  // The case's id is on the claim before the case exists, so a delivery that stops anywhere after this leaves a claim
  // naming its case (or a case never made), which the takeover or the sweep settles; no case is ever left unowned.
  const caseId = ulid();
  const linked = await env.DB.prepare(
    "UPDATE intake_messages SET case_id = ? WHERE org_id = ? AND message_key = ? AND state = 'pending' AND claimed_at = ?",
  )
    .bind(caseId, claim.orgId, claim.key, claim.claimedAt)
    .run()
    .catch(() => null);
  if (linked?.meta.changes !== 1) {
    await releaseClaim(env.DB, claim).catch(() => {});
    throw new RetryDelivery("the delivery's claim could not be recorded");
  }
  const admitted = await admitCase(
    env.DB,
    { id: caseId, orgId, channel: "email", headersAvailable: false, forwardedBy: from, messageId },
    now,
  );
  if (!admitted.ok) {
    if (admitted.error.code === "capped") {
      // The same message forwarded tomorrow is a new delivery, not a duplicate.
      await releaseClaim(env.DB, claim).catch(() => {});
      await sendCapNotice(env, orgId, from, now);
      return { kind: "capped" };
    }
    // The insert may have committed with its answer lost: the case goes too, or the claim stays for the sweep.
    await undo(env, claim, caseId);
    throw new RetryDelivery(`the case could not be admitted: ${admitted.error.message}`);
  }
  await settle(env, claim, caseId, () => putRaw(store(env), caseId, raw).then(() => {}));
  try {
    await env.ANALYSIS.create({ id: caseId, params: { caseId } });
  } catch (error) {
    const state = await workflowState(env, caseId);
    if (state === "unknown")
      // Whether it started is unknown, so nothing is deleted: the claim stays pending with its case for the next one to
      // reach it.
      throw new RetryDelivery(`the Workflow may not have started: ${(error as Error).message}`);
    if (state === "absent") {
      await undo(env, claim, caseId);
      throw new RetryDelivery(`the Workflow did not start: ${(error as Error).message}`);
    }
  }
  // The case is in the pipeline; a claim left pending here is marked done by the sweep, which finds its Workflow.
  await markDone(env.DB, claim).catch(() => {});
  return { kind: "admitted", caseId };
}

// Runs the steps between admission and the Workflow; any failure undoes the case and releases the claim, then throws.
async function settle(env: Env, claim: Claim, caseId: string, steps: () => Promise<void>) {
  try {
    await steps();
  } catch (error) {
    await undo(env, claim, caseId);
    throw new RetryDelivery(`the delivery could not be stored: ${(error as Error).message}`);
  }
}

// Claims a delivery, or answers that it is a duplicate, or throws for a retry while another delivery holds it. A pending
// claim past its lease is taken over (one taker wins the compare-and-set on its claimed_at) and its case settled first.
async function claimDelivery(env: Env, orgId: string, key: string, now: Date): Promise<Claim | "duplicate"> {
  const at = now.toISOString();
  const claimed = await env.DB.prepare(
    "INSERT INTO intake_messages (org_id, message_key, state, case_id, claimed_at) VALUES (?, ?, 'pending', NULL, ?) ON CONFLICT (org_id, message_key) DO UPDATE SET state = 'pending', case_id = NULL, claimed_at = excluded.claimed_at WHERE intake_messages.state = 'done' AND intake_messages.claimed_at <= ?",
  )
    .bind(orgId, key, at, new Date(now.getTime() - DUPLICATE_WINDOW_MS).toISOString())
    .run();
  if (claimed.meta.changes === 1) return { orgId, key, claimedAt: at };
  const held = await env.DB.prepare(
    "SELECT state, case_id, claimed_at FROM intake_messages WHERE org_id = ? AND message_key = ?",
  )
    .bind(orgId, key)
    .first<{ state: string; case_id: string | null; claimed_at: string }>();
  if (!held) throw new RetryDelivery("the delivery's claim changed while it was read");
  if (held.state === "done") return "duplicate";
  if (held.claimed_at > new Date(now.getTime() - CLAIM_LEASE_MS).toISOString())
    throw new RetryDelivery("the same message is being processed by another delivery");
  const taken = await takeOver(env.DB, { orgId, key, claimedAt: held.claimed_at }, at);
  if (!taken) throw new RetryDelivery("another delivery took over the same message");
  const settled = await settleStale(env, taken, held.case_id);
  if (settled === "done") return "duplicate";
  if (settled === "unknown") throw new RetryDelivery("an earlier delivery of the same message may still be starting");
  return taken;
}

// The stale claim, re-stamped with this taker's time, or null when another taker got there first.
async function takeOver(db: D1Database, claim: Claim, at: string): Promise<Claim | null> {
  const taken = await db
    .prepare(
      "UPDATE intake_messages SET claimed_at = ? WHERE org_id = ? AND message_key = ? AND state = 'pending' AND claimed_at = ?",
    )
    .bind(at, claim.orgId, claim.key, claim.claimedAt)
    .run();
  return taken.meta.changes === 1 ? { ...claim, claimedAt: at } : null;
}

// Settles a claim left by a delivery that stopped: its Workflow running means it is done; no Workflow means its case
// (if any) is removed and the claim is free to process again; unknown leaves it.
async function settleStale(env: Env, claim: Claim, caseId: string | null): Promise<"done" | "free" | "unknown"> {
  if (!caseId) return "free";
  const state = await workflowState(env, caseId);
  if (state === "unknown") return "unknown";
  if (state === "found") {
    await markDone(env.DB, claim);
    return "done";
  }
  await removeCase(env, caseId);
  await env.DB.prepare(
    "UPDATE intake_messages SET case_id = NULL WHERE org_id = ? AND message_key = ? AND claimed_at = ?",
  )
    .bind(claim.orgId, claim.key, claim.claimedAt)
    .run();
  return "free";
}

// Whether the case's Workflow instance exists: `instance.not_found` is the binding's answer for none; any other
// failure leaves it unknown.
async function workflowState(env: Env, caseId: string): Promise<"found" | "absent" | "unknown"> {
  try {
    await env.ANALYSIS.get(caseId);
    return "found";
  } catch (error) {
    return /instance\.not_found/.test((error as Error).message) ? "absent" : "unknown";
  }
}

// Removes what a delivery created for a case, then its claim. A failure here leaves the claim pending with its case,
// which the next delivery or the sweep settles.
async function undo(env: Env, claim: Claim, caseId: string) {
  try {
    await removeCase(env, caseId);
    await releaseClaim(env.DB, claim);
  } catch {
    // Left for the takeover or the sweep.
  }
}

// The intake path's own undo, before a case has a Workflow: its raw object, then its rows (artefacts first, though they
// cascade). The store itself never deletes; the closure purge (D07 T02 §9) removes finished cases.
async function removeCase(env: Env, caseId: string) {
  await env.ARTEFACTS.delete(rawKey(caseId));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artefacts WHERE case_id = ?").bind(caseId),
    env.DB.prepare("DELETE FROM cases WHERE id = ? AND status = 'received'").bind(caseId),
  ]);
}

const releaseClaim = (db: D1Database, claim: Claim) =>
  db
    .prepare(
      "DELETE FROM intake_messages WHERE org_id = ? AND message_key = ? AND state = 'pending' AND claimed_at = ?",
    )
    .bind(claim.orgId, claim.key, claim.claimedAt)
    .run();

const markDone = (db: D1Database, claim: Claim) =>
  db
    .prepare(
      "UPDATE intake_messages SET state = 'done' WHERE org_id = ? AND message_key = ? AND state = 'pending' AND claimed_at = ?",
    )
    .bind(claim.orgId, claim.key, claim.claimedAt)
    .run();

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
      sendKey: `cap:${orgId}:${sastDate(now)}:${to}`,
      kind: "notice",
      to,
      from: NOTICE_FROM,
      subject: "Today's IsItLegit checks are used up",
      text: `Today's limit of ${cap} checks is reached; it resets at midnight. Forward the message again tomorrow and we will check it then.`,
    },
  ).catch(() => null);
}

// Sweeps the claims (the scheduled run, every 15 minutes): done claims older than a day are deleted, and pending claims
// past their lease are settled as a takeover would. Answers the counts for the run's log line.
export async function sweepIntake(env: Env, now = new Date()) {
  const counts = { expired: 0, completed: 0, removed: 0, unsettled: 0 };
  const expired = await env.DB.prepare("DELETE FROM intake_messages WHERE state = 'done' AND claimed_at <= ?")
    .bind(new Date(now.getTime() - DUPLICATE_WINDOW_MS).toISOString())
    .run();
  counts.expired = expired.meta.changes;
  const stale = await env.DB.prepare(
    "SELECT org_id, message_key, case_id, claimed_at FROM intake_messages WHERE state = 'pending' AND claimed_at <= ? ORDER BY claimed_at LIMIT 50",
  )
    .bind(new Date(now.getTime() - CLAIM_LEASE_MS).toISOString())
    .all<{ org_id: string; message_key: string; case_id: string | null; claimed_at: string }>();
  for (const row of stale.results) {
    const claim = await takeOver(
      env.DB,
      { orgId: row.org_id, key: row.message_key, claimedAt: row.claimed_at },
      now.toISOString(),
    );
    if (!claim) continue;
    const settled = await settleStale(env, claim, row.case_id).catch(() => "unknown" as const);
    if (settled === "done") counts.completed++;
    else if (settled === "unknown") counts.unsettled++;
    else {
      await releaseClaim(env.DB, claim);
      counts.removed++;
    }
  }
  return counts;
}

const store = (env: Env): Store => ({ bucket: env.ARTEFACTS, db: env.DB });

// A header's value as stored, or null when absent, empty or longer than RFC 5322's line limit.
const headerValue = (value: string | null) => {
  const v = value?.trim();
  return v && v.length <= 998 ? v : null;
};

const sastDate = (now: Date) => new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);

const sha256Hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
