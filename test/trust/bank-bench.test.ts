// Bank-matching latency (D05 T01 §2, completion review):
// `BANK_BENCH=1 pnpm exec vitest run test/trust/bank-bench.test.ts --silent=false --reporter=verbose`
// prints the timings as JSON. Workload: one protected business with 5 registered accounts (a small business holds a
// few), checked once cold (the keys imported from the secrets, then the first match), 60 times warm one after another,
// and 20 times at once (the business's whole hourly allowance). Every timing includes the limit upserts and the audit
// write, and counts only once its answer is checked. Target: p95 below 1 second for one check, warm or concurrent.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addAccount, bankKeys, MATCHES_PER_HOUR, matchBankAccount } from "../../src/trust/bank";
import { setIdentity } from "../../src/trust/identity";
import { protectableOrg } from "./helpers";

const db = env.DB;
const ACCOUNTS = 5;
const WARM = 60;
const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    Math.round((sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number) * 10) / 10
  );
};

describe.skipIf(!(env as unknown as { BANK_BENCH?: string }).BANK_BENCH)("bank matching timings", () => {
  it("times cold, warm and concurrent checks", { timeout: 120_000 }, async () => {
    const orgId = await protectableOrg("bench.example", "money@bench.example");
    await setIdentity(db, orgId, "owner", {
      displayNames: ["Bench"],
      financeContact: "money@bench.example",
      protected: true,
    });
    const setup = await bankKeys(env);
    for (let i = 0; i < ACCOUNTS; i++)
      await addAccount(db, setup, orgId, "owner", {
        number: `1000000${i}`,
        branchCode: "250655",
        bankName: "Kestrel Bank (fictional)",
        holder: "Bench (Pty) Ltd",
      });
    const claim = { number: "10000004", branchCode: "250655" };
    // Each warm check in its own hour, so the hourly limit never answers for the database.
    const hour = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, 5) + i * 3_600_000);

    const coldStart = performance.now();
    const cold = await matchBankAccount(
      db,
      await bankKeys(env),
      { sender: "cold@check.example" },
      orgId,
      claim,
      hour(0),
    );
    const coldMs = performance.now() - coldStart;
    expect(cold).toEqual({ match: true });

    const warm: number[] = [];
    for (let i = 1; i <= WARM; i++) {
      const started = performance.now();
      const answer = await matchBankAccount(db, setup, { sender: `w${i}@check.example` }, orgId, claim, hour(i));
      warm.push(performance.now() - started);
      expect(answer).toEqual({ match: true });
    }

    const at = hour(WARM + 1);
    const burstStart = performance.now();
    const burst = await Promise.all(
      Array.from({ length: MATCHES_PER_HOUR }, async (_, i) => {
        const started = performance.now();
        const answer = await matchBankAccount(db, setup, { sender: `c${i}@check.example` }, orgId, claim, at);
        expect(answer).toEqual({ match: true });
        return performance.now() - started;
      }),
    );
    const burstMs = performance.now() - burstStart;

    const report = {
      accounts: ACCOUNTS,
      coldMs: Math.round(coldMs * 10) / 10,
      warm: { runs: WARM, p50Ms: pct(warm, 50), p95Ms: pct(warm, 95), maxMs: pct(warm, 100) },
      concurrent: { runs: MATCHES_PER_HOUR, p50Ms: pct(burst, 50), p95Ms: pct(burst, 95), allMs: Math.round(burstMs) },
    };
    console.log(`BANK_BENCH ${JSON.stringify(report)}`);
    expect(report.warm.p95Ms).toBeLessThan(1000);
    expect(report.concurrent.p95Ms).toBeLessThan(1000);
  });
});
