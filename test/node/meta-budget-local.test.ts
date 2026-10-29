import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { execute, localBudget } from "../../scripts/lib/meta-budget.ts";
import { BEFORE_LEDGER, importSpend } from "../../scripts/meta-spend-import.ts";
import type { Runner } from "../../scripts/smoke.ts";
import { inline, reserveStatement } from "../../src/meta/budget-sql.ts";
import { BudgetExceeded } from "../../src/meta/guard.ts";

// The local callers' budget (D03 T01 §2): the same statement the Worker runs, sent through `wrangler d1 execute`. Here
// wrangler is a stand-in that runs each command on an in-memory SQLite holding the real migration, so the SQL itself is
// what is tested, a Worker's reservation racing a local one on the same rows.
const MIGRATION = readFileSync(new URL("../../src/db/migrations/0020_model_spend.sql", import.meta.url), "utf-8");

function wrangler(db = new DatabaseSync(":memory:")) {
  db.exec(MIGRATION);
  const commands: string[] = [];
  const run: Runner = async (_command, args) => {
    const sql = args[args.indexOf("--command") + 1] as string;
    commands.push(sql);
    if (/^\s*select/i.test(sql)) return JSON.stringify([{ results: db.prepare(sql).all(), success: true, meta: {} }]);
    const changes = Number(db.prepare(sql).run().changes);
    return JSON.stringify([{ results: [], success: true, meta: { changes } }]);
  };
  return { db, run, commands };
}

const at = () => new Date("2026-10-30T08:00:00.000Z");

describe("the local budget", () => {
  it("reserves in the shared table and refuses once a Worker's reservation took the rest of the day", async () => {
    const w = wrangler();
    // The Worker reserved US$13 today through its own binding: the same statement, on the same rows.
    w.db.exec(
      inline(
        reserveStatement(
          {
            id: "worker-1",
            at: "2026-10-30T07:00:00.000Z",
            day: "2026-10-30",
            source: "worker",
            caller: "analysis",
            model: "muse-spark-1.3",
            caseId: "c1",
            attempt: 1,
            estimateUsd: 13,
          },
          15,
          90,
        ),
      ),
    );
    const budget = localBudget("meta-smoke", w.run, at);
    const id = await budget.reserve("muse-spark-1.3", 1.5, 1);
    expect(w.db.prepare("SELECT source, caller, state FROM model_spend WHERE id = ?").get(id)).toEqual({
      source: "local",
      caller: "meta-smoke",
      state: "reserved",
    });
    const refused = await budget.reserve("muse-spark-1.3", 1, 1).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BudgetExceeded);
    expect((refused as BudgetExceeded).cap).toBe("day");
    await budget.settle(id, 0.4);
    expect(w.db.prepare("SELECT actual_usd, state FROM model_spend WHERE id = ?").get(id)).toEqual({
      actual_usd: 0.4,
      state: "settled",
    });
  });

  it("fails the reservation when the database cannot be reached, so nothing is sent", async () => {
    const down: Runner = async () => {
      throw new Error("wrangler d1 execute failed (exit 1): fetch failed");
    };
    await expect(localBudget("meta-smoke", down, at).reserve("muse-spark-1.3", 1, 1)).rejects.toThrow(/exit 1/);
    const unsuccessful: Runner = async () => JSON.stringify([{ success: false }]);
    await expect(execute({ sql: "SELECT 1", params: [] }, unsuccessful)).rejects.toThrow(/did not succeed/);
  });

  it("counts on the SAST day, so a local call at 23:30 UTC lands on the next day's cap", async () => {
    const w = wrangler();
    await localBudget("meta-smoke", w.run, () => new Date("2026-11-02T23:30:00.000Z")).reserve("muse-spark-1.3", 1, 1);
    expect(w.db.prepare("SELECT day FROM model_spend").get()).toEqual({ day: "2026-11-03" });
  });
});

describe("the import of spend made before the guard", () => {
  it("adds each ledger entry and each earlier record once, on its day, whatever is run twice", async () => {
    const w = wrangler();
    const ledger = [
      {
        date: "2026-10-28",
        run: "glimmer-teacher-1",
        call: "muse-spark-1.3 a",
        estimate: 0.013,
        cost: 0.0138,
        state: "settled" as const,
      },
      {
        date: "2026-10-28",
        run: "glimmer-teacher-1",
        call: "muse-spark-1.3 b",
        estimate: 0.013,
        cost: null,
        state: "uncertain" as const,
      },
    ];
    const first = await importSpend(ledger, w.run);
    const second = await importSpend(ledger, w.run);
    expect([first.added, second.added]).toEqual([BEFORE_LEDGER.length + 2, 0]);
    const rows = w.db.prepare("SELECT day, state, actual_usd, estimate_usd FROM model_spend ORDER BY id").all();
    expect(rows).toHaveLength(BEFORE_LEDGER.length + 2);
    // Counted as the caps count it: the settled one at its cost, the uncertain one at its estimate.
    const counted = w.db
      .prepare("SELECT sum(CASE WHEN state = 'settled' THEN actual_usd ELSE estimate_usd END) AS usd FROM model_spend")
      .get() as { usd: number };
    expect(counted.usd).toBeCloseTo(0.008507 + 0.000291 + 0.0138 + 0.013);
    expect(first.total).toBeCloseTo(counted.usd);
  });
});
