import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BrandTable } from "../../src/checks/brand-schema";
import type { CaseView } from "../../src/checks/case-view";
import {
  headerDomains,
  lookalikeEvidence,
  MAX_COMPARED,
  MAX_LOOKALIKES,
  split,
} from "../../src/checks/domain-lookalike";
import { readEvidence } from "../../src/checks/evidence";
import { runChecks } from "../../src/checks/runner";
import { createCase } from "../../src/db/cases";
import { parsedKey, putParsed, putRaw, rawKey, type Store } from "../../src/intake/store";
import { checks } from "../../src/pipeline/analysis-workflow";

// D02 T03 §2: the original's header domains against the organisation's own, its suppliers' and the brand table's.
const OWN = "fynbosfreight.co.za";
const SUPPLIER = "karooparts.co.za";
const brand = (name: string, domains: string[]) => ({
  name,
  display_names: [name],
  domains,
  user_content: [],
  sources: [],
});
const TABLE = {
  version: 1,
  revision: "test",
  community_labels: [],
  brands: [brand("Example Bank", ["examplebank.co.za"]), brand("Example", ["example.com"])],
  excluded: [],
} as unknown as BrandTable;

const h = (name: string, value: string) => ({ name, value });
function view(
  headers: { name: string; value: string }[],
  { headersAvailable = true, suppliers = [SUPPLIER], brands = TABLE } = {},
): CaseView {
  return {
    tenant: {
      orgId: "org-lookalike",
      channel: "email",
      receivers: [],
      headersAvailable,
      trusted: { own: [OWN], suppliers },
    },
    raw: "raw/case-lookalike/message.eml",
    brands,
    senderHistory: null,
    domainAges: null,
    attachmentHeads: null,
    hiddenText: null,
    htmlAttachments: null,
    attachmentRisks: null,
    instructions: null,
    invisibleText: null,
    links: null,
    expansions: null,
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers,
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
  };
}
const from = (address: string) => view([h("From", `Accounts <${address}>`)]);
const only = (v: CaseView) => {
  const items = lookalikeEvidence(v);
  expect(items).toHaveLength(1);
  return items[0];
};

describe("headerDomains", () => {
  it("lists From, every Reply-To and the topmost Return-Path as registrable domains with their fields", () => {
    const v = view([
      h("Return-Path", "<bounce@mail.bounce.example>"),
      h("Return-Path", "<older@ignored.example>"),
      h("From", "Accounts <billing@sub.fynbosfreight.co.za>"),
      h("Reply-To", "a@one.example, b@two.example"),
      h("Reply-To", "c@one.example"),
    ]);
    expect(headerDomains(v).map((d) => [d.domain, d.fields])).toEqual([
      ["fynbosfreight.co.za", ["From"]],
      ["one.example", ["Reply-To"]],
      ["two.example", ["Reply-To"]],
      ["bounce.example", ["Return-Path"]],
    ]);
  });

  it("lists none without the original's own headers", () => {
    expect(headerDomains(view([h("From", "member@member.example")], { headersAvailable: false }))).toEqual([]);
  });
});

