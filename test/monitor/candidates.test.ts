// Lookalike candidates (D05 T04 §1; spec 4.11): every one recognised by the lookalike check, in ASCII form, each class
// proven by exact examples, the business's own domains never among them, and the cap filled in rank order.
import { describe, expect, it } from "vitest";
import { split as checkSplit, techniqueOf } from "../../src/checks/domain-lookalike";
import { ADDED_WORDS } from "../../src/checks/lookalike";
import { candidatesFor, candidatesForBusiness, MAX_CANDIDATES, OTHER_TLDS } from "../../src/monitor/candidates";

// Every TLD swap and added-word form of a domain: the candidates ranked first, which the cap must never drop.
const firstRanked = (label: string, suffix: string) => [
  ...OTHER_TLDS.filter((tld) => tld !== suffix).map((tld) => `${ascii(label)}.${tld}`),
  ...ADDED_WORDS.flatMap((word) =>
    ["-", ""].flatMap((join) => [
      `${ascii(`${label}${join}${word}`)}.${suffix}`,
      `${ascii(`${word}${join}${label}`)}.${suffix}`,
    ]),
  ),
];

// The check's own split: a candidate it cannot read as a registrable domain is not one it can flag.
const split = (host: string) => {
  const parts = checkSplit(host);
  if (!parts) throw new Error(`the lookalike check cannot split ${host}`);
  return parts;
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
      ...OTHER_TLDS.filter((tld) => tld !== "co.za").map((tld) => `fynbosfreight.${tld}`),
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

  it("varies an internationalised domain in Unicode and encodes each candidate (completion review)", () => {
    const idn = candidatesFor("xn--bcher-kva.de");
    expect(idn).toContain(`${ascii("bücher-payments")}.de`);
    expect(idn).toContain(`${ascii("paymentsbücher")}.de`);
    expect(idn).toContain(`${ascii("bücher")}.co.za`);
    for (const d of idn) expect(techniqueOf(split(d), split("xn--bcher-kva.de")), d).not.toBeNull();
  });

  it("watches a .com business's .co.za twin (completion review)", () => {
    expect(candidatesFor("fynbosfreight.com")).toContain("fynbosfreight.co.za");
  });

  it("keeps every TLD swap and added word when the cap is reached", () => {
    const long = candidatesFor("internationalcourierservices.co.za");
    expect(long).toHaveLength(MAX_CANDIDATES);
    for (const d of firstRanked("internationalcourierservices", "co.za")) expect(long, d).toContain(d);
  });

  it("caps at 300, filling the list with TLD swaps and added words before confusables and typos", () => {
    const long = candidatesFor("internationalcourierservices.co.za");
    expect(long.length).toBe(MAX_CANDIDATES);
    const target = split("internationalcourierservices.co.za");
    const kinds = long.map((d) => techniqueOf(split(d), target));
    const firstLater = kinds.findIndex((k) => k === "skeleton" || k === "edit");
    expect(kinds.slice(firstLater).every((k) => k === "skeleton" || k === "edit")).toBe(true);
    expect(kinds.filter((k) => k === "different-tld")).toHaveLength(OTHER_TLDS.filter((tld) => tld !== "co.za").length);
    expect(kinds.filter((k) => k === "added-word").length).toBeGreaterThan(0);
  });
});

describe("what the check can read (round 1)", () => {
  it("produces only domains the lookalike check splits as registrable, a private-suffix input included", () => {
    for (const input of ["uk.co.za", "fynbosfreight.co.za", "mail.example.co.uk"])
      for (const d of candidatesFor(input)) {
        const parts = checkSplit(d);
        expect(parts?.domain, `${input}: ${d}`).toBe(d);
      }
  });

  it("writes Unicode inputs as ASCII throughout and excludes a business's own internationalised domains", () => {
    const business = candidatesForBusiness(["bücher.de", "bücher.com"]);
    expect(business).not.toContain(`${ascii("bücher")}.com`);
    expect(business).not.toContain(`${ascii("bücher")}.de`);
    for (const d of [...business, ...candidatesFor("example.рф")]) expect(d, d).toMatch(/^[a-z0-9.-]+$/);
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
    // Every domain's TLD swaps and added words are kept (the business's own domains aside).
    for (const [label, suffix] of [
      ["fynbosfreight", "co.za"],
      ["fynbosfreight", "com"],
      ["fynbos-logistics", "co.za"],
    ] as const)
      for (const d of firstRanked(label, suffix)) if (!domains.includes(d)) expect(all, d).toContain(d);
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
