// Claim detection (D05 T02 §2): every route, the signature boundary, voice states, logo
// judgements, combined routes, multiple identities, unavailable routes, and the registered
// check's evidence with privacy (no contact, bank or logo storage reference anywhere).
import { describe, expect, it } from "vitest";
import { CheckRegistry } from "../../src/checks/registry";
import { claimEvidence, detectClaims, registerClaimCheck, type ClaimInput } from "../../src/trust/claim";

const FYNBOS = { orgId: "org-fynbos", names: ["Fynbos Freight"], domains: ["fynbosfreight.co.za"] };
const KAROO = { orgId: "org-karoo", names: ["Karoo Couriers"], domains: ["karoocouriers.co.za"] };

const base: ClaimInput = {
  fromName: null,
  fromDomain: null,
  replyToDomain: null,
  text: null,
  voice: null,
  candidates: [FYNBOS, KAROO],
  logoJudgements: [],
  unavailable: [],
};
const routes = (input: ClaimInput, org = "org-fynbos") =>
  detectClaims(input).find((h) => h.orgId === org)?.routes ?? [];

describe("claim routes", () => {
  it("detects display name, From exact and lookalike, Reply-To exact and lookalike independently", () => {
    expect(routes({ ...base, fromName: "Fynbos Freight" })).toContain("display-name");
    expect(routes({ ...base, fromDomain: "mail.fynbosfreight.co.za" })).toContain("from-domain");
    expect(routes({ ...base, fromDomain: "fynbosfreight.example" })).toContain("from-lookalike");
    expect(routes({ ...base, replyToDomain: "fynbosfreight.co.za" })).toContain("reply-to-domain");
    expect(routes({ ...base, replyToDomain: "fynbosfrieght.co.za" })).toContain("reply-to-lookalike");
    expect(routes({ ...base, fromDomain: "unrelated.example" })).toEqual([]);
  });

  it("reads the signature only in the last 15 lines", () => {
    const inside = [...Array(20).fill("A line of body."), "Regards, Fynbos Freight"].join("\n");
    const outside = ["Fynbos Freight", ...Array(20).fill("A line of body.")].join("\n");
    expect(routes({ ...base, text: inside })).toContain("signature");
    expect(routes({ ...base, text: outside })).not.toContain("signature");
  });

  it("reads a voice claim only from a read voice note, and combines routes per identity", () => {
    expect(routes({ ...base, voice: { state: "read", claimedIdentity: "Karoo Couriers" } }, "org-karoo")).toContain(
      "voice",
    );
    expect(routes({ ...base, voice: { state: "silent", claimedIdentity: null } }, "org-karoo")).toEqual([]);
    expect(routes({ ...base, voice: { state: "failed", claimedIdentity: null } }, "org-karoo")).toEqual([]);
    const both = detectClaims({ ...base, fromName: "Fynbos Freight", fromDomain: "fynbosfreight.co.za" });
    expect(both).toHaveLength(1);
    expect(both[0]?.routes).toEqual(expect.arrayContaining(["display-name", "from-domain"]));
    const two = detectClaims({ ...base, fromName: "Karoo Couriers", fromDomain: "fynbosfreight.co.za" });
    expect(two.map((h) => h.orgId).sort()).toEqual(["org-fynbos", "org-karoo"]);
  });

  it("claims by logo only on a same judgement, and states unavailable routes", () => {
    expect(
      routes({ ...base, logoJudgements: [{ orgId: "org-fynbos", same: true, cropKey: "case/crop.jpg" }] }),
    ).toContain("logo");
    expect(
      routes({ ...base, logoJudgements: [{ orgId: "org-fynbos", same: false, cropKey: "case/crop.jpg" }] }),
    ).toEqual([]);
    const items = claimEvidence({ ...base, unavailable: ["the registered logo could not be read"] });
    expect(items.at(-1)?.summary).toContain("could not be compared");
    expect(detectClaims(base)).toEqual([]);
  });

  it("registers trust.claim and yields info evidence with no private fields", () => {
    const registry = new CheckRegistry();
    registerClaimCheck(registry);
    expect(registry.names()).toContain("trust.claim");
    const items = claimEvidence({
      ...base,
      fromName: "Fynbos Freight",
      logoJudgements: [{ orgId: "org-fynbos", same: true, cropKey: "case/crop.jpg" }],
    });
    expect(items[0]?.check).toBe("trust.claim");
    expect(items[0]?.severity).toBe("info");
    expect(items[0]?.artefacts).toEqual(["case/crop.jpg"]);
    const detail = JSON.stringify(items[0]?.detail);
    expect(detail).toContain("org-fynbos");
    for (const banned of ["finance", "bank", "account", "logo_r2", "storage"]) expect(detail).not.toContain(banned);
  });
});
