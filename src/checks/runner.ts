// The check runner (D02 T01 §2; spec 4.3a "an outage leaves a not-checked line, never a guess"): every registered check
// whose inputs are available runs at once, each within its own budget, and its evidence takes its place in registration
// order. A check that throws, rejects, runs out of time or returns evidence the schema refuses becomes one `not_checked`
// item naming it and its error class, never its message (which can carry hostile text); the others still store. A check
// whose inputs are not available never runs: each missing input gives one `not_checked` item naming the checks it held
// back and why.
import type { CaseView } from "./case-view";
import { type EvidenceDraft, EvidenceRefused, evidenceIn } from "./evidence";
import { checks } from "./index";
import type { Check, CheckInput, CheckRegistry } from "./registry";

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

async function runOne(check: Check, view: CaseView, registry: CheckRegistry): Promise<EvidenceDraft[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Timeout()), check.timeoutMs);
  });
  try {
    // A check that throws before its first await is caught here like one that rejects.
    const items = await Promise.race([Promise.resolve().then(() => check.run(view)), deadline]);
    const schema = evidenceIn(registry);
    for (const item of items) {
      // Each item is the check's own, under its own name, in the shape the store takes.
      if (item.check !== check.name || !schema.safeParse({ ...item, id: "E1" }).success)
        throw new EvidenceRefused(`${check.name} returned malformed evidence`);
    }
    return items;
  } catch (error) {
    return [notChecked(check.name, error)];
  } finally {
    clearTimeout(timer);
  }
}

export async function runChecks(view: CaseView, registry: CheckRegistry = checks): Promise<EvidenceDraft[]> {
  // Each slot is one check's items, or one missing input's item at the first check it held back.
  type Skip = { missing: CheckInput; held: string[] };
  const slots: ({ name: string; items: Promise<EvidenceDraft[]> } | Skip)[] = [];
  const skips = new Map<CheckInput, Skip>();
  for (const check of registry.all()) {
    const missing = [...new Set(check.needs)].filter((input) => !available(view, input));
    if (missing.length === 0) {
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
  return settled.flatMap((result, i): EvidenceDraft[] => {
    const slot = slots[i] as (typeof slots)[number];
    if ("items" in slot) return result.status === "fulfilled" ? result.value : [notChecked(slot.name, result.reason)];
    const { missing, held } = slot;
    const reason = MISSING[missing] ?? `its ${missing} were not available`;
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
}
