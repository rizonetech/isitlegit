// Lookalike candidates (D05 T04 §1; spec 4.11): every one recognised by the lookalike check, in ASCII form, each class
// proven by exact examples, the business's own domains never among them, and the cap filled in rank order.
import { getDomain, getPublicSuffix } from "tldts";
import { describe, expect, it } from "vitest";
import { techniqueOf } from "../../src/checks/domain-lookalike";
import { candidatesFor, candidatesForBusiness, MAX_CANDIDATES, OTHER_TLDS } from "../../src/monitor/candidates";

const split = (host: string) => {
  const domain = getDomain(host) as string;
  const suffix = getPublicSuffix(host) as string;
  return { domain, label: domain.slice(0, -(suffix.length + 1)), suffix };
};
const ascii = (label: string) => new URL(`http://${label}.example/`).hostname.slice(0, -".example".length);

describe("candidatesFor", () => {
  const all = candidatesFor("fynbosfreight.co.za");

  it("includes the Cyrillic о variant as its A-label, which the check names a skeleton match", () => {
    const variant = `${ascii("fynbоsfreight")}.co.za`; // the second "o" is Cyrillic U+043E
    expect(variant.startsWith("xn--")).toBe(true);
    expect(all).toContain(variant);
    expect(techniqueOf(split(variant), split("fynbosfreight.co.za"))).toBe("skeleton");
  });

  it("holds an exact example of each typo, each added-word placement and separator, and each listed TLD", () => {
    for (const example of [
      "fynbsfreight.co.za", // omission
      "fynboosfreight.co.za", // repetition
      "fynbsofreight.co.za", // adjacent swap
      "fynbisfreight.co.za", // adjacent key (o to i)
      "fynbosfreight-payments.co.za",
      "fynbosfreightpayments.co.za",
      "payments-fynbosfreight.co.za",
      "paymentsfynbosfreight.co.za",
      ...OTHER_TLDS.map((tld) => `fynbosfreight.${tld}`),
    ])
      expect(all, example).toContain(example);
  });

  it("is unique, never the original, every one in ASCII and recognised by the check", () => {
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("fynbosfreight.co.za");
    for (const d of all) {
      expect(d, d).toMatch(/^[a-z0-9.-]+$/);
      expect(techniqueOf(split(d), split("fynbosfreight.co.za")), d).not.toBeNull();
    }
  });

  it("gives a label under 6 characters no typo, and reads a subdomain as its registrable domain", () => {
    const short = candidatesFor("kfc.co.za");
    expect(short).not.toContain("kc.co.za");
    expect(short).not.toContain("kfcc.co.za");
    expect(short).toContain("kfc.com");
    expect(candidatesFor("mail.fynbosfreight.co.za")).toEqual(all);
  });

  it("caps at 300, filling the list with TLD swaps and added words before confusables and typos", () => {
    const long = candidatesFor("internationalcourierservices.co.za");
    expect(long.length).toBe(MAX_CANDIDATES);
    const target = split("internationalcourierservices.co.za");
    const kinds = long.map((d) => techniqueOf(split(d), target));
    const firstLater = kinds.findIndex((k) => k === "skeleton" || k === "edit");
    expect(kinds.slice(firstLater).every((k) => k === "skeleton" || k === "edit")).toBe(true);
    expect(kinds.filter((k) => k === "different-tld")).toHaveLength(OTHER_TLDS.length);
    expect(kinds.filter((k) => k === "added-word").length).toBeGreaterThan(0);
  });
});

describe("candidatesForBusiness", () => {
  it("merges a business's domains, never names one of them, and keeps the whole within 300", () => {
    const domains = ["fynbosfreight.co.za", "fynbosfreight.com", "fynbos-logistics.co.za"];
    const all = candidatesForBusiness(domains);
    expect(all.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(new Set(all).size).toBe(all.length);
    for (const own of domains) expect(all).not.toContain(own);
    expect(all).toContain("fynbosfreight.net");
    expect(all).toContain("fynbos-logistics.com");
    // Every TLD swap and added word of every domain comes before any confusable or typo.
    const kindOf = (d: string) => {
      for (const own of domains) {
        const k = techniqueOf(split(d), split(own));
        if (k) return k;
      }
      return null;
    };
    const kinds = all.map(kindOf);
    const firstLater = kinds.findIndex((k) => k === "skeleton" || k === "edit");
    expect(kinds.slice(firstLater).every((k) => k === "skeleton" || k === "edit")).toBe(true);
  });
});
