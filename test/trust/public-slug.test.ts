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

describe("recovery and retired addresses (completion review)", () => {
  it("keeps a given-up address from every other business, so its old links still answer as unknown", async () => {
    const a = await business("Hoopoe Freight");
    const b = await business("Kingfisher Freight");
    await protect(a.orgId, a.contact);
    await protect(b.orgId, b.contact);
    await changePublicSlug(db, a.orgId, "owner", `hoopoe-${n}`);
    await expect(changePublicSlug(db, b.orgId, "owner", "hoopoe-freight")).rejects.toThrow(SLUG_REFUSALS.taken);
    expect(await orgBySlug(db, "hoopoe-freight")).toBeNull();
    const c = await business("Hoopoe Freight");
    await protect(c.orgId, c.contact);
    expect((await publicSlug(db, c.orgId)).slug).toBe("hoopoe-freight-2");
  });

  it("never lets two racing requests end with a retired address in use (round 1)", async () => {
    const a = await business("Oxpecker Freight");
    const b = await business("Sunbird Freight");
    await protect(a.orgId, a.contact);
    await protect(b.orgId, b.contact);
    const old = (await publicSlug(db, a.orgId)).slug as string;
    await Promise.allSettled([
      changePublicSlug(db, a.orgId, "owner", `oxpecker-${n}`),
      changePublicSlug(db, b.orgId, "owner", old),
    ]);
    const holders = await db.prepare("SELECT org_id FROM identities WHERE public_slug = ?").bind(old).all();
    const retiredRow = await db.prepare("SELECT 1 FROM retired_public_slugs WHERE slug = ?").bind(old).first();
    // Either a still holds it (b refused), or a gave it up and nobody holds it.
    if (retiredRow) expect(holders.results).toEqual([]);
    else expect(holders.results.map((r) => r.org_id)).toEqual([a.orgId]);
    // And no write, of any kind, puts a retired address back in use.
    if (retiredRow)
      await expect(
        db.prepare("UPDATE identities SET public_slug = ? WHERE org_id = ?").bind(old, b.orgId).run(),
      ).rejects.toThrow(/retired/);
  });

  it("refuses the second of two submissions of the same new address as spent, never as an outage (round 3)", async () => {
    const a = await business("Mousebird Couriers");
    await protect(a.orgId, a.contact);
    const wanted = `mousebird-${n}`;
    const results = await Promise.allSettled([
      changePublicSlug(db, a.orgId, "owner", wanted),
      changePublicSlug(db, a.orgId, "owner", wanted),
    ]);
    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value : (r.reason as Error).message)).sort();
    expect(outcomes).toEqual(["changed", SLUG_REFUSALS.spent].sort());
    expect(await publicSlug(db, a.orgId)).toEqual({ slug: wanted, changed: true });
    const events = await db
      .prepare("SELECT COUNT(*) AS n FROM trust_events WHERE org_id = ? AND detail_json LIKE '%publicSlug%'")
      .bind(a.orgId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it("says an unchanged address changed nothing and keeps the change unspent", async () => {
    const a = await business("Weaver Paper");
    await protect(a.orgId, a.contact);
    expect(await changePublicSlug(db, a.orgId, "owner", "weaver-paper")).toBe("unchanged");
    expect((await publicSlug(db, a.orgId)).changed).toBe(false);
  });

  it("rolls a change back whole when its audit cannot be written, the allowance kept", async () => {
    const a = await business("Shrike Couriers");
    await protect(a.orgId, a.contact);
    await db.exec(
      "CREATE TRIGGER fail_slug_events BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    try {
      await expect(changePublicSlug(db, a.orgId, "owner", "shrike")).rejects.toThrow(/audit down/);
    } finally {
      await db.exec("DROP TRIGGER IF EXISTS fail_slug_events");
    }
    expect(await publicSlug(db, a.orgId)).toEqual({ slug: "shrike-couriers", changed: false });
    expect(await orgBySlug(db, "shrike")).toBeNull();
  });

  it("recovers an assignment that failed after the save, and the backfill goes on past one that keeps failing", async () => {
    const a = await business("Barbet Logistics");
    const b = await business("Bulbul Logistics");
    await db.exec(
      `CREATE TRIGGER fail_slug_assign BEFORE UPDATE OF public_slug ON identities WHEN NEW.org_id IN ('${a.orgId}', '${b.orgId}') BEGIN SELECT RAISE(ABORT, 'store down'); END`,
    );
    await protect(a.orgId, a.contact);
    await protect(b.orgId, b.contact);
    expect((await publicSlug(db, a.orgId)).slug).toBeNull();
    // b keeps failing; a recovers once the store is back.
    await db.exec("DROP TRIGGER fail_slug_assign");
    await db.exec(
      `CREATE TRIGGER fail_slug_assign BEFORE UPDATE OF public_slug ON identities WHEN NEW.org_id = '${b.orgId}' BEGIN SELECT RAISE(ABORT, 'store down'); END`,
    );
    try {
      await backfillPublicSlugs(db);
      expect((await publicSlug(db, a.orgId)).slug).toBe("barbet-logistics");
      expect((await publicSlug(db, b.orgId)).slug).toBeNull();
    } finally {
      await db.exec("DROP TRIGGER IF EXISTS fail_slug_assign");
    }
    await backfillPublicSlugs(db);
    expect((await publicSlug(db, b.orgId)).slug).toBe("bulbul-logistics");
  });
});
