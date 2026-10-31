import { describe, expect, it } from "vitest";
import { liveRun, readResult, WORST_USD } from "../../scripts/walkthrough-live.ts";
import { type Budget, BudgetExceeded } from "../../src/meta/guard.ts";
import { allowance, RESULT } from "../walkthrough/allowance.ts";

// D04 T02 §4: the live run's spend. One worst-case row reserved first, settled from the test's RESULT line: reported
// costs, an uncertain attempt at its estimate, the whole estimate kept when no line came back; a cap sends nothing.
function ledger(refuse = false) {
  const calls: { op: string; id: string; usd?: number; certainty?: string }[] = [];
  const budget: Budget = {
    async reserve(model, estimateUsd, _a, id) {
      if (refuse) throw new BudgetExceeded("day", model);
      calls.push({ op: "reserve", id: id as string, usd: estimateUsd });
      return id as string;
    },
    async settle(id, usd, record) {
      calls.push({ op: "settle", id, usd, certainty: record?.certainty as string });
    },
    async uncertain(id) {
      calls.push({ op: "uncertain", id });
    },
    async refused() {},
    async cached() {},
    async outputFailed() {},
  };
  return { budget, calls };
}
const report = (attempts: { estimateUsd: number; actualUsd: number | null }[]) =>
  JSON.stringify({
    testResults: [
      { assertionResults: [{ meta: { [RESULT]: { outcome: "finished", steps: 5, ms: 9000, attempts } } }] },
    ],
  });
const SECRETS = { meta: "meta-secret-0123456789", run: "run-token-0123456789" };

describe("walkthrough-live", () => {
  it("reserves the worst case first and settles at the reported costs", async () => {
    const { budget, calls } = ledger();
    const seen: NodeJS.ProcessEnv[] = [];
    const kept: string[] = [];
    const out = await liveRun({
      budget,
      keep: (output) => kept.push(output),
      readSecrets: async () => SECRETS,
      runTest: async (env) => {
        seen.push(env);
        return {
          code: 0,
          stdout: `leaked ${SECRETS.meta}`,
          report: report([
            { estimateUsd: 0.2, actualUsd: 0.01 },
            { estimateUsd: 0.2, actualUsd: 0.02 },
          ]),
        };
      },
      log: () => {},
    });
    expect(calls[0]).toMatchObject({ op: "reserve", usd: WORST_USD });
    expect(calls[1]).toMatchObject({ op: "settle", id: calls[0]?.id, certainty: "measured" });
    expect(calls[1]?.usd).toBeCloseTo(0.03, 10);
    expect(out).toMatchObject({ code: 0, settled: "measured" });
    expect(kept.join("")).not.toContain(SECRETS.meta);
    expect(seen[0]).toMatchObject({
      WALK_LIVE: "1",
      WALK_META_API_KEY: SECRETS.meta,
      WALK_CF_AIG_TOKEN: SECRETS.run,
      WALK_ALLOWANCE_USD: String(WORST_USD),
    });
  });

  it("counts an uncertain attempt at its estimate, and keeps the whole estimate when no result comes back", async () => {
    const a = ledger();
    await liveRun({
      budget: a.budget,
      readSecrets: async () => SECRETS,
      runTest: async () => ({
        code: 1,
        stdout: "",
        report: report([
          { estimateUsd: 0.2, actualUsd: 0.01 },
          { estimateUsd: 0.3, actualUsd: null },
        ]),
      }),
      log: () => {},
    });
    expect(a.calls[1]).toMatchObject({ op: "settle", certainty: "estimated" });
    expect(a.calls[1]?.usd).toBeCloseTo(0.31, 10);

    const b = ledger();
    const out = await liveRun({
      budget: b.budget,
      readSecrets: async () => SECRETS,
      runTest: async () => ({ code: 1, stdout: "crashed", report: "" }),
      log: () => {},
    });
    expect(b.calls.map((c) => c.op)).toEqual(["reserve", "uncertain"]);
    expect(out).toMatchObject({ code: 1, settled: "kept" });

    const c = ledger();
    await expect(
      liveRun({
        budget: c.budget,
        readSecrets: async () => {
          throw new Error("vault down");
        },
        runTest: async () => ({ code: 0, stdout: "", report: "" }),
        log: () => {},
      }),
    ).rejects.toThrow("vault down");
    // Nothing was sent: the row is released at nothing, not kept.
    expect(c.calls.map((x) => [x.op, x.usd])).toEqual([
      ["reserve", WORST_USD],
      ["settle", 0],
    ]);
  });

  it("sends nothing when the cap refuses the reservation", async () => {
    const { budget } = ledger(true);
    let read = 0;
    let ran = 0;
    const out = await liveRun({
      budget,
      readSecrets: async () => {
        read++;
        return SECRETS;
      },
      runTest: async () => {
        ran++;
        return { code: 0, stdout: "", report: "" };
      },
      log: () => {},
    });
    expect(out).toMatchObject({ code: 2, settled: "refused" });
    expect([read, ran]).toEqual([0, 0]);
  });

  it("holds every attempt against the allowance and refuses the one past it", async () => {
    const held = allowance(0.5);
    const call = { callId: "c", owner: { kind: "script" as const, name: "t" } };
    await held.reserve("muse-wonder-1.0", 0.3, 1, "a", call);
    await expect(held.reserve("muse-wonder-1.0", 0.3, 2, "b", call)).rejects.toBeInstanceOf(BudgetExceeded);
    await held.settle("a", 0.01);
    expect(held.attempts()).toEqual([{ estimateUsd: 0.3, actualUsd: 0.01 }]);
    expect(readResult("nothing")).toBeNull();
  });
});
