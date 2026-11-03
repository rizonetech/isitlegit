// Labels that follow by a fixed rule from a page's other labels (D03 T04 §9), stored with label source `rule`.
//
//   node scripts/glimmer/label-rules.ts        # apply to every stored page, printing counts
//
// Every page ends complete or excluded: a benign page's type is `none`; a page with no `lure`, with source labels that
// contradict each other, still incomplete after the rules, or whose files no longer match their hashes is written to
// `raw/labels/excluded.jsonl` with its reason, and §10 builds from neither file's excluded pages.
//
// A lure's type, when its source gave none, follows from the screener prompt's own definitions
// (`SCREENER_SYSTEM_PROMPT`): a page that asks for card details is `payment`; one that asks for a sign-in is
// `credential`; one with neither form is `impersonation`. `fake_shop` is never derived: a shop is told from a lookalike
// only by a source or a judge, so a source's own `fake_shop` stands. Training may use a rule label; evaluation never
// trusts one (§10), and Astra and Claude's decision replaces it where they judge the page.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDomain } from "tldts";
import { type LURE_TYPES, PageAnswer } from "../../src/vision/page-screen.ts";
import { NO_SITE, NOT_FOUND, wallShown } from "./render.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

const ROOT = resolve(import.meta.dirname, "../..");

// Whether a lure type the rules derive rests on a false form flag that is untrusted (read off an inert copy, §18): a
// form that copy could not show may be there, so the type is no better than unverified (§9 final review).
export function restsOnUnverified(
  type: StoredPage["labels"]["lure_type"],
  labels: StoredPage["labels"],
  sources: StoredPage["label_source"],
): boolean {
  const unsure = (field: "has_login_form" | "has_payment_form") =>
    labels[field] === false && sources[field] === "unverified";
  if (type === "impersonation") return unsure("has_login_form") || unsure("has_payment_form");
  if (type === "credential") return unsure("has_payment_form");
  return false;
}

export function derivedLureType(page: StoredPage): (typeof LURE_TYPES)[number] | null {
  const { labels } = page;
  if (labels.lure === false && labels.lure_type === undefined) return "none";
  if (labels.lure !== true || labels.lure_type !== undefined) return null;
  if (labels.has_payment_form === undefined || labels.has_login_form === undefined) return null;
  if (labels.has_payment_form) return "payment";
  if (labels.has_login_form) return "credential";
  return "impersonation";
}

