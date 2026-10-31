// The live walkthrough's budget inside the Worker test (D04 T02 §4): an allowance of what scripts/walkthrough-live.ts
// reserved in the shared ledger. Every attempt the client makes is held against it; one that would pass it is refused
// as the cap (`BudgetExceeded`), so the run can never spend more than was reserved. What each attempt cost (Meta's
// reported figure, or none when it was left uncertain) is kept on the test's `task.meta[RESULT]`, which the script reads
// from Vitest's JSON report and settles from (the Worker pool drops a passing test's console output).
import { type Budget, BudgetExceeded } from "../../src/meta/guard.ts";

export const RESULT = "walk";

export type Attempt = { estimateUsd: number; actualUsd: number | null };

export function allowance(limitUsd: number): Budget & { attempts: () => Attempt[] } {
  const held = new Map<string, Attempt>();
  let spent = 0;
  return {
    async reserve(model, estimateUsd, _attempt, id) {
      if (spent + estimateUsd > limitUsd) throw new BudgetExceeded("total", model);
      spent += estimateUsd;
      const key = id ?? crypto.randomUUID();
      held.set(key, { estimateUsd, actualUsd: null });
      return key;
    },
    async settle(id, actualUsd) {
      const attempt = held.get(id);
      if (attempt) attempt.actualUsd = actualUsd;
    },
    async uncertain() {},
    async refused() {},
    async cached() {},
    async outputFailed() {},
    attempts: () => [...held.values()],
  };
}
