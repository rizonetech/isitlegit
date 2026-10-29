// The budget guard's contract with the Meta client (D03 T01 §2): every transport attempt is reserved before it is sent
// and settled after, through a `Budget` the caller supplies (the Worker's D1, src/meta/budget.ts; a local script's, the
// same D1 through wrangler, scripts/lib/meta-budget.ts). With extensions on its imports, so scripts can run the client.
import type { ModelId } from "./models.ts";
import { costUsd, type Usage } from "./pricing.ts";

export type Cap = "day" | "total" | "reserve";

// A call the caps cannot pay for; it never reaches Meta, and it is never retried. The Workflow ends the step partial with
// `budget:<cap>:<model>`.
export class BudgetExceeded extends Error {
  readonly cap: Cap;
  readonly model: string;
  constructor(cap: Cap, model: string) {
    super(`budget: the ${cap} cap refused a call to ${model}`);
    this.name = "BudgetExceeded";
    this.cap = cap;
    this.model = model;
  }
}

// The budget behind one caller: `reserve` throws BudgetExceeded when a cap refuses, and any other error when the budget
// cannot be reached, in which case nothing is sent. `id` names the row when the caller keeps its own record of the call
// (a local ledger entry), so the same call is one row however often the history is imported.
export type Budget = {
  reserve(model: ModelId, estimateUsd: number, attempt: number, id?: string): Promise<string>;
  settle(id: string, actualUsd: number): Promise<void>;
  uncertain(id: string): Promise<void>;
};

// Thrown by a caller's transport when it stopped before the request left (a local record that could not be written):
// the attempt's reservation is released at nothing, never kept as a charge (round 1).
export class NotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSent";
  }
}

// Whether an error, or anything it wraps (an SDK wraps its transport's error as its cause), says nothing was sent.
const neverSent = (error: unknown): boolean => {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++)
    if (e instanceof NotSent) return true;
  return false;
};

// The budget could not be reached or written: the call is not sent.
export class BudgetUnavailable extends Error {
  constructor() {
    super("budget: the spend could not be reserved; nothing was sent");
    this.name = "BudgetUnavailable";
  }
}

// One attempt, charged: reserved at the estimate first; settled at the reported cost (the estimate when the usage is
// unreadable); a request Meta refused itself (a 4xx other than 408: invalid, unauthorised, rate-limited) settled at
// nothing, since it was never run; and anything else left counted at its estimate: an answer lost, cut off or
// unreadable, and a 5xx or a 408, which a gateway can answer after the request reached Meta (a 504 timeout) (D03 T01 §2
// completion review). A failed settlement leaves the row counted at its estimate, never released.
export async function charged<T>(
  budget: Budget,
  model: ModelId,
  estimateUsd: number,
  attempt: number,
  send: () => Promise<T>,
  usage: (answer: T) => Usage,
): Promise<T> {
  let id: string;
  try {
    id = await budget.reserve(model, estimateUsd, attempt);
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    throw new BudgetUnavailable();
  }
  let answer: T;
  try {
    answer = await send();
  } catch (error) {
    const status =
      (error as { status?: unknown; details?: { status?: unknown } }).status ??
      (error as { details?: { status?: unknown } }).details?.status;
    const refused = typeof status === "number" && status >= 400 && status < 500 && status !== 408;
    await (refused || neverSent(error) ? budget.settle(id, 0) : budget.uncertain(id)).catch(() => {});
    throw error;
  }
  await budget.settle(id, costUsd(model, usage(answer)) ?? estimateUsd).catch(() => {});
  return answer;
}
