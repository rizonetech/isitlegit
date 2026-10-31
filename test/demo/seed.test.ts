// The fictional demo businesses (D07 T07 §1): seeded once, rerunnable, resumable after an interruption, never touching
// a protected organisation or account, and checked read-only from the persisted records.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import others from "../../data/demo/businesses/businesses.json";
import courier from "../../data/demo/businesses/logo/hadeda-couriers.svg?raw";
import packaging from "../../data/demo/businesses/logo/kestrel-packaging.svg?raw";
import office from "../../data/demo/businesses/logo/marula-office-supplies.svg?raw";
import tyres from "../../data/demo/businesses/logo/quagga-tyres.svg?raw";
import brand from "../../data/demo/fynbos-freight/brand.json";
import fynbosMark from "../../data/demo/fynbos-freight/logo/mark.svg?raw";
import { demoBusinesses } from "../../src/demo/businesses";
import {
  checkDemo,
  type DemoBusiness,
  FYNBOS_ORG_ID,
  FynbosMissing,
  ProtectedTarget,
  SeedFailed,
  seedDemo,
} from "../../src/demo/seed";
import { addAccount, bankKeys } from "../../src/trust/bank";
import { getIdentity, setIdentity } from "../../src/trust/identity";
import { storeLogo } from "../../src/trust/logo";

const db = env.DB;
const logos = {
  fynbos: fynbosMark,
  byPath: {
    "logo/hadeda-couriers.svg": courier,
    "logo/kestrel-packaging.svg": packaging,
    "logo/marula-office-supplies.svg": office,
    "logo/quagga-tyres.svg": tyres,
  },
};
const businesses = (): DemoBusiness[] => demoBusinesses(brand, others, logos);

const TABLES = [
  "organization",
  "user",
  "member",
  "org_domains",
  "org_addresses",
  "identities",
  "bank_accounts",
  "trust_events",
];
async function dump() {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) out[t] = (await db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()).results;
  return JSON.stringify(out);
}
async function fynbosExists() {
  const at = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('u-demo', 'Demo', 'demo@rizonetech.com', 1, ?, ?)`,
      )
      .bind(at, at),
    db
      .prepare(
        `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Fynbos Freight', 'fynbos-freight', ?)`,
      )
      .bind(FYNBOS_ORG_ID, at),
    db
      .prepare(
        `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('m-demo', ?, 'u-demo', 'owner', ?)`,
      )
      .bind(FYNBOS_ORG_ID, at),
  ]);
}

beforeEach(async () => {
  await db.exec("DROP TRIGGER IF EXISTS fail_account");
  await db.exec("DROP TRIGGER IF EXISTS fail_domain");
  for (const t of [...TABLES, "bank_key_epoch"].reverse()) await db.prepare(`DELETE FROM "${t}"`).run();
  for (const o of (await env.ARTEFACTS.list()).objects) await env.ARTEFACTS.delete(o.key);
});

