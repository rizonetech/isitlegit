// Consumer mailbox providers (D06 T01 §4, correction 10): domains anyone can open a mailbox at, so an address there
// says nothing about which business it belongs to, and a supplier recorded with one would match every stranger's
// mail. The list is the major global providers and the South African ISPs' own mailbox domains; a hosted service that
// sends for its customers (an e-signature or accounting service) is not a mailbox and is not listed. Matched on the
// registrable domain, so a provider's regional or mail hosts count and a lookalike that only starts with one does not.
export const CONSUMER_MAILBOXES: ReadonlySet<string> = new Set([
  // Global providers.
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.za",
  "live.com",
  "live.co.za",
  "msn.com",
  "yahoo.com",
  "yahoo.co.za",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
  "tutanota.com",
  "fastmail.com",
  // South African ISP and portal mailboxes.
  "mweb.co.za",
  "telkomsa.net",
  "vodamail.co.za",
  "webmail.co.za",
  "iafrica.com",
  "absamail.co.za",
  "lantic.net",
  "polka.co.za",
  "cybersmart.co.za",
  "afrihost.co.za",
  "axxess.co.za",
  "imaginet.co.za",
  "worldonline.co.za",
  "telkomsa.co.za",
]);

// Whether `domain` (any case, a trailing dot allowed) is one of the providers or a host under one.
export function isConsumerMailbox(domain: string): boolean {
  const host = domain.trim().toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) if (CONSUMER_MAILBOXES.has(labels.slice(i).join("."))) return true;
  return false;
}
