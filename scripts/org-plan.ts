// The operator's plan changes (D07 T02 §8), on the live D1 through the operator's Wrangler login, with the same
// statements the Worker runs (src/auth/plans.ts). The admin detail page's controls follow in D07 T08 §5.
//
//   node scripts/org-plan.ts <organisation id> free|protect|msp
//   node scripts/org-plan.ts <organisation id> extend <ISO date>
import { extendTrialStatement, parseExtension, STORED_PLANS, setPlanStatement } from "../src/auth/plan-sql.ts";
import { execute } from "./lib/meta-budget.ts";
import { type Runner, runCommand } from "./smoke.ts";

export async function orgPlan(args: string[], run: Runner = runCommand, now = new Date()): Promise<string> {
  const [orgId, action, when] = args;
  if (!orgId || !action)
    throw new Error("usage: node scripts/org-plan.ts <organisation id> free|protect|msp|extend <ISO date>");
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

if (import.meta.filename === process.argv[1]) {
  orgPlan(process.argv.slice(2)).then(
    (line) => console.log(`org-plan: ${line}`),
    (error: unknown) => {
      console.error(`org-plan: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