describe("domain.lookalike", () => {
  it("finds the four techniques against the organisation's own domain, high", () => {
    const cases: [string, string][] = [
      ["billing@fynbоsfreight.co.za", "skeleton"],
      ["billing@fynbosfreight.com", "different-tld"],
      ["billing@fynbosfreight-payments.co.za", "added-word"],
      ["billing@fynbosfreigth.co.za", "edit"],
    ];
    for (const [address, technique] of cases) {
      const item = only(from(address));
      expect(item, address).toMatchObject({
        check: "domain.lookalike",
        severity: "high",
        artefacts: ["raw/case-lookalike/message.eml"],
        detail: { target: OWN, targetKind: "own", technique, fields: ["From"] },
      });
      expect(item?.summary.length).toBeLessThanOrEqual(200);
    }
  });

  it("never flags an exact match, the organisation's own domain or a brand's own", () => {
    for (const address of [
      "billing@fynbosfreight.co.za",
      "a@mail.fynbosfreight.co.za",
      "x@examplebank.co.za",
      "x@karooparts.co.za",
    ])
      expect(lookalikeEvidence(from(address)), address).toEqual([]);
  });

  it("is high for a supplier's lookalike, and runs the same without suppliers", () => {
    expect(only(from("pay@karoopart.co.za"))).toMatchObject({
      severity: "high",
      detail: { target: SUPPLIER, targetKind: "supplier", technique: "edit" },
    });
    expect(lookalikeEvidence(view([h("From", "pay@karoopart.co.za")], { suppliers: [] }))).toEqual([]);
  });

  it("is medium for a brand's lookalike, naming the brand", () => {
    expect(only(from("alerts@examp1ebank.co.za"))).toMatchObject({
      severity: "medium",
      detail: { target: "examplebank.co.za", targetKind: "brand", brand: "Example Bank", technique: "skeleton" },
    });
  });

  it("reads example.org against example.com as a different ending, unless the brand table lists both", () => {
    expect(only(from("x@example.org"))).toMatchObject({ severity: "medium", detail: { technique: "different-tld" } });
    const both = { ...TABLE, brands: [brand("Example", ["example.com", "example.org"])] } as unknown as BrandTable;
    expect(lookalikeEvidence(view([h("From", "x@example.org")], { brands: both }))).toEqual([]);
  });

  it("prefers the organisation's own target over a brand, and cites every field the domain came from", () => {
    const v = view([h("From", "a@fynbosfreight.com"), h("Reply-To", "b@fynbosfreight.com")]);
    expect(only(v)).toMatchObject({
      severity: "high",
      detail: {
        targetKind: "own",
        fields: ["From", "Reply-To"],
        headers: ["From: a@fynbosfreight.com", "Reply-To: b@fynbosfreight.com"],
      },
    });
  });

  it("does not compare short labels by edit distance", () => {
    const table = { ...TABLE, brands: [brand("Short", ["absa.co.za"])] } as unknown as BrandTable;
    expect(lookalikeEvidence(view([h("From", "x@absb.co.za")], { brands: table }))).toEqual([]);
  });
});

