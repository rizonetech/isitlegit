import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listOwnDomains, listSupplierDomains } from "../../src/checks/suppliers";
import { makeOrg } from "../trust/helpers";

// D02 T03 §11: only claimable domains count as an organisation's own or its suppliers'.
const db = env.DB;
const now = new Date().toISOString();
const verified = (org: string, domain: string) =>
  db
    .prepare(
      "INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, ?, ?, 'verified', 'dns', ?, ?)",
    )
    .bind(crypto.randomUUID(), org, domain, "t".repeat(32), now, now);
const supplier = (org: string, domains: string[]) => {
  const name = `Supplier ${crypto.randomUUID().slice(0, 6)}`;
  return db
    .prepare(
      `INSERT INTO suppliers (id, org_id, name, name_key, domains_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'o', ?, ?)`,
    )
    .bind(crypto.randomUUID(), org, name, name.toLowerCase(), JSON.stringify(domains), now, now);
};

describe("an organisation's own and supplier domains", () => {
  it("leave out IsItLegit's own domain, an old claim on it among them, and keep a verified demo domain", async () => {
    const org = await makeOrg();
    await db.batch([
      verified(org, "isitlegit.co.za"),
      verified(org, "fynbos.demo.isitlegit.co.za"),
      verified(org, "fynbosfreight.co.za"),
      supplier(org, ["isitlegit.co.za", "karoo.demo.isitlegit.co.za", "karooparts.co.za"]),
    ]);
    expect(await listOwnDomains(db, org)).toEqual(["fynbos.demo.isitlegit.co.za", "fynbosfreight.co.za"]);
    expect(await listSupplierDomains(db, org)).toEqual(["karoo.demo.isitlegit.co.za", "karooparts.co.za"]);
  });
});
