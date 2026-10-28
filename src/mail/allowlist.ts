// Who IsItLegit may mail during the event (D01 T02 §2; design spec section 11 Outbound, 4.6a). sendMail asks this before
// anything else, so no caller can skip it. Recipients come from code and stored records, never from a model.
//
// A member is a user with a membership in any organisation: membership exists only through invite-code signup (D07 T02
// §4) or an accepted invitation, so it is the authorisation (a first signup's link goes before the address is verified).
// A demo alias is an address at exactly isitlegit.co.za or demo.isitlegit.co.za, which forward to the operator's
// Rizonetech mailbox. The operator is OPERATOR_EMAIL. Per kind:
//   signin                    members, pending unexpired invitees, demo aliases, the operator
//   reply, notice, renewal    members, demo aliases, the operator
//   verify                    demo aliases only (closed-loop verification goes only to the fictional demo businesses)
//   alert                     demo aliases and the operator (impersonation and counterparty alerts, the operator's
//                             unsettled-send handover), never a member's own address
//   claim                     ownership codes (D07 T02 §5): admin@ or postmaster@ a domain with a pending claim, an
//                             address with a pending claim, and nothing else (not even the demo aliases)
import type { MailKind } from "./smtp2go";

const DEMO_DOMAINS = new Set(["isitlegit.co.za", "demo.isitlegit.co.za"]);

export const isDemoAlias = (address: string) => {
  const at = address.lastIndexOf("@");
  return at > 0 && DEMO_DOMAINS.has(address.slice(at + 1).toLowerCase());
};

async function isMember(db: D1Database, address: string) {
  const row = await db
    .prepare(`SELECT 1 FROM "user" u JOIN "member" m ON m."userId" = u.id WHERE lower(u.email) = ? LIMIT 1`)
    .bind(address)
    .first();
  return row !== null;
}

async function isInvitee(db: D1Database, address: string, now: Date) {
  const row = await db
    .prepare(`SELECT 1 FROM "invitation" WHERE lower(email) = ? AND status = 'pending' AND "expiresAt" > ? LIMIT 1`)
    .bind(address, now.toISOString())
    .first();
  return row !== null;
}

// A pending ownership claim on this address: on it directly, or on its domain when it is admin@ or postmaster@.
async function isClaimRecipient(db: D1Database, address: string) {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const row = await db
    .prepare(
      "SELECT 1 FROM org_addresses WHERE address = ? AND state = 'pending' UNION ALL SELECT 1 FROM org_domains WHERE domain = ? AND state = 'pending' AND ? IN ('admin', 'postmaster') LIMIT 1",
    )
    .bind(address, domain, local)
    .first();
  return row !== null;
}

export async function isAllowedRecipient(
  db: D1Database,
  to: string,
  kind: MailKind,
  operatorEmail: string | undefined,
  now = new Date(),
): Promise<boolean> {
  const address = to.trim().toLowerCase();
  const demo = isDemoAlias(address);
  const operator = !!operatorEmail && address === operatorEmail.trim().toLowerCase();
  switch (kind) {
    case "verify":
      return demo;
    case "claim":
      return isClaimRecipient(db, address);
    case "alert":
      return demo || operator;
    case "signin":
      return demo || operator || (await isMember(db, address)) || (await isInvitee(db, address, now));
    case "reply":
    case "notice":
    case "renewal":
      return demo || operator || (await isMember(db, address));
  }
}
