// The trial-end notices to the owners (D07 T08 §11): one three days before an organisation's Protect trial ends and one
// after it has, saying the exact end, which protection stops and that free checks go on. Run from the quarter-hour
// schedule (src/index.ts). Who is due is decided by `planOf` (src/auth/plans.ts), the rule the Plan page uses, so the notice
// and the page never disagree; the send key holds the organisation, the notice, the trial's end and the owner, so an
// extension (a new end) is a new notice, a stale one is never sent, and every owner has their own. A send the provider
// refused is tried again by the next run while it is still due (the ledger claims a failed key again); an uncertain one is
// the reconciler's (D01 T02 §5) and is never sent again here. One log line of counts says what was left unresolved.

import { PLAN_DAILY_CASES } from "../auth/plan-sql";
import { planOf, TRIAL_DAYS } from "../auth/plans";
import { isProtectedAccount, isProtectedOrganisation } from "../auth/protected";
import { sendMail } from "./smtp2go";
import { trialNoticeEmail } from "./templates/auth-mail";

const DAY_MS = 86_400_000;
const AHEAD_MS = 3 * DAY_MS;
const BEHIND_MS = 7 * DAY_MS;
const FROM = "IsItLegit <no-reply@isitlegit.co.za>";

export type NoticeEnv = { DB: D1Database; APP_URL: string; SMTP2GO_API_KEY?: string; OPERATOR_EMAIL?: string };
export type NoticeCounts = { sent: number; failed: number; uncertain: number; skipped: number };

// `clock` is read afresh before each check: a slow send must not leave the next owner judged by the moment the run began.
export async function sendTrialNotices(env: NoticeEnv, clock: () => Date = () => new Date()): Promise<NoticeCounts> {
  const counts: NoticeCounts = { sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  let candidates = 0;
  try {
    candidates = await run(env, clock, counts);
  } catch (error) {
    // A read that failed is said as a failure, never as nothing due: the operator reads this line.
    console.log(JSON.stringify({ event: "trial-notices", outcome: "failed", error: (error as Error).name, ...counts }));
    throw error;
  }
  console.log(JSON.stringify({ event: "trial-notices", outcome: "ran", ...counts, candidates }));
  return counts;
}

// What is due for an organisation now, by the rule the Plan page reads: the trial ending within three days, or a trial
// that ended in the last seven and left the organisation on the free plan; null when neither.
async function dueFor(env: NoticeEnv, orgId: string, now: Date) {
  const plan = await planOf(env.DB, orgId, now);
  if (plan?.plan === "trial" && Date.parse(plan.trialEndsAt) - now.getTime() <= AHEAD_MS)
    return { kind: "ending" as const, endsAt: new Date(plan.trialEndsAt) };
  if (plan?.plan === "free" && plan.trialEndedAt && now.getTime() - Date.parse(plan.trialEndedAt) <= BEHIND_MS)
    return { kind: "ended" as const, endsAt: new Date(plan.trialEndedAt) };
  return null;
}

// The daily checks the organisation keeps after the trial, as the Plan page reads them: the operator's override when set
// (0 is a pause), else the free plan's.
async function keptPerDay(env: NoticeEnv, orgId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
    .bind(orgId)
    .first<{ cap: number | null }>();
  return row?.cap ?? PLAN_DAILY_CASES.free;
}

async function run(env: NoticeEnv, clock: () => Date, counts: NoticeCounts): Promise<number> {
  const now = clock();
  // Organisations whose trial (no stored plan) ends between a week ago and three days from now: the cheap read; `planOf`
  // decides each one.
  const due = (
    await env.DB.prepare(
      `SELECT o.id AS id, o.name AS name FROM "organization" o LEFT JOIN org_limits l ON l.org_id = o.id
       WHERE l.plan IS NULL AND COALESCE(l.trial_ends_at, strftime('%Y-%m-%dT%H:%M:%fZ', o."createdAt", '+${TRIAL_DAYS} days')) BETWEEN ? AND ?`,
    )
      .bind(new Date(now.getTime() - BEHIND_MS).toISOString(), new Date(now.getTime() + AHEAD_MS).toISOString())
      .all<{ id: string; name: string }>()
  ).results;
  for (const org of due) {
    if (isProtectedOrganisation(org.id)) continue;
    const first = await dueFor(env, org.id, now);
    if (!first) continue;
    const members = (
      await env.DB.prepare(
        `SELECT m."userId" AS userId, m.role AS role, lower(u.email) AS email FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ?`,
      )
        .bind(org.id)
        .all<{ userId: string; role: string; email: string }>()
    ).results;
    // The protected live test accounts' organisations get no mail at all.
    if (members.some((m) => isProtectedAccount(m.email))) continue;
    const owners = members.filter((m) => m.role.split(",").some((r) => r.trim() === "owner"));
    for (const owner of owners) {
      // Checked again before each owner: an extension or a chosen plan while the first send was under way drops the rest.
      const still = await dueFor(env, org.id, clock());
      if (!still || still.kind !== first.kind || still.endsAt.getTime() !== first.endsAt.getTime()) break;
      // And the owner is still an owner: a member demoted meanwhile is not sent the owners' notice.
      const role = await env.DB.prepare(`SELECT role FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
        .bind(org.id, owner.userId)
        .first<{ role: string }>();
      if (!role?.role.split(",").some((r) => r.trim() === "owner")) continue;
      const mail = trialNoticeEmail({
        appUrl: env.APP_URL,
        kind: still.kind,
        organisation: org.name,
        endsAt: still.endsAt,
        link: new URL("/settings/plan", env.APP_URL).toString(),
        freePerDay: await keptPerDay(env, org.id),
      });
      const outcome = await sendMail(
        { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
        {
          sendKey: `trial:${org.id}:${still.kind}:${still.endsAt.toISOString()}:${owner.userId}`,
          kind: "notice",
          to: owner.email,
          from: FROM,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        },
      ).catch(() => null);
      if (outcome?.status === "sent") counts.sent++;
      else if (outcome?.status === "duplicate" && outcome.previous === "sent") counts.skipped++;
      else if (outcome?.status === "uncertain" || (outcome?.status === "duplicate" && outcome.previous === "uncertain"))
        counts.uncertain++;
      else counts.failed++;
    }
  }
  return due.length;
}