// The brands lures copy most, as the page names them; South African brands first, since they matter most here. A
// longer name is tried before a shorter one it contains ("Microsoft 365" before "Microsoft"). Names that are also common
// standalone capitals (X, AU) are left out: they would name a brand on any page with a close button or a country code.
export const KNOWN_BRANDS = [
  "FNB",
  "Standard Bank",
  "Absa",
  "Nedbank",
  "Capitec",
  "Investec",
  "TymeBank",
  "Discovery",
  "African Bank",
  "Old Mutual",
  "SARS",
  "eFiling",
  "Home Affairs",
  "SASSA",
  "Vodacom",
  "MTN",
  "Telkom",
  "Cell C",
  "DStv",
  "Takealot",
  "Checkers",
  "Pick n Pay",
  "Woolworths",
  "Shoprite",
  "The Courier Guy",
  "PostNet",
  "SA Post Office",
  "Eskom",
  "Microsoft 365",
  "Microsoft",
  "Outlook",
  "Office 365",
  "OneDrive",
  "SharePoint",
  "Google",
  "Gmail",
  "Apple",
  "iCloud",
  "Facebook",
  "Instagram",
  "WhatsApp",
  "Meta",
  "LinkedIn",
  "Netflix",
  "Amazon",
  "PayPal",
  "DHL",
  "FedEx",
  "UPS",
  "USPS",
  "Royal Mail",
  "Yahoo",
  "AOL",
  "Dropbox",
  "DocuSign",
  "Adobe",
  "WeTransfer",
  "Zoom",
  "Steam",
  "Roblox",
  "Coinbase",
  "Binance",
  "MetaMask",
  "Trezor",
  "Ledger",
  "Trust Wallet",
  "Blockchain.com",
  "Kraken",
  "Crypto.com",
  "OpenSea",
  "Spotify",
  "Disney+",
  "eBay",
  "Walmart",
  "Alibaba",
  "AliExpress",
  "Shopify",
  "Booking.com",
  "Airbnb",
  "Uber",
  "Twitter",
  "TikTok",
  "Telegram",
  "Discord",
  "Snapchat",
  "Chase",
  "Bank of America",
  "Wells Fargo",
  "Citibank",
  "HSBC",
  "Barclays",
  "Lloyds",
  "NatWest",
  "Santander",
  "ING",
  "BNP Paribas",
  "Société Générale",
  "Crédit Agricole",
  "Deutsche Bank",
  "Commonwealth Bank",
  "Westpac",
  "ANZ",
  "Itaú",
  "Bradesco",
  "Banco do Brasil",
  "Mercado Libre",
  "Rakuten",
  "Naver",
  "Kakao",
  "LINE",
  "SoftBank",
  "Docomo",
  "Orange",
  "Vodafone",
  "AT&T",
  "Verizon",
  "T-Mobile",
  "Comcast",
  "Xfinity",
  "Swisscom",
  "La Poste",
  "Correos",
  "Poste Italiane",
  "Australia Post",
  "Canada Post",
  "Interac",
  "Venmo",
  "Cash App",
  "Zelle",
  "Stripe",
  "Square",
  "Visa",
  "Mastercard",
  "American Express",
  "Webmail",
  "cPanel",
  "Roundcube",
  "Zimbra",
].sort((a, b) => b.length - a.length);
// The brands our South African list names (`eval/glimmer/benign-sa-urls.txt`, its third column), the ones lures copy here.
// A name that is also an everyday word ("Game", "Clicks", "Rain") would name a brand on any page using the word, so it
// is matched only as a host stem, never in a lure's text; so are names of three letters or fewer.
const EVERYDAY = new Set(
  "@Home Bash Bolt Builders Clicks Coronation Game Howler Imperial Incredible Liberty Lift Loot Momentum Places Pineapple Rain Sage Spar Stitch Stuff Typo Vox".split(
    " ",
  ),
);
function listedBrands(): string[] {
  const file = join(ROOT, "eval/glimmer/benign-sa-urls.txt");
  if (!existsSync(file)) return [];
  return [
    ...new Set(
      readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("#"))
        .map((line) => line.split("\t")[2]?.trim() ?? "")
        .filter(Boolean),
    ),
  ];
}
const LISTED = listedBrands();

// One name per brand, whatever its spelling or host: the key is the name in lowercase letters and digits only, so
// `standardbank.co.za`, "STANDARD BANK" and "Standard Bank" meet, and a few known long forms map to the short one.
const brandKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const CANONICAL = new Map<string, string>();
for (const name of [...KNOWN_BRANDS, ...LISTED])
  if (!CANONICAL.has(brandKey(name))) CANONICAL.set(brandKey(name), name);
// Long forms a page writes out, with the name each stands for.
const LONG_FORMS: [string, string][] = [
  ["Standard Bank Group", "Standard Bank"],
  ["First National Bank", "FNB"],
  ["Absa Bank", "Absa"],
  ["Absa Group", "Absa"],
  ["Capitec Bank", "Capitec"],
  ["Nedbank Group", "Nedbank"],
  ["Discovery Bank", "Discovery"],
  ["South African Revenue Service", "SARS"],
  ["SARS eFiling", "SARS"],
];
for (const [form, name] of LONG_FORMS) CANONICAL.set(brandKey(form), name);
// A brand named by its domain ("Booking.com", "Domains.co.za") also answers to its host's stem, as a real page's host
// gives it (`www.booking.com` is `booking`).
for (const name of [...KNOWN_BRANDS, ...LISTED]) {
  const stem = /^([\p{L}\p{N}-]+)\.[\p{L}.]+$/u.exec(name)?.[1];
  if (stem && !CANONICAL.has(brandKey(stem))) CANONICAL.set(brandKey(stem), name);
}

