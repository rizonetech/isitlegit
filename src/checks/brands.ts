// The curated brand table (D02 T03 §3; spec 4.4, brand real domains, curated table first): the brands most impersonated
// in South African small-business mail, their real domains and names, each domain from a dated page on the brand's own
// site. The table is bundled (data/brands.json) and KV holds a copy under `brands:v1`, so a new revision is read without
// a deploy; a copy that is missing, slow, refused or malformed is not used, the bundled table is, and the reason is
// logged. A brand's registrable domains are its own except the hosts where it publishes other people's content
// (`user_content`), answered as its platform but not the brand.
import BUNDLED from "../../data/brands.json";
import { BRANDS_KEY, BRANDS_SCHEMA, type Brand, BrandTable, registrable } from "./brand-schema";

export { BRANDS_KEY, BRANDS_PREVIOUS_KEY, BRANDS_SCHEMA, type Brand, BrandTable, registrable } from "./brand-schema";
export const KV_READ_MS = 1_000;
export const HELD_MS = 60_000;

// The bundled table, checked when the module loads: a malformed one fails every test and the deploy's build.
export const bundled: BrandTable = BrandTable.parse(BUNDLED);

type Held = { table: BrandTable; until: number };
let held: Held | undefined;
// For tests: forget what this isolate read.
export const forgetBrandTable = () => {
  held = undefined;
};

export type BrandEnv = { CACHE: KVNamespace };

// The table in force: KV's copy when it reads in time and is valid, else the bundled one, the reason logged.
export async function brandTable(env: BrandEnv, now: () => number = Date.now): Promise<BrandTable> {
  if (held && now() < held.until) return held.table;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<"stalled">((resolve) => {
    timer = setTimeout(() => resolve("stalled"), KV_READ_MS);
  });
  let table = bundled;
  try {
    const read = await Promise.race([env.CACHE.get(BRANDS_KEY, "json"), stalled]);
    if (read === "stalled") log("stalled");
    else if (read === null) log("missing");
    else {
      const parsed = BrandTable.safeParse(read);
      if (parsed.success) table = parsed.data;
      else log((read as { version?: unknown }).version === BRANDS_SCHEMA ? "invalid" : "version");
    }
  } catch (error) {
    log("refused", error instanceof Error ? error.name : "Error");
  } finally {
    clearTimeout(timer);
  }
  held = { table, until: now() + HELD_MS };
  return table;
}

function log(reason: string, errorClass?: string) {
  console.warn(
    JSON.stringify({ event: "brand-table", source: "bundled", reason, ...(errorClass ? { errorClass } : {}) }),
  );
}

// A name as people write it, compared without case, spacing or punctuation.
const folded = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

export function getBrand(table: BrandTable, name: string): Brand | null {
  const wanted = folded(name);
  if (!wanted) return null;
  return table.brands.find((b) => [b.name, ...b.display_names].some((n) => folded(n) === wanted)) ?? null;
}

export type BrandMatch = { brand: Brand; official: boolean };

// The brand a host belongs to: official on its registrable domains and their subdomains, its platform but not the brand
// on a host where it publishes other people's content; null for any other host.
export function brandForDomain(table: BrandTable, host: string): BrandMatch | null {
  return brandAt(table, host, null);
}

// The same for a web address, where a path can carry other people's content on a brand's own host (a PayPal invoice at
// `www.paypal.com/invoice/...` is the sender's words, not PayPal's).
export function brandForUrl(table: BrandTable, url: string): BrandMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return brandAt(table, parsed.hostname, parsed.pathname);
}

function brandAt(table: BrandTable, host: string, path: string | null): BrandMatch | null {
  const lower = host.toLowerCase().replace(/\.$/, "");
  const domain = registrable(lower);
  if (!domain) return null;
  const brand = table.brands.find((b) => b.domains.includes(domain));
  if (!brand) return null;
  const hosted = brand.user_content.some((entry) => {
    const slash = entry.indexOf("/");
    const entryHost = slash < 0 ? entry : entry.slice(0, slash);
    if (lower !== entryHost && !lower.endsWith(`.${entryHost}`)) return false;
    return slash < 0 || (path !== null && path.startsWith(entry.slice(slash)));
  });
  return { brand, official: !hosted };
}
