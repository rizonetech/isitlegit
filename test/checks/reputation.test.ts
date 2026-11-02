import { describe, expect, it } from "vitest";
import type { CaseView } from "../../src/checks/case-view";
import {
  counterSignalEvidence,
  listingEvidence,
  REPUTATION_PROVIDERS,
  type Reputation,
} from "../../src/checks/reputation";

// D02 T06 §4 checkpoint: every listing and counter-signal names a provider in REPUTATION_PROVIDERS, and every
// listing carries what was listed and that provider's delisting page.
const DELIST_HOST: Record<string, string> = {
  "google-web-risk": "safebrowsing.google.com",
  "cloudflare-security-dns": "radar.cloudflare.com",
};

function view(reputation: Reputation): CaseView {
  return {
    tenant: {
      orgId: "org-rep",
      channel: "email",
      receivers: [],
      headersAvailable: true,
      trusted: { own: ["bank.example"], suppliers: [] },
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
    domainAges: {
      checkedAt: "2026-11-01T12:00:00.000Z",
      ages: [
        {
          domain: "bank.example",
          fields: ["From"],
          age: { state: "known", registered: "2010-01-01T00:00:00.000Z", server: "rdap.example" },
        },
      ],
      unread: [],
    },
    attachmentHeads: null,
    hiddenText: null,
    htmlAttachments: null,
    attachmentRisks: null,
    instructions: null,
    invisibleText: null,
    links: null,
    expansions: null,
    source: { kind: "message", path: "rfc822", otherOriginals: 0 },
    headers: [{ name: "From", value: "Accounts <billing@bank.example>" }],
    text: null,
    html: null,
    attachments: [],
    truncated: [],
    omitted: 0,
    reputation,
  };
}

describe("the reputation providers", () => {
  it("stamps every item with its provider, and every listing with what was listed and its delisting page", () => {
    const reputation: Reputation = {
      links: [
        {
          url: "https://bank.example/phish",
          webRisk: {
            state: "listed",
            threatTypes: ["SOCIAL_ENGINEERING"],
            expiresAt: "2099-01-01T00:00:00.000Z",
            cached: false,
          },
        },
      ],
      domains: [
        {
          domain: "bank.example",
          cloudflare: { state: "blocked", cached: false, caveat: "caveat" },
          wellKnown: { state: "known", date: "2026-11-01", source: "Majestic Million", generation: "g1" },
        },
      ],
      notLookedUp: 0,
    };
    const listings = listingEvidence(view(reputation));
    const signals = counterSignalEvidence(view(reputation));
    expect(listings.length).toBeGreaterThan(0);
    expect(signals.length).toBeGreaterThan(0);
    for (const item of [...listings, ...signals]) {
      expect(REPUTATION_PROVIDERS).toContain(item.detail.provider);
    }
    for (const item of listings) {
      expect(typeof item.detail.listed).toBe("string");
      expect(item.detail.listed).toBeTruthy();
      expect(String(item.detail.delist_url)).toContain(DELIST_HOST[item.detail.provider as string]);
    }
    expect(new Set(listings.map((i) => i.detail.provider))).toEqual(
      new Set(["google-web-risk", "cloudflare-security-dns"]),
    );
    expect(new Set(signals.map((i) => i.detail.provider))).toEqual(
      new Set(["majestic-million", "domain-age", "trust-network"]),
    );
  });
});
