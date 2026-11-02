// Which organisation a sender belongs to (D07 T02 §5; spec 4.1): the lookup the email handler gates on and the mail
// allowlist admits replies by. Kept apart from the claim routes so the allowlist can read it without importing them.
import { getDomain, parse } from "tldts";

// A host name as typed: ASCII letters, digits and hyphens in dot-separated labels of 1 to 63 (an internationalised
// name in its xn-- form), nothing else; so a URL, an address or a path is refused rather than read for a domain in it.
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// IsItLegit's own domain, which no organisation can claim, and the private suffix under it where each demo
// organisation has a domain of its own (`fynbosfreight.demo.isitlegit.co.za`), as the public suffix list's private
// section has hosting platforms: without it every demo domain reduced to `isitlegit.co.za` (the trust lane, 2026-10-31).
export const OWN_DOMAIN = "isitlegit.co.za";
export const DEMO_SUFFIX = `demo.${OWN_DOMAIN}`;
// A claim any reader may act on: never one on IsItLegit's own domain, which the claim route refuses and which a row
// stored before that refusal (none in production on 2026-10-31) must never turn into membership, an identity or a
// verified domain, in any environment (D07 T02 §20). For a reader's WHERE clause over org_domains, aliased or not.
export const claimable = (column = "domain") => `${column} <> '${OWN_DOMAIN}'`;

// A domain's registrable form (`mail.example.co.za` is `example.co.za`; `mail.x.demo.isitlegit.co.za` is
// `x.demo.isitlegit.co.za`), or null for an IP address, a public suffix (`demo.isitlegit.co.za` among them) or anything
// that is not a host name.
export function registrable(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST.test(host) || parse(host).isIp) return null;
  if (host === DEMO_SUFFIX) return null;
  if (host.endsWith(`.${DEMO_SUFFIX}`)) {
    const labels = host.slice(0, -DEMO_SUFFIX.length - 1).split(".");
    return `${labels[labels.length - 1]}.${DEMO_SUFFIX}`;
  }
  return getDomain(host, { allowPrivateDomains: false }) ?? null;
}

// The organisation a sender belongs to, and by what: the address itself verified on its own (the more specific claim
// wins), else its verified registrable domain, which admits every mailbox at it. An address whose organisation also
// verified its domain counts as the domain's, which asks only domain-level authentication of the mail
// (src/intake/sender.ts). Null for anything else.
export async function memberOfSender(
  db: D1Database,
  sender: string,
): Promise<{ orgId: string; by: "domain" | "address" } | null> {
  const address = sender.trim().toLowerCase();
  // An address: one @, something on each side.
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@") || at === address.length - 1) return null;
  const domain = registrable(address.slice(at + 1));
  const [byAddress, byDomain] = await Promise.all([
    db
      .prepare("SELECT org_id FROM org_addresses WHERE address = ? AND state = 'verified'")
      .bind(address)
      .first<{ org_id: string }>(),
    domain
      ? db
          .prepare(`SELECT org_id FROM org_domains WHERE domain = ? AND state = 'verified' AND ${claimable()}`)
          .bind(domain)
          .first<{ org_id: string }>()
      : null,
  ]);
  const found = byAddress
    ? {
        orgId: byAddress.org_id,
        by: byDomain?.org_id === byAddress.org_id ? ("domain" as const) : ("address" as const),
      }
    : byDomain
      ? { orgId: byDomain.org_id, by: "domain" as const }
      : null;
  if (!found) return null;
  // A closed organisation's senders are no members (D07 T02 §9), at the one resolution intake and the allowlist share.
  const closed = await db
    .prepare(`SELECT "closedAt" AS closedAt FROM "organization" WHERE id = ?`)
    .bind(found.orgId)
    .first<{ closedAt: string | null }>();
  return closed?.closedAt ? null : found;
}

// The organisation alone, for the allowlist and the claim routes. A closed organisation's senders resolve to no
// member (D07 T02 §9): forwarded mail for it takes the ordinary not-a-member answer, never a new case.
export const findMemberBySender = async (db: D1Database, sender: string) => {
  const orgId = (await memberOfSender(db, sender))?.orgId ?? null;
  if (!orgId) return null;
  const closed = await db
    .prepare(`SELECT "closedAt" AS closedAt FROM "organization" WHERE id = ?`)
    .bind(orgId)
    .first<{ closedAt: string | null }>();
  return closed?.closedAt ? null : orgId;
};

// What an organisation accepts mail from, for the Cases list's first-run line (D07 T04 §1): its verified domains and
// its verified addresses, each sorted.
export async function verifiedSenders(
  db: D1Database,
  orgId: string,
): Promise<{ domains: string[]; addresses: string[] }> {
  const [domains, addresses] = await db.batch<{ value: string }>([
    db
      .prepare(
        `SELECT domain AS value FROM org_domains WHERE org_id = ? AND state = 'verified' AND ${claimable()} ORDER BY domain`,
      )
      .bind(orgId),
    db
      .prepare("SELECT address AS value FROM org_addresses WHERE org_id = ? AND state = 'verified' ORDER BY address")
      .bind(orgId),
  ]);
  return {
    domains: (domains?.results ?? []).map((r) => r.value),
    addresses: (addresses?.results ?? []).map((r) => r.value),
  };
}