// The one name a brand goes by (a known spelling, or the name as given when it is not one we know).
export function canonicalBrand(name: string): string {
  return CANONICAL.get(brandKey(name)) ?? name.trim();
}

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const bounded = (names: string[]) =>
  `(?<![\\p{L}\\p{N}])(${[...new Set(names)]
    .sort((a, b) => b.length - a.length)
    .map(escaped)
    .join("|")})(?![\\p{L}\\p{N}])`;
// The known brands as they are; the list's names only past three letters and when not an everyday word.
const SINGLE = [...KNOWN_BRANDS, ...LISTED.filter((name) => name.length > 3 && !EVERYDAY.has(name))].filter(
  (name) => !/\s/.test(name),
);
const SEVERAL = [...KNOWN_BRANDS, ...LISTED, ...LONG_FORMS.map(([form]) => form)].filter(
  (name) => /\s/.test(name) && !EVERYDAY.has(name),
);
// A one-word name as listed or in capitals ("Absa", "ABSA"; "visa" or "square" in running text is a word, not a brand);
// a name of several words, or a long form, in any case ("standard bank", "FIRST NATIONAL BANK").
const BRAND_RULE = new RegExp(
  `${bounded(SEVERAL)}|${bounded([...SINGLE, ...SINGLE.map((n) => n.toUpperCase())])}`,
  "iu",
);
const SINGLE_EXACT = new Set([...SINGLE, ...SINGLE.map((n) => n.toUpperCase())]);
const LEADING_BRAND = new RegExp(`^(?:${BRAND_RULE.source})`, "iu");
// The length of the known brand `text` begins with, read as a lure's text is (`firstBrand`: a name of several words in
// any case, a one-word name as listed or in capitals), or 0 for none: `Standard Bank` of `Standard Bank Customer Care`.
// What the redaction keeps of a line signed for a business (`businessSignOff` in redact.ts, §19 round 3).
export function leadingBrand(text: string): number {
  const match = LEADING_BRAND.exec(text);
  if (match?.[1]) return match[1].length;
  return match?.[2] && SINGLE_EXACT.has(match[2]) ? match[2].length : 0;
}
function firstBrand(text: string): string | undefined {
  const pattern = new RegExp(BRAND_RULE.source, "giu");
  for (const match of text.matchAll(pattern)) {
    const several = match[1];
    if (several) return several;
    // The pattern is case-blind; a one-word name counts only in a case it is listed in, or in capitals.
    const single = match[2];
    if (single && SINGLE_EXACT.has(single)) return single;
  }
  return undefined;
}
// Another service named only to sign in with it, or as a page's maker, is not the page's brand.
const THIRD_PARTY =
  /\b(?:(?:sign|log) ?(?:in|on|up)|continue|connect|register) (?:with|using|via) [\p{L}\p{N}]+(?:\.\p{L}{2,})?|\bpowered by [\p{L}\p{N}]+(?:\.\p{L}{2,})?/giu;

// A page's brand when its source gave none, or when a rule gave the one it has (rules are re-run as they improve; a
// source's own brand is never touched): a lure's, the first known brand its text names near the top (with sign-in
// buttons for other services left out), canonical; else none, which the receipt counts as unresolved; a real page's,
// its site's name from its host (`standardbank.co.za` is "Standard Bank", `en.wikipedia.org` is `wikipedia`), else
// none. Undefined when there is nothing to set.
export function derivedBrand(page: StoredPage, text: string): string | null | undefined {
  if (page.labels.lure === undefined) return undefined;
  if (page.labels.brand !== undefined && page.label_source.brand !== "rule") return undefined;
  let brand: string | null;
  if (page.labels.lure) {
    const found = firstBrand(text.slice(0, 2000).replace(THIRD_PARTY, " "));
    brand = found ? canonicalBrand(found) : null;
  } else {
    const stem = (page.host ? getDomain(page.host) : null)?.split(".")[0];
    brand = stem ? canonicalBrand(stem) : null;
  }
  return page.labels.brand === brand ? undefined : brand;
}