describe("domain.lookalike's bounds and limits (plan review)", () => {
  it("keeps the strongest 20 and counts the rest, so the runner keeps the findings", async () => {
    const replyTo = Array.from({ length: 30 }, (_, i) => `a@fynbosfreight${i}.co.za`).join(", ");
    const v = view([h("From", "x@unrelated.example"), h("Reply-To", replyTo)]);
    const items = lookalikeEvidence(v);
    expect(items).toHaveLength(MAX_LOOKALIKES + 1);
    expect(items[MAX_LOOKALIKES]).toMatchObject({ severity: "high", detail: { more: 10 } });
    const run = await runChecks(v);
    expect(run.some((e) => e.check === "not_checked")).toBe(false);
    expect(run.filter((e) => e.check === "domain.lookalike")).toHaveLength(MAX_LOOKALIKES + 1);
  });

  it("says a right-to-left domain was not compared, and still compares the rest", () => {
    const v = view([h("From", "x@\u05d0\u05d1\u05d2\u05d3.co.za"), h("Reply-To", "y@fynbosfreight.com")]);
    const items = lookalikeEvidence(v);
    expect(items.map((i) => [i.severity, i.detail.technique ?? i.detail.compared])).toEqual([
      ["high", "different-tld"],
      ["info", false],
    ]);
  });

  it("says a trusted domain could not be compared, and still compares the others", () => {
    const v = view([h("From", "y@fynbosfreight.com")]);
    v.tenant.trusted.own.push("\u05d0\u05d1\u05d2\u05d3.co.za");
    const items = lookalikeEvidence(v);
    expect(items.map((i) => i.severity)).toEqual(["high", "info"]);
    expect(items[1]?.detail).toMatchObject({ compared: false });
  });

  it("flags neither an unrelated domain nor one three edits away", () => {
    for (const address of ["x@totallydifferent.co.za", "x@fynbosfroyghx.co.za"])
      expect(lookalikeEvidence(from(address)), address).toEqual([]);
  });

  it("reads an A-label and its Unicode form as one domain", () => {
    const ascii = new URL("http://fynb\u043esfreight.co.za").hostname;
    expect(ascii.startsWith("xn--")).toBe(true);
    const v = view([h("From", `a@${ascii}`), h("Reply-To", "b@fynb\u043esfreight.co.za")]);
    expect(only(v)).toMatchObject({ detail: { technique: "skeleton", fields: ["From", "Reply-To"] } });
  });

  it("reads one domain as one in either order of Unicode and A-label (completion review)", () => {
    const ascii = new URL("http://fynb\u043esfreight.co.za").hostname;
    for (const [first, second] of [
      ["fynb\u043esfreight.co.za", ascii],
      [ascii, "fynb\u043esfreight.co.za"],
    ]) {
      const v = view([h("From", `a@${first}`), h("Reply-To", `b@${second}`)]);
      expect(only(v)).toMatchObject({ detail: { domain: ascii, technique: "skeleton", fields: ["From", "Reply-To"] } });
    }
  });

  it("compares at most MAX_COMPARED domains, quickly, and counts the rest as not compared (completion review)", () => {
    const many = Array.from({ length: 4000 }, (_, i) => `a@d${i}-unrelated.example`).join(", ");
    const v = view([h("From", "x@fynbosfreight.com"), h("Reply-To", many)]);
    const started = Date.now();
    const items = lookalikeEvidence(v);
    expect(Date.now() - started).toBeLessThan(500);
    expect(items[0]).toMatchObject({ severity: "high", detail: { technique: "different-tld" } });
    const rest = items.find((i) => Array.isArray(i.detail.unread));
    expect(rest?.detail.unreadCount).toBe(4001 - MAX_COMPARED);
  });

  it("compares the From first and leaves a domain past the budget counted, not compared", () => {
    const filler = Array.from({ length: MAX_COMPARED }, (_, i) => `a@d${i}-unrelated.example`);
    const v = view([h("From", "x@unrelated.example"), h("Reply-To", [...filler, "z@fynbosfreight.net"].join(", "))]);
    const items = lookalikeEvidence(v);
    expect(items.some((i) => i.detail.domain === "fynbosfreight.net")).toBe(false);
    const rest = items.find((i) => typeof i.detail.unreadCount === "number");
    expect(rest?.detail.unread).toContain("fynbosfreight.net");
  });

  it("stays within its budget when every finding cites a header of megabytes (round 1)", () => {
    const addresses = Array.from({ length: 99 }, (_, i) => `a@fynbosfreight${i}.co.za`).join(", ");
    const v = view([h("From", "x@unrelated.example"), h("Reply-To", `${addresses} (${"x".repeat(2_000_000)})`)]);
    const started = Date.now();
    const items = lookalikeEvidence(v);
    expect(Date.now() - started).toBeLessThan(500);
    expect(items.filter((i) => i.severity === "high").length).toBeGreaterThan(0);
    for (const item of items) expect(JSON.stringify(item.detail).length).toBeLessThan(64 * 1024);
  });

  it("reads a Return-Path with a comment around its address (round 1)", () => {
    const v = view([h("From", "x@unrelated.example"), h("Return-Path", "<bounce@fynbosfreight.com> (comment)")]);
    expect(only(v)).toMatchObject({ detail: { domain: "fynbosfreight.com", fields: ["Return-Path"] } });
  });

  it("accounts for every domain and trusted domain not compared, keeping the findings (completion review)", () => {
    const rtl = Array.from({ length: 21 }, (_, i) => `a@\u05d0\u05d1${"\u05d2".repeat(i + 1)}.co.za`).join(", ");
    const v = view([h("From", "x@fynbosfreight.com"), h("Reply-To", rtl)]);
    v.tenant.trusted.own.push("\u05d0\u05d1\u05d3.co.za");
    const items = lookalikeEvidence(v);
    expect(items[0]?.severity).toBe("high");
    const listed = items.filter((i) => typeof i.detail.domain === "string" && i.detail.compared === false);
    const aggregate = items.find((i) => Array.isArray(i.detail.unlisted));
    expect(listed.length + Number(aggregate?.detail.unlistedCount ?? 0)).toBe(21);
    expect(items.some((i) => Array.isArray(i.detail.targets))).toBe(true);
  });

  it("names the organisation's own target over a brand both imitate", () => {
    const table = { ...TABLE, brands: [brand("Fynbos Bank", ["fynbosfreigh.co.za"])] } as unknown as BrandTable;
    expect(only(view([h("From", "x@fynbosfreight.net")], { brands: table }))).toMatchObject({
      severity: "high",
      detail: { target: OWN, targetKind: "own" },
    });
  });
});

