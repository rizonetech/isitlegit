// The curated brand table (D02 T03 §3; spec 4.4, brand real domains, curated table first): the brands most impersonated
// in South African small-business mail, their real domains and names, each domain from a dated page on the brand's own
// site. The table is bundled (data/brands.json) and KV holds a copy under `brands:v1`, so a new revision is read without
// a deploy; a copy that is missing, slow, refused or malformed is not used, the bundled table is, and the reason is
// logged. A brand's registrable domains are its own except the hosts where it publishes other people's content
// (`user_content`), answered as its platform but not the brand.
import BUNDLED from "../../data/brands.json";
import { BRANDS_KEY, BRANDS_SCHEMA, type Brand, BrandTable, covers, registrable } from "./brand-schema";

export { BRANDS_KEY, BRANDS_PREVIOUS_KEY, BRANDS_SCHEMA, type Brand, BrandTable, registrable } from "./brand-schema";
export const KV_READ_MS = 1_000;
export const HELD_MS = 60_000;

// The bundled table, checked when the module loads: a malformed one fails every test and the deploy's build.
export const bundled: BrandTable = BrandTable.parse(BUNDLED);

// Where the table in force was read from: KV's copy (also when it equals the bundle), or the bundled table.
export type BrandSource = "kv" | "bundled";
type Held = { table: BrandTable; source: BrandSource; until: number; namespace: KVNamespace };
let held: Held | undefined;
// For tests: forget what this isolate read.
export const forgetBrandTable = () => {
  held = undefined;
};

export type BrandEnv = { CACHE: KVNamespace };

// The table in force: KV's copy when it reads in time and is valid, else the bundled one, the reason logged.
export async function brandTable(env: BrandEnv, now: () => number = Date.now): Promise<BrandTable> {
  return (await brandTableRead(env, now)).table;
}

// The same, with where it was read from (D02 T01 §6), so a run can record the data it judged by: a held value keeps the
// source of the read that filled it.
export async function brandTableRead(
  env: BrandEnv,
  now: () => number = Date.now,
): Promise<{ table: BrandTable; source: BrandSource }> {
  // Held per namespace, so another binding never gets this one's table (final review).
  if (held && held.namespace === env.CACHE && now() < held.until) return { table: held.table, source: held.source };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<"stalled">((resolve) => {
    timer = setTimeout(() => resolve("stalled"), KV_READ_MS);
  });
  let table = bundled;
  let source: BrandSource = "bundled";
  try {
    const read = await Promise.race([env.CACHE.get(BRANDS_KEY, "json"), stalled]);
    if (read === "stalled") log("stalled");
    else if (read === null) log("missing");
    else {
      const parsed = BrandTable.safeParse(read);
      if (parsed.success && covers(parsed.data, bundled).length === 0) {
        table = parsed.data;
        source = "kv";
      } else if (parsed.success) log("shrunk");
      else log((read as { version?: unknown }).version === BRANDS_SCHEMA ? "invalid" : "version");
    }
  } catch (error) {
    log("refused", error instanceof Error ? error.name : "Error");
  } finally {
    clearTimeout(timer);
  }
  held = { table, source, until: now() + HELD_MS, namespace: env.CACHE };
  return { table, source };
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

// The brand a mail domain belongs to (D02 T02 §4, round 1): as `brandForDomain`, except that a path-scoped
// `user_content` entry (`paypal.com/invoice/`) never applies, since a mailbox has no path: `service@paypal.com` is
// PayPal's own. A host-level entry (`icloud.com`, a consumer mailbox the brand runs) and a community label still do.
export function brandForMailbox(table: BrandTable, host: string): BrandMatch | null {
  return brandAt(table, host, null, true);
}

function brandAt(table: BrandTable, host: string, path: string | null, mailbox = false): BrandMatch | null {
  const lower = host.toLowerCase().replace(/\.$/, "");
  const domain = registrable(lower);
  if (!domain) return null;
  const brand = table.brands.find((b) => b.domains.includes(domain));
  if (!brand) return null;
  // Any label left of the registrable domain counts: `community.fabric.microsoft.com` as much as `community.x.com`.
  const below = lower === domain ? [] : lower.slice(0, -domain.length - 1).split(".");
  if (below.some((label) => table.community_labels.includes(label))) return { brand, official: false };
  const hosted = brand.user_content.some((entry) => {
    const slash = entry.indexOf("/");
    const spec = slash < 0 ? entry : entry.slice(0, slash);
    const exact = spec.startsWith("=");
    const entryHost = exact ? spec.slice(1) : spec;
    if (lower !== entryHost && (exact || !lower.endsWith(`.${entryHost}`))) return false;
    if (mailbox) return slash < 0;
    // A host alone cannot say which path it serves, so a host with other people's content on some paths is not
    // answered as official without one (round 1): only a web address's own path clears it.
    return slash < 0 || path === null || pathUnder(path, entry.slice(slash));
  });
  return { brand, official: !hosted };
}

// Whether a path lies under a prefix whose `*` segments match any one segment.
function pathUnder(path: string, prefix: string): boolean {
  const want = prefix.split("/").slice(1, -1);
  // Each segment decoded and case-folded, so `%61nswers` and `Answers` are `answers` (round 2); a segment that does not
  // decode is compared as written.
  const have = path
    .split("/")
    .slice(1)
    .map((segment) => {
      try {
        return decodeURIComponent(segment).toLowerCase();
      } catch {
        return segment.toLowerCase();
      }
    });
  if (have.length < want.length) return false;
  return want.every((segment, i) => segment === "*" || segment === have[i]);
}
