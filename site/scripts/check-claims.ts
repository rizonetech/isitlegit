// The claims gate (D07 T06 §6; §3's promise): the deploy refuses while any claim's owner section is not stamped, naming
// each claim and owner. It reads the owners' state from the generated plan. The result is the owners' status, never
// proof that the live service backs a claim (§20 reads that back after the deploy).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Registry = Record<string, { text: string; owners?: readonly string[] }>;
export type OwnerState = "stamped" | "open" | "missing";
export type ClaimRow = { id: string; owners: { ref: string; state: OwnerState }[] };

export function checkClaims(registry: Registry, stateOf: (ref: string) => OwnerState) {
  const cache = new Map<string, OwnerState>();
  const state = (ref: string) => {
    if (!cache.has(ref)) cache.set(ref, stateOf(ref));
    return cache.get(ref) as OwnerState;
  };
  const rows: ClaimRow[] = Object.entries(registry).map(([id, claim]) => ({
    id,
    owners: (claim.owners ?? []).map((ref) => ({ ref, state: state(ref) })),
  }));
  const problems = rows.flatMap((row) =>
    row.owners.filter((o) => o.state !== "stamped").map((o) => `${row.id}: ${o.ref} is ${o.state === "open" ? "not stamped" : "not a section of the plan"}`),
  );
  return { rows, problems };
}

// The owners' state from the generated plan (`todo/implementation-plan.md`, kept current by `todo-graph.py plan --check`
// in the pre-commit hook and CI): `[x]` is a stamped section, `[ ]` an open one, no row a section that does not exist.
// One file read, where `todo-graph.py resolve` per owner would load the whole graph for each of them.
export function planState(planText: string): (ref: string) => OwnerState {
  const states = new Map<string, OwnerState>();
  for (const m of planText.matchAll(/^\|\s*\[( |x)\]\s*\|\s*(D\d+ T\d+ §\d+)\s*\|/gm))
    states.set(m[2] as string, m[1] === "x" ? "stamped" : "open");
  return (ref) => states.get(ref) ?? "missing";
}

if (import.meta.filename === process.argv[1]) {
  const root = join(import.meta.dirname, "../..");
  // --plan and --claims point the gate at another plan or registry (the deploy test's fixture); the defaults are real.
  // --proven-only is the interim deploy mode (D07 T06 §20): list every omitted claim by id, never silently, exit 0.
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { plan: { type: "string" }, claims: { type: "string" }, "proven-only": { type: "boolean" } },
  });
  const { claims } = await import(values.claims ?? "../src/lib/claims.ts");
  const plan = readFileSync(values.plan ?? join(root, "todo/implementation-plan.md"), "utf8");
  const { rows, problems } = checkClaims(claims as Registry, planState(plan));
  for (const row of rows) console.log(`${row.id}: ${row.owners.map((o) => `${o.ref} ${o.state}`).join(", ") || "no owner"}`);
  const omitted = rows.filter((row) => row.owners.some((o) => o.state !== "stamped")).map((row) => row.id);
  if (values["proven-only"]) {
    for (const id of omitted) console.log(`proven-only: omitting ${id}`);
    console.log(`proven-only: ${rows.length - omitted.length} proven, ${omitted.length} omitted of ${rows.length} claims`);
    process.exit(0);
  }
  if (problems.length) {
    console.error(`check-claims: refusing, ${problems.length} claim owner(s) not stamped:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log(`check-claims: ${rows.length} claims, every owner stamped`);
}
