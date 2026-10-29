import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRANDS_KEY,
  BrandTable,
  brandForDomain,
  brandForUrl,
  brandTable,
  bundled,
  forgetBrandTable,
  getBrand,
  HELD_MS,
  KV_READ_MS,
} from "../../src/checks/brands";

// D02 T03 §3: the curated brand table, bundled and in KV, and the lookups the lookalike check reads.
const NAMED = [
  "Standard Bank",
  "FNB",
  "Absa",
  "Nedbank",
  "Investec",
  "Capitec",
  "Discovery Bank",
  "TymeBank",
  "Microsoft",
  "Google",
  "Apple",
  "DocuSign",
  "Adobe",
  "SARS",
  "Xero",
  "Sage",
  "DHL",
  "FedEx",
  "Aramex",
  "The Courier Guy",
  "PostNet",
  "Takealot",
  "Netflix",
  "PayPal",
  "Payfast",
  "Yoco",
];

const source = (url: string, names: string[]) => ({ url, read: "2026-10-29", names, evidence: "Official site." });
// A table unlike the bundled one, to tell which the reader used.
const kvTable = (revision = "2026-10-30") => ({
  version: 1,
  revision,
  brands: [
    {
      name: "Fynbos Freight",
      display_names: ["Fynbos Freight", "FynbosFreight"],
      domains: ["fynbosfreight.example"],
      user_content: [],
      sources: [source("https://fynbosfreight.example/security", ["fynbosfreight.example"])],
    },
  ],
  excluded: [],
});

function kv(get: (key: string) => Promise<unknown>) {
  return { CACHE: { get: vi.fn(get) } as unknown as KVNamespace };
}
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  forgetBrandTable();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});
const reasons = () => warn.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])).reason);

describe("the bundled table", () => {
  it("is valid, with every domain sourced from a dated page on the brand's own site", () => {
    expect(BrandTable.safeParse(bundled).success).toBe(true);
    for (const brand of bundled.brands)
      for (const domain of brand.domains)
        expect(
          brand.sources.some((s) => s.names.includes(domain)),
          `${brand.name} ${domain}`,
        ).toBe(true);
  });

  it("covers each of the 26 named brands, or says why one is left out", () => {
    const present = new Set(bundled.brands.map((b) => b.name));
    const excluded = new Set(bundled.excluded.map((e) => e.name));
    for (const name of NAMED) expect(present.has(name) || excluded.has(name), name).toBe(true);
  });

  it("lists no customer-tenant domain as a brand's", () => {
    const all = bundled.brands.flatMap((b) => b.domains);
    for (const tenant of ["sharepoint.com", "googleusercontent.com", "azurewebsites.net", "blogspot.com", "github.io"])
      expect(all).not.toContain(tenant);
  });
});

describe("the schema", () => {
  const valid = kvTable();
  const brand = valid.brands[0] as (typeof valid.brands)[number];
  const withBrand = (change: Record<string, unknown>) => ({ ...valid, brands: [{ ...brand, ...change }] });

  it("refuses an empty table, empty lists, bad domains, foreign or undated sources and unsourced domains", () => {
    expect(BrandTable.safeParse(valid).success).toBe(true);
    const refused = [
      { ...valid, brands: [] },
      { ...valid, version: 2 },
      withBrand({ display_names: [] }),
      withBrand({ domains: [] }),
      withBrand({ domains: ["Fynbos Freight"] }),
      withBrand({ domains: ["www.fynbosfreight.example"] }),
      withBrand({ sources: [source("https://elsewhere.example/page", ["fynbosfreight.example"])] }),
      withBrand({ sources: [source("http://fynbosfreight.example/page", ["fynbosfreight.example"])] }),
      withBrand({ sources: [{ ...source("https://fynbosfreight.example/p", ["fynbosfreight.example"]), read: "" }] }),
      withBrand({ domains: ["fynbosfreight.example", "fynbos.example"] }),
      withBrand({ user_content: ["sites.other.example"] }),
    ];
    for (const [i, table] of refused.entries()) expect(BrandTable.safeParse(table).success, String(i)).toBe(false);
  });
});

describe("brandTable", () => {
  it("uses KV's copy when it is valid", async () => {
    const table = await brandTable(kv(async () => kvTable()));
    expect(table.revision).toBe("2026-10-30");
    expect(reasons()).toEqual([]);
  });

  it("falls back to the bundled table, logged, for a missing, wrong-version, invalid, refused or stalled read", async () => {
    const cases: [string, (key: string) => Promise<unknown>][] = [
      ["missing", async () => null],
      ["version", async () => ({ ...kvTable(), version: 2 })],
      ["invalid", async () => ({ ...kvTable(), brands: [] })],
      ["refused", async () => Promise.reject(new TypeError("KV down"))],
      ["stalled", () => new Promise(() => {})],
    ];
    vi.useFakeTimers();
    for (const [reason, get] of cases) {
      forgetBrandTable();
      warn.mockClear();
      const reading = brandTable(kv(get));
      await vi.advanceTimersByTimeAsync(KV_READ_MS + 1);
      expect((await reading).revision, reason).toBe(bundled.revision);
      expect(reasons(), reason).toEqual([reason]);
    }
  });

  it("reads the key it names, and holds what it read for a minute", async () => {
    let now = 1_000;
    const env = kv(async () => kvTable());
    await brandTable(env, () => now);
    await brandTable(env, () => now + HELD_MS - 1);
    expect(env.CACHE.get).toHaveBeenCalledTimes(1);
    expect(env.CACHE.get).toHaveBeenCalledWith(BRANDS_KEY, "json");
    now += HELD_MS;
    await brandTable(env, () => now);
    expect(env.CACHE.get).toHaveBeenCalledTimes(2);
  });

  it("reads a new revision, and a restored one, without a rebuild", async () => {
    let stored: unknown = kvTable("2026-10-30");
    let now = 0;
    const env = kv(async () => stored);
    expect((await brandTable(env, () => now)).revision).toBe("2026-10-30");
    stored = kvTable("2026-11-05");
    now += HELD_MS;
    expect((await brandTable(env, () => now)).revision).toBe("2026-11-05");
    stored = kvTable("2026-10-30");
    now += HELD_MS;
    expect((await brandTable(env, () => now)).revision).toBe("2026-10-30");
  });
});

