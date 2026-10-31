// Loupe's runtime ledger for a local script (D03 T04 §14): the same `glimmer_runtime` statements the Worker binds on
// D1 (src/vision/glimmer-minutes.ts), sent through `wrangler d1 execute isitlegit --remote` on the operator's Wrangler
// login, as scripts/lib/meta-budget.ts does for the Meta budget. One ledger for every caller: a local wake and a Worker
// burst cannot both take the last minutes of a day. When the database cannot be reached, the reservation is refused and
// nothing is sent to the deployment.
import type { Exec } from "../../src/vision/glimmer-minutes.ts";
import { execute } from "../lib/meta-budget.ts";
import { type Runner, runCommand } from "../smoke.ts";

export const wranglerExec =
  (run: Runner = runCommand): Exec =>
  async (statement) => {
    const answer = await execute(statement, run);
    return { rows: answer.results ?? [], changes: answer.meta?.changes ?? 0 };
  };
