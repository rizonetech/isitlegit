// Account closure and the coordinated purge (D07 T02 §9; design spec 4.8: case summaries deleted within 30 days
// of closure). Closing is the owner's, from the Account page: it stamps the organisation's closedAt once (a repeat
// keeps the first stamp), the organisation then refuses new cases and its verified domains and addresses are
// inactive, and the scheduled purge, starting 25 days after closure so deletion completes inside the promise,
// deletes its stored artefacts and every row the section names, in an order a failed run can resume. The two
// protected live test accounts and Fynbos Freight are never closed or purged (src/auth/protected.ts, AGENTS.md).
import { isProtectedAccount, isProtectedOrganisation } from "./protected";

export type CloseOutcome =
  | { ok: true; already: boolean }
  | { ok: false; reason: "not-owner" | "no-organisation" | "protected" };

const DAY_MS = 24 * 60 * 60_000;
// The purge starts this long after closure, so even a run that fails and is retried the next day finishes inside
// the promised 30 days; an organisation still present after that is overdue and is named in the run's log line.
export const PURGE_AFTER_MS = 25 * DAY_MS;
export const PROMISE_MS = 30 * DAY_MS;

export async function organisationClosedAt(db: D1Database, orgId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT "closedAt" AS closedAt FROM "organization" WHERE id = ?`)
    .bind(orgId)
    .first<{ closedAt: string | null }>();
  return row?.closedAt ?? null;
}

// True when any member's email is a protected account: protection follows the people, not only Fynbos Freight.
async function hasProtectedMember(db: D1Database, orgId: string): Promise<boolean> {
  const rows = await db
    .prepare(
      `SELECT "user".email AS email FROM "member" JOIN "user" ON "user".id = "member"."userId" WHERE "member"."organizationId" = ?`,
    )
    .bind(orgId)
    .all<{ email: string }>();
  return rows.results.some((r) => isProtectedAccount(r.email));
}

export async function organisationProtected(db: D1Database, orgId: string): Promise<boolean> {
  return isProtectedOrganisation(orgId) || (await hasProtectedMember(db, orgId));
}

// Close the organisation for its owner. Another member, a non-member and a protected organisation change nothing.
export async function closeOrganisation(
  db: D1Database,
  orgId: string,
  userId: string,
  now: Date,
): Promise<CloseOutcome> {
  const member = await db
    .prepare(`SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
    .bind(orgId, userId)
    .first<{ role: string }>();
  if (!member) return { ok: false, reason: "no-organisation" };
  if (member.role !== "owner") return { ok: false, reason: "not-owner" };
  if (await organisationProtected(db, orgId)) return { ok: false, reason: "protected" };
  const done = await db
    .prepare(
      `UPDATE "organization" SET "closedAt" = ? WHERE id = ? AND "closedAt" IS NULL RETURNING "closedAt" AS closedAt`,
    )
    .bind(now.toISOString(), orgId)
    .first<{ closedAt: string }>();
  if (done) {
    // Its verified domains and addresses are released at once, so another organisation may claim them; the rows
    // the purge would delete anyway go now, and the claimable check needs no second read of closure.
    await db.prepare(`DELETE FROM org_domains WHERE org_id = ?`).bind(orgId).run();
    await db.prepare(`DELETE FROM org_addresses WHERE org_id = ?`).bind(orgId).run();
    return { ok: true, already: false };
  }
  // A repeat (double press, two tabs, retry after a lost answer) keeps the first stamp.
  return (await organisationClosedAt(db, orgId))
    ? { ok: true, already: true }
    : { ok: false, reason: "no-organisation" };
}

