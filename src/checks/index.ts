// Every check the pipeline runs, registered into the one registry in the order their evidence appears: the intake items
// first, so `E1` says how the case arrived (D02 T01 §1). Each later check section registers here, after them.
import { registerArcCheck } from "./arc";
import { registerTypeMismatchCheck } from "./attachment-type";
import { registerAuthChecks } from "./auth";
import { registerAuthResultsCheck } from "./auth-results";
import { registerDomainAgeCheck } from "./domain-age";
import { registerLookalikeCheck } from "./domain-lookalike";
import { registerIntakeChecks } from "./intake";
import { checks } from "./registry";
import { registerSenderChecks } from "./sender";

registerIntakeChecks(checks);
registerAuthResultsCheck(checks);
registerAuthChecks(checks);
registerArcCheck(checks);
registerSenderChecks(checks);
registerLookalikeCheck(checks);
registerDomainAgeCheck(checks);
registerTypeMismatchCheck(checks);

export { allChecks, checks } from "./registry";
