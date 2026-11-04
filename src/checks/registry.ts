// The check registry (D02 T01 §1): every check registers once, by name, with the parts of the case it reads and its time
// budget, and the runner (D02 T01 §2) runs them in registration order. A check is pure: it gets the case view and
// returns its evidence, never reaching the store.
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";

// A check's name: lowercase words joined by dots, `intake.forward`, `not_checked`.
export const CHECK_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
// Names the runner itself writes (D02 T01 §2), which no check may register: a check that threw or ran out of time is
// one `not_checked` item naming it, never a silence and never a guess.
export const SYSTEM_CHECKS = ["not_checked"] as const;
// Producers that add evidence after the checks step (D02 T01 §5), each a family: its items are named `<family>.<name>`
// (`walkthrough.chain`) and written by `addEvidence`, never by a registered check, so no check may take the family.
export const LATER_PRODUCERS = ["walkthrough", "agent", "vision", "invoice", "verification"] as const;
export type LaterProducer = (typeof LATER_PRODUCERS)[number];
export const familyOf = (name: string) => name.split(".")[0] ?? name;
// A check's largest budget: the runner's checks all run inside one attempt of the Workflow's `checks` step, at most 30
// seconds (`RETRIES` in src/pipeline/analysis-workflow.ts), so a check that needs longer (a model call) is its own step.
export const MAX_CHECK_MS = 20_000;
// The most items one check may return, and the most checks: bounded lists keep the store's batch small (D02 T01 §2's
// final review), and a check with more to say summarises (the link check caps at 50 links, D02 T07 §1).
export const MAX_ITEMS_PER_CHECK = 50;
export const MAX_CHECKS = 64;

// The parts of the case view a check may read, each one the runner knows how to find missing (`available`).
export const CHECK_INPUTS = ["source", "headers", "text", "html", "attachments", "truncated", "omitted"] as const;
export type CheckInput = (typeof CHECK_INPUTS)[number] & Exclude<keyof CaseView, "tenant">;

// A check gets a frozen view and a signal that aborts when its budget runs out, which any I/O it does passes on (a
// fetch's `signal`). It must yield to the event loop to be timed out at all: a Worker cannot stop synchronous
// JavaScript, so a check whose own work is synchronous keeps it bounded (bounded inputs, linear-time parsing); one that
// never yields runs until the Workflow step's attempt ends, and the case is then partial, naming `checks` (D01 T01 §7).
export type Check = {
  name: string;
  needs: CheckInput[];
  timeoutMs: number;
  run: (view: Readonly<CaseView>, signal: AbortSignal) => EvidenceDraft[] | Promise<EvidenceDraft[]>;
  // Why the check has nothing to check in this view, or null when it has (D02 T01 §3): a check whose `run` would return
  // nothing because its input is not there says so here, so its outcome is `skipped` with this reason, never a clean
  // `ran`. Pure; when it names a reason, `run` returns `[]` for the same view (each check's test says so).
  applies?: (view: Readonly<CaseView>) => string | null;
  // What part of its input the check could not read, or null when it read it all: a check that ran over only part of
  // it is stored `partial` with this reason, never a clean `ran` (D02 T01 §3's completion review: a damaged archive's
  // macro and encryption checks found nothing because they read nothing).
  partial?: (view: Readonly<CaseView>) => string | null;
  // What the check saw, in a few plain words without its own label, when it ran over all its input (D02 T01 §7): the
  // report draws "<check words>: <summary>" ("Links: 1, to fynbosfreight.example"). From the view and the check's own
  // items only, holding nothing of the message its card does not show; null when it has nothing to say. A summary that
  // throws, is empty, runs past MAX_OUTCOME_SUMMARY characters or is not plain is stored as null, the outcome kept.
  summary?: (view: Readonly<CaseView>, items: readonly EvidenceDraft[]) => string | null;
  // The targets the check examined, as stored text (D02 T01 §8): read by the runner only when the check ran
  // over all its input and found nothing, so a clean outcome can show what was looked at. From the view only,
  // never a new read. A hook that throws or returns a malformed entry loses only its examined set.
  examined?: (view: Readonly<CaseView>) => string[];
};

export const MAX_OUTCOME_SUMMARY = 120;

export class CheckRegistry {
  readonly #checks = new Map<string, Check>();

  register(check: Check): Check {
    if (!CHECK_NAME.test(check.name))
      throw new TypeError(`a check's name is lowercase words joined by dots: ${check.name}`);
    if ((SYSTEM_CHECKS as readonly string[]).includes(check.name))
      throw new TypeError(`${check.name} is written by the runner and cannot be registered`);
    if ((LATER_PRODUCERS as readonly string[]).includes(familyOf(check.name)))
      throw new TypeError(
        `${check.name} is in ${familyOf(check.name)}'s family, a later step's, and cannot be registered`,
      );
    if (this.#checks.has(check.name)) throw new TypeError(`a check named ${check.name} is already registered`);
    if (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > MAX_CHECK_MS)
      throw new RangeError(`${check.name}'s time budget is a whole number of milliseconds, at most ${MAX_CHECK_MS}`);
    if (typeof check.run !== "function") throw new TypeError(`${check.name} has no run function`);
    if (
      !Array.isArray(check.needs) ||
      !check.needs.every((input) => (CHECK_INPUTS as readonly unknown[]).includes(input))
    )
      throw new TypeError(`${check.name}'s needs are inputs of the case view (${CHECK_INPUTS.join(", ")})`);
    if (this.#checks.size >= MAX_CHECKS) throw new RangeError(`at most ${MAX_CHECKS} checks are registered`);
    this.#checks.set(check.name, check);
    return check;
  }

  all(): Check[] {
    return [...this.#checks.values()];
  }

  names(): string[] {
    return [...this.#checks.keys()];
  }
}

// The one registry the pipeline runs: `src/checks/index.ts` registers every check into it, the intake checks first.
export const checks = new CheckRegistry();
export const registerCheck = (check: Check) => checks.register(check);
export const allChecks = () => checks.all();
