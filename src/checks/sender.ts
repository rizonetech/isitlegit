// Display name, Reply-To and Return-Path checks (D02 T02 §4; spec 4.3, Sender). Business email compromise keeps a
// real-looking display name over a different address, or sends the replies elsewhere. Each check reads the original's
// headers only, says nothing when they did not come (`auth.results` says why), and carries the header it rests on and
// the raw message key, its detail fitted to the store.
import { addressParser } from "postal-mime";
import { ATOM, asciiDomain, bounded, fittedDetail, fromDomain, LOCAL, plain } from "./auth";
import { registrable } from "./brand-schema";
import { brandForMailbox } from "./brands";
import type { CaseView } from "./case-view";
import type { EvidenceDraft } from "./evidence";
import type { CheckRegistry } from "./registry";

type Header = { name: string; value: string };
const named = (headers: readonly Header[], name: string) => headers.filter((h) => h.name.trim().toLowerCase() === name);

// A mailbox as compared: a local part valid by RFC 5322 (dot-separated atoms, or a quoted string, section 3.2.4),
// case-folded, a quoted one that needs no quotes read as its plain form (`"accounts"` is `accounts`), and the domain in
// its A-label form; null when either part is not valid (completion review: `"pay@desk"@x` is valid, `a..b@x` is not).
const DOT_ATOM = new RegExp(`^${ATOM}(?:\\.${ATOM})*$`, "u");
export function mailbox(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  const domain = asciiDomain(address.slice(at + 1));
  const raw = address.slice(0, at);
  if (!domain || !LOCAL.test(raw)) return null;
  let local = raw;
  if (raw.startsWith('"')) {
    const inner = raw.slice(1, -1).replace(/\\(.)/g, "$1");
    local = DOT_ATOM.test(inner) ? inner : `"${inner}"`;
  }
  return `${local.toLowerCase()}@${domain}`;
}
const siteOf = (domain: string | null) => {
  const ascii = domain === null ? null : asciiDomain(domain);
  return ascii === null ? null : registrable(ascii);
};

function item(
  view: CaseView,
  check: string,
  severity: EvidenceDraft["severity"],
  summary: string,
  detail: Record<string, unknown>,
  cited: Header | Header[],
): EvidenceDraft {
  const headers = (Array.isArray(cited) ? cited : [cited]).map((h) => `${h.name}: ${h.value}`);
  return {
    check,
    severity,
    summary: bounded(summary),
    detail: fittedDetail({ ...detail, headers }) as EvidenceDraft["detail"],
    artefacts: [view.raw],
  };
}

// The original's single From header and its one mailbox, or null.
function fromOf(view: CaseView): { header: Header; name: string; address: string } | null {
  const from = named(view.headers, "from");
  if (from.length !== 1 || !from[0]) return null;
  const parsed = addressParser(from[0].value, { flatten: true }).filter((a) => a.address);
  if (parsed.length !== 1) return null;
  return { header: from[0], name: parsed[0]?.name ?? "", address: (parsed[0]?.address ?? "").toLowerCase() };
}

// What a display name shows, found in one linear pass (round 1): each `@` grown outward over the characters a mailbox
// may hold (RFC 5322 section 3.2.3's atext and dots to its left, apostrophes included; a domain's letters, digits,
// dots and hyphens to its right), stopping at anything else, so `Email:debtors@x` shows `debtors@x`; and each run of
// domain characters elsewhere read as a domain when it is dot-separated labels ending in a top-level domain (letters, or
// an A-label such as `xn--p1ai`). No pattern ever rescans: a run is bounded by MAX_WORD, past which it is skipped.
const MAX_WORD = 320;
const LOCAL_CHAR = /[\p{L}\p{N}\p{M}!#$%&'*+/=?^_`{|}~.-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}\p{M}.-]/u;
const SHOWN_DOMAIN = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:\p{L}{2,}|xn--[a-z0-9-]+)$/iu;
const trimDots = (text: string) => text.replace(/^[.-]+/u, "").replace(/[.-]+$/u, "");
function shownIn(name: string): { addresses: string[]; domains: string[] } {
  const chars = Array.from(name);
  const addresses: string[] = [];
  const inAddress = new Array<boolean>(chars.length).fill(false);
  for (let at = 0; at < chars.length; at++) {
    if (chars[at] !== "@") continue;
    let start = at;
    if (chars[at - 1] === '"') {
      // A quoted local part (`"debtors"@x`, round 2): back to its opening quote, an escaped quote skipped, bounded.
      let open = at - 2;
      while (open >= 0 && at - open < MAX_WORD && !(chars[open] === '"' && chars[open - 1] !== "\\")) open--;
      if (open >= 0 && chars[open] === '"') start = open;
    } else while (start > 0 && at - start < MAX_WORD && LOCAL_CHAR.test(chars[start - 1] as string)) start--;
    let end = at + 1;
    while (end < chars.length && end - at < MAX_WORD && DOMAIN_CHAR.test(chars[end] as string)) end++;
    const local = chars[start] === '"' ? chars.slice(start, at).join("") : trimDots(chars.slice(start, at).join(""));
    const domain = trimDots(chars.slice(at + 1, end).join(""));
    const found = local && domain ? `${local}@${domain}` : "";
    // Only a mailbox that reads is taken out of the domain scan: otherwise the domain is still read on its own.
    if (!found || !mailbox(found)) continue;
    addresses.push(found);
    for (let i = start; i < end; i++) inAddress[i] = true;
  }
  const domains: string[] = [];
  let run: string[] = [];
  const flush = () => {
    const word = trimDots(run.join(""));
    if (word && run.length <= MAX_WORD && SHOWN_DOMAIN.test(word)) domains.push(word);
    run = [];
  };
  for (const [i, c] of chars.entries()) {
    if (!inAddress[i] && DOMAIN_CHAR.test(c)) run.push(c);
    else flush();
  }
  flush();
  return { addresses, domains };
}

