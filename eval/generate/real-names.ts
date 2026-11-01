// The real names a synthetic message must never carry (D08 T01 §3): every brand in the curated brand table
// (`data/brands.json`: its names, display names and domain labels) and the South African banks, insurers, retailers,
// couriers, telecoms, utilities and public bodies it does not hold. Matched case-insensitively as whole words.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const EXTRA = [
  // Banks and financial services not in the brand table.
  "Capitec",
  "Investec",
  "African Bank",
  "Bidvest Bank",
  "Sasfin",
  "Mercantile Bank",
  "Old Mutual",
  "Sanlam",
  "Liberty",
  "Momentum",
  "Discovery",
  "Outsurance",
  "Santam",
  "Hollard",
  "Mukuru",
  "Ozow",
  "PayShap",
  "SnapScan",
  "Zapper",
  // Retail.
  "Shoprite",
  "Checkers",
  "Pick n Pay",
  "Woolworths",
  "Makro",
  "Game",
  "Clicks",
  "Dis-Chem",
  "Mr Price",
  "Pep",
  "Builders Warehouse",
  // Couriers and logistics.
  "The Courier Guy",
  "Fastway",
  "Pargo",
  "Courier IT",
  "Dawn Wing",
  "RAM Couriers",
  "SA Post Office",
  "Postbank",
  // Telecoms and utilities.
  "Vodacom",
  "MTN",
  "Telkom",
  "Cell C",
  "Rain",
  "Eskom",
  "City Power",
  "Rand Water",
  // Public bodies.
  "South African Revenue Service",
  "CIPC",
  "UIF",
  "Home Affairs",
  "SAPS",
  "Sassa",
  "eFiling",
  // Global brands often impersonated, beyond the table.
  "Amazon",
  "WhatsApp",
  "Facebook",
  "Instagram",
  "LinkedIn",
  "Dropbox",
  "Zoom",
  "Office 365",
  "OneDrive",
  "Gmail",
  "Outlook",
];

// Names that are also everyday words ("rain", "outlook", "sage"), matched only as written, capital first.
export const AS_WRITTEN = new Set([
  "Game",
  "Pep",
  "Rain",
  "Liberty",
  "Momentum",
  "Discovery",
  "Zoom",
  "Outlook",
  "Clicks",
  "Checkers",
  "Sage",
  "Apple",
]);

type Brand = { name: string; display_names?: string[]; domains?: string[] };

// Every real name, from the brand table and EXTRA: names, display names, and each domain's first label when it is a
// word of four letters or more (so `fnb.co.za` gives `fnb` from its name, and `standardbank.co.za` gives
// `standardbank`).
export function realNames(root = ROOT): string[] {
  const table = JSON.parse(readFileSync(join(root, "data", "brands.json"), "utf8")) as { brands: Brand[] } | Brand[];
  const brands = Array.isArray(table) ? table : table.brands;
  const names = new Set<string>(EXTRA);
  for (const b of brands) {
    names.add(b.name);
    for (const d of b.display_names ?? []) names.add(d);
    for (const domain of b.domains ?? []) {
      const label = domain.split(".")[0] ?? "";
      if (label.length >= 4) names.add(label);
    }
  }
  return [...names].filter((n) => n.trim().length >= 2);
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The real names a text carries, as written in the list.
export function realNamesIn(text: string, names = realNames()): string[] {
  return names.filter((n) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${literal(n)}($|[^\\p{L}\\p{N}])`, AS_WRITTEN.has(n) ? "u" : "iu").test(text),
  );
}
