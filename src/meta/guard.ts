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
// Who a call is for (D03 T01 §3): a case's step, a monitor run's screening of a host before any case exists, or a named
// script (the live check). Every call has one, so every cost is attributed.
export type Owner =
  | { kind: "case"; caseId: string; step: string }
  | { kind: "monitor"; run: string; host: string; step: string }
  | { kind: "script"; name: string };

// One client invocation: its id groups its attempts (a 503 then a success are two rows of one call).
export type Call = { callId: string; owner: Owner };

// What an attempt's record holds once it ends: never a prompt or a response, only counts, ids, the outcome and the
// cost's certainty (`measured` from Meta's reported usage, `estimated` otherwise, `none` when it never ran).
export type AttemptRecord = {
  ms: number;
  inputTokens?: number | undefined;
  cachedTokens?: number | undefined;
  outputTokens?: number | undefined;
  // The non-token billable quantity, so a charge can be reproduced from the row (completion review, E2).
  images?: number | undefined;
  audioSeconds?: number | undefined;
  searches?: number | undefined;
  logId?: string | null | undefined;
  requestId?: string | null | undefined;
  outcome: "ok" | "error" | "refused";
  errorClass?: string | undefined;
  certainty: "measured" | "estimated" | "none";
  source: "meta-usage" | "estimate";
};

export type Budget = {
  reserve(model: ModelId, estimateUsd: number, attempt: number, id?: string, call?: Call): Promise<string>;
  // A call the client refused before any reservation (a request it will not send): its record, costing nothing. A cap's
  // refusal is recorded by `reserve` itself (D03 T01 §3 final review).
  refused(model: string, call: Call, errorClass: string): Promise<void>;
  // A call answered from the result cache (D03 T01 §4): its record, costing nothing, with the hit's latency.
  cached(model: ModelId, call: Call, ms: number): Promise<void>;
  // A paid answer that failed its structured output (D03 T01 §5): the call's record marked with the failure's kind.
  outputFailed(callId: string, errorClass: string): Promise<void>;
  settle(id: string, actualUsd: number, record?: AttemptRecord): Promise<void>;
  uncertain(id: string, record?: AttemptRecord): Promise<void>;
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
// The gateway's and Meta's ids an error carries (a ModelError's details), never its message.
const traceOf = (error: unknown) => {
  const details = (error as { details?: { logId?: unknown; requestId?: unknown } }).details;
  return {
    logId: typeof details?.logId === "string" ? details.logId : null,
    requestId: typeof details?.requestId === "string" ? details.requestId : null,
  };
};
const CLASS = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const classOf = (error: unknown) => {
  const kind = (error as { kind?: unknown }).kind;
  const name = error instanceof Error ? error.name : "Error";
  return typeof kind === "string" && CLASS.test(kind) ? kind : CLASS.test(name) ? name : "Error";
};

// A settlement that could not be written: the row stays counted at its estimate for the cron to mark, and the failure is
// logged (its class only), so repeated write failures show before the spend they hold does (final review).
const unrecorded = (error: unknown) =>
  console.error(JSON.stringify({ event: "budget", outcome: "unsettled", error: classOf(error) }));

// What an answer reports: its usage, and whether that usage is Meta's own (`reported`), or derived from the request
// (SAM's images sent, an image edit's count asked for), which is then labelled estimated, never measured.
export type Answered = { usage: Usage; logId: string | null; requestId: string | null; reported?: boolean };

// How the client describes an error it will hand on: its kind, its status and the ids it carries, read through the
// client's own classification, so a failed attempt's record keeps them (completion review, C1).
export type Described = {
  errorClass: string;
  status?: number | undefined;
  logId: string | null;
  requestId: string | null;
};

// One attempt, charged and recorded: reserved at the estimate first (with its call's identity and owner); settled at
// the reported cost (`measured`) or, when the usage is unreadable, at the estimate (`estimated`); a request Meta refused
// itself (a 4xx other than 408: invalid, unauthorised, rate-limited) or one never sent settled at nothing (`none`), since
// it never ran; and anything else left counted at its estimate: an answer lost, cut off or unreadable, and a 5xx or a 408,
// which a gateway can answer after the request reached Meta (a 504 timeout). A settlement that cannot be written leaves the
// row counted at its estimate, never released, for the cron to mark (D03 T01 §2, §3).
export async function charged<T>(
  budget: Budget,
  model: ModelId,
  estimateUsd: number,
  attempt: number,
  send: () => Promise<T>,
  answered: (answer: T) => Answered,
  call?: Call,
  now: () => number = () => Date.now(),
  describe?: (error: unknown) => Described,
): Promise<T> {
  let id: string;
  try {
    id = await budget.reserve(model, estimateUsd, attempt, undefined, call);
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    throw new BudgetUnavailable();
  }
  const started = now();
  let answer: T;
  try {
    answer = await send();
  } catch (error) {
    const ms = Math.max(0, now() - started);
    const described = describe?.(error);
    const status =
      described?.status ??
      (error as { status?: unknown; details?: { status?: unknown } }).status ??
      (error as { details?: { status?: unknown } }).details?.status;
    const refused = (typeof status === "number" && status >= 400 && status < 500 && status !== 408) || neverSent(error);
    const ended = {
      ms,
      ...(described ? { logId: described.logId, requestId: described.requestId } : traceOf(error)),
      errorClass: neverSent(error) ? "NotSent" : (described?.errorClass ?? classOf(error)),
      source: "estimate" as const,
    };
    await (refused
      ? budget.settle(id, 0, { ...ended, outcome: "refused", certainty: "none" })
      : budget.uncertain(id, { ...ended, outcome: "error", certainty: "estimated" })
    ).catch(unrecorded);
    throw error;
  }
  const ms = Math.max(0, now() - started);
  const { usage, logId, requestId, reported = true } = answered(answer);
  const priced = costUsd(model, usage);
  // Derived from the request rather than reported by Meta: the same price, labelled estimated.
  const cost = priced;
  const measured = priced !== null && reported;
  await budget
    .settle(id, cost ?? estimateUsd, {
      ms,
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      images: usage.images,
      audioSeconds: usage.audioSeconds,
      searches: usage.searches,
      logId,
      requestId,
      outcome: "ok",
      certainty: measured ? "measured" : "estimated",
      source: measured ? "meta-usage" : "estimate",
    })
    .catch(unrecorded);
  return answer;
}
