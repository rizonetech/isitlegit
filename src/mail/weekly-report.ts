// The Friday weekly counts email (D07 T04 §20; operator decision 2026-11-02, SPEC N10): members who opted in on
// the Account page get the week's three Cases numbers as they stand on Friday, from the quarter-hour schedule
// inside a Friday 16:00 SAST to Monday 00:00 SAST window, so a refused send retries on the next tick and a tick
// the Worker missed is caught up. One send per member per week rides the mail ledger's send key; an uncertain
// delivery is the reconciler's and is never sent again here. Eligibility (still a member of the organisation,
// still opted in) is rechecked before every provider attempt, as the trial notices guard theirs; the protected
// accounts and organisation are never sent to.

import { isProtectedAccount, isProtectedOrganisation } from "../auth/protected";
import { weeklyStats, weekStart } from "../db/case-stats";
import { sendMail } from "./smtp2go";
import { weeklyReportEmail } from "./templates/auth-mail";

export type WeeklyReportEnv = {
  DB: D1Database;
  APP_URL: string;
  BETTER_AUTH_SECRET?: string;
  SMTP2GO_API_KEY?: string;
  OPERATOR_EMAIL?: string;
};
export type WeeklyCounts = { sent: number; failed: number; uncertain: number; skipped: number };

const encoder = new TextEncoder();
async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`weekly-unsubscribe\n${text}`)));
  return btoa(String.fromCharCode(...mac))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// The one-step unsubscribe token: the organisation, the member and the opt-in time it was issued under, signed.
// A link from an earlier opt-in is stale once the member opts in again, because its time no longer matches.
const b64 = (v: string) => btoa(v).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (v: string) => atob(v.replace(/-/g, "+").replace(/_/g, "/"));
export async function weeklyToken(secret: string, orgId: string, userId: string, optedInAt: string): Promise<string> {
  const payload = `${orgId}\n${userId}\n${optedInAt}`;
  return `${b64(payload)}.${await sign(secret, payload)}`;
}
export async function readWeeklyToken(
  secret: string,
  token: string,
): Promise<{ orgId: string; userId: string; optedInAt: string } | null> {
  const at = token.lastIndexOf(".");
  if (at < 0) return null;
  let payload: string;
  try {
    payload = unb64(token.slice(0, at));
  } catch {
    return null;
  }
  const parts = payload.split("\n");
  if (parts.length !== 3) return null;
  const [orgId, userId, optedInAt] = parts as [string, string, string];
  return (await sign(secret, payload)) === token.slice(at + 1) ? { orgId, userId, optedInAt } : null;
}

// Inside the send window: Friday 16:00 SAST (14:00 UTC) to Monday 00:00 SAST (Sunday 22:00 UTC).
export function inWeeklyWindow(now: Date): boolean {
  const utcDay = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (utcDay === 5) return minutes >= 14 * 60;
  if (utcDay === 6 || utcDay === 0) return utcDay === 6 || minutes < 22 * 60;
  return false;
}

export async function sendWeeklyReports(
  env: WeeklyReportEnv,
  clock: () => Date = () => new Date(),
): Promise<WeeklyCounts> {
  const counts: WeeklyCounts = { sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  const now = clock();
  if (!inWeeklyWindow(now)) return counts;
  const secret = env.BETTER_AUTH_SECRET ?? "";
  const rows = (
    await env.DB.prepare(
      `SELECT w.org_id AS orgId, w.user_id AS userId, w.opted_in_at AS optedInAt, o.name AS orgName, lower(u.email) AS email
       FROM weekly_report_optins w
       JOIN "organization" o ON o.id = w.org_id
       JOIN "member" m ON m."organizationId" = w.org_id AND m."userId" = w.user_id
       JOIN "user" u ON u.id = w.user_id
       ORDER BY w.org_id, w.user_id`,
    ).all<{ orgId: string; userId: string; optedInAt: string; orgName: string; email: string }>()
  ).results;
  const monday = weekStart(now);
  for (const row of rows) {
    if (isProtectedOrganisation(row.orgId) || isProtectedAccount(row.email)) {
      counts.skipped++;
      continue;
    }
    const eligible = async () => {
      const held = await env.DB.prepare(
        `SELECT 1 AS held FROM weekly_report_optins w
         JOIN "member" m ON m."organizationId" = w.org_id AND m."userId" = w.user_id
         WHERE w.org_id = ? AND w.user_id = ? AND w.opted_in_at = ?`,
      )
        .bind(row.orgId, row.userId, row.optedInAt)
        .first<{ held: number }>();
      return Boolean(held);
    };
    let unread = false;
    const guarded: typeof fetch = async (input, init) => {
      let ok: boolean;
      try {
        ok = await eligible();
      } catch {
        unread = true;
        return Response.json({ data: { error_code: "CHECK_UNAVAILABLE" } }, { status: 400 });
      }
      if (!ok) return Response.json({ data: { error_code: "NO_LONGER_OPTED_IN" } }, { status: 400 });
      return fetch(input, init);
    };
    const stats = await weeklyStats(env.DB, row.orgId, clock());
    const token = await weeklyToken(secret, row.orgId, row.userId, row.optedInAt);
    const mail = weeklyReportEmail({
      appUrl: env.APP_URL,
      organisation: row.orgName,
      checked: stats.thisWeek.checked,
      flagged: stats.thisWeek.malicious + stats.thisWeek.suspicious,
      medianSeconds: stats.thisWeek.medianSecondsToVerdict,
      casesLink: new URL("/cases", env.APP_URL).toString(),
      unsubscribeLink: new URL(`/weekly-report/unsubscribe?token=${encodeURIComponent(token)}`, env.APP_URL).toString(),
    });
    const outcome = await sendMail(
      { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL, fetch: guarded },
      {
        sendKey: `weekly:${row.orgId}:${row.userId}:${monday}`,
        kind: "notice",
        to: row.email,
        from: "IsItLegit <no-reply@isitlegit.co.za>",
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      },
    ).catch(() => null);
    if (unread || !outcome) counts.failed++;
    else if (outcome.status === "sent") counts.sent++;
    else if (outcome.status === "uncertain") counts.uncertain++;
    else if (outcome.status === "duplicate") counts.skipped++;
    else counts.failed++;
  }
  console.log(JSON.stringify({ event: "weekly-report", outcome: "ran", ...counts, candidates: rows.length }));
  return counts;
}
