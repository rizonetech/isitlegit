import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BrandTable } from "../../src/checks/brand-schema";
import type { CaseView } from "../../src/checks/case-view";
import { headerDomains, lookalikeEvidence, MAX_COMPARED, MAX_LOOKALIKES } from "../../src/checks/domain-lookalike";
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
