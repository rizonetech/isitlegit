// The tests' view of which claims are proven at this commit (D07 T06 §20): expectations derive from the generated
// plan, so an owner stamp flips the proven set with no test edits and the claims return automatically on the next build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planState } from "../../scripts/check-claims.ts";
import { claims, type ClaimId } from "../../src/lib/claims.ts";
import { isProven } from "../../src/lib/proven.ts";

const plan = readFileSync(join(import.meta.dirname, "../../../todo/implementation-plan.md"), "utf8");
export const stateOf = planState(plan);

// A registry id is proven when every owner section is stamped.
export const proven = (id: ClaimId): boolean => isProven(claims[id].owners, stateOf);

// The proven members of a claim list, in order.
export const provenIds = (ids: readonly ClaimId[]): ClaimId[] => ids.filter(proven);