describe("domain.lookalike through the checks step", () => {
  it("stores a lookalike of the organisation's verified domain as high", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const org = `org-look-${crypto.randomUUID().slice(0, 8)}`;
    const own = `own${crypto.randomUUID().slice(0, 6)}freight.co.za`;
    await env.DB.prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
      .bind(crypto.randomUUID(), org, own, "t".repeat(32), new Date().toISOString(), new Date().toISOString())
      .run();
    // Another organisation's verified domain and this one's pending domain: neither is a target (plan review).
    const other = `other${crypto.randomUUID().slice(0, 6)}freight.co.za`;
    const pending = `pend${crypto.randomUUID().slice(0, 6)}freight.co.za`;
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, 'org-elsewhere', ?, ?, 'verified', 'dns', ?, ?)",
      ).bind(crypto.randomUUID(), other, "t".repeat(32), now, now),
      env.DB.prepare(
        "INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
      ).bind(crypto.randomUUID(), org, pending, "t".repeat(32), now),
    ]);
    const made = await createCase(env.DB, { orgId: org, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nPay.\r\n"));
    const lookalike = own.replace(".co.za", ".com");
    await putParsed(store, id, {
      headers: [
        h("Return-Path", `<bounce@${lookalike}>`),
        h("From", `Accounts <billing@${lookalike}>`),
        h("Reply-To", `pay@${lookalike}, a@${other.replace(".co.za", ".com")}, b@${pending.replace(".co.za", ".com")}`),
      ],
      text: "Pay.",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "rfc822", headersAvailable: true, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: org, channel: "email" }, async () => []);
    const items = (await readEvidence(env.DB, id)).filter((e) => e.check === "domain.lookalike");
    expect(items).toMatchObject([
      {
        severity: "high",
        artefacts: [rawKey(id)],
        detail: {
          domain: lookalike,
          target: own,
          targetKind: "own",
          technique: "different-tld",
          fields: ["From", "Reply-To", "Return-Path"],
        },
      },
    ]);
  });
});

// D02 T03 §11: IsItLegit's demo organisations each have a domain of their own under demo.isitlegit.co.za.
describe("demo domains", () => {
  const demo = (name: string) => `${name}.demo.isitlegit.co.za`;
  const withOwn = (headers: { name: string; value: string }[], own: string[]) => {
    const v = view(headers);
    return { ...v, tenant: { ...v.tenant, trusted: { own, suppliers: [] } } };
  };

  it("splits a demo domain at the suffix: the label before it, the suffix being IsItLegit's", () => {
    expect(split("fynb0s.demo.isitlegit.co.za")).toEqual({
      domain: demo("fynb0s"),
      label: "fynb0s",
      suffix: "demo.isitlegit.co.za",
    });
    expect(split("mail.fynbos.demo.isitlegit.co.za")).toMatchObject({ domain: demo("fynbos"), label: "fynbos" });
    expect(split("demo.isitlegit.co.za")).toBeNull();
    // Elsewhere, as before.
    expect(split("mail.fynbos.co.za")).toMatchObject({ domain: "fynbos.co.za", label: "fynbos", suffix: "co.za" });
  });

  it("finds a lookalike of one demo organisation's domain, none of an unrelated one's or its own subdomain", () => {
    const own = [demo("fynbos")];
    const found = lookalikeEvidence(withOwn([h("From", `Accounts <x@${demo("fynb0s")}>`)], own));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "high", detail: { domain: demo("fynb0s"), target: demo("fynbos") } });
    // An unrelated demo organisation is no lookalike of it.
    expect(lookalikeEvidence(withOwn([h("From", `Accounts <x@${demo("karoo")}>`)], own))).toEqual([]);
    // Nor is the organisation's own subdomain.
    expect(lookalikeEvidence(withOwn([h("From", `Accounts <x@mail.${demo("fynbos")}>`)], own))).toEqual([]);
  });
});

