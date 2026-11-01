import { describe, expect, it } from "vitest";
import { floorFor } from "../../src/agent/floor";
import type { CaseView } from "../../src/checks/case-view";
import type { Expansion } from "../../src/checks/expand";
import { CheckRegistry } from "../../src/checks/registry";
import {
  counterSignalEvidence,
  coverageEvidence,
  listingEvidence,
  REPUTATION_PROVIDERS,
  type Reputation,
  registerReputationChecks,
  weighListing,
} from "../../src/checks/reputation";
import { runChecksWithOutcomes } from "../../src/checks/runner";

// D02 T06 §4 (spec 4.3a): a listing weighs by its granularity and only with our own evidence beside it; counter-
// signals pull the other way; what could not be checked is said, never read as a negative answer.
const NOW = "2026-11-01T12:00:00.000Z";
const h = (name: string, value: string) => ({ name, value });
const MICROSOFT = [{ kind: "microsoft" as const, pattern: "*.outlook.com" }];
// Microsoft 365's stamped results (test/checks/auth-results.test.ts): SPF and DMARC failed.
const FAILED_AUTH = [
  h("Received", "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS"),
  h(
    "Authentication-Results",
    "spf=fail (sender IP is 192.168.50.50) smtp.mailfrom=evil.example; dkim=pass header.d=evil.example; dmarc=fail action=quarantine header.from=evil.example; compauth=fail reason=000",
  ),
  h("Received", "from mail.evil.example (203.0.113.5) by AM5EUR01FT001.mail.protection.outlook.com with ESMTP"),
  h("From", "Accounts <billing@evil.example>"),
];
const PASSED_ALIGNED = [
  h("Received", "from AM6PR01.eurprd01.prod.outlook.com by AM6PR02.eurprd01.prod.outlook.com with HTTPS"),
  h(
    "Authentication-Results",
    "spf=pass smtp.mailfrom=bank.example; dkim=pass header.d=bank.example; dmarc=pass header.from=bank.example; compauth=pass reason=100",
  ),
  h("Received", "from mail.bank.example (203.0.113.5) by AM5EUR01FT001.mail.protection.outlook.com with ESMTP"),
  h("From", "Accounts <billing@bank.example>"),
];

