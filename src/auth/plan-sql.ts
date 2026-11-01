// The operator's plan statements (D07 T02 §8), shared by the Worker (./plans) and the operator's script
// (scripts/org-plan.ts), so both make the same change. No Worker types: the script runs them under Node.
import type { Statement } from "../meta/budget-sql.ts";

export const STORED_PLANS = ["free", "protect", "msp"] as const;
// The trial's length (./plans TRIAL_DAYS), here as SQL needs it.
const TRIAL_DAYS_SQL = 14;

// An extension's end, as the operator writes it: an ISO 8601 date-time with its zone (`2026-11-12T00:00:00Z`, or with
// an offset), and a real calendar date. Anything else (`2027-02-30`, `03/04/2027`, a date with no zone) is refused, so
// a mistyped date never changes access (completion review).
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
export function parseExtension(text: string): Date {
  const m = ISO.exec(text.trim());
  if (!m)
    throw new RangeError("an extension ends at an ISO 8601 date and time with its zone, such as 2026-11-12T00:00:00Z");
  const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
  const calendar = new Date(Date.UTC(y as number, (mo as number) - 1, d as number));
  if (
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== (mo as number) - 1 ||
    calendar.getUTCDate() !== d ||
    (h as number) > 23 ||
    (mi as number) > 59 ||
    (se ?? 0) > 59
  )
    throw new RangeError(`${text} is not a real date and time`);
  return new Date(text.trim());
}

// The daily case cap by plan (D07 T08 §8; design/SPEC.md S5 and M10, design spec 2b): Free check is up to 5 checks a
// day; the trial, Protect and MSP keep the event's 50 until the operator sets them; an organisation that is not found
// gets 50 (`DEFAULT_DAILY_CASES`, as before).
export const DEFAULT_DAILY_CASES = 50;
export const PLAN_DAILY_CASES = { trial: 50, free: 5, protect: 50, msp: 50 } as const;
// The cap an operator may set by hand for one organisation (D07 T05; D07 T08 §15): up to 500, for the eval run that checks
// 275 samples in a day. It is the operator's alone (`scripts/org-plan.ts`; no route, page or member can write it); the
// plans' own caps above are unchanged, and spend stays held by the Meta caps.
export const MAX_DAILY_CASES_OVERRIDE = 500;

// An organisation's cap as one SQL expression, so it is read in the same statement that counts or admits: the override
// (`org_limits.daily_cases_override`) when set, else the effective plan's cap by the rule `planOf` reads
// (src/auth/plans.ts): Protect or MSP stored; Free stored; otherwise the trial until its end (`trial_ends_at` when
// extended, else 14 days from `createdAt`) and Free from that moment; 50 for an organisation not found. `org` and `now`
// are the caller's SQL for the organisation id and the moment as an ISO 8601 instant; they appear in the order
// `dailyCapBinds` gives.
export function dailyCapSql(org = "?", now = "?"): string {
  const p = PLAN_DAILY_CASES;
  return `COALESCE((SELECT daily_cases_override FROM org_limits WHERE org_id = ${org}), (SELECT CASE WHEN l.plan IN ('protect', 'msp') THEN ${p.protect} WHEN l.plan = 'free' THEN ${p.free} WHEN ${now} >= COALESCE(l.trial_ends_at, strftime('%Y-%m-%dT%H:%M:%fZ', o."createdAt", '+${TRIAL_DAYS_SQL} days')) THEN ${p.free} ELSE ${p.trial} END FROM "organization" o LEFT JOIN org_limits l ON l.org_id = o.id WHERE o.id = ${org}), ${DEFAULT_DAILY_CASES})`;
}
// The values for `dailyCapSql("?", "?")`'s placeholders, in order.
export const dailyCapBinds = (orgId: string, now: Date) => [orgId, now.toISOString(), orgId];

// The operator's daily cap for an organisation, over its plan's (D07 T05's "daily limit"), and its removal ("Use plan
// limit"), which puts the organisation back on its plan's cap.
export function setDailyCapOverrideStatement(orgId: string, cases: number): Statement {
  if (!Number.isInteger(cases) || cases < 0 || cases > MAX_DAILY_CASES_OVERRIDE)
    throw new RangeError(`a daily cap is a whole number from 0 to ${MAX_DAILY_CASES_OVERRIDE}`);
  return {
    sql: 'INSERT INTO org_limits (org_id, daily_cases_override) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM "organization" WHERE id = ?1) ON CONFLICT (org_id) DO UPDATE SET daily_cases_override = excluded.daily_cases_override',
    params: [orgId, cases],
  };
}
export function clearDailyCapOverrideStatement(orgId: string): Statement {
  return { sql: "UPDATE org_limits SET daily_cases_override = NULL WHERE org_id = ?1", params: [orgId] };
}

// The operator's changes (scripts/org-plan.ts; the admin detail page's controls, D07 T08 §5). A plan replaces the trial;
// an extension puts the organisation back on its trial until the given time. The operator's cap override
// (`daily_cases_override`) is kept either way.
export function setPlanStatement(orgId: string, plan: (typeof STORED_PLANS)[number]): Statement {
  if (!(STORED_PLANS as readonly string[]).includes(plan)) throw new RangeError(`no such plan: ${plan}`);
  return {
    // A plan replaces the trial, and any extension with it (final review: no stale trial end is left behind).
    sql: 'INSERT INTO org_limits (org_id, plan) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM "organization" WHERE id = ?1) ON CONFLICT (org_id) DO UPDATE SET plan = excluded.plan, trial_ends_at = NULL',
    params: [orgId, plan],
  };
}

export function extendTrialStatement(orgId: string, until: Date, now = new Date()): Statement {
  if (Number.isNaN(until.getTime()) || until <= now)
    throw new RangeError("a trial is extended to a time still to come");
  return {
    // Only ever later, and never over a paid plan (final review): an extension that would end before the trial's current
    // end (its own extension, else 14 days from createdAt), or that would replace Protect or MSP, changes nothing.
    sql: `INSERT INTO org_limits (org_id, plan, trial_ends_at) SELECT ?1, NULL, ?2 WHERE EXISTS (SELECT 1 FROM "organization" WHERE id = ?1) AND NOT EXISTS (SELECT 1 FROM org_limits WHERE org_id = ?1 AND plan IN ('protect', 'msp')) AND ?2 > coalesce((SELECT trial_ends_at FROM org_limits WHERE org_id = ?1), (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', "createdAt", '+${TRIAL_DAYS_SQL} days') FROM "organization" WHERE id = ?1)) ON CONFLICT (org_id) DO UPDATE SET plan = NULL, trial_ends_at = excluded.trial_ends_at`,
    params: [orgId, until.toISOString()],
  };
}