describe("lookalikes in links and landing pages (D02 T03 §7)", () => {
  const linkItem = (host: string) => ({
    raw: `https://${host}/x`,
    href: `https://${host}/x`,
    host,
    display: host,
    kind: "text" as const,
    part: "body",
    anchor: null,
  });
  const withLinks = (base: CaseView, hosts: string[]): CaseView => ({
    ...base,
    links: { items: hosts.map(linkItem), more: 0, unread: [] },
    expansions: { items: [], skipped: [] },
  });
  const lookalikes = (v: CaseView) =>
    lookalikeEvidence(v).filter((i) => i.severity === "high" || i.severity === "medium");

  it("finds a lookalike link host, naming where it was found", () => {
    const items = lookalikes(withLinks(from("billing@sender.example"), ["examplebank-secure.co.za"]));
    expect(items).toHaveLength(1);
    expect(items[0]?.summary).toContain("in a link");
    expect(items[0]?.detail.found).toEqual([{ via: "link", url: "https://examplebank-secure.co.za/x", part: "body" }]);
  });

  it("finds a lookalike behind a redirect and on the page it lands on", () => {
    const expansion = {
      link: "https://short.example/a",
      outcome: "done" as const,
      reason: null,
      hops: [
        {
          url: "https://examplebank-secure.co.za/hop",
          host: "examplebank-secure.co.za",
          status: 302,
          location: "https://examplebnk.co.za/land",
          via: "server" as const,
        },
      ],
      final: "https://examplebnk.co.za/land",
      finalHost: "examplebnk.co.za",
      landing: null,
      downloads: [],
      refused: [],
      ms: 1,
    };
    const base = { ...from("billing@sender.example"), expansions: { items: [expansion], skipped: [] } };
    const items = lookalikes(base as CaseView);
    const byDomain = new Map(items.map((i) => [i.detail.domain, i]));
    expect(byDomain.get("examplebank-secure.co.za")?.summary).toContain("behind a redirect");
    expect(byDomain.get("examplebnk.co.za")?.summary).toContain("on the page it lands on");
  });

  it("never calls an interrupted chain's last host a landing, and never flags the organisation's own domain", () => {
    const expansion = {
      link: "https://short.example/a",
      outcome: "timeout" as const,
      reason: "deadline",
      hops: [],
      final: "https://examplebnk.co.za/stuck",
      finalHost: "examplebnk.co.za",
      landing: null,
      downloads: [],
      refused: [],
      ms: 1,
    };
    const base = {
      ...withLinks(from("billing@sender.example"), ["fynbosfreight.co.za"]),
      expansions: { items: [expansion], skipped: [] },
    };
    const items = lookalikes(base as CaseView);
    expect(items).toHaveLength(1);
    expect(items[0]?.summary).toContain("behind a redirect");
    expect(items[0]?.summary).not.toContain("lands on");
  });

  it("runs without the original's headers when the case has links, and merges a domain found twice", () => {
    const base = view([h("From", "Accounts <billing@example.com>")], { headersAvailable: false });
    const items = lookalikes(withLinks(base, ["examplebank-secure.co.za"]));
    expect(items).toHaveLength(1);
    const merged = lookalikes(withLinks(from("billing@examplebank-secure.co.za"), ["examplebank-secure.co.za"]));
    const both = merged.filter((i) => i.detail.domain === "examplebank-secure.co.za");
    expect(both).toHaveLength(1);
    expect(both[0]?.detail.fields).toEqual(expect.arrayContaining(["From", "in a link"]));
  });

  it("accounts for candidates past the bound, with findings kept", () => {
    const hosts = [
      "examplebank-secure.co.za",
      ...Array.from({ length: MAX_COMPARED + 4 }, (_, i) => `plain${i}.example`),
    ];
    const items = lookalikeEvidence(withLinks(from("billing@sender.example"), hosts));
    expect(items.some((i) => i.detail.domain === "examplebank-secure.co.za")).toBe(true);
    const accounting = items.find((i) => i.detail.unreadCount !== undefined);
    expect(accounting?.detail.unreadCount).toBe(6);
  });

  it("stores the evidence through the checks step and reads it back", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-lookalike", channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nHi.\r\n"));
    await putParsed(store, id, {
      headers: [{ name: "From", value: "Accounts <billing@sender.example>" }],
      text: "Pay here: https://standardbank-secure.co.za/x",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "inline", headersAvailable: false, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: "org-lookalike", channel: "email" }, async () => []);
    const stored = (await readEvidence(env.DB, id)).filter((e) => e.check === "domain.lookalike");
    const hit = stored.find((e) => e.detail.domain === "standardbank-secure.co.za");
    expect(hit).toBeDefined();
    expect(hit?.detail.found).toEqual([{ via: "link", url: "https://standardbank-secure.co.za/x", part: "summary" }]);
  });
});

