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

export async function sendTrialNotices(env: NoticeEnv, now = new Date()): Promise<NoticeCounts> {
  const counts: NoticeCounts = { sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  // Organisations whose trial (no stored plan) ends between a week ago and three days from now: the cheap read; `planOf`
  // below decides each one.
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
    const plan = await planOf(env.DB, org.id, now);
    let kind: "ending" | "ended" | null = null;
    let endsAt: Date | null = null;
    if (plan?.plan === "trial" && Date.parse(plan.trialEndsAt) - now.getTime() <= AHEAD_MS) {
      kind = "ending";
      endsAt = new Date(plan.trialEndsAt);
    } else if (
      plan?.plan === "free" &&
      plan.trialEndedAt &&
      now.getTime() - Date.parse(plan.trialEndedAt) <= BEHIND_MS
    ) {
      kind = "ended";
      endsAt = new Date(plan.trialEndedAt);
    }
    if (!kind || !endsAt) continue;
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
      const mail = trialNoticeEmail({
        appUrl: env.APP_URL,
        kind,
        organisation: org.name,
        endsAt,
        link: new URL("/settings/plan", env.APP_URL).toString(),
        freePerDay: PLAN_DAILY_CASES.free,
      });
      const outcome = await sendMail(
        { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
        {
          sendKey: `trial:${org.id}:${kind}:${endsAt.toISOString()}:${owner.userId}`,
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
  console.log(JSON.stringify({ event: "trial-notices", ...counts, candidates: due.length }));
  return counts;
}