// What a page shows once its site is gone: a parked or for-sale domain, a suspended account, a takedown notice.
// Each phrase names the site itself (this domain, this account as a host's notice says it, the website): a lure says
// "your account has been suspended" or "disabled due to suspicious activity" to the visitor, and is no takedown (§18
// round 1).
const PARKED =
  /this domain (is|may be) for sale|buy this domain|domain (is )?parked|parked (free|domain)|this (account|website|site) (has been |is )?suspended|(this|the) (website|site|page) (has been |was |is )?(taken down|disabled|blocked|removed|suspended)|(phishing|deceptive) (site|page)s? (has been |was )?(taken down|removed|blocked)|deceptive site ahead|(site|page|website) (has been |was )?reported (as )?(a )?phishing/i;

// Why a page's capture cannot carry its publisher's label (§18, plan review gap 5; §28, G6 and plan review gap 6):
// the capture shows something other than the page the label was given for, or is blank with no form. Null when it can.
// Little text alone is no sign: a lure can be a logo and two fields, its screenshot carrying it.
// The render's title, overlays and structural readings go to the wall and error rules, as the renderer reads them.
export function captureProblem(
  text: string,
  evidence?: {
    title: string;
    overlays: string;
    captcha?: boolean | undefined;
    consentWall?: boolean | undefined;
    challengeCover?: boolean | undefined;
    wall?: boolean | undefined;
  },
  flags?: { has_login_form?: boolean | undefined; has_payment_form?: boolean | undefined },
): string | null {
  if (evidence?.captcha) return "a CAPTCHA frame";
  if (evidence?.consentWall) return "a cookie wall covering the page";
  if (evidence?.challengeCover) return "a bot challenge drawn over the page";
  // The whole text for the site's own notices, which name the site and nothing a lure says: one padded below ordinary
  // copy is still the page's (§18 final review). The error rule reads the page's head and title, as the renderer does:
  // its phrases ("cannot be found", "no longer available") are also what a delivery or offer lure says further down.
  if (PARKED.test(text)) return "a parked, suspended or taken-down page";
  if (NO_SITE.test(text.slice(0, 2000))) return "a directory listing, an empty placeholder or a suspended host";
  if (NOT_FOUND.test(`${evidence?.title ?? ""}\n${text.slice(0, 3000)}`)) return "an error page";
  if (evidence?.wall || wallShown({ title: evidence?.title ?? "", text, overlays: evidence?.overlays ?? "" }))
    return "a bot challenge";
  if (!text.trim() && !flags?.has_login_form && !flags?.has_payment_form) return "an empty page";
  return null;
}

// A label complete as the screener answers (every field of `PageAnswer` but its confidence).
export function completeLabel(labels: StoredPage["labels"]): boolean {
  return PageAnswer.safeParse({ ...labels, confidence: 1 }).success;
}

// Why a page cannot train or be evaluated on its labels as they stand, or null when it can.
export function labelProblem(page: StoredPage): string | null {
  const { lure, lure_type } = page.labels;
  if (lure === undefined) return "no lure label";
  if (lure_type !== undefined && (lure_type === "none") === lure)
    return `the source labels contradict each other (lure ${lure}, lure_type ${lure_type})`;
  if (!completeLabel(page.labels)) {
    const missing = ["brand", "has_login_form", "has_payment_form", "lure_type"].filter(
      (field) => page.labels[field as keyof typeof page.labels] === undefined,
    );
    return `incomplete after the rules (missing ${missing.join(", ")})`;
  }
  return null;
}

export const excludedFile = (dir: string) => join(dir, "raw", "labels", "excluded.jsonl");