describe("lookalike partial outcomes (D02 T03 §7, completion review)", () => {
  const outcomesOf = async (id: string) => {
    const { readCheckOutcomes } = await import("../../src/checks/evidence");
    return (await readCheckOutcomes(env.DB, id)) ?? [];
  };
  it("reads partial when a followed page did not finish, and when links were not followed", async () => {
    const store: Store = { bucket: env.ARTEFACTS, db: env.DB };
    const made = await createCase(env.DB, { orgId: "org-lookalike", channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await putRaw(store, id, new TextEncoder().encode("From: x@y.example\r\n\r\nHi.\r\n"));
    await putParsed(store, id, {
      headers: [{ name: "From", value: "Accounts <billing@sender.example>" }],
      text: "Pay here: https://standardbank-secure.co.za/x",
      html: null,
      attachments: [],
      truncated: [],
      omitted: 0,
      forward: { path: "inline", headersAvailable: false, otherOriginals: 0 },
    });
    await checks(store, id, parsedKey(id), { orgId: "org-lookalike", channel: "email" }, async () => []);
    const outcomes = await outcomesOf(id);
    const lookalike = outcomes.find((o) => o.check === "domain.lookalike");
    expect(lookalike?.outcome).toBe("partial");
    expect(lookalike?.reason).toContain("not followed");
  });
});

describe("lookalike eligibility and provenance counting (D02 T03 §7, round 1)", () => {
  it("runs for a headerless case whose link sources went unread, so it can read partial", async () => {
    const { CheckRegistry } = await import("../../src/checks/registry");
    const { registerLookalikeCheck } = await import("../../src/checks/domain-lookalike");
    const registry = new CheckRegistry();
    registerLookalikeCheck(registry);
    const check = registry.all().find((c) => c.name === "domain.lookalike");
    const base = view([h("From", "Accounts <billing@sender.example>")], { headersAvailable: false });
    const withUnread = {
      ...base,
      links: { items: [], more: 0, unread: [{ key: "attachment-1", why: "damaged" as const }] },
    } as CaseView;
    expect(check?.applies?.(withUnread)).toBeNull();
    expect(check?.partial?.(withUnread)).toContain("not read");
    const empty = { ...base, links: { items: [], more: 0, unread: [] } } as CaseView;
    expect(check?.applies?.(empty)).toContain("no links");
  });

  it("does not count an identical provenance twice toward the overflow count", () => {
    const base = from("billing@sender.example");
    const item = {
      raw: "https://examplebank-secure.co.za/x",
      href: "https://examplebank-secure.co.za/x",
      host: "examplebank-secure.co.za",
      display: "examplebank-secure.co.za",
      kind: "text" as const,
      part: "body",
      anchor: null,
    };
    const v = { ...base, links: { items: [item, { ...item, anchor: "Pay now" }], more: 0, unread: [] } } as CaseView;
    const hit = lookalikeEvidence(v).find((i) => i.detail.domain === "examplebank-secure.co.za");
    expect(hit?.detail.found).toHaveLength(1);
    expect(hit?.detail.foundMore).toBeUndefined();
  });
});

describe("lookalike provenance past the bound (D02 T03 §7, round 2)", () => {
  it("counts a repeated provenance once even after the retained list is full", () => {
    const base = from("billing@sender.example");
    const mk = (n: number, anchor: string | null = null) => ({
      raw: `https://examplebank-secure.co.za/p${n}`,
      href: `https://examplebank-secure.co.za/p${n}`,
      host: "examplebank-secure.co.za",
      display: "examplebank-secure.co.za",
      kind: "text" as const,
      part: "body",
      anchor,
    });
    const items = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6), mk(6, "Pay now"), mk(1, "Again")];
    const v = { ...base, links: { items, more: 0, unread: [] } } as CaseView;
    const hit = lookalikeEvidence(v).find((i) => i.detail.domain === "examplebank-secure.co.za");
    expect(hit?.detail.found).toHaveLength(5);
    expect(hit?.detail.foundMore).toBe(1);
  });
});

