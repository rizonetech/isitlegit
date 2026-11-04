// Admitting a delivery as a case, for both front doors: a forward to check@ (./email.ts, D01 T01 §3) and an upload
// (./upload.ts, D01 T03 §1).
//
// A delivery is claimed in `intake_messages` before anything else is written (keyed within the organisation by the
// caller: a forward's Message-ID or its SHA-256, an upload's `upload:<SHA-256>`), then processed in the only order that
// works: write the new case's id to the claim, admit the case under that id and the daily cap, store what came (its
// artefact rows name the case), start the Workflow (instance id = case id), mark the claim done. So a delivery that
// stops anywhere leaves a claim naming its case. A case once made is never deleted (D01 T03 §12): one whose file never
// stored ends partial (RawMissing) and its claim is freed, so the caller's retry makes a new case beside it; one stored
// but not started keeps its claim pending, and whoever next reaches it (the same delivery's retry after five minutes,
// or the sweep each minute) starts its Workflow, or settles it by asking the Workflow when its start is unknown.
import { admitCase, type SourceKind, unstartedPartial } from "../db/cases";
import { ulid } from "../db/ulid";
import type { CaseExperiment } from "../pipeline/ablate";
import {
  activeExperimentCase,
  bindCaseExperiment,
  ExperimentRefused,
  requireOrdinaryReplay,
  reserveExperiment,
} from "../pipeline/case-experiments";
import { eventStatement } from "../pipeline/events";
import { recoverIntakeObject } from "./store";

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
  // A counterparty check (D05 T02 §1): a non-member's forward claiming a protected business, held by its own limits.
  origin?: "counterparty" | null;
  // A replay run id (D01 T01 §22): honoured only for the eval organisation (the EVAL_ORG_ID variable), where it
  // scopes the claim so each replay run admits its own case; ignored for every other organisation.
  replayRunId?: string | null;
  experiment?: CaseExperiment;
  // Stores what came under the new case; a failure undoes the case and releases the claim.
  store: (caseId: string) => Promise<void>;
};

export async function admitDelivery(env: Env, delivery: Delivery, now = new Date()): Promise<Admission> {
  const { orgId } = delivery;
  // The claim's key carries its door, so neither can make the other's: an email whose Message-ID reads like an upload's
  // key would otherwise answer that upload with the email's case (round 1).
  // A replay run (D01 T01 §22) scopes its key with the run id, which the claim row then carries for attribution;
  // only the eval organisation's runs are scoped, and only while EVAL_ORG_ID names it.
  const replay =
    delivery.replayRunId && env.EVAL_ORG_ID && delivery.orgId === env.EVAL_ORG_ID ? delivery.replayRunId : null;
  let experiment: CaseExperiment | undefined;
  if (delivery.experiment) {
    if (delivery.channel !== "upload") throw new ExperimentRefused(400, "Experiments require an upload.");
    const { replayRunId: _run, ...input } = delivery.experiment;
    experiment = await reserveExperiment(env, orgId, input, delivery.replayRunId);
  } else if (replay) await requireOrdinaryReplay(env.DB, orgId, replay);
  const key = replay
    ? `replay:${replay}:${claimKey(delivery.channel, delivery.key)}`
    : claimKey(delivery.channel, delivery.key);
  const claim = await claimDelivery(env, orgId, key, now);
  if (!experiment && replay) {
    try {
      await requireOrdinaryReplay(env.DB, orgId, replay);
    } catch (error) {
      if (!("duplicate" in claim)) await releaseClaim(env.DB, claim);
      throw error;
    }
  }
  if ("duplicate" in claim) return { kind: "duplicate", caseId: claim.duplicate };

  // The durable sample binding outlives the temporary delivery claim. Recover under this claim's lease.
  if (experiment) {
    const previous = await activeExperimentCase(env.DB, orgId, experiment, delivery.key);
    if (previous) {
      await env.DB.prepare(
        "UPDATE intake_messages SET case_id=? WHERE org_id=? AND message_key=? AND state='pending' AND claimed_at=?",
      )
        .bind(previous, orgId, key, claim.claimedAt)
        .run();
      const settled = await settleStale(env, claim, previous);
      if (settled === "done") return { kind: "duplicate", caseId: previous };
      if (settled === "unknown") throw new RetryDelivery("The experiment case is still being settled.");
    }
  }

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
      origin: delivery.origin ?? null,
    },
    now,
  );
  if (!admitted.ok) {
    if (admitted.error.code === "capped") {
      // The same delivery tomorrow is a new one, not a duplicate.
      await releaseClaim(env.DB, claim).catch(() => {});
      return { kind: "capped" };
    }
    // The insert may have committed with its answer lost: such a case stays, ended partial where the member sees it,
    // and the claim is freed (D01 T03 §12); one never made leaves only the claim, freed. Unsettled, the sweep does it.
    await endUnstored(env, claim, caseId, "release").catch(() => false);
    throw new RetryDelivery(`the case could not be admitted: ${admitted.error.message}`);
  }
  try {
    if (experiment) await bindCaseExperiment(env.DB, caseId, orgId, experiment, delivery.key);
    await delivery.store(caseId);
  } catch (error) {
    // A store error does not prove nothing was stored: its read after the row's insert can fail with the file and row
    // both committed (§12 round 1). Only a file known missing ends the case partial (RawMissing), its claim freed so
    // the same delivery makes a new case; a stored one, or one whose storage cannot be read, keeps its claim pending,
    // and the sweep starts it or settles it (D01 T03 §12).
    const there = await stored(env, caseId).catch(() => null);
    if (there === false) await endUnstored(env, claim, caseId, "release").catch(() => false);
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
    if (state === "absent")
      // Stored, not started: the case stays with its claim pending, and the sweep starts it once the lease has run out
      // (D01 T03 §12); a retry within the lease is told to wait, one after it finds the case started.
      throw new RetryDelivery(`the Workflow did not start: ${(error as Error).message}`);
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
  // Its file never stored (or its case never made): ended partial where the member reads it, in one batch with the
  // claim's change, and the claim kept for the caller that took it over (a retry makes its case under it).
  if (!(await endUnstored(env, claim, caseId, "keep").catch(() => false))) return "unknown";
  return "free";
}