describe("seedDemo", () => {
  it("seeds five businesses with every part, flagged demo, and a second run changes nothing", async () => {
    await fynbosExists();
    const first = await seedDemo(env, businesses());
    expect(first).toHaveLength(5);
    expect(first.find((r) => r.slug === "fynbos-freight")?.steps.organisation).toBe("present");
    for (const r of first.filter((x) => x.slug !== "fynbos-freight"))
      expect(Object.values(r.steps)).toEqual(Array(6).fill("created"));
    for (const b of businesses()) {
      const org = await db
        .prepare(`SELECT id, metadata FROM "organization" WHERE id = ? OR slug = ?`)
        .bind(b.existingOrgId ?? "", `demo-${b.slug}`)
        .first<{ id: string; metadata: string }>();
      expect(JSON.parse(org?.metadata ?? "{}")).toEqual({ demo: true });
      const identity = await getIdentity(db, org?.id as string);
      expect(identity?.protected).toBe(true);
      expect(identity?.financeContact).toBe(b.accounts);
      expect(await env.ARTEFACTS.head(identity?.logo?.key as string)).not.toBeNull();
      expect(
        (
          await db
            .prepare(`SELECT count(*) AS n FROM org_domains WHERE org_id = ? AND domain = ? AND state = 'verified'`)
            .bind(org?.id, b.domain)
            .first<{ n: number }>()
        )?.n,
      ).toBe(1);
      expect(
        (
          await db
            .prepare(`SELECT count(*) AS n FROM bank_accounts WHERE org_id = ?`)
            .bind(org?.id)
            .first<{ n: number }>()
        )?.n,
      ).toBe(1);
    }
    const before = await dump();
    const objectsBefore = (await env.ARTEFACTS.list()).objects.length;
    const second = await seedDemo(env, businesses());
    for (const r of second) expect(Object.values(r.steps)).toEqual(Array(6).fill("present"));
    expect(await dump()).toBe(before);
    expect((await env.ARTEFACTS.list()).objects.length).toBe(objectsBefore);
  });

  it("leaves what the protected organisation already holds exactly as found", async () => {
    await fynbosExists();
    await setIdentity(db, FYNBOS_ORG_ID, "operator", {
      displayNames: ["Fynbos Freight (operator's own)"],
      financeContact: null,
      protected: false,
    });
    await db
      .prepare(`UPDATE "organization" SET metadata = ? WHERE id = ?`)
      .bind(JSON.stringify({ note: "operator" }), FYNBOS_ORG_ID)
      .run();
    await seedDemo(env, businesses());
    const identity = await getIdentity(db, FYNBOS_ORG_ID);
    expect(identity?.displayNames).toEqual(["Fynbos Freight (operator's own)"]);
    expect(identity?.protected).toBe(false);
    expect(
      (
        await db
          .prepare(`SELECT metadata FROM "organization" WHERE id = ?`)
          .bind(FYNBOS_ORG_ID)
          .first<{ metadata: string }>()
      )?.metadata,
    ).toBe('{"note":"operator"}');
    const report = (await checkDemo(env, businesses())).find((c) => c.slug === "fynbos-freight");
    expect(report?.problems.join(" ")).toMatch(/not protected \(left as found/);
    expect(report?.problems.join(" ")).toMatch(/not flagged demo/);
  });

  it("never removes or replaces what the protected organisation holds: its own logo and account stay, the seed only adds", async () => {
    await fynbosExists();
    await setIdentity(db, FYNBOS_ORG_ID, "operator", {
      displayNames: ["Fynbos Freight"],
      financeContact: null,
      protected: false,
    });
    const own = await storeLogo(
      env.ARTEFACTS,
      db,
      FYNBOS_ORG_ID,
      "operator",
      new TextEncoder().encode(courier),
      "image/svg+xml",
    );
    await addAccount(db, await bankKeys(env), FYNBOS_ORG_ID, "operator", {
      number: "0000007777",
      branchCode: "000000",
      bankName: "Protea Bank",
      holder: "Fynbos Freight (Pty) Ltd",
    });
    const before = await db
      .prepare(
        `SELECT display_names_json, finance_contact_email, protected, version, logo_r2_key FROM identities WHERE org_id = ?`,
      )
      .bind(FYNBOS_ORG_ID)
      .first();
    await seedDemo(env, businesses());
    expect(
      await db
        .prepare(
          `SELECT display_names_json, finance_contact_email, protected, version, logo_r2_key FROM identities WHERE org_id = ?`,
        )
        .bind(FYNBOS_ORG_ID)
        .first(),
    ).toEqual(before);
    expect((await getIdentity(db, FYNBOS_ORG_ID))?.logo?.key).toBe(own.key);
    expect(await env.ARTEFACTS.head(own.key)).not.toBeNull();
    expect(
      (
        await db
          .prepare(`SELECT count(*) AS n FROM bank_accounts WHERE org_id = ?`)
          .bind(FYNBOS_ORG_ID)
          .first<{ n: number }>()
      )?.n,
    ).toBe(2);
  });

  it("refuses a data file that names a protected organisation or account for another business, before writing", async () => {
    await fynbosExists();
    const before = await dump();
    const reuse = businesses().map((b) => (b.slug === "quagga-tyres" ? { ...b, existingOrgId: FYNBOS_ORG_ID } : b));
    await expect(seedDemo(env, reuse)).rejects.toBeInstanceOf(ProtectedTarget);
    const owned = businesses().map((b) =>
      b.slug === "quagga-tyres" ? { ...b, ownerEmail: "derick@rizonetech.com" } : b,
    );
    await expect(seedDemo(env, owned)).rejects.toMatchObject({ code: "PROTECTED_TARGET" });
    const moved = businesses().map((b) => (b.slug === "fynbos-freight" ? { ...b, existingOrgId: "someone-else" } : b));
    await expect(seedDemo(env, moved)).rejects.toBeInstanceOf(ProtectedTarget);
    expect(await dump()).toBe(before);
  });

  it("writes nothing when Fynbos Freight is missing", async () => {
    await expect(seedDemo(env, businesses())).rejects.toBeInstanceOf(FynbosMissing);
    expect((await db.prepare(`SELECT count(*) AS n FROM "organization"`).first<{ n: number }>())?.n).toBe(0);
  });

  it("resumes after an interruption: no duplicate organisation, membership or account, and the protected data unchanged", async () => {
    await fynbosExists();
    await db.exec(
      `CREATE TRIGGER fail_account BEFORE INSERT ON bank_accounts WHEN NEW.holder LIKE 'Marula%' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    await expect(seedDemo(env, businesses())).rejects.toMatchObject({
      name: "SeedFailed",
      business: "marula-office-supplies",
      step: "account",
    });
    await db.exec("DROP TRIGGER fail_account");
    await db.exec(
      `CREATE TRIGGER fail_domain BEFORE INSERT ON org_domains WHEN NEW.domain LIKE 'quagga%' BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    await expect(seedDemo(env, businesses())).rejects.toBeInstanceOf(SeedFailed);
    await db.exec("DROP TRIGGER fail_domain");
    await seedDemo(env, businesses());
    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n;
    expect(await count(`SELECT count(*) AS n FROM "organization"`)).toBe(5);
    expect(await count(`SELECT count(*) AS n FROM member`)).toBe(5);
    expect(await count(`SELECT count(*) AS n FROM bank_accounts`)).toBe(5);
    expect(await count(`SELECT count(*) AS n FROM identities`)).toBe(5);
    expect((await checkDemo(env, businesses())).flatMap((c) => c.problems)).toEqual([]);
  });
});

describe("checkDemo", () => {
  it("reads complete state as clean, and every missing part by name, without writing", async () => {
    await fynbosExists();
    expect((await checkDemo(env, businesses())).every((c) => c.problems.length > 0)).toBe(true);
    await seedDemo(env, businesses());
    const reports = await checkDemo(env, businesses());
    expect(reports.flatMap((c) => c.problems)).toEqual([]);
    expect(reports.every((c) => c.protected)).toBe(true);
    const tyresOrg = reports.find((c) => c.slug === "quagga-tyres")?.orgId as string;
    const key = (await getIdentity(db, tyresOrg))?.logo?.key as string;
    await env.ARTEFACTS.delete(key);
    await db.prepare(`DELETE FROM bank_accounts WHERE org_id = ?`).bind(tyresOrg).run();
    await db.prepare(`UPDATE "organization" SET metadata = NULL WHERE id = ?`).bind(tyresOrg).run();
    const before = await dump();
    const broken = (await checkDemo(env, businesses())).find((c) => c.slug === "quagga-tyres");
    expect(broken?.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/logo object is missing/),
        expect.stringMatching(/account is not registered/),
        expect.stringMatching(/not flagged demo/),
      ]),
    );
    expect(await dump()).toBe(before);
  });
});
