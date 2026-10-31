// The check runner (D02 T01 §2; spec 4.3a "an outage leaves a not-checked line, never a guess"): every registered check
// whose inputs are available runs at once, each within its own budget, and its evidence takes its place in registration
// order. A check that throws, rejects, runs out of time or returns evidence the schema refuses becomes one `not_checked`
// item naming it and its error class, never its message (which can carry hostile text); the others still store. A check
// whose inputs are not available never runs: each missing input gives one `not_checked` item naming the checks it held
// back and why.
import type { CaseView } from "./case-view";
import { type EvidenceDraft, EvidenceRefused, evidenceIn } from "./evidence";
import { checks } from "./index";
import { type Check, type CheckInput, type CheckRegistry, MAX_ITEMS_PER_CHECK } from "./registry";

export class Timeout extends Error {
  override name = "Timeout";
}

// Whether the view holds an input a check reads. The headers count only when they are the original's own (an inline
// forward or a draft .msg has none, D01 T01 §4); a body counts when the message has one, even empty; every other input
// is always there, an empty list being a fact rather than a gap.
export function available(view: CaseView, input: CheckInput): boolean {
  if (input === "headers") return view.tenant.headersAvailable;
  if (input === "text") return view.text !== null;
  if (input === "html") return view.html !== null;
  return true;
}

const MISSING: Partial<Record<CheckInput, string>> = {
  headers: "the original's headers were not available",
  text: "the original has no plain-text body",
  html: "the original has no HTML body",
};

// An error's class when it reads as one, else `Error`: a thrown value's name is still the check's to choose.
const CLASS = /^[A-Z][A-Za-z0-9]{0,63}$/;
const classOf = (error: unknown) => (error instanceof Error && CLASS.test(error.name) ? error.name : "Error");

function notChecked(check: string, error: unknown): EvidenceDraft {
  return {
    check: "not_checked",
    severity: "info",
    summary: `${check} could not run`,
    detail: { check, errorClass: classOf(error) },
    artefacts: [],
  };
}

async function runOne(check: Check, view: Readonly<CaseView>, registry: CheckRegistry): Promise<EvidenceDraft[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new AbortController();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // The check's own I/O stops with it, not only the wait for it (final review).
      budget.abort(new Timeout());
      reject(new Timeout());
    }, check.timeoutMs);
  });
  try {
    // A check that throws before its first await is caught here like one that rejects.
    const items: unknown = await Promise.race([Promise.resolve().then(() => check.run(view, budget.signal)), deadline]);
    if (!Array.isArray(items) || items.length > MAX_ITEMS_PER_CHECK)
      throw new EvidenceRefused(`${check.name} returned no list, or more than ${MAX_ITEMS_PER_CHECK} items`);
    const schema = evidenceIn(registry);
    for (const item of items) {
      // Each item is the check's own, under its own name, in the shape the store takes.
      if (
        typeof item !== "object" ||
        item === null ||
        item.check !== check.name ||
        !schema.safeParse({ ...item, id: "E1" }).success
      )
        throw new EvidenceRefused(`${check.name} returned malformed evidence`);
    }
    return items as EvidenceDraft[];
  } catch (error) {
    return [notChecked(check.name, error)];
  } finally {
    clearTimeout(timer);
  }
}

// A deep copy no check can change: every check reads the same case, so none may rewrite what its peers see (final
// review). Writing to it throws, in the writing check, which then reports not_checked.
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
}

// What happened to each registered check (D02 T01 §3): it ran, giving `findings` items; it ran over only part of its
// input (`partial`, `reason` what went unread); it was skipped, `reason` why it had nothing to check; or it failed,
// `reason` its error's class as its not_checked item names it (a timeout's `Timeout`).
export type CheckOutcome = {
  check: string;
  outcome: "ran" | "partial" | "skipped" | "failed";
  reason: string | null;
  findings: number;
};

// What the named check says it could not read, bounded; a predicate that throws says the check's coverage is unknown.
function partialOf(registry: CheckRegistry, name: string, view: Readonly<CaseView>): string | null {
  const check = registry.all().find((c) => c.name === name);
  try {
    return check?.partial?.(view)?.slice(0, 300) || null;
  } catch {
    return "what it read could not be told";
  }
}

export async function runChecks(input: CaseView, registry: CheckRegistry = checks): Promise<EvidenceDraft[]> {
  return (await runChecksWithOutcomes(input, registry)).items;
}

// The checks' evidence, and each registered check's outcome in registration order.
export async function runChecksWithOutcomes(
  input: CaseView,
  registry: CheckRegistry = checks,
): Promise<{ items: EvidenceDraft[]; outcomes: CheckOutcome[] }> {
  const view = frozen(structuredClone(input));
  // Each slot is one check's items, or one missing input's item at the first check it held back.
  type Skip = { missing: CheckInput; held: string[] };
  const slots: ({ name: string; items: Promise<EvidenceDraft[]> } | Skip)[] = [];
  const skips = new Map<CheckInput, Skip>();
  const outcomes = new Map<string, CheckOutcome>();
  for (const check of registry.all()) {
    const missing = [...new Set(check.needs)].filter((input) => !available(view, input));
    if (missing.length === 0) {
      // A check with nothing to check is skipped with its own reason (plan review: an inline forward's authentication
      // checks returned nothing and read as clean). A predicate that throws leaves the check to run and say so.
      let nothing: string | null = null;
      try {
        nothing = check.applies?.(view) ?? null;
      } catch {
        nothing = null;
      }
      if (nothing) {
        outcomes.set(check.name, { check: check.name, outcome: "skipped", reason: nothing.slice(0, 300), findings: 0 });
        continue;
      }
      slots.push({ name: check.name, items: runOne(check, view, registry) });
      continue;
    }
    for (const input of missing) {
      const skip = skips.get(input) ?? { missing: input, held: [] };
      if (!skips.has(input)) {
        skips.set(input, skip);
        slots.push(skip);
      }
      skip.held.push(check.name);
    }
  }
  const settled = await Promise.allSettled(slots.map((slot) => ("items" in slot ? slot.items : Promise.resolve([]))));
  const items = settled.flatMap((result, i): EvidenceDraft[] => {
    const slot = slots[i] as (typeof slots)[number];
    if ("items" in slot) {
      const items = result.status === "fulfilled" ? result.value : [notChecked(slot.name, result.reason)];
      // A check that failed gives only its own not_checked item, which names its error's class.
      const failed = items.length === 1 && items[0]?.check === "not_checked";
      const unread = failed ? null : partialOf(registry, slot.name, view);
      outcomes.set(
        slot.name,
        failed
          ? { check: slot.name, outcome: "failed", reason: String(items[0]?.detail.errorClass), findings: 0 }
          : unread
            ? { check: slot.name, outcome: "partial", reason: unread, findings: items.length }
            : { check: slot.name, outcome: "ran", reason: null, findings: items.length },
      );
      return items;
    }
    const { missing, held } = slot;
    const reason = MISSING[missing] ?? `its ${missing} were not available`;
    // A check held back by more than one missing input is named by the first.
    for (const name of held)
      if (!outcomes.has(name)) outcomes.set(name, { check: name, outcome: "skipped", reason, findings: 0 });
    return [
      {
        check: "not_checked",
        severity: "info",
        summary: `${held.length} ${held.length === 1 ? "check" : "checks"} did not run because ${reason}.`,
        detail: { missing, checks: held },
        artefacts: [],
      },
    ];
  });
  return {
    items,
    outcomes: registry
      .all()
      .map((check) => outcomes.get(check.name))
      .filter((o): o is CheckOutcome => o !== undefined),
  };
}
