// The fictional demo company's kit (data/demo/fynbos-freight): it stays fictional and every file it names is a clean
// SVG, so no lane's test, capture or seed can pick up a real business's identifier or a script inside a logo.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "../../data/demo/fynbos-freight");
const brand = JSON.parse(readFileSync(join(DIR, "brand.json"), "utf8"));

describe("the Fynbos Freight demo kit", () => {
  it("is marked fictional, with identifiers no real business can hold", () => {
    expect(brand.fictional).toBe(true);
    expect(brand.registration_number).toMatch(/^2099\//);
    expect(brand.address.postcode).toBe("0000");
    expect(brand.vat_number).toBeNull();
    expect(brand.phone).toBeNull();
    expect(brand.bank.fictional).toBe(true);
    expect(brand.bank.account_on_file).toMatch(/^0000/);
    expect(brand.bank.changed_account_in_hero_case).toMatch(/^0000/);
  });

  it("uses only .example and demo.isitlegit.co.za domains", () => {
    const domains = [brand.domains.verified, brand.domains.test, ...brand.domains.lookalikes];
    for (const domain of domains) expect(domain).toMatch(/(\.example|\.demo\.isitlegit\.co\.za)$/);
    for (const box of [brand.mailboxes.accounts, brand.mailboxes.dispatch])
      expect(box).toMatch(/@fynbosfreight\.demo\.isitlegit\.co\.za$/);
  });

  it("names logo files that exist and hold no script, handler or outside reference", () => {
    for (const file of Object.values(brand.brand.logo) as string[]) {
      const path = join(DIR, file);
      expect(existsSync(path), file).toBe(true);
      const svg = readFileSync(path, "utf8");
      expect(svg.trimStart().startsWith("<svg"), file).toBe(true);
      expect(svg, file).not.toMatch(/<script|\son\w+=|href=|<foreignObject|<image/i);
    }
  });
});
