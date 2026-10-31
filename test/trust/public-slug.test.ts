// The verify page's public address (D05 T02 §6, corrections 2, 10, 11 and 13): assigned when protection is first
// switched on, numbered on a collision, backfilled for identities protected before it existed, changed once by the
// owner (twice never, concurrently once), and found by the page.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setIdentity } from "../../src/trust/identity";
import {
  assignPublicSlug,
  backfillPublicSlugs,
  changePublicSlug,
  orgBySlug,
  publicSlug,
  SLUG_REFUSALS,
} from "../../src/trust/public-slug";
import { SLUG } from "../../src/trust/slug";
import { protectableOrg } from "./helpers";

const db = env.DB;
let n = 0;
async function business(name: string) {
  const tag = `${++n}${crypto.randomUUID().slice(0, 6)}`;
  const orgId = await protectableOrg(`b${tag}.example`, `money@b${tag}.example`, name);
  return { orgId, contact: `money@b${tag}.example` };
}
const protect = (orgId: string, contact: string, on = true) =>
  setIdentity(db, orgId, "owner", { displayNames: ["x"], financeContact: contact, protected: on });

describe("assigning", () => {
  it("gives a business its slug when protection is first switched on, numbering a collision, keeping it after", async () => {
    const a = await business("Fynbos Freight (Pty) Ltd");
    await setIdentity(db, a.orgId, "owner", { displayNames: ["x"], financeContact: a.contact, protected: false });
    expect((await publicSlug(db, a.orgId)).slug).toBeNull();
    await protect(a.orgId, a.contact);
    expect((await publicSlug(db, a.orgId)).slug).toBe("fynbos-freight");
    const b = await business("Fynbos Freight Ltd");
    await protect(b.orgId, b.contact);
    expect((await publicSlug(db, b.orgId)).slug).toBe("fynbos-freight-2");
    await protect(a.orgId, a.contact, false);
    await protect(a.orgId, a.contact);
    expect((await publicSlug(db, a.orgId)).slug).toBe("fynbos-freight");
    expect(await orgBySlug(db, "fynbos-freight")).toBe(a.orgId);
    expect(await orgBySlug(db, "FYNBOS-FREIGHT-2")).toBe(b.orgId);
    expect(await orgBySlug(db, "no-such-business")).toBeNull();
  });

  it("gives a short, a non-Latin and a 70-character name a valid slug, and a save never fails on it", async () => {
    for (const name of [
      "AB",
      "Ηλιος Μεταφορές",
      "The Very Long Name of a South African Logistics and Courier Company",
    ]) {
      const b = await business(name);
      await protect(b.orgId, b.contact);
      const { slug } = await publicSlug(db, b.orgId);
      expect(slug, name).toMatch(SLUG);
    }
  });

  it("backfills an identity protected before slugs existed, and assigns concurrently only once", async () => {
    const b = await business("Karoo Couriers CC");
    await protect(b.orgId, b.contact);
    await db.prepare("UPDATE identities SET public_slug = NULL WHERE org_id = ?").bind(b.orgId).run();
    expect(await backfillPublicSlugs(db)).toBeGreaterThanOrEqual(1);
    expect((await publicSlug(db, b.orgId)).slug).toBe("karoo-couriers");
    await db.prepare("UPDATE identities SET public_slug = NULL WHERE org_id = ?").bind(b.orgId).run();
    const both = await Promise.all([assignPublicSlug(db, b.orgId), assignPublicSlug(db, b.orgId)]);
    expect(new Set(both).size).toBe(1);
  });
});

describe("the owner's one change", () => {
  it("changes once, refuses a second, a taken and a malformed one, and keeps the allowance after a refusal", async () => {
    const a = await business("Hadeda Couriers");
    const b = await business("Ibis Logistics");
    await protect(a.orgId, a.contact);
    await protect(b.orgId, b.contact);
    await expect(changePublicSlug(db, a.orgId, "owner", "ibis-logistics")).rejects.toThrow(SLUG_REFUSALS.taken);
    await expect(changePublicSlug(db, a.orgId, "owner", "-bad-")).rejects.toThrow(SLUG_REFUSALS.malformed);
    expect((await publicSlug(db, a.orgId)).changed).toBe(false);
    await changePublicSlug(db, a.orgId, "owner", "hadeda");
    expect(await publicSlug(db, a.orgId)).toEqual({ slug: "hadeda", changed: true });
    expect(await orgBySlug(db, "hadeda-couriers")).toBeNull();
    await expect(changePublicSlug(db, a.orgId, "owner", "hadeda-sa")).rejects.toThrow(SLUG_REFUSALS.spent);
  });

  it("lets only one of two concurrent changes through", async () => {
    const a = await business("Sunbird Paper");
    await protect(a.orgId, a.contact);
    const results = await Promise.allSettled([
      changePublicSlug(db, a.orgId, "owner", "sunbird-one"),
      changePublicSlug(db, a.orgId, "owner", "sunbird-two"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(["sunbird-one", "sunbird-two"]).toContain((await publicSlug(db, a.orgId)).slug);
  });
});
