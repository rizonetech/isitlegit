// The verify page's public address (D05 T02 §6, correction 11): readable from the registered name, the company form
// dropped, always valid for any accepted name, and within 60 characters with any collision suffix.
import { describe, expect, it } from "vitest";
import { MAX_SLUG, publicSlugOf, SLUG, withSuffix } from "../../src/trust/slug";

describe("publicSlugOf", () => {
  it("reads the registered name, its company form dropped", () => {
    expect(publicSlugOf("Fynbos Freight (Pty) Ltd", "org-1")).toBe("fynbos-freight");
    expect(publicSlugOf("Karoo Couriers CC", "org-1")).toBe("karoo-couriers");
    expect(publicSlugOf("Café Ndlovu & Sons Inc.", "org-1")).toBe("cafe-ndlovu-sons");
    expect(publicSlugOf("Pty Ltd", "org-1")).toBe("pty");
  });

  it("gives a valid slug for a short, a non-Latin and a very long name", () => {
    const id = "ZF5SufztotybeXIWVncExFAVu9GYZ8Fu";
    expect(publicSlugOf("AB", id)).toBe("business-zf5sufzt");
    expect(publicSlugOf("Ηλιος Μεταφορές", id)).toBe("business-zf5sufzt");
    const long = publicSlugOf("The Very Long Name of a South African Logistics and Courier Company", id);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).toBe("the-very-long-name-of-a-south-african-logistics");
    for (const s of ["fynbos-freight", "business-zf5sufzt", long]) expect(s).toMatch(SLUG);
  });
});

describe("withSuffix", () => {
  it("numbers a collision within 60 characters", () => {
    expect(withSuffix("fynbos-freight", 1)).toBe("fynbos-freight");
    expect(withSuffix("fynbos-freight", 2)).toBe("fynbos-freight-2");
    const long = "a".repeat(50);
    expect(withSuffix(long, 12)).toHaveLength(53);
    const full = `${"b".repeat(59)}c`;
    expect(withSuffix(full, 123).length).toBeLessThanOrEqual(MAX_SLUG);
    expect(withSuffix(full, 123)).toMatch(SLUG);
  });
});
