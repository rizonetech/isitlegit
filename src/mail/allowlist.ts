// Who IsItLegit may mail during the event (D01 T02 §2; design spec section 11 Outbound, 4.6a). sendMail asks this before
// anything else, so no caller can skip it. Recipients come from code and stored records, never from a model.
//
// A member is a user with a membership in any organisation: membership exists only through invite-code signup (D07 T02
// §4) or an accepted invitation, so it is the authorisation (a first signup's link goes before the address is verified).
// A demo alias is an address at exactly isitlegit.co.za or demo.isitlegit.co.za, which forward to the operator's
// Rizonetech mailbox. The operator is OPERATOR_EMAIL. Per kind:
//   signin                    members, pending unexpired invitees, demo aliases, the operator
//   reply, notice             members, any address findMemberBySender resolves (a verified address, or any address at
//                             a verified domain: the forwarders intake admits, D01 T01 §3), demo aliases, the operator;
//                             and a reply names its case: a counterparty case's own forwarder is admitted for that
//                             case's one reply only, under its key `reply:<case id>` (D05 T02 §1), never for a
//                             notice, another key or another case's mail
//   renewal                   members, demo aliases, the operator
//   verify                    demo aliases only (closed-loop verification goes only to the fictional demo businesses)
//   alert                     demo aliases and the operator (impersonation and counterparty alerts, the operator's
//                             unsettled-send handover), never a member's own address
//   claim                     ownership codes (D07 T02 §5): admin@ or postmaster@ a domain with a pending claim, an
//                             address with a pending claim, and nothing else (not even the demo aliases)
import { findMemberBySender } from "../auth/senders";
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

// The forwarder of this counterparty case (D05 T02 §1): a non-member who is answered once, for the case they sent,
// under that reply's own key (the reply step's `reply:<case id>` for a case's first run). A retry of that reply reuses
// the key, so it is admitted again; any other mail to them, this case's under another key included, is not.
export const counterpartyReplyKey = (caseId: string) => `reply:${caseId}`;
async function isCounterpartyForwarder(db: D1Database, caseId: string, address: string, grouped = false) {
  const row = await db
    .prepare(
      grouped
        ? "SELECT 1 FROM cases WHERE id = ? AND origin = 'counterparty' AND forwarded_by = ? AND EXISTS (SELECT 1 FROM case_children WHERE parent_case_id = cases.id) LIMIT 1"
        : "SELECT 1 FROM cases WHERE id = ? AND origin = 'counterparty' AND forwarded_by = ? LIMIT 1",
    )
    .bind(caseId, address)
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
  operatorEmail: string | readonly string[] | undefined,
  now = new Date(),
  send?: { caseId?: string | undefined; sendKey?: string | undefined },
): Promise<boolean> {
  const address = to.trim().toLowerCase();
  const demo = isDemoAlias(address);
  // The operator's mailboxes: OPERATOR_EMAIL, and for forwarding-failure alerts its fallback (D01 T02 §6).
  const operators = (typeof operatorEmail === "string" ? [operatorEmail] : (operatorEmail ?? [])).map((o) =>
    o.trim().toLowerCase(),
  );
  const operator = operators.some((o) => o !== "" && address === o);
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
      if (
        send?.caseId &&
        (send.sendKey === counterpartyReplyKey(send.caseId) || send.sendKey === `reply:group:${send.caseId}`) &&
        (await isCounterpartyForwarder(db, send.caseId, address, send.sendKey === `reply:group:${send.caseId}`))
      )
        return true;
      return demo || operator || (await isMember(db, address)) || (await findMemberBySender(db, address)) !== null;
    case "notice":
      return demo || operator || (await isMember(db, address)) || (await findMemberBySender(db, address)) !== null;
    case "renewal":
      return demo || operator || (await isMember(db, address));
  }
}
