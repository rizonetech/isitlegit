// The ownership-code mail (D07 T02 §5): mail kind `claim`, one send key per code, and its outcome in three words the
// routes answer with: sent (SMTP2GO confirmed it), unknown (it may have gone) or failed (refused or not sent).
import { sendMail } from "../mail/smtp2go";
import { claimCodeEmail } from "../mail/templates/auth-mail";

export type MailOutcome = "sent" | "unknown" | "failed";
export const CLAIM_FROM = "IsItLegit <verify@isitlegit.co.za>";

export async function sendClaimCode(
  env: Env,
  claim: {
    to: string;
    claimId: string;
    codeId: string;
    code: string;
    what: string;
    // A domain (mailed to admin@ or postmaster@ it) or one address; the code's life from its owner (domains.ts).
    kind: "domain" | "address";
    lifetimeMs: number;
    // The deadline stored with the code when it was issued.
    expiresAt: Date;
  },
): Promise<MailOutcome> {
  const outcome = await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    {
      sendKey: `claim:${claim.claimId}:${claim.codeId}`,
      kind: "claim",
      to: claim.to,
      from: CLAIM_FROM,
      subject: "Your IsItLegit verification code",
      ...claimCodeEmail({
        appUrl: env.APP_URL,
        kind: claim.kind,
        what: claim.what,
        code: claim.code,
        lifetimeSeconds: claim.lifetimeMs / 1000,
        expiresAt: claim.expiresAt,
      }),
    },
  ).catch(() => null);
  if (!outcome) return "failed";
  if (outcome.status === "sent" || (outcome.status === "duplicate" && outcome.previous === "sent")) return "sent";
  if (outcome.status === "uncertain" || (outcome.status === "duplicate" && outcome.previous === "uncertain"))
    return "unknown";
  return "failed";
}
