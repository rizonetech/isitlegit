import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { receiversOf } from "../../src/auth/receivers";
import { memberOfSender, registrable } from "../../src/auth/senders";
import { aligned } from "../../src/checks/auth";
import { findIdentityByClaim } from "../../src/trust/identity";

// D07 T02 §20: each <name>.demo.isitlegit.co.za is its own registrable domain, so two demo organisations are two
// tenants through every consumer of registrable(): sender membership, the protected identity match, DMARC's relaxed
// alignment and the receiver patterns. Each case fails under the former calculation, which reduced every demo domain
// to isitlegit.co.za (the public suffix list knows no demo suffix).
const db = (env as unknown as Env).DB;
const FYNBOS = "fynbosfreight.demo.isitlegit.co.za";
const KAROO = "karoocouriers.demo.isitlegit.co.za";

async function demoOrg(domain: string) {
  const org = `org-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const finance = `accounts@${domain}`;
  await db.batch([
    db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(org, domain, org, now),
    db
      .prepare(
        "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
      )
      .bind(crypto.randomUUID(), org, domain, "t".repeat(32), now, now),
    db
      .prepare(
        "INSERT INTO org_addresses (id, org_id, address, state, verified_at, created_at) VALUES (?, ?, ?, 'verified', ?, ?)",
      )
      .bind(crypto.randomUUID(), org, finance, now, now),
    db
      .prepare(
        `INSERT INTO identities (org_id, display_names_json, finance_contact_email, protected, updated_at, updated_by)
         VALUES (?, ?, ?, 1, ?, 'test')`,
      )
      .bind(org, JSON.stringify([domain.split(".")[0]]), finance, now),
  ]);
  return org;
}

describe("two demo organisations are two tenants", () => {
  it("keeps each demo domain's mail with its own organisation, and none at the parent", async () => {
    const fynbos = await demoOrg(FYNBOS);
    const karoo = await demoOrg(KAROO);
    expect(await memberOfSender(db, `lindiwe@${FYNBOS}`)).toEqual({ orgId: fynbos, by: "domain" });
    expect(await memberOfSender(db, `ops@mail.${FYNBOS}`)).toEqual({ orgId: fynbos, by: "domain" });
    expect(await memberOfSender(db, `sipho@${KAROO}`)).toEqual({ orgId: karoo, by: "domain" });
    // The parent and the suffix belong to neither.
    expect(await memberOfSender(db, "someone@isitlegit.co.za")).toBeNull();
    expect(await memberOfSender(db, "someone@demo.isitlegit.co.za")).toBeNull();
    // Removing one organisation's claim revokes its mail, and only its own.
    await db.prepare("DELETE FROM org_domains WHERE org_id = ?").bind(fynbos).run();
    expect(await memberOfSender(db, `lindiwe@${FYNBOS}`)).toBeNull();
    expect(await memberOfSender(db, `sipho@${KAROO}`)).toEqual({ orgId: karoo, by: "domain" });
  });

  it("matches a protected identity by its own demo domain only, never a sibling's or the parent's", async () => {
    const fynbos = await demoOrg(`a${FYNBOS}`);
    const karoo = await demoOrg(`a${KAROO}`);
    const of = async (domain: string) => (await findIdentityByClaim(db, { domain })).map((m) => m.orgId);
    expect(await of(`invoices.a${FYNBOS}`)).toEqual([fynbos]);
    expect(await of(`a${KAROO}`)).toEqual([karoo]);
    expect(await of("isitlegit.co.za")).toEqual([]);
    expect(await of("demo.isitlegit.co.za")).toEqual([]);
  });

  it("aligns a demo domain's own subdomains for DMARC, never a sibling or the parent", () => {
    expect(aligned(`bounce.${FYNBOS}`, FYNBOS)).toBe(true);
    expect(aligned(KAROO, FYNBOS)).toBe(false);
    expect(aligned("isitlegit.co.za", FYNBOS)).toBe(false);
    expect(aligned(FYNBOS, "isitlegit.co.za")).toBe(false);
  });

  it("confines a receiver pattern to its own demo domain", () => {
    const patterns = receiversOf([`mx1.${FYNBOS}`]).map((r) => r.pattern);
    expect(patterns).toContain(`*.${FYNBOS}`);
    expect(patterns).not.toContain("*.isitlegit.co.za");
    expect(registrable(`mx1.${FYNBOS}`)).toBe(FYNBOS);
  });
});
