// Admitting a delivery as a case, for both front doors: a forward to check@ (./email.ts, D01 T01 §3) and an upload
// (./upload.ts, D01 T03 §1).
//
// A delivery is claimed in `intake_messages` before anything else is written (keyed within the organisation by the
// caller: a forward's Message-ID or its SHA-256, an upload's `upload:<SHA-256>`), then processed in the only order that
// works: write the new case's id to the claim, admit the case under that id and the daily cap, store what came (its
// artefact rows name the case), start the Workflow (instance id = case id), mark the claim done. So a delivery that
// stops anywhere leaves a claim naming its case. A failed step is undone and RetryDelivery thrown, so the caller's retry
// starts clean; when it is unknown whether the Workflow started, the claim is left pending with its case and whoever next
// reaches it (the same delivery's retry after five minutes, or the scheduled sweep) settles it by asking the Workflow.
import { admitCase, type SourceKind, setStatus } from "../db/cases";
import { ulid } from "../db/ulid";
import { recordEvent } from "../pipeline/events";

// A pending claim younger than this belongs to a delivery still being processed; an older one to a delivery that
// stopped. Well above a handler's run time.
export const CLAIM_LEASE_MS = 5 * 60_000;
// A done claim marks the same delivery as a duplicate for a day.
export const DUPLICATE_WINDOW_MS = 24 * 60 * 60_000;

// Thrown when a delivery should be retried rather than dropped: a step failed and was undone, or the same delivery is
// being processed by another right now.
export class RetryDelivery extends Error {
  override name = "RetryDelivery";
  // When the same delivery is held by another under its lease, how long until the lease runs out: retrying sooner is
  // refused again, so a client should wait this long (an upload's Retry-After).
  constructor(
    message: string,
    readonly retryAfterMs = 5_000,
  ) {
    super(message);
  }
}

type Claim = { orgId: string; key: string; claimedAt: string };

export type Admission =
  | { kind: "admitted"; caseId: string }
  // The same delivery within a day: the first one's case, when the claim names it.
  | { kind: "duplicate"; caseId: string | null }
  | { kind: "capped" };

export type Delivery = {
  orgId: string;
  // The delivery's identity within its door (a forward's Message-ID or SHA-256, an upload's SHA-256); the claim is
  // keyed by the door and this together (claimKey).
  key: string;
  channel: "email" | "upload";
  sourceKind: SourceKind;
  headersAvailable: boolean;
  forwardedBy?: string | null;
  messageId?: string | null;
  // The uploading member's user id, on an upload (D01 T03 §11).
  uploadedBy?: string | null;
  // What an uploaded file claimed to be: its name and submitted media type (D02 T04 §4).
  uploadName?: string | null;
  uploadMediaType?: string | null;
  // Stores what came under the new case; a failure undoes the case and releases the claim.
  store: (caseId: string) => Promise<void>;
};

export async function admitDelivery(env: Env, delivery: Delivery, now = new Date()): Promise<Admission> {
  const { orgId } = delivery;
  // The claim's key carries its door, so neither can make the other's: an email whose Message-ID reads like an upload's
  // key would otherwise answer that upload with the email's case (round 1).
  const key = claimKey(delivery.channel, delivery.key);
  const claim = await claimDelivery(env, orgId, key, now);
  if ("duplicate" in claim) return { kind: "duplicate", caseId: claim.duplicate };

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
    {
      id: caseId,
      orgId,
      channel: delivery.channel,
      sourceKind: delivery.sourceKind,
      headersAvailable: delivery.headersAvailable,
      forwardedBy: delivery.forwardedBy ?? null,
      messageId: delivery.messageId ?? null,
      uploadedBy: delivery.uploadedBy ?? null,
      uploadName: delivery.uploadName ?? null,
      uploadMediaType: delivery.uploadMediaType ?? null,
    },
    now,
  );
  if (!admitted.ok) {
    if (admitted.error.code === "capped") {
      // The same delivery tomorrow is a new one, not a duplicate.
      await releaseClaim(env.DB, claim).catch(() => {});
      return { kind: "capped" };
    }
    // The insert may have committed with its answer lost: the case goes too, or the claim stays for the sweep.
    await undo(env, claim, caseId);
    throw new RetryDelivery(`the case could not be admitted: ${admitted.error.message}`);
  }
  try {
    await delivery.store(caseId);
  } catch (error) {
    await undo(env, claim, caseId);
    throw new RetryDelivery(`the delivery could not be stored: ${(error as Error).message}`);
  }
  // A delivery stalled past the lease may have been taken over meanwhile, its case removed: it starts no Workflow then.
  // A create call that itself stalls past the lease can still start one for a case removed meanwhile; that instance
  // ends at its admit step, which skips a case that does not exist, so it does nothing.
  if (!(await stillHolds(env.DB, claim))) throw new RetryDelivery("the delivery stalled and another took it over");
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
  // The case is in the pipeline. A claim this delivery no longer holds was taken over (the taker settles it by its
  // Workflow); one it could not mark is marked done by the sweep, which finds the Workflow.
  const marked = await markDone(env.DB, claim).catch(() => null);
  if (marked && marked.meta.changes !== 1) throw new RetryDelivery("the delivery stalled and another took it over");
  return { kind: "admitted", caseId };
}

export const claimKey = (channel: Delivery["channel"], key: string) => `${channel}:${key}`;

