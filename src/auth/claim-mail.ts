// The ownership-code mail (D07 T02 §5): mail kind `claim`, one send key per code, and its outcome in three words the
// routes answer with: sent (SMTP2GO confirmed it), unknown (it may have gone) or failed (refused or not sent).
import { sendMail } from "../mail/smtp2go";

export type MailOutcome = "sent" | "unknown" | "failed";
export const CLAIM_FROM = "IsItLegit <verify@isitlegit.co.za>";

export async function sendClaimCode(
  env: Env,
  claim: { to: string; claimId: string; codeId: string; code: string; what: string },
): Promise<MailOutcome> {
  const outcome = await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    {
      sendKey: `claim:${claim.claimId}:${claim.codeId}`,
      kind: "claim",
      to: claim.to,
      from: CLAIM_FROM,
      subject: "Your IsItLegit verification code",
      text: `Someone at an organisation on IsItLegit is proving it controls ${claim.what}. If that is you or your team, enter this code within 30 minutes:\n\n${claim.code}\n\nIf you did not expect this, ignore it: nothing changes without the code.`,
    },
  ).catch(() => null);
  if (!outcome) return "failed";
  if (outcome.status === "sent" || (outcome.status === "duplicate" && outcome.previous === "sent")) return "sent";
  if (outcome.status === "uncertain" || (outcome.status === "duplicate" && outcome.previous === "uncertain"))
    return "unknown";
  return "failed";
}
