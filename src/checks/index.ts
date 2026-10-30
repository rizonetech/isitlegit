// Every check the pipeline runs, registered into the one registry in the order their evidence appears: the intake items
// first, so `E1` says how the case arrived (D02 T01 §1). Each later check section registers here, after them.
import { registerArcCheck } from "./arc";
import { registerAuthChecks } from "./auth";
import { registerAuthResultsCheck } from "./auth-results";
import { registerIntakeChecks } from "./intake";
import { checks } from "./registry";

registerIntakeChecks(checks);
registerAuthResultsCheck(checks);
registerAuthChecks(checks);
registerArcCheck(checks);

export { allChecks, checks } from "./registry";