// Claims a delivery, or answers that it is a duplicate (with the first one's case), or throws for a retry while another
// delivery holds it. A pending claim past its lease is taken over (one taker wins the compare-and-set on its claimed_at)
// and its case settled first.
async function claimDelivery(
  env: Env,
  orgId: string,
  key: string,
  now: Date,
): Promise<Claim | { duplicate: string | null }> {
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
  if (held.state === "done") return { duplicate: held.case_id };
  if (held.claimed_at > new Date(now.getTime() - CLAIM_LEASE_MS).toISOString())
    throw new RetryDelivery(
      "the same delivery is being processed by another",
      Math.max(1_000, Date.parse(held.claimed_at) + CLAIM_LEASE_MS - now.getTime()),
    );
  const taken = await takeOver(env.DB, { orgId, key, claimedAt: held.claimed_at }, at);
  if (!taken) throw new RetryDelivery("another delivery took over the same one");
  const settled = await settleStale(env, taken, held.case_id);
  if (settled === "done") return { duplicate: held.case_id };
  if (settled === "unknown") throw new RetryDelivery("an earlier delivery of the same one may still be starting");
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

// Settles a claim left by a delivery that stopped. Its Workflow running means it is done. A case the member may already
// have seen is never deleted (D01 T03 §12): one admitted with its file stored but never started is started now, so it
// finishes or ends `partial` with a reason the member reads; one whose file never stored ends `partial` reading
// `RawMissing` and frees the claim, so the same upload or redelivery makes a new case beside it. A claim whose case was
// never made is free: a retry caller keeps it and makes its case under it, the sweep releases it. Unknown leaves it.
async function settleStale(env: Env, claim: Claim, caseId: string | null): Promise<"done" | "free" | "unknown"> {
  if (!caseId) return "free";
  const state = await workflowState(env, caseId);
  if (state === "unknown") return "unknown";
  if (state === "found") {
    await markDone(env.DB, claim);
    return "done";
  }
  const row = await env.DB.prepare("SELECT org_id, status FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ org_id: string; status: string }>();
  // One the pipeline has moved on (`running` or later) is its, not ours.
  if (row && row.status !== "received") {
    await markDone(env.DB, claim);
    return "done";
  }
  if (row && (await stored(env, caseId))) {
    try {
      await env.ANALYSIS.create({ id: caseId, params: { caseId } });
    } catch {
      // Started by another meanwhile, or the start's outcome is unknown: the next one to reach it asks again.
      if ((await workflowState(env, caseId)) !== "found") return "unknown";
    }
    await markDone(env.DB, claim);
    return "done";
  }
  if (row) {
    // Its file never stored: the case stays, failed in words the member reads, and the claim is free.
    const failed = await recordEvent(env.DB, caseId, "admit", "failed", { errorClass: "RawMissing", once: true });
    if (!failed.ok) return "unknown";
    await setStatus(env.DB, row.org_id, caseId, "running");
    const ended = await setStatus(env.DB, row.org_id, caseId, "partial");
    if (!ended.ok) return "unknown";
  }
  await env.DB.prepare(
    "UPDATE intake_messages SET case_id = NULL WHERE org_id = ? AND message_key = ? AND claimed_at = ?",
  )
    .bind(claim.orgId, claim.key, claim.claimedAt)
    .run();
  return "free";
}

// Whether the case's delivered file is stored: its raw message or uploaded file has its row and its object.
async function stored(env: Env, caseId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT r2_key FROM artefacts WHERE case_id = ? AND kind IN ('raw', 'attachment') ORDER BY r2_key LIMIT 1",
  )
    .bind(caseId)
    .first<{ r2_key: string }>();
  return !!row && (await env.ARTEFACTS.head(row.r2_key)) !== null;
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

// The intake path's own undo, before a case has a Workflow: every object under the case's own prefixes (raw/<case>/
// and art/<case>/, src/intake/store.ts), listed rather than taken from its artefact rows, so an object whose row was
// never written (R2 took the file, then D1 failed) goes too; then its rows (artefacts first, though they cascade). The
// store itself never deletes; the closure purge (D07 T02 §9) removes finished cases.
async function removeCase(env: Env, caseId: string) {
  for (const prefix of [`raw/${caseId}/`, `art/${caseId}/`]) {
    let cursor: string | undefined;
    do {
      const page = await env.ARTEFACTS.list({ prefix, ...(cursor ? { cursor } : {}) });
      if (page.objects.length) await env.ARTEFACTS.delete(page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM artefacts WHERE case_id = ?").bind(caseId),
    env.DB.prepare("DELETE FROM cases WHERE id = ? AND status = 'received'").bind(caseId),
  ]);
}

// Whether this delivery still holds its claim (nobody took it over).
const stillHolds = async (db: D1Database, claim: Claim) =>
  (await db
    .prepare(
      "SELECT 1 FROM intake_messages WHERE org_id = ? AND message_key = ? AND state = 'pending' AND claimed_at = ?",
    )
    .bind(claim.orgId, claim.key, claim.claimedAt)
    .first()) !== null;

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

// Sweeps the claims (the scheduled run, every 15 minutes), email and upload alike: done claims older than a day are
// deleted, and pending claims past their lease are settled as a takeover would. Answers the counts for the run's log.
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

export const sha256Hex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