describe("the completion review (2026-10-29)", () => {
  it("knows the brands' operational domains: SARS eFiling and Payfast's own", () => {
    expect(brandForDomain(bundled, "secure.sarsefiling.co.za")).toMatchObject({
      brand: { name: "SARS" },
      official: true,
    });
    expect(brandForDomain(bundled, "www.payfast.co.za")).toMatchObject({ brand: { name: "Payfast" }, official: true });
  });

  it("gives customer content on a brand's own host or path no official standing", () => {
    expect(brandForUrl(bundled, "https://www.paypal.com/invoice/p/#INV2-ABCD")).toMatchObject({
      brand: { name: "PayPal" },
      official: false,
    });
    expect(brandForUrl(bundled, "https://www.paypal.com/signin")).toMatchObject({ official: true });
    expect(brandForDomain(bundled, "communityhub.sage.com")).toMatchObject({
      brand: { name: "Sage" },
      official: false,
    });
    expect(brandForUrl(bundled, "https://sites.google.com/view/lure")).toMatchObject({ official: false });
    expect(brandForUrl(bundled, "not a url")).toBeNull();
  });
});

describe("round 1 (2026-10-29)", () => {
  it("gives Microsoft Q&A and Apple Discussions no official standing", () => {
    expect(brandForUrl(bundled, "https://learn.microsoft.com/en-us/answers/questions/123/lure")).toMatchObject({
      brand: { name: "Microsoft" },
      official: false,
    });
    expect(brandForUrl(bundled, "https://learn.microsoft.com/en-za/answers/questions/9")).toMatchObject({
      official: false,
    });
    expect(brandForUrl(bundled, "https://learn.microsoft.com/en-us/azure/")).toMatchObject({ official: true });
    expect(brandForDomain(bundled, "discussions.apple.com")).toMatchObject({
      brand: { name: "Apple" },
      official: false,
    });
  });

  it("answers a host alone as not official when some of its paths carry other people's content", () => {
    expect(brandForDomain(bundled, "www.paypal.com")).toMatchObject({ brand: { name: "PayPal" }, official: false });
    expect(brandForDomain(bundled, "paypal.com")).toMatchObject({ official: true });
    expect(brandForDomain(bundled, "learn.microsoft.com")).toMatchObject({ official: false });
  });

  it("knows Microsoft's sign-in hosts, and that live.com itself is anyone's mailbox", () => {
    expect(brandForDomain(bundled, "login.microsoftonline.com")).toMatchObject({
      brand: { name: "Microsoft" },
      official: true,
    });
    expect(brandForDomain(bundled, "login.live.com")).toMatchObject({ brand: { name: "Microsoft" }, official: true });
    expect(brandForDomain(bundled, "live.com")).toMatchObject({ brand: { name: "Microsoft" }, official: false });
  });
});

describe("getBrand and brandForDomain", () => {
  it("finds a brand by any of its names, without regard to case, spacing or punctuation", () => {
    expect(getBrand(bundled, "fnb")?.name).toBe("FNB");
    expect(getBrand(bundled, "First National Bank")?.name).toBe("FNB");
    expect(getBrand(bundled, "  FIRST-NATIONAL bank ")?.name).toBe("FNB");
    expect(getBrand(bundled, "Docu Sign")?.name).toBe("DocuSign");
    expect(getBrand(bundled, "Fynbos Freight")).toBeNull();
    expect(getBrand(bundled, "")).toBeNull();
  });

  it("answers a brand's domains and subdomains as official, and nothing that only ends like them", () => {
    expect(brandForDomain(bundled, "fnb.co.za")).toMatchObject({ brand: { name: "FNB" }, official: true });
    expect(brandForDomain(bundled, "Secure.FNB.co.za.")).toMatchObject({ brand: { name: "FNB" }, official: true });
    for (const host of ["fnb.co.za.example", "fnb-co-za.example", "myfnb.co.za", "example.test", "localhost"])
      expect(brandForDomain(bundled, host), host).toBeNull();
  });

  it("answers a host where a brand publishes other people's content as its platform, not the brand", () => {
    expect(brandForDomain(bundled, "sites.google.com")).toMatchObject({ brand: { name: "Google" }, official: false });
    expect(brandForDomain(bundled, "accounts.google.com")).toMatchObject({ brand: { name: "Google" }, official: true });
    // A customer's host on a provider's private suffix is the customer's.
    expect(brandForDomain(bundled, "lure.blob.core.windows.net")).toBeNull();
  });
});
