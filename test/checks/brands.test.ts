import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SUFFIX } from "../../src/auth/senders";
import { DEMO_SUFFIX_OF_CHECKS } from "../../src/checks/brand-schema";
import {
  BRANDS_KEY,
  BrandTable,
  brandForDomain,
  brandForUrl,
  brandTable,
  brandTableRead,
  bundled,
  forgetBrandTable,
  getBrand,
  HELD_MS,
  KV_READ_MS,
  registrable,
  tableId,
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
// A one-brand table, to exercise the schema.
const smallTable = (revision = "2026-10-30") => ({
  version: 1,
  revision,
  community_labels: [],
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
// The bundled table under another revision, to tell which the reader used: a KV copy must name every bundled brand.
const kvTable = (revision = "2026-10-30") => ({ ...bundled, revision });

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
  const valid = smallTable();
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

describe("brandTableRead: where the table came from", () => {
  it("says kv for a valid KV copy, also one identical to the bundle, so a run is never recorded as bundled for reading KV", async () => {
    expect((await brandTableRead(kv(async () => kvTable("2026-10-30")))).source).toBe("kv");
    forgetBrandTable();
    const same = await brandTableRead(kv(async () => structuredClone(bundled)));
    expect(same.source).toBe("kv");
    expect(same.table.revision).toBe(bundled.revision);
  });

  it("says bundled for every fallback reason", async () => {
    const cases: [string, (key: string) => Promise<unknown>][] = [
      ["missing", async () => null],
      ["version", async () => ({ ...kvTable(), version: 2 })],
      ["invalid", async () => ({ ...kvTable(), brands: [] })],
      ["shrunk", async () => smallTable()],
      ["refused", async () => Promise.reject(new TypeError("KV down"))],
      ["stalled", () => new Promise(() => {})],
    ];
    vi.useFakeTimers();
    for (const [reason, get] of cases) {
      forgetBrandTable();
      const reading = brandTableRead(kv(get));
      await vi.advanceTimersByTimeAsync(KV_READ_MS + 1);
      const read = await reading;
      expect(read.source, reason).toBe("bundled");
      expect(read.table.revision, reason).toBe(bundled.revision);
    }
  });

  it("keeps the source of the read that filled a held value, and reads again after it expires", async () => {
    let now = 0;
    let stored: unknown = kvTable("2026-10-30");
    const env = kv(async () => stored);
    expect(await brandTableRead(env, () => now)).toMatchObject({ source: "kv" });
    // KV now has nothing, but the held value is still the one read, from KV.
    stored = null;
    expect(await brandTableRead(env, () => now + HELD_MS - 1)).toMatchObject({
      source: "kv",
      table: { revision: "2026-10-30" },
    });
    // After it expires the new read is bundled, and that is what is held.
    now += HELD_MS;
    expect(await brandTableRead(env, () => now)).toMatchObject({ source: "bundled" });
    stored = kvTable("2026-11-05");
    expect(await brandTableRead(env, () => now + 1)).toMatchObject({ source: "bundled" });
  });

  it("identifies a table by its content: two published under one revision date differ, one serialised twice does not", async () => {
    const a = kvTable("2026-11-05");
    const b = structuredClone(a);
    b.brands[0]?.display_names.push("Another Name");
    const idA = (await brandTableRead(kv(async () => a))).id;
    forgetBrandTable();
    const idB = (await brandTableRead(kv(async () => b))).id;
    expect(idA).toMatch(/^[0-9a-f]{12}$/);
    expect(idB).not.toBe(idA);
    // The same content with its keys in another order is the same table.
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a).reverse())));
    forgetBrandTable();
    expect((await brandTableRead(kv(async () => reordered))).id).toBe(idA);
    expect(await tableId(BrandTable.parse(a))).toBe(idA);
    // Directly, without the schema's own key order: the identity sorts keys itself.
    expect(await tableId(reordered as BrandTable)).toBe(idA);
    // A held value keeps the identity of the read that filled it; the bundle has its own.
    forgetBrandTable();
    expect((await brandTableRead(kv(async () => null))).id).toBe(await tableId(bundled));
  });

  it("never gives one namespace the table and source another read", async () => {
    const first = kv(async () => kvTable("2026-10-30"));
    const second = kv(async () => null);
    expect((await brandTableRead(first)).source).toBe("kv");
    expect((await brandTableRead(second)).source).toBe("bundled");
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
      ["shrunk", async () => smallTable()],
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
    // PayPal's mail can carry a customer's invoice from any PayPal host, so a host alone never says PayPal is speaking.
    expect(brandForDomain(bundled, "paypal.com")).toMatchObject({ official: false });
    expect(brandForUrl(bundled, "https://paypal.com/invoice/p/#INV2-ABCD")).toMatchObject({ official: false });
    expect(brandForUrl(bundled, "https://www.paypal.com/signin")).toMatchObject({ official: true });
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

describe("round 2 (2026-10-29)", () => {
  it("matches a path however it is encoded or cased", () => {
    for (const path of [
      "/en-us/%61nswers/questions/1",
      "/en-us/Answers/questions/1",
      "/EN-US/ANSWERS/x",
      "/en-us/answer%73/q",
    ])
      expect(brandForUrl(bundled, `https://learn.microsoft.com${path}`), path).toMatchObject({ official: false });
    expect(brandForUrl(bundled, "https://learn.microsoft.com/en-us/%zz/answers")).toMatchObject({ official: true });
  });

  it("treats a community, forum, discussion or answers host as other people's content on any brand", () => {
    for (const host of [
      "community.fabric.microsoft.com",
      "community.adobe.com",
      "forums.docusign.com",
      "answers.netflix.com",
    ])
      expect(brandForDomain(bundled, host), host).toMatchObject({ official: false });
    expect(brandForDomain(bundled, "communications.fnb.co.za")).toMatchObject({ official: true });
  });
});

describe("the final review (2026-10-29)", () => {
  it("matches a prefix itself and the locale-less route", () => {
    for (const path of ["/answers/questions/1", "/en-us/answers", "/answers"])
      expect(brandForUrl(bundled, `https://learn.microsoft.com${path}`), path).toMatchObject({ official: false });
  });

  it("gives OneDrive no official standing, while Microsoft's sign-in stays official", () => {
    expect(brandForDomain(bundled, "onedrive.live.com")).toMatchObject({
      brand: { name: "Microsoft" },
      official: false,
    });
    expect(brandForDomain(bundled, "login.live.com")).toMatchObject({ official: true });
  });

  it("pins the standing of the hosts that carry customers' words on a brand's own platform", () => {
    expect(brandForDomain(bundled, "docusign.net")).toMatchObject({ brand: { name: "DocuSign" }, official: false });
    expect(brandForDomain(bundled, "docusign.com")).toMatchObject({ official: true });
    expect(brandForDomain(bundled, "icloud.com")).toMatchObject({ brand: { name: "Apple" }, official: false });
    expect(brandForDomain(bundled, "apple.com")).toMatchObject({ official: true });
    expect(brandForDomain(bundled, "gmail.com")).toMatchObject({ brand: { name: "Google" }, official: false });
    expect(brandForDomain(bundled, "live.com")).toMatchObject({ brand: { name: "Microsoft" }, official: false });
  });

  it("keeps the community labels in the table, and reads them from the table in force", () => {
    expect(bundled.community_labels).toContain("community");
    const plain = { ...bundled, community_labels: [] };
    expect(brandForDomain(plain, "community.adobe.com")).toMatchObject({ official: true });
    expect(brandForDomain(bundled, "community.adobe.com")).toMatchObject({ official: false });
  });

  it("holds a read per namespace", async () => {
    const one = kv(async () => kvTable("2026-10-30"));
    const two = kv(async () => kvTable("2026-11-01"));
    expect((await brandTable(one, () => 0)).revision).toBe("2026-10-30");
    expect((await brandTable(two, () => 1)).revision).toBe("2026-11-01");
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

// D02 T03 §11: IsItLegit's demo suffix is a private suffix, so each demo organisation's domain is its own.
describe("registrable under the demo suffix", () => {
  it("keeps the checks' suffix the same as the one the claims use", () => {
    expect(DEMO_SUFFIX_OF_CHECKS).toBe(DEMO_SUFFIX);
  });

  it("refuses a malformed host under it, as the parser it replaced did, so it never becomes the organisation's domain", () => {
    for (const bad of [
      "mail..fynbos.demo.isitlegit.co.za",
      ".fynbos.demo.isitlegit.co.za",
      "-fynbos.demo.isitlegit.co.za",
      "fyn bos.demo.isitlegit.co.za",
      "fynbos_.demo.isitlegit.co.za",
      "fynbos.demo.isitlegit.co.za:8080.demo.isitlegit.co.za",
      `${"a".repeat(64)}.demo.isitlegit.co.za`,
      `${"a.".repeat(130)}fynbos.demo.isitlegit.co.za`,
    ])
      expect(registrable(bad), bad).toBeNull();
    expect(registrable(`${"a".repeat(63)}.demo.isitlegit.co.za`)).toBe(`${"a".repeat(63)}.demo.isitlegit.co.za`);
    expect(registrable("xn--bcher-kva.demo.isitlegit.co.za")).toBe("xn--bcher-kva.demo.isitlegit.co.za");
  });

  it("reduces a host under it to the one label before it, the suffix itself to nothing, other private suffixes kept", () => {
    expect(registrable("mail.fynbos.demo.isitlegit.co.za")).toBe("fynbos.demo.isitlegit.co.za");
    expect(registrable("FYNBOS.demo.isitlegit.co.za.")).toBe("fynbos.demo.isitlegit.co.za");
    expect(registrable("karoo.demo.isitlegit.co.za")).not.toBe(registrable("fynbos.demo.isitlegit.co.za"));
    expect(registrable("demo.isitlegit.co.za")).toBeNull();
    // IsItLegit's own domain and the rest of the public suffix list, as before.
    expect(registrable("app.isitlegit.co.za")).toBe("isitlegit.co.za");
    expect(registrable("a.github.io")).toBe("a.github.io");
    expect(registrable("x.blob.core.windows.net")).toBe("x.blob.core.windows.net");
    expect(registrable("mail.example.co.za")).toBe("example.co.za");
  });
});
