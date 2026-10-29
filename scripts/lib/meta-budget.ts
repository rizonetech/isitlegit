// The Meta budget for a local caller (D03 T01 §2): the smoke test, the live client check and the Glimmer lane's teacher
// labels reserve every attempt in the same `model_spend` table the Worker does, with the same statement
// (src/meta/budget-sql.ts), through `wrangler d1 execute isitlegit --remote` on the operator's Wrangler login. One budget
// for every caller: a local call and a Worker call cannot both spend the last of an allowance. When the database cannot
// be reached, the reservation fails and nothing is sent to Meta.
import { createHash } from "node:crypto";
import {
  cachedStatement,
  capEventStatement,
  inline,
  outputFailedStatement,
  ownerColumns,
  refusedStatement,
  reserveStatement,
  type Statement,
  settleStatement,
  spentStatement,
  uncertainStatement,
} from "../../src/meta/budget-sql.ts";
import { capEvent, DAY_CAP_USD, refusingCap, totalLimitFor } from "../../src/meta/caps.ts";
import { sastDay } from "../../src/meta/day.ts";
import { type Budget, BudgetExceeded } from "../../src/meta/guard.ts";
import { type Runner, runCommand } from "../smoke.ts";

type D1Answer = { results?: Record<string, unknown>[]; success?: boolean; meta?: { changes?: number } };

// One statement on the live D1; its answer, or an error when wrangler fails or answers anything but success.
export async function execute(statement: Statement, run: Runner = runCommand, timeoutMs = 60_000): Promise<D1Answer> {
  const out = await run(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "isitlegit", "--remote", "--json", "--command", inline(statement)],
    "",
    Date.now() + timeoutMs,
  );
  const answer = (JSON.parse(out) as D1Answer[])[0];
  if (!answer?.success) throw new Error("wrangler d1 execute did not succeed");
  return answer;
}

// The row id of a call a local ledger records (scripts/meta-smoke.ts `Spend`): its date, run and call, so the guarded
// reservation and a later import of the same ledger entry are one row (D03 T01 §2 completion review).
export const ledgerId = (date: string, run: string, call: string) =>
  `ledger:${createHash("sha256").update(`${date}\n${run}\n${call}`).digest("hex").slice(0, 32)}`;

export function localBudget(caller: string, run: Runner = runCommand, now: () => Date = () => new Date()): Budget {
  return {
    async reserve(model, estimateUsd, attempt, id, call) {
      const at = now();
      const row = {
        ...ownerColumns(call),
        id: id ?? crypto.randomUUID(),
        at: at.toISOString(),
        day: sastDay(at),
        source: "local" as const,
        caller,
        model,
        attempt,
        estimateUsd,
      };
      // A refusal named from a second read, tried again when no cap refuses on that read (src/meta/budget.ts).
      let cap: ReturnType<typeof refusingCap> = null;
      for (let tries = 0; tries < 3 && !cap; tries++) {
        const inserted = await execute(reserveStatement(row, DAY_CAP_USD, totalLimitFor(row.day)), run);
        if (inserted.meta?.changes === 1) return row.id;
        const spent = (await execute(spentStatement(row.day), run)).results?.[0] ?? {};
        cap = refusingCap(Number(spent.day_usd ?? 0), Number(spent.total_usd ?? 0), estimateUsd, row.day);
      }
      const refused = cap ?? "day";
      // The cap's event, for the Worker's cron to alert the operator (a local script cannot send it), tried three times;
      // one that cannot be written is said, so the person running the script alerts the operator themselves.
      let recorded = false;
      for (let tries = 0; tries < 3 && !recorded; tries++)
        recorded = await execute(
          capEventStatement(capEvent(refused, row.day), refused, model, row.day, row.at),
          run,
        ).then(
          () => true,
          () => false,
        );
      if (!recorded) console.error(`meta-budget: the ${refused} cap's event could not be recorded; tell the operator`);
      // The refused attempt's own record, costing nothing (D03 T01 §3 final review).
      await execute(refusedStatement(row, `budget:${refused}`), run).catch(() =>
        console.error(`meta-budget: the refused ${model} attempt's record could not be written`),
      );
      throw new BudgetExceeded(refused, model);
    },
    async settle(id, actualUsd, record) {
      await execute(settleStatement(id, actualUsd, now().toISOString(), record), run);
    },
    async uncertain(id, record) {
      await execute(uncertainStatement(id, record), run);
    },
    async refused(model, call, errorClass) {
      const at = now();
      const row = {
        ...ownerColumns(call),
        id: crypto.randomUUID(),
        at: at.toISOString(),
        day: sastDay(at),
        source: "local" as const,
        caller,
        model,
        attempt: 1,
        estimateUsd: 0,
      };
      await execute(refusedStatement(row, errorClass), run);
    },
    async outputFailed(callId, errorClass) {
      await execute(outputFailedStatement(callId, errorClass), run);
    },
    async cached(model, call, ms) {
      const at = now();
      const row = {
        ...ownerColumns(call),
        id: crypto.randomUUID(),
        at: at.toISOString(),
        day: sastDay(at),
        source: "local" as const,
        caller,
        model,
        attempt: 1,
        estimateUsd: 0,
      };
      await execute(cachedStatement(row, ms), run);
    },
  };
}