export function displayAddressEvidence(view: CaseView): EvidenceDraft[] {
  if (!view.tenant.headersAvailable) return [];
  const from = fromOf(view);
  if (!from?.name) return [];
  const actual = mailbox(from.address);
  const actualSite = siteOf(fromDomain(view.headers));
  if (!actual || !actualSite) return [];
  const { addresses, domains } = shownIn(from.name);
  // A shown mailbox is compared whole (a different person at the same domain is a different sender); a shown domain
  // by its registrable domain.
  const otherMailbox = addresses.find((a) => mailbox(a) !== actual);
  const otherDomain = domains.find((d) => {
    const site = siteOf(d);
    return site !== null && site !== actualSite;
  });
  const shown = otherMailbox ?? otherDomain;
  if (!shown) return [];
  return [
    item(
      view,
      "sender.display_address",
      "medium",
      `The sender's name shows ${plain(shown, 70)}, but the email came from ${plain(from.address, 70)}.`,
      { shown, from: from.address },
      from.header,
    ),
  ];
}

// A brand is named when one of its display names appears as whole words, compared case-folded after NFKC.
const fold = (text: string) => text.normalize("NFKC").toLowerCase();
function names(text: string, phrase: string): boolean {
  const words = fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const wanted = fold(phrase)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!wanted.length) return false;
  return words.some((_, i) => wanted.every((w, j) => words[i + j] === w));
}

export function displayBrandEvidence(view: CaseView): EvidenceDraft[] {
  if (!view.tenant.headersAvailable) return [];
  const from = fromOf(view);
  if (!from?.name) return [];
  const domain = fromDomain(view.headers);
  const brand = view.brands.brands.find((b) => [b.name, ...b.display_names].some((n) => names(from.name, n)));
  if (!brand) return [];
  const ascii = domain === null ? null : asciiDomain(domain);
  // Official: one of the brand's registrable domains or under it; a `user_content` host (a consumer mailbox it runs) is
  // its platform, never the brand.
  const at = ascii === null ? null : brandForMailbox(view.brands, ascii);
  if (at?.brand.name === brand.name && at.official) return [];
  return [
    item(
      view,
      "sender.display_brand",
      "medium",
      `The sender's name says ${plain(brand.name, 40)}, but ${plain(domain ?? from.address, 70)} is not one of ${plain(brand.name, 40)}'s domains.`,
      { brand: brand.name, from: from.address, domain },
      from.header,
    ),
  ];
}

// Every Reply-To destination, groups included, so a same-domain first address cannot hide an external second one; a
// comparison that cannot be made (no valid From, a destination that cannot be read) says so.
export function replyToEvidence(view: CaseView): EvidenceDraft[] {
  if (!view.tenant.headersAvailable) return [];
  const headers = named(view.headers, "reply-to");
  const header = headers[0];
  if (!header) return [];
  const fromSite = siteOf(fromDomain(view.headers));
  // Each destination with the field it is in, so a finding cites the field that holds it (completion review).
  const found = headers.flatMap((h) =>
    addressParser(h.value, { flatten: true }).map((a) => ({ address: a.address ?? "", header: h })),
  );
  const destinations = found.map((f) => f.address);
  const unreadable = !destinations.length || destinations.some((d) => mailbox(d) === null);
  if (fromSite === null || unreadable)
    return [
      item(
        view,
        "sender.reply_to",
        "info",
        "Where replies go could not be compared with the sender's domain.",
        { destinations, from: fromSite },
        header,
      ),
    ];
  const outside = found.filter((f) => siteOf(f.address.slice(f.address.lastIndexOf("@") + 1)) !== fromSite);
  const elsewhere = outside.map((f) => f.address);
  if (!elsewhere.length) return [];
  return [
    item(
      view,
      "sender.reply_to",
      "medium",
      `Replies go to ${plain(elsewhere.join(", "), 80)}, not to the sender's own domain ${plain(fromSite, 50)}.`,
      { destinations, elsewhere, from: fromSite },
      [...new Set(outside.map((f) => f.header))],
    ),
  ];
}