describe("lookalike clean summary names the domains compared (D02 T03 §12)", () => {
  const linkItem = (host: string) => ({
    raw: `https://${host}/x`,
    href: `https://${host}/x`,
    host,
    display: host,
    kind: "text" as const,
    part: "body",
    anchor: null,
  });
  const withLinks = (base: CaseView, hosts: string[]): CaseView => ({
    ...base,
    links: { items: hosts.map(linkItem), more: 0, unread: [] },
    expansions: { items: [], skipped: [] },
  });
  const untrustedView = (headers: { name: string; value: string }[]): CaseView => {
    const v = view(headers, { suppliers: [] });
    return { ...v, tenant: { ...v.tenant, trusted: { own: [], suppliers: [] } } };
  };
  const cleanFrom = (address: string) => untrustedView([h("From", `Accounts <${address}>`)]);

  it("names the count and first compared domain for three domains, one domain, and a 63-character hostname cut inside 120 characters", async () => {
    const { lookalikeSummary } = await import("../../src/checks/domain-lookalike");
    const { runChecksWithOutcomes } = await import("../../src/checks/runner");
    const { saveEvidence, readCheckOutcomes } = await import("../../src/checks/evidence");
    const { checks: allChecks } = await import("../../src/checks/index");

    // 1. Clean three-domain case (From + two links), read back from stored outcomes.
    const three = withLinks(cleanFrom("billing@fynbosfreight.example"), ["karoo.example", "cederberg.example"]);
    expect(lookalikeSummary(three, lookalikeEvidence(three))).toBe(
      "no lookalike among 3 domains, from fynbosfreight.example",
    );
    const madeThree = await createCase(env.DB, {
      orgId: "org-lookalike-s12",
      channel: "email",
      headersAvailable: true,
    });
    if (!madeThree.ok) throw new Error(madeThree.error.message);
    const runThree = await runChecksWithOutcomes(three);
    await saveEvidence(env.DB, madeThree.value.id, runThree.items, allChecks, undefined, runThree.outcomes);
    const storedThree = (await readCheckOutcomes(env.DB, madeThree.value.id))?.find(
      (o) => o.check === "domain.lookalike",
    );
    expect(storedThree?.summary).toBe("no lookalike among 3 domains, from fynbosfreight.example");

    // 2. One-domain case in the singular, read back from stored outcomes.
    const one = cleanFrom("billing@fynbosfreight.example");
    expect(lookalikeSummary(one, lookalikeEvidence(one))).toBe(
      "no lookalike among 1 domain, from fynbosfreight.example",
    );
    const madeOne = await createCase(env.DB, { orgId: "org-lookalike-s12", channel: "email", headersAvailable: true });
    if (!madeOne.ok) throw new Error(madeOne.error.message);
    const runOne = await runChecksWithOutcomes(one);
    await saveEvidence(env.DB, madeOne.value.id, runOne.items, allChecks, undefined, runOne.outcomes);
    const storedOne = (await readCheckOutcomes(env.DB, madeOne.value.id))?.find((o) => o.check === "domain.lookalike");
    expect(storedOne?.summary).toBe("no lookalike among 1 domain, from fynbosfreight.example");

    // 3. 63-character label under a long registrable domain cut inside the 120-character bound, both ordinary and partial.
    const longHost = `${"a".repeat(63)}.${"b".repeat(60)}`;
    const ordinaryLong = cleanFrom(`billing@${longHost}`);
    const ordinarySummary = lookalikeSummary(ordinaryLong, lookalikeEvidence(ordinaryLong));
    expect(ordinarySummary).toMatch(/^no lookalike among 1 domain, from a+…$/);
    expect(Array.from(ordinarySummary).length).toBeLessThanOrEqual(120);

    const partialLong = untrustedView([
      h("From", `billing@${longHost}`),
      h("Reply-To", "x@\u05d0\u05d1\u05d2\u05d3.co.za"),
    ]);
    const partialItems = lookalikeEvidence(partialLong);
    const partialSummary = lookalikeSummary(partialLong, partialItems);
    expect(partialSummary).toMatch(/^no lookalike among 1 domain compared, from a+…, some not compared$/);
    expect(Array.from(partialSummary).length).toBeLessThanOrEqual(120);

    // Stored outcome read-back for both ordinary and partial long summaries.
    const made1 = await createCase(env.DB, { orgId: "org-lookalike-s12", channel: "email", headersAvailable: true });
    if (!made1.ok) throw new Error(made1.error.message);
    const run1 = await runChecksWithOutcomes(ordinaryLong);
    await saveEvidence(env.DB, made1.value.id, run1.items, allChecks, undefined, run1.outcomes);
    const stored1 = (await readCheckOutcomes(env.DB, made1.value.id))?.find((o) => o.check === "domain.lookalike");
    expect(stored1?.summary).toBe(ordinarySummary);

    const made2 = await createCase(env.DB, { orgId: "org-lookalike-s12", channel: "email", headersAvailable: true });
    if (!made2.ok) throw new Error(made2.error.message);
    const run2 = await runChecksWithOutcomes(partialLong);
    await saveEvidence(env.DB, made2.value.id, run2.items, allChecks, undefined, run2.outcomes);
    const stored2 = (await readCheckOutcomes(env.DB, made2.value.id))?.find((o) => o.check === "domain.lookalike");
    expect(stored2?.summary).toBe(partialSummary);
  });

  it("keeps the uncompared wording after the count, skips uncompared or exempt domains first, and caps at MAX_COMPARED", async () => {
    const { lookalikeSummary } = await import("../../src/checks/domain-lookalike");

    // Skipped-first (right-to-left From, comparable Reply-To): names the compared domain, never the skipped one.
    const skippedFirst = untrustedView([
      h("From", "x@\u05d0\u05d1\u05d2\u05d3.co.za"),
      h("Reply-To", "billing@fynbosfreight.example"),
    ]);
    expect(lookalikeSummary(skippedFirst, lookalikeEvidence(skippedFirst))).toBe(
      "no lookalike among 1 domain compared, from fynbosfreight.example, some not compared",
    );

    // Exempt-first (trusted OWN From, comparable Reply-To): names the compared domain, never the exempt one.
    const exemptFirst = view([h("From", "billing@fynbosfreight.co.za"), h("Reply-To", "accounts@plain.example")]);
    expect(lookalikeSummary(exemptFirst, lookalikeEvidence(exemptFirst))).toBe(
      "no lookalike among 1 domain, from plain.example",
    );

    // Over-cap (MAX_COMPARED + 2 domains): counts only the 100 compared domains.
    const overCap = withLinks(
      cleanFrom("billing@fynbosfreight.example"),
      Array.from({ length: MAX_COMPARED + 1 }, (_, i) => `plain${i}.example`),
    );
    expect(lookalikeSummary(overCap, lookalikeEvidence(overCap))).toBe(
      `no lookalike among ${MAX_COMPARED} domains compared, from fynbosfreight.example, some not compared`,
    );

    // Exempt-only and zero-comparison cases (OWN is fynbosfreight.co.za in view()).
    const exemptOnly = view([h("From", "billing@fynbosfreight.co.za")]);
    expect(lookalikeSummary(exemptOnly, lookalikeEvidence(exemptOnly))).toBe(
      "trusted or reserved domains only, none compared",
    );
    const noCandidates = untrustedView([]);
    expect(lookalikeSummary(noCandidates, lookalikeEvidence(noCandidates))).toBe("no lookalike of a known name");
    const uncomparedOnly = untrustedView([h("From", "x@\u05d0\u05d1\u05d2\u05d3.co.za")]);
    expect(lookalikeSummary(uncomparedOnly, lookalikeEvidence(uncomparedOnly))).toBe(
      "no lookalike among the domains compared, some not compared",
    );
  });
});