function view(over: Partial<CaseView> = {}): CaseView {
  return {
    tenant: {
      orgId: "org-rep",
      channel: "email",
      receivers: MICROSOFT,
      headersAvailable: true,
      trusted: { own: [], suppliers: [] },
    },
    raw: "raw/case-rep/message.eml",
    brands: {
      version: 1,
      revision: "t",
      community_labels: [],
      brands: [],
      excluded: [],
    } as unknown as CaseView["brands"],
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
    headers: [h("From", "Accounts <billing@evil.example>")],
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
    reputation: null,
    ...over,
  };
}
const rep = (over: Partial<Reputation> = {}): Reputation => ({ links: [], domains: [], notLookedUp: 0, ...over });
const listedUrl = (url: string): Reputation["links"][number] => ({
  url,
  webRisk: {
    state: "listed" as const,
    threatTypes: ["SOCIAL_ENGINEERING"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    cached: false,
  },
});
const blockedDomain = (
  domain: string,
  wellKnown: Reputation["domains"][number]["wellKnown"] = {
    state: "unknown",
    date: "2026-11-01",
    source: "Majestic Million",
    generation: "g1",
  },
) => ({
  domain,
  cloudflare: { state: "blocked" as const, cached: false, caveat: "caveat" },
  wellKnown,
});

describe("weighListing", () => {
  it("is high only when corroborated, medium for URL and domain, low for IP", () => {
    for (const provider of REPUTATION_PROVIDERS)
      for (const granularity of ["url", "domain", "ip"] as const) {
        expect(weighListing({ provider, granularity, corroborated: true })).toBe("high");
        expect(weighListing({ provider, granularity, corroborated: false })).toBe(
          granularity === "ip" ? "low" : "medium",
        );
      }
  });
});

describe("reputation.listing", () => {
  it("weighs an uncorroborated listing at medium, with provider, listing, cap and delisting page", () => {
    const items = listingEvidence(view({ reputation: rep({ links: [listedUrl("https://evil.example/phish")] }) }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ check: "reputation.listing", severity: "medium" });
    expect(items[0]?.detail).toMatchObject({
      provider: "google-web-risk",
      listed: "https://evil.example/phish",
      granularity: "url",
      cap: "suspicious",
      delist_url: "https://safebrowsing.google.com/safebrowsing/report_error/",
    });
    expect(items[0]?.summary).toContain("evil.example");
  });

  it("weighs a blocked domain at medium, and high with a failed authentication beside it", () => {
    const plain = listingEvidence(view({ reputation: rep({ domains: [blockedDomain("evil.example")] }) }));
    expect(plain[0]?.severity).toBe("medium");
    expect(plain[0]?.detail).toMatchObject({
      provider: "cloudflare-security-dns",
      granularity: "domain",
      listed: "evil.example",
    });
    const backed = listingEvidence(
      view({ headers: FAILED_AUTH, reputation: rep({ domains: [blockedDomain("evil.example")] }) }),
    );
    expect(backed[0]?.severity).toBe("high");
    expect(backed[0]?.detail.corroborated).toBe(true);
  });

  it("corroborates only the domain a credential form or a lookalike belongs to", () => {
    const expansion = {
      link: "https://form.example/login",
      outcome: "done",
      reason: null,
      hops: [],
      final: "https://form.example/login",
      finalHost: "form.example",
      landing: {
        finalUrl: "https://form.example/login",
        title: null,
        text: "",
        textTruncated: false,
        scans: [
          {
            url: "https://form.example/login",
            forms: [{ passwordFields: 1, destinations: [{ host: "form.example", offDomain: false }] }],
            loosePasswordFields: 0,
            scripts: [],
            shots: [],
          },
        ],
        downloads: [],
        refused: [],
        unreadable: [],
      },
      downloads: [],
      refused: [],
      ms: 1,
    } as unknown as Expansion;
    const items = listingEvidence(
      view({
        expansions: { items: [expansion], skipped: [] },
        reputation: rep({ domains: [blockedDomain("form.example"), blockedDomain("other.example")] }),
      }),
    );
    expect(items.find((i) => i.detail.listed === "form.example")?.severity).toBe("high");
    expect(items.find((i) => i.detail.listed === "other.example")?.severity).toBe("medium");
  });

  it("corroborates the domain a lookalike imitates, and no other", () => {
    const items = listingEvidence(
      view({
        brands: {
          version: 1,
          revision: "t",
          community_labels: [],
          brands: [{ name: "Bank", domains: ["standardbank.example"] }],
          excluded: [],
        } as unknown as CaseView["brands"],
        links: {
          items: [
            {
              raw: "https://standardbnk.example/login",
              href: "https://standardbnk.example/login",
              host: "standardbnk.example",
              display: "standardbnk.example",
              kind: "text",
              part: "body",
              anchor: null,
            },
          ],
          more: 0,
          unread: [],
        },
        reputation: rep({ domains: [blockedDomain("standardbnk.example"), blockedDomain("other.example")] }),
      }),
    );
    expect(items.find((i) => i.detail.listed === "standardbnk.example")?.severity).toBe("high");
    expect(items.find((i) => i.detail.listed === "other.example")?.severity).toBe("medium");
  });

  it("never floors a case at malicious on listings alone, and leaves independent critical evidence at malicious", () => {
    const high = {
      id: "E1",
      check: "reputation.listing",
      severity: "high" as const,
      summary: "x",
      detail: { cap: "suspicious" },
    };
    expect(floorFor([high]).verdict).toBe("suspicious");
    const criticalCapped = { ...high, id: "E2", severity: "critical" as const };
    expect(floorFor([criticalCapped]).verdict).toBe("suspicious");
    const ipOnly = { ...high, id: "E3", severity: "low" as const, detail: { cap: "suspicious" } };
    expect(floorFor([ipOnly]).verdict).toBe("safe");
    const independent = {
      id: "E4",
      check: "link.credential_form",
      severity: "critical" as const,
      summary: "x",
      detail: {},
    };
    expect(floorFor([independent, criticalCapped]).verdict).toBe("malicious");
  });

  it("bounds the items through the real runner, the rest counted in one more", async () => {
    const domains = Array.from({ length: 30 }, (_, i) => blockedDomain(`d${i}.example`));
    const registry = new CheckRegistry();
    registerReputationChecks(registry);
    const { items, outcomes } = await runChecksWithOutcomes(view({ reputation: rep({ domains }) }), registry);
    const listings = items.filter((i) => i.check === "reputation.listing");
    expect(listings.length).toBeLessThanOrEqual(21);
    expect(listings.at(-1)?.detail.more).toBe(10);
    expect(outcomes.find((o) => o.check === "reputation.listing")?.outcome).toBe("ran");
  });
});

describe("reputation.counter_signal", () => {
  it("shows each counter-signal only beside its own listed domain", () => {
    const items = counterSignalEvidence(
      view({
        headers: PASSED_ALIGNED,
        tenant: {
          orgId: "org-rep",
          channel: "email",
          receivers: MICROSOFT,
          headersAvailable: true,
          trusted: { own: ["bank.example"], suppliers: ["supplier.example"] },
        },
        domainAges: {
          checkedAt: NOW,
          ages: [
            {
              domain: "bank.example",
              fields: ["From"],
              age: { state: "known", registered: "2010-01-01T00:00:00.000Z", server: "rdap.example" },
            },
            {
              domain: "young.example",
              fields: ["From"],
              age: { state: "known", registered: "2026-01-01T00:00:00.000Z", server: "rdap.example" },
            },
          ],
          unread: [],
        },
        reputation: rep({
          domains: [
            blockedDomain("bank.example", {
              state: "known",
              date: "2026-11-01",
              source: "Majestic Million",
              generation: "g1",
            }),
            blockedDomain("young.example"),
            blockedDomain("supplier.example"),
          ],
        }),
      }),
    );
    const providers = items.map((i) => `${i.detail.domain}:${i.detail.provider}`);
    expect(providers).toContain("bank.example:majestic-million");
    expect(providers).toContain("bank.example:domain-age");
    expect(providers).toContain("bank.example:dmarc-aligned");
    expect(providers).toContain("bank.example:trust-network");
    // A young domain, a supplier's domain and an unknown well-known answer claim nothing.
    expect(providers.filter((p) => p.startsWith("young.example"))).toEqual([]);
    expect(providers.filter((p) => p.startsWith("supplier.example"))).toEqual([]);
    expect(items.every((i) => REPUTATION_PROVIDERS.includes(i.detail.provider as never))).toBe(true);
  });

  it("treats the three-year line strictly, and says nothing when the age is unavailable", () => {
    const at = (registered: string) =>
      counterSignalEvidence(
        view({
          domainAges: {
            checkedAt: NOW,
            ages: [{ domain: "bank.example", fields: ["From"], age: { state: "known", registered, server: "rdap.example" } }],
            unread: [],
          },
          reputation: rep({ domains: [blockedDomain("bank.example")] }),
        }),
      ).filter((i) => i.detail.provider === "domain-age");
    expect(at("2023-11-01T12:00:00.000Z")).toHaveLength(1);
    expect(at("2023-11-02T12:00:00.000Z")).toHaveLength(0);
    const unknown = counterSignalEvidence(
      view({
        domainAges: {
          checkedAt: NOW,
          ages: [{ domain: "bank.example", fields: ["From"], age: { state: "unknown", reason: "no-date" } }],
          unread: [],
        },
        reputation: rep({ domains: [blockedDomain("bank.example")] }),
      }),
    );
    expect(unknown.filter((i) => i.detail.provider === "domain-age")).toHaveLength(0);
  });
});

describe("reputation.coverage", () => {
  it("says what was not checked, beside a listing that stands, and keeps the outcome partial", async () => {
    const mixed = view({
      reputation: rep({
        links: [
          listedUrl("https://evil.example/phish"),
          { url: "https://x.example/a", webRisk: { state: "not_checked", reason: "unavailable" } },
          { url: "https://z.example/a", webRisk: { state: "capped", scope: "organisation" } },
        ],
        domains: [
          blockedDomain("evil.example"),
          {
            domain: "y.example",
            cloudflare: { state: "not_checked", reason: "unavailable" },
            wellKnown: { state: "not_loaded" },
          },
        ],
        notLookedUp: 2,
      }),
    });
    const coverage = coverageEvidence(mixed);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.detail.checked).toBe(false);
    expect(coverage[0]?.summary).toContain("not fully checked");
    const registry = new CheckRegistry();
    registerReputationChecks(registry);
    const { outcomes, items } = await runChecksWithOutcomes(mixed, registry);
    expect(items.some((i) => i.check === "reputation.listing")).toBe(true);
    expect(outcomes.find((o) => o.check === "reputation.listing")?.outcome).toBe("partial");
    // Every answer read: no coverage item, and nothing when there was nothing to look up.
    expect(coverageEvidence(view({ reputation: rep({ links: [listedUrl("https://evil.example/phish")] }) }))).toEqual(
      [],
    );
    expect(coverageEvidence(view({ reputation: null }))).toEqual([]);
    expect(
      coverageEvidence(
        view({
          reputation: null,
          links: {
            items: [
              {
                raw: "https://a.example",
                href: "https://a.example",
                host: "a.example",
                display: "a.example",
                kind: "text",
                part: "body",
                anchor: null,
              },
            ],
            more: 0,
            unread: [],
          },
        }),
      ),
    ).toHaveLength(1);
  });
});