// Delete one closed organisation's data in an order that resumes: stored objects first (their keys are read from
// artefact rows), then the cases with their child rows, then the organisation's own rows, then its memberships,
// invitations and limits, then the organisation itself. Returns how many R2 objects were deleted.
export async function purgeOrganisation(
  env: { DB: D1Database; ARTEFACTS: R2Bucket },
  orgId: string,
  limit = 200,
): Promise<{ objects: number; done: boolean }> {
  const db = env.DB;
  // Objects are deleted as they are found, artefact-row keys first, then each case's two prefixes listed a page
  // at a time, so one run's work is bounded by `limit` and a retry continues from what is left (D01 T01 §2).
  let objects = 0;
  const drop = async (key: string) => {
    await env.ARTEFACTS.delete(key);
    await db.prepare(`DELETE FROM artefacts WHERE r2_key = ?`).bind(key).run();
    objects++;
  };
  while (objects < limit) {
    const row = await db
      .prepare(`SELECT a.r2_key AS key FROM artefacts a JOIN cases c ON c.id = a.case_id WHERE c.org_id = ? LIMIT 1`)
      .bind(orgId)
      .first<{ key: string }>();
    if (!row) break;
    await drop(row.key);
  }
  if (objects >= limit) return { objects, done: false };
  const caseIds = (
    await db.prepare(`SELECT id FROM cases WHERE org_id = ?`).bind(orgId).all<{ id: string }>()
  ).results.map((r) => r.id);
  let more = false;
  for (const caseId of caseIds) {
    for (const prefix of [`raw/${caseId}/`, `art/${caseId}/`]) {
      const listed = await env.ARTEFACTS.list({ prefix, limit: Math.max(1, limit - objects) });
      for (const object of listed.objects) {
        if (objects >= limit) {
          more = true;
          break;
        }
        await drop(object.key);
      }
      if (listed.truncated || objects >= limit) more = true;
      if (more) break;
    }
    if (more) break;
  }
  if (more) return { objects, done: false };
  const del = (sql: string) => db.prepare(sql).bind(orgId).run();
  await del(`DELETE FROM sender_observations WHERE org_id = ?`);
  await del(`DELETE FROM evidence WHERE case_id IN (SELECT id FROM cases WHERE org_id = ?)`);
  await del(`DELETE FROM case_events WHERE case_id IN (SELECT id FROM cases WHERE org_id = ?)`);
  await del(`DELETE FROM case_verdicts WHERE case_id IN (SELECT id FROM cases WHERE org_id = ?)`);
  await del(`DELETE FROM cases WHERE org_id = ?`);
  await del(
    `DELETE FROM invitation_uses WHERE invitation_id IN (SELECT id FROM "invitation" WHERE "organizationId" = ?)`,
  );
  await del(`DELETE FROM invite_redemptions WHERE org_id = ?`);
  await del(`DELETE FROM auth_events WHERE org_id = ?`);
  await del(`DELETE FROM org_domains WHERE org_id = ?`);
  await del(`DELETE FROM org_addresses WHERE org_id = ?`);
  await del(`DELETE FROM verification_codes WHERE org_id = ?`);
  await del(`DELETE FROM verification_sends WHERE org_id = ?`);
  await del(`DELETE FROM org_receivers WHERE org_id = ?`);
  await del(`DELETE FROM receiver_lookups WHERE org_id = ?`);
  await del(`DELETE FROM org_sender_salts WHERE org_id = ?`);
  await del(`DELETE FROM intake_messages WHERE org_id = ?`);
  await del(`DELETE FROM "invitation" WHERE "organizationId" = ?`);
  await del(`DELETE FROM "member" WHERE "organizationId" = ?`);
  await del(`DELETE FROM org_limits WHERE org_id = ?`);
  await del(`DELETE FROM "organization" WHERE id = ?`);
  return { objects, done: true };
}

// What one scheduled run did, for its single log line.
export type PurgeReport = {
  purged: string[];
  overdue: string[];
  failed: { id: string; deadline: string }[];
  abandoned: number;
};

// Purge every organisation closed at least PURGE_AFTER_MS ago, and abandoned signups untouched for 30 days. A
// protected organisation is skipped and left closed; one whose promised 30 days have passed without a completed
// purge is named overdue. An organisation that fails is left for the next run and named, never half-reported.
const countOf = async (db: D1Database, sql: string, bind: string) =>
  (await db.prepare(sql).bind(bind).first<{ n: number }>())?.n ?? 0;

export async function scheduledClosurePurge(
  env: { DB: D1Database; ARTEFACTS: R2Bucket },
  now: Date,
): Promise<PurgeReport> {
  const db = env.DB;
  const cutoff = new Date(now.getTime() - PURGE_AFTER_MS).toISOString();
  const due = await db
    .prepare(`SELECT id, "closedAt" AS closedAt FROM "organization" WHERE "closedAt" IS NOT NULL AND "closedAt" <= ?`)
    .bind(cutoff)
    .all<{ id: string; closedAt: string }>();
  const report: PurgeReport = { purged: [], overdue: [], failed: [], abandoned: 0 };
  for (const org of due.results) {
    if (await organisationProtected(db, org.id)) continue;
    const deadline = new Date(Date.parse(org.closedAt) + PROMISE_MS).toISOString();
    try {
      const purged = await purgeOrganisation(env, org.id);
      if (purged.done) report.purged.push(org.id);
      else if (now.getTime() - Date.parse(org.closedAt) > PROMISE_MS) report.overdue.push(org.id);
    } catch {
      report.failed.push({ id: org.id, deadline });
      if (now.getTime() - Date.parse(org.closedAt) > PROMISE_MS) report.overdue.push(org.id);
    }
  }
  // An abandoned signup: a pending redemption untouched for 30 days. Its user goes too when it has no membership
  // (an interrupted signup), and never when the address is protected or the user belongs somewhere.
  const stale = await db
    .prepare(`SELECT id, user_id AS userId, email FROM invite_redemptions WHERE status = 'pending' AND created_at <= ?`)
    .bind(new Date(now.getTime() - PROMISE_MS).toISOString())
    .all<{ id: string; userId: string | null; email: string }>();
  for (const row of stale.results) {
    if (isProtectedAccount(row.email)) continue;
    await db.prepare(`DELETE FROM invite_redemptions WHERE id = ?`).bind(row.id).run();
    report.abandoned++;
    if (row.userId) {
      const memberOf = await db
        .prepare(`SELECT COUNT(*) AS n FROM "member" WHERE "userId" = ?`)
        .bind(row.userId)
        .first<{ n: number }>();
      if (!memberOf?.n) {
        const user = await db
          .prepare(`SELECT email FROM "user" WHERE id = ?`)
          .bind(row.userId)
          .first<{ email: string }>();
        if (user && !isProtectedAccount(user.email))
          await db.prepare(`DELETE FROM "user" WHERE id = ?`).bind(row.userId).run();
      }
    }
  }
  return report;
}
