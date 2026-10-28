// Labels that follow by a fixed rule from a page's other labels (D03 T04 §9), stored with label source `rule`.
//
//   node scripts/glimmer/label-rules.ts        # apply to every stored page, printing counts
//
// A lure's type, when its source gave none, follows from the screener prompt's own definitions
// (`SCREENER_SYSTEM_PROMPT`): a page that asks for card details is `payment`; one that asks for a sign-in is
// `credential`; one with neither form is `impersonation`. `fake_shop` is never derived: a shop is told from a lookalike
// only by a source or a judge, so a source's own `fake_shop` stands. Training may use a rule label; evaluation never
// trusts one (§10), and Astra and Claude's decision replaces it where they judge the page.
import { getDomain } from "tldts";
import type { LURE_TYPES } from "../../src/vision/page-screen.ts";
import { openStore, type StoredPage, storeDir } from "./store.ts";

export function derivedLureType(page: StoredPage): (typeof LURE_TYPES)[number] | null {
  const { labels } = page;
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
const BRAND_RULE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${KNOWN_BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`,
  "u",
);

// A page's brand when its source gave none: a lure's, the first known brand its text names near the top (case as
// listed), else none, which is the right answer for a shop under an invented name; a real page's, its site's name from
// its host (`en.wikipedia.org` is `wikipedia`), else none.
export function derivedBrand(page: StoredPage, text: string): string | null | undefined {
  if (page.labels.brand !== undefined || page.labels.lure === undefined) return undefined;
  if (page.labels.lure) return BRAND_RULE.exec(text.slice(0, 2000))?.[1] ?? null;
  const site = page.host ? getDomain(page.host) : null;
  return site ? (site.split(".")[0] ?? null) : null;
}

export function applyRules(store: ReturnType<typeof openStore>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const page of store.manifest()) {
    const labels = { ...page.labels };
    const sources = { ...page.label_source };
    const type = derivedLureType(page);
    if (type) {
      labels.lure_type = type;
      sources.lure_type = "rule";
      counts[type] = (counts[type] ?? 0) + 1;
    }
    const brand = derivedBrand(page, store.readPage(page.id).text);
    if (brand !== undefined) {
      labels.brand = brand;
      sources.brand = "rule";
      counts[brand === null ? "brand none" : "brand named"] =
        (counts[brand === null ? "brand none" : "brand named"] ?? 0) + 1;
    }
    if (type || brand !== undefined) store.setLabels(page.id, labels, sources);
  }
  return counts;
}

if (import.meta.filename === process.argv[1]) console.log(JSON.stringify(applyRules(openStore(storeDir()))));
