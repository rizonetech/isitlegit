// Every check the pipeline runs, registered into the one registry in the order their evidence appears: the intake items
// first, so `E1` says how the case arrived (D02 T01 §1). Each later check section registers here, after them.

import { registerAiInstructionCheck } from "./ai-instructions";
import { registerArcCheck } from "./arc";
import { registerAttachmentRiskChecks } from "./attachment-risk";
import { registerTypeMismatchCheck } from "./attachment-type";
import { registerAuthChecks } from "./auth";
import { registerAuthResultsCheck } from "./auth-results";
import { registerDomainAgeCheck } from "./domain-age";
import { registerLookalikeCheck } from "./domain-lookalike";
import { registerHiddenTextCheck } from "./hidden-content";
import { registerHtmlAttachmentCheck } from "./html-attachment";
import { registerIntakeChecks } from "./intake";
import { registerLandingChecks, registerLinkExpansionChecks, registerLinkMismatchCheck } from "./links";
import { checks } from "./registry";
import { registerSenderChecks } from "./sender";
import { registerVoiceChecks } from "./voice";

registerIntakeChecks(checks);
registerAuthResultsCheck(checks);
registerAuthChecks(checks);
registerArcCheck(checks);
registerSenderChecks(checks);
registerLookalikeCheck(checks);
registerDomainAgeCheck(checks);
registerTypeMismatchCheck(checks);
registerHiddenTextCheck(checks);
registerHtmlAttachmentCheck(checks);
registerAttachmentRiskChecks(checks);
registerAiInstructionCheck(checks);
registerLinkMismatchCheck(checks);
registerLinkExpansionChecks(checks);
registerLandingChecks(checks);
registerVoiceChecks(checks);

export { allChecks, checks } from "./registry";