// The first two of a page's items whose lure labels contradict (one a lure, one not, or two lures of different
// types), named with their labels; null when they agree or the page stands for one item.
export function itemConflict(page: StoredPage): string | null {
  const items = page.items ?? [];
  for (const [index, a] of items.entries())
    for (const b of items.slice(index + 1)) {
      const lure = a.lure !== undefined && b.lure !== undefined && a.lure !== b.lure;
      const type = a.lure && b.lure && a.lure_type && b.lure_type && a.lure_type !== b.lure_type;
      if (lure || type)
        return `items ${a.id} (${a.lure ? `lure, ${a.lure_type ?? "type unknown"}` : "not a lure"}) and ${b.id} (${b.lure ? `lure, ${b.lure_type ?? "type unknown"}` : "not a lure"}) share this content with contradictory labels`;
    }
  return null;
}

export function readExcluded(dir: string): Map<string, string> {
  const file = excludedFile(dir);
  if (!existsSync(file)) return new Map();
  return new Map(
    readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const { id, reason } = JSON.parse(line) as { id: string; reason: string };
        return [id, reason];
      }),
  );
}

function writeExcluded(dir: string, excluded: Map<string, string>): void {
  const file = excludedFile(dir);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w");
  try {
    const data = Buffer.from([...excluded].map(([id, reason]) => `${JSON.stringify({ id, reason })}\n`).join(""));
    for (let at = 0; at < data.length; ) {
      const written = writeSync(fd, data, at, data.length - at); // a nearly full disk may write less than asked
      if (written <= 0) throw new Error(`a write took no bytes at ${at} of ${data.length}`);
      at += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  // The rename reaches the disk too, as durably as the labels and receipt that rest on it (§9 final review).
  const folder = openSync(dirname(file), "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}

// Applies the rules to every whole page and writes the exclusions file afresh: every page then has a complete label or
// an excluded entry with its reason. Counts what it derived and excluded.
export function applyRules(store: ReturnType<typeof openStore>): Record<string, number> {
  const counts: Record<string, number> = {};
  const count = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const excluded = new Map<string, string>();
  for (const id of store.verify().damaged)
    excluded.set(id, "its files no longer match their hashes, or its record does not read");
  const listedPages = store.manifest({ tolerant: true });
  // One page text two sources label oppositely (one a lure, one not): neither label can be trusted for it (§18).
  const lureByText = new Map<string, Set<boolean>>();
  for (const page of listedPages) {
    if (page.origin !== "public" || page.labels.lure === undefined) continue;
    const seen = lureByText.get(page.sha256.text) ?? new Set<boolean>();
    seen.add(page.labels.lure);
    lureByText.set(page.sha256.text, seen);
  }
  for (const listed of listedPages) {
    if (excluded.has(listed.id)) continue;
    const read = store.readVerifiedPage(listed.id);
    if (!read) {
      excluded.set(listed.id, "its files no longer match their hashes, or its record does not read");
      continue;
    }
    const { page, text } = read;
    // A publisher's label holds only for a capture that shows the page it was given for (§18, plan review gap 5).
    if (page.origin === "public") {
      const shown = captureProblem(text, page.evidence, page.labels);
      if (shown) {
        excluded.set(page.id, `the capture is ${shown}, not the page its label was given for`);
        continue;
      }
      if ((lureByText.get(page.sha256.text)?.size ?? 0) > 1) {
        excluded.set(page.id, "the same page text is labelled a lure by one source and not by another");
        continue;
      }
    }
    // Items with this one content whose labels contradict (§28, G3): the page is no item's, so it is excluded, naming
    // both, whichever arrived first.
    const conflict = itemConflict(page);
    if (conflict) {
      excluded.set(page.id, conflict);
      continue;
    }
    let current = page;
    if (!labelProblem(page)?.startsWith("the source labels contradict")) {
      const labels = { ...page.labels };
      const sources = { ...page.label_source };
      // A live screenshot beside text and form flags read from an inert copy of its HTML (7 Days Later, §18 gap 7):
      // a form a script builds shows in the picture but not in the inert copy, so a false flag there is untrusted.
      // Marked before the lure type is derived, so the type knows what it rests on.
      let flags = false;
      if (page.source === "7-days-later")
        for (const field of ["has_login_form", "has_payment_form"] as const)
          if (labels[field] === false && sources[field] !== "unverified") {
            sources[field] = "unverified";
            flags = true;
          }
      if (flags) count("form flag untrusted");
      const type = derivedLureType(page);
      if (type) {
        labels.lure_type = type;
        sources.lure_type = restsOnUnverified(type, labels, sources) ? "unverified" : "rule";
        count(type);
      } else if (sources.lure_type === "rule" && restsOnUnverified(labels.lure_type, labels, sources)) {
        // A type an earlier run derived before its flags were found untrusted.
        sources.lure_type = "unverified";
        flags = true;
      }
      const brand = derivedBrand(page, text);
      if (brand !== undefined) {
        labels.brand = brand;
        sources.brand = "rule";
        count(brand === null ? (page.labels.lure ? "brand unresolved" : "brand none") : "brand named");
      }
      if (type || brand !== undefined || flags) current = store.setLabels(page.id, labels, sources);
    }
    const problem = labelProblem(current);
    if (problem) excluded.set(page.id, problem);
  }
  // A sample page the leak check flagged (raw/samples/LEAK-CHECK.json, read here by path as the teacher's state
  // is): barred from every dataset, split and evaluation until a section 19 round re-admits it after a clean
  // leak check over it (coordinator decision, 2026-11-02). The checker's OCR entity pass finds names and places
  // the importer's per-item checker stored past; the flagged page itself never trains or is evaluated on.
  // A page barred for a leak flag stays barred: the entry is carried forward from the last exclusions file,
  // so a later clean check over the eligible remainder never silently re-admits it. Re-admission is the
  // section 19 round's recorded act (the entry removed, then a clean leak check over the page).
  for (const [id, reason] of readExcluded(store.dir))
    if (reason.startsWith("flagged by the sample leak check") && !excluded.has(id)) excluded.set(id, reason);
  const leakFile = join(store.dir, "raw", "samples", "LEAK-CHECK.json");
  if (existsSync(leakFile)) {
    try {
      const { failures } = JSON.parse(readFileSync(leakFile, "utf-8")) as {
        failures?: { id: string; representation?: string; reason?: string }[];
      };
      const stored = new Set(listedPages.filter((p) => p.origin === "samples").map((p) => p.id));
      for (const failure of failures ?? [])
        if (stored.has(failure.id))
          excluded.set(
            failure.id,
            `flagged by the sample leak check (${failure.representation ?? "record"}: ${failure.reason ?? "a client detail shows"}); barred from every dataset until a section 19 round re-admits it`,
          );
    } catch {
      // A record that does not read flags nothing; the leak check's own verdict stands in the build.
    }
  }
  // A page whose teacher answer was lost (`quarantined` in raw/teacher/state.json, read here without the teacher's
  // module) may have been disputed: kept out of training and evaluation.
  const teacherFile = join(store.dir, "raw", "teacher", "state.json");
  if (existsSync(teacherFile)) {
    const { pages } = JSON.parse(readFileSync(teacherFile, "utf-8")) as {
      pages: Record<string, { status: string; reason?: string }>;
    };
    for (const [id, outcome] of Object.entries(pages))
      if (outcome.status === "quarantined" && !excluded.has(id))
        excluded.set(id, `the teacher's answer was lost (${outcome.reason ?? "quarantined"})`);
  }
  writeExcluded(store.dir, excluded);
  for (const reason of excluded.values()) count(`excluded: ${reason.replace(/ \(.*$/, "")}`);
  return counts;
}

if (import.meta.filename === process.argv[1]) console.log(JSON.stringify(applyRules(openStore(storeDir()))));