// Ends an admitted case whose file never stored `partial` (its `admit` step failed, RawMissing), and frees its claim:
// `keep` clears the claim's case for the caller holding it, `release` deletes the claim. One D1 batch, so no
// interruption leaves the case `running` without a Workflow, or `partial` with its claim still naming it (D01 T03 §12's
// completion review). A case never made is only the claim's change. False when the batch did not commit.
async function endUnstored(env: Env, claim: Claim, caseId: string, claimTo: "keep" | "release"): Promise<boolean> {
  const row = await env.DB.prepare("SELECT org_id, status FROM cases WHERE id = ?")
    .bind(caseId)
    .first<{ org_id: string; status: string }>();
  const claimWrite =
    claimTo === "keep"
      ? env.DB.prepare(
          "UPDATE intake_messages SET case_id = NULL WHERE org_id = ? AND message_key = ? AND state = 'pending' AND claimed_at = ?",
        )
      : env.DB.prepare(
          "DELETE FROM intake_messages WHERE org_id = ? AND message_key = ? AND state = 'pending' AND claimed_at = ?",
        );
  const writes = [claimWrite.bind(claim.orgId, claim.key, claim.claimedAt)];
  if (row?.status === "received") {
    const event = {
      caseId,
      step: "admit",
      status: "failed" as const,
      startedAt: new Date().toISOString(),
      ms: null,
      error: "RawMissing",
    };
    writes.unshift(eventStatement(env.DB, event, true), unstartedPartial(env.DB, row.org_id, caseId));
    writes.push(
      env.DB.prepare(
        "UPDATE case_experiments SET active_upload_key=NULL WHERE case_id=? AND active_upload_key IS NOT NULL",
      ).bind(caseId),
    );
  }
  await env.DB.batch(writes);
  return true;
}

// Whether the case's delivered file is stored: its raw message or uploaded file has its row and its object.
async function stored(env: Env, caseId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT r2_key FROM artefacts WHERE case_id = ? AND kind IN ('raw', 'attachment') ORDER BY r2_key LIMIT 1",
  )
    .bind(caseId)
    .first<{ r2_key: string }>();
  if (row && (await env.ARTEFACTS.head(row.r2_key)) !== null) return true;
  return recoverIntakeObject({ db: env.DB, bucket: env.ARTEFACTS }, caseId);
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
