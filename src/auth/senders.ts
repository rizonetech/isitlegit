// Which organisation a sender belongs to (D07 T02 §5; spec 4.1): the lookup the email handler gates on and the mail
// allowlist admits replies by. Kept apart from the claim routes so the allowlist can read it without importing them.
import { getDomain, parse } from "tldts";

// A host name as typed: ASCII letters, digits and hyphens in dot-separated labels of 1 to 63 (an internationalised
// name in its xn-- form), nothing else; so a URL, an address or a path is refused rather than read for a domain in it.
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

// A domain's registrable form (`mail.example.co.za` is `example.co.za`), or null for an IP address, a public suffix
// or anything that is not a host name.
export function registrable(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (!HOST.test(host) || parse(host).isIp) return null;
  return getDomain(host, { allowPrivateDomains: false }) ?? null;
}

// The organisation a sender belongs to, for the email handler: a verified address, else the verified registrable
// domain of the address, else null.
export async function findMemberBySender(db: D1Database, sender: string): Promise<string | null> {
  const address = sender.trim().toLowerCase();
  // An address: one @, something on each side.
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@") || at === address.length - 1) return null;
  const byAddress = await db
    .prepare("SELECT org_id FROM org_addresses WHERE address = ? AND state = 'verified'")
    .bind(address)
    .first<{ org_id: string }>();
  if (byAddress) return byAddress.org_id;
  const domain = registrable(address.slice(address.lastIndexOf("@") + 1));
  if (!domain) return null;
  const byDomain = await db
    .prepare("SELECT org_id FROM org_domains WHERE domain = ? AND state = 'verified'")
    .bind(domain)
    .first<{ org_id: string }>();
  return byDomain?.org_id ?? null;
}