// Mail services whose bounce addresses carry their own domain for everyone they send for (their registrable domains).
export const MAIL_SERVICES = [
  "smtp2go.com",
  "smtpcorp.com",
  "outlook.com",
  "microsoft.com",
  "google.com",
  "googlemail.com",
  "mcsv.net",
  "mailchimpapp.net",
  "mandrillapp.com",
] as const;

// The topmost Return-Path, which the receiving system writes at final delivery: absent or `<>` (a valid empty bounce
// path) says nothing; one that cannot be read says so; one in another registrable domain is low, unless it is a known
// mail service's own.
export function returnPathEvidence(view: CaseView): EvidenceDraft[] {
  if (!view.tenant.headersAvailable) return [];
  const header = named(view.headers, "return-path")[0];
  if (!header) return [];
  const path = header.value
    .trim()
    .replace(/^<\s*|\s*>$/g, "")
    .trim();
  if (!path) return [];
  const fromSite = siteOf(fromDomain(view.headers));
  const box = mailbox(path);
  if (!box || fromSite === null)
    return [
      item(
        view,
        "sender.return_path",
        "info",
        "The bounce address could not be compared with the sender's domain.",
        { path, from: fromSite },
        header,
      ),
    ];
  const site = siteOf(box.slice(box.lastIndexOf("@") + 1));
  if (site === fromSite || (site !== null && (MAIL_SERVICES as readonly string[]).includes(site))) return [];
  return [
    item(
      view,
      "sender.return_path",
      "low",
      `Bounces go to ${plain(site ?? path, 60)}, not to the sender's own domain ${plain(fromSite, 50)}.`,
      { path, site, from: fromSite },
      header,
    ),
  ];
}

// A sender the organisation's earlier IsItLegit checks never had (D02 T02 §5): weak, said as what IsItLegit can know,
// since mail the organisation received without checking it is not seen here.
export function firstTimeEvidence(view: CaseView): EvidenceDraft[] {
  if (!view.tenant.headersAvailable || view.senderHistory !== "first") return [];
  const from = fromOf(view);
  if (!from) return [];
  return [
    item(
      view,
      "sender.first_time",
      "low",
      `${plain(from.address, 80)} has not appeared in your organisation's earlier IsItLegit checks. Mail you received without checking it is not counted.`,
      { history: "first", from: from.address },
      from.header,
    ),
  ];
}

export function registerSenderChecks(registry: CheckRegistry): void {
  // Without the original's headers each returns nothing: skipped, never clean (D02 T01 §3).
  const applies = (view: Readonly<CaseView>) =>
    view.tenant.headersAvailable ? null : "the original's headers were not available";
  registry.register({
    name: "sender.display_address",
    needs: [],
    timeoutMs: 1_000,
    run: displayAddressEvidence,
    examined: (view) => {
      const from = fromOf(view);
      return from ? [from.address] : [];
    },
    applies,
    summary: (_, items) => (items.length ? "its name shows another address" : "its name shows no other address"),
  });
  registry.register({
    name: "sender.display_brand",
    needs: [],
    timeoutMs: 1_000,
    run: displayBrandEvidence,
    examined: (view) => {
      const domain = fromDomain(view.headers);
      return domain ? [domain] : [];
    },
    applies,
    summary: (_, items) =>
      items.length ? "its name names a brand its address does not" : "its name names no other brand",
  });
  registry.register({
    name: "sender.reply_to",
    needs: [],
    timeoutMs: 1_000,
    run: replyToEvidence,
    examined: (view) => named(view.headers, "reply-to").map((h) => h.value),
    applies,
    summary: (view, items) =>
      !named(view.headers, "reply-to").length
        ? "replies go to the sender"
        : !items.length
          ? "replies go to the sender's domain"
          : items.some((i) => i.severity !== "info")
            ? "replies go to another domain"
            : "where replies go could not be compared",
  });
  registry.register({
    name: "sender.return_path",
    needs: [],
    timeoutMs: 1_000,
    run: returnPathEvidence,
    examined: (view) => named(view.headers, "return-path").map((h) => h.value),
    applies,
    summary: (view, items) =>
      !named(view.headers, "return-path")[0]?.value.replace(/[<>\s]/g, "")
        ? "no bounce address was given"
        : !items.length
          ? "bounces go to the sender's domain or its mail service"
          : items.some((i) => i.severity !== "info")
            ? "bounces go to another domain"
            : "the bounce address could not be compared",
  });
  registry.register({
    name: "sender.first_time",
    needs: [],
    timeoutMs: 1_000,
    run: firstTimeEvidence,
    examined: (view) => {
      const from = fromOf(view);
      return from ? [from.address] : [];
    },
    // What IsItLegit's own checks have seen of the sender; the span of mail is D02 T02 §8's (familiarity).
    summary: (view) =>
      view.senderHistory === "first" ? "yes" : view.senderHistory === "seen" ? "no, seen before" : null,
    applies: (view) => applies(view) ?? (view.senderHistory === null ? "the sender's history was not read" : null),
  });
}
