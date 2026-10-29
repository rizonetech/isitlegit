// The operator's plan statements (D07 T02 §8), shared by the Worker (./plans) and the operator's script
// (scripts/org-plan.ts), so both make the same change. No Worker types: the script runs them under Node.
import type { Statement } from "../meta/budget-sql.ts";

export const STORED_PLANS = ["free", "protect", "msp"] as const;

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

// The operator's changes (scripts/org-plan.ts; the admin detail page's controls, D07 T08 §5). A plan replaces the trial;
// an extension puts the organisation back on its trial until the given time. `daily_cases` is kept either way.
export function setPlanStatement(orgId: string, plan: (typeof STORED_PLANS)[number]): Statement {
  if (!(STORED_PLANS as readonly string[]).includes(plan)) throw new RangeError(`no such plan: ${plan}`);
  return {
    sql: 'INSERT INTO org_limits (org_id, plan) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM "organization" WHERE id = ?1) ON CONFLICT (org_id) DO UPDATE SET plan = excluded.plan',
    params: [orgId, plan],
  };
}

export function extendTrialStatement(orgId: string, until: Date, now = new Date()): Statement {
  if (Number.isNaN(until.getTime()) || until <= now)
    throw new RangeError("a trial is extended to a time still to come");
  return {
    sql: 'INSERT INTO org_limits (org_id, plan, trial_ends_at) SELECT ?1, NULL, ?2 WHERE EXISTS (SELECT 1 FROM "organization" WHERE id = ?1) ON CONFLICT (org_id) DO UPDATE SET plan = NULL, trial_ends_at = excluded.trial_ends_at',
    params: [orgId, until.toISOString()],
  };
}
