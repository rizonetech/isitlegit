// The operator's plan statements (D07 T02 §8), shared by the Worker (./plans) and the operator's script
// (scripts/org-plan.ts), so both make the same change. No Worker types: the script runs them under Node.
import type { Statement } from "../meta/budget-sql.ts";

export const STORED_PLANS = ["free", "protect", "msp"] as const;

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
