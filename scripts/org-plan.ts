// The operator's plan changes (D07 T02 §8), on the live D1 through the operator's Wrangler login, with the same
// statements the Worker runs (src/auth/plans.ts). The admin detail page's controls follow in D07 T08 §5.
//
//   node scripts/org-plan.ts <organisation id> free|protect|msp
//   node scripts/org-plan.ts <organisation id> extend <ISO date>
//   node scripts/org-plan.ts <organisation id> cap <0 to 500>     the daily-cases override (D07 T08 §15), 0 pauses checking
//   node scripts/org-plan.ts <organisation id> cap clear          back to the plan's own cap
import {
  clearDailyCapOverrideStatement,
  extendTrialStatement,
  MAX_DAILY_CASES_OVERRIDE,
  parseExtension,
  STORED_PLANS,
  setDailyCapOverrideStatement,
  setPlanStatement,
} from "../src/auth/plan-sql.ts";
import { execute } from "./lib/meta-budget.ts";
import { type Runner, runCommand } from "./smoke.ts";

export async function orgPlan(args: string[], run: Runner = runCommand, now = new Date()): Promise<string> {
  const [orgId, action, when] = args;
  if (!orgId || !action)
    throw new Error(
      "usage: node scripts/org-plan.ts <organisation id> free|protect|msp|extend <ISO date>|cap <0 to 500>|cap clear",
    );
  if (action === "cap") return orgCap(orgId, when, run);
  const statement =
    action === "extend"
      ? extendTrialStatement(orgId, parseExtension(when ?? ""), now)
      : (STORED_PLANS as readonly string[]).includes(action)
        ? setPlanStatement(orgId, action as (typeof STORED_PLANS)[number])
        : null;
  if (!statement) throw new Error(`no such plan: ${action}`);
  const answer = await execute(statement, run);
  if ((answer.meta?.changes ?? 0) !== 1)
    throw new Error(
      action === "extend"
        ? `${orgId} not extended: no such organisation, a paid plan, or not later than its current trial end`
        : `no organisation ${orgId}`,
    );
  return action === "extend"
    ? `${orgId}: trial until ${parseExtension(when ?? "").toISOString()}`
    : `${orgId}: ${action}`;
}

// The daily-cases override: set (a whole number from 0 to the ceiling) or cleared, then read back from the live database.
async function orgCap(orgId: string, value: string | undefined, run: Runner): Promise<string> {
  if (!value) throw new Error("usage: node scripts/org-plan.ts <organisation id> cap <0 to 500>|clear");
  const clearing = value === "clear";
  if (!clearing && !/^\d+$/.test(value))
    throw new Error(`a daily cap is a whole number from 0 to ${MAX_DAILY_CASES_OVERRIDE}, or clear`);
  // The shared statement refuses a number past the ceiling (a RangeError), the same rule the Worker holds.
  const statement = clearing
    ? clearDailyCapOverrideStatement(orgId)
    : setDailyCapOverrideStatement(orgId, Number(value));
  const answer = await execute(statement, run);
  if ((answer.meta?.changes ?? 0) !== 1) throw new Error(`no organisation ${orgId}`);
  const read = await execute(
    { sql: "SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?1", params: [orgId] },
    run,
  );
  const stored = (read.results?.[0] as { cap?: number | null } | undefined)?.cap ?? null;
  if (clearing ? stored !== null : stored !== Number(value))
    throw new Error(`${orgId}: the stored override reads ${stored === null ? "none" : stored}, not what was asked`);
  return clearing ? `${orgId}: daily cap back to the plan's own` : `${orgId}: daily cap ${stored}`;
}

if (import.meta.filename === process.argv[1]) {
  orgPlan(process.argv.slice(2)).then(
    (line) => console.log(`org-plan: ${line}`),
    (error: unknown) => {
      console.error(`org-plan: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
