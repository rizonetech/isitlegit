// Owner-stamp state for proven-only rendering (D07 T06 §20): a claim renders only when every owner section is
// stamped in the generated plan at build time. `Claim.astro` renders nothing for a blocked claim, and pages filter
// claim-driven lists through `isProven`. When an owner stamps, its claims return on the next build with no code change.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type OwnerState, planState } from "../../scripts/check-claims.ts";

let cached: ((ref: string) => OwnerState) | undefined;

// The generated plan, found by walking up from the working directory (the Astro build bundles components, so a path
// relative to this file would land in the bundle output, not the repository).
function planFile(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "todo", "implementation-plan.md");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`proven: no todo/implementation-plan.md above ${process.cwd()}`);
}

// The owner-stamp function for this build, read once from the generated plan (a test passes its own plan text).
export function ownerState(planText?: string): (ref: string) => OwnerState {
  if (!cached || planText !== undefined) cached = planState(planText ?? readFileSync(planFile(), "utf8"));
  return cached;
}

// A registry entry is proven when every owner section is stamped (an entry with no owners is always proven).
export function isProven(owners: readonly string[] | undefined, state: (ref: string) => OwnerState = ownerState()): boolean {
  return (owners ?? []).every((ref) => state(ref) === "stamped");
}
