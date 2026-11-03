// Protected identities (D05 T01 §1; spec 2a): the schema's constraints, validated and audited changes that commit
// with their events, a finance contact that must be a verified address, protection that holds only while its domain
// and contact do, claim matching that returns only which organisation, and two organisations kept apart.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { isAllowedRecipient } from "../../src/mail/allowlist";
import {
  findIdentityByClaim,
  getIdentity,
  IdentityRefused,
  identityContact,
  normaliseName,
  protectedIdentities,
  setIdentity,
} from "../../src/trust/identity";
import { addAddress, addDomain, events, makeOrg, protectableOrg } from "./helpers";

const db = env.DB;
const names = ["Hadeda Couriers (Pty) Ltd", "Hadeda"];
const input = (over: Record<string, unknown> = {}) => ({
  displayNames: names,
  financeContact: "accounts@hadeda.example",
  protected: false,
  ...over,
});
const refused = async (p: Promise<unknown>, message: RegExp) => {
  await expect(p).rejects.toBeInstanceOf(IdentityRefused);
  await expect(p).rejects.toThrow(message);
};

// Storage is shared by the tests of one file, and a verified domain or address belongs to one organisation, so each
// test starts from empty trust and verification tables.
beforeEach(async () => {
  await db.exec("DROP TRIGGER IF EXISTS fail_trust_events");
  await db.batch(
    ["trust_events", "identities", "org_domains", "org_addresses"].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

describe("the schema", () => {
  it("stores a valid identity and event, and refuses malformed rows", async () => {
    const orgId = await makeOrg();
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO identities (org_id, display_names_json, updated_at, updated_by) VALUES (?, '[\"A\"]', ?, 'u1')",
      )
      .bind(orgId, now)
      .run();
    await db
      .prepare(
        "INSERT INTO trust_events (id, org_id, actor, kind, detail_json, created_at) VALUES ('e1', ?, 'u1', 'identity.set', '{}', ?)",
      )
      .bind(orgId, now)
      .run();
    const bad = (sql: string, ...args: unknown[]) =>
      expect(
        db
          .prepare(sql)
          .bind(...args)
          .run(),
      ).rejects.toThrow();
    await bad("INSERT INTO identities (org_id, updated_at, updated_by) VALUES ('no-such-org', ?, 'u1')", now);
    const other = await makeOrg();
    await bad(
      "INSERT INTO identities (org_id, display_names_json, updated_at, updated_by) VALUES (?, '{}', ?, 'u1')",
      other,
      now,
    );
    await bad(
      "INSERT INTO identities (org_id, logo_r2_key, logo_media_type, updated_at, updated_by) VALUES (?, 'ident/someone-else/logo.png', 'image/png', ?, 'u1')",
      other,
      now,
    );
    await bad(
      "INSERT INTO identities (org_id, logo_r2_key, updated_at, updated_by) VALUES (?, ?, ?, 'u1')",
      other,
      `ident/${other}/logo.png`,
      now,
    );
    await bad(
      "INSERT INTO trust_events (id, org_id, actor, kind, created_at) VALUES ('e2', ?, 'u1', 'identity.unknown', ?)",
      orgId,
      now,
    );
  });
});

describe("setIdentity", () => {
  it("stores, reads back and replaces an identity, one event per change naming its fields", async () => {
    const orgId = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    await setIdentity(db, orgId, "owner-1", input());
    let identity = await getIdentity(db, orgId);
    expect(identity).toMatchObject({
      displayNames: names,
      financeContact: "accounts@hadeda.example",
      protected: false,
      updatedBy: "owner-1",
    });
    await setIdentity(db, orgId, "owner-2", input({ displayNames: ["Hadeda"] }));
    identity = await getIdentity(db, orgId);
    expect(identity?.displayNames).toEqual(["Hadeda"]);
    expect(await events(orgId)).toEqual([
      { kind: "identity.set", actor: "owner-1", detail: { fields: ["displayNames", "financeContact", "protected"] } },
      { kind: "identity.set", actor: "owner-2", detail: { fields: ["displayNames"] } },
    ]);
  });

  it("refuses each malformed input", async () => {
    const orgId = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ displayNames: [] }, /displayNames/],
      [{ displayNames: Array.from({ length: 11 }, (_, i) => `Name ${i}`) }, /displayNames/],
      [{ displayNames: ["x".repeat(121)] }, /displayNames/],
      [{ displayNames: ["(—) !!"] }, /letters or digits/],
      [{ displayNames: ["Hadeda (Pty) Ltd", "hadeda pty ltd"] }, /the same/],
      [{ nickname: "H" }, /nickname|Unrecognized/i],
    ];
    for (const [over, message] of cases) await refused(setIdentity(db, orgId, "o", input(over)), message);
    expect(await getIdentity(db, orgId)).toBeNull();
  });

  it("commits a change and its event together, or neither", async () => {
    const orgId = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    await setIdentity(db, orgId, "o", input());
    await db.exec(
      "CREATE TRIGGER fail_trust_events BEFORE INSERT ON trust_events BEGIN SELECT RAISE(ABORT, 'audit down'); END",
    );
    await expect(setIdentity(db, orgId, "o", input({ displayNames: ["Changed"] }))).rejects.toThrow(/audit down/);
    expect((await getIdentity(db, orgId))?.displayNames).toEqual(names);
  });
});

describe("the finance contact", () => {
  it("must be a verified address of this organisation, and is the identity's contact", async () => {
    const orgId = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    await addAddress(orgId, "pending@hadeda.example", "pending");
    const other = await protectableOrg("other.example", "finance@other.example");
    await refused(setIdentity(db, orgId, "o", input({ financeContact: "pending@hadeda.example" })), /verified address/);
    await refused(setIdentity(db, orgId, "o", input({ financeContact: "finance@other.example" })), /verified address/);
    await setIdentity(db, orgId, "o", input({ financeContact: "Accounts@Hadeda.example" }));
    expect(await identityContact(db, orgId)).toBe("accounts@hadeda.example");
    expect(await identityContact(db, other)).toBeNull();
  });

  it("is stored when verified even if mail may not go to it now: eligibility is the mail layer's", async () => {
    const orgId = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    await setIdentity(db, orgId, "o", input());
    expect(await identityContact(db, orgId)).toBe("accounts@hadeda.example");
    expect(await isAllowedRecipient(db, "accounts@hadeda.example", "verify", undefined)).toBe(false);
  });
});

describe("protection", () => {
  it("needs a verified domain and a finance contact, each named, and switches off at any time", async () => {
    const noDomain = await makeOrg();
    await addAddress(noDomain, "a@nodomain.example");
    await refused(
      setIdentity(db, noDomain, "o", input({ financeContact: "a@nodomain.example", protected: true })),
      /a verified domain$/,
    );
    const orgId = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    await refused(setIdentity(db, orgId, "o", input({ financeContact: null, protected: true })), /a finance contact$/);
    const bare = await makeOrg();
    await refused(
      setIdentity(db, bare, "o", input({ financeContact: null, protected: true })),
      /a verified domain and a finance contact/,
    );
    await setIdentity(db, orgId, "o", input({ protected: true }));
    expect((await getIdentity(db, orgId))?.effective).toEqual({ on: true });
    await setIdentity(db, orgId, "o", input({ protected: false }));
    expect(await getIdentity(db, orgId)).toMatchObject({
      protected: false,
      effective: { on: false, reason: "protection is switched off" },
    });
  });

  it("ends when the last verified domain or the contact's verified address is removed", async () => {
    const a = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    await setIdentity(db, a, "o", input({ protected: true }));
    expect(await findIdentityByClaim(db, { domain: "hadeda.example" })).toHaveLength(1);
    await db.prepare("DELETE FROM org_domains WHERE org_id = ?").bind(a).run();
    expect((await getIdentity(db, a))?.effective).toEqual({ on: false, reason: "no domain is verified" });
    expect(await findIdentityByClaim(db, { displayName: "Hadeda" })).toEqual([]);

    const b = await protectableOrg("ibis.example", "finance@ibis.example", "Ibis Stationers");
    await setIdentity(
      db,
      b,
      "o",
      input({ displayNames: ["Ibis Stationers"], financeContact: "finance@ibis.example", protected: true }),
    );
    await db.prepare("DELETE FROM org_addresses WHERE org_id = ? AND address = 'finance@ibis.example'").bind(b).run();
    expect((await getIdentity(db, b))?.effective).toEqual({
      on: false,
      reason: "the finance contact is no longer a verified address",
    });
    expect(await identityContact(db, b)).toBeNull();
    expect(await findIdentityByClaim(db, { domain: "ibis.example" })).toEqual([]);
  });
});

describe("findIdentityByClaim", () => {
  it("matches normalised names and registrable domains, every match, and only which organisation", async () => {
    expect(normaliseName("Hadeda Couriers (Pty) Ltd")).toBe(normaliseName("hadeda  couriers pty ltd"));
    const a = await protectableOrg("hadeda-couriers.example", "accounts@hadeda-couriers.example");
    await setIdentity(db, a, "o", input({ financeContact: "accounts@hadeda-couriers.example", protected: true }));
    const b = await protectableOrg("hadeda-cleaning.example", "money@hadeda-cleaning.example");
    await setIdentity(
      db,
      b,
      "o",
      input({ displayNames: ["Hadeda"], financeContact: "money@hadeda-cleaning.example", protected: true }),
    );
    const draft = await protectableOrg("draft.example", "x@draft.example");
    await setIdentity(db, draft, "o", input({ displayNames: ["Draft Holdings"], financeContact: "x@draft.example" }));
    const pending = await makeOrg();
    await addDomain(pending, "pending.example", "pending");

    const byName = await findIdentityByClaim(db, { displayName: "hadeda  couriers pty ltd" });
    expect(byName).toEqual([{ orgId: a, name: "Hadeda Couriers (Pty) Ltd", matchedBy: "name" }]);
    expect((await findIdentityByClaim(db, { displayName: "HADEDA" })).map((m) => m.orgId).sort()).toEqual(
      [a, b].sort(),
    );
    expect(await findIdentityByClaim(db, { domain: "billing.hadeda-couriers.example" })).toEqual([
      { orgId: a, name: "hadeda-couriers.example", matchedBy: "domain" },
    ]);
    for (const claim of [
      { displayName: "Kestrel Bank" },
      { domain: "unrelated.example" },
      { displayName: "Draft Holdings" },
      { domain: "pending.example" },
    ])
      expect(await findIdentityByClaim(db, claim)).toEqual([]);
    for (const m of byName) expect(Object.keys(m).sort()).toEqual(["matchedBy", "name", "orgId"]);
  });
});

describe("tenancy", () => {
  it("keeps two organisations' identities and events apart", async () => {
    const a = await protectableOrg("hadeda.example", "accounts@hadeda.example");
    const b = await protectableOrg("ibis.example", "finance@ibis.example");
    await setIdentity(db, a, "o", input());
    expect(await getIdentity(db, b)).toBeNull();
    await setIdentity(db, b, "o", input({ displayNames: ["Ibis"], financeContact: "finance@ibis.example" }));
    expect((await getIdentity(db, a))?.displayNames).toEqual(names);
    expect((await events(a)).length).toBe(1);
    expect((await events(b)).length).toBe(1);
  });
});

describe("the revision a caller's form was drawn from", () => {
  it("refuses a save against an old revision before writing, and applies one against the current revision", async () => {
    const orgId = await protectableOrg("rev.example", "money@rev.example");
    const base = { financeContact: "money@rev.example" };
    // No identity yet is revision 0.
    await expect(setIdentity(db, orgId, "a", input({ ...base, displayNames: ["A"] }), new Date(), 3)).rejects.toThrow(
      /since the page was drawn/,
    );
    expect(await getIdentity(db, orgId)).toBeNull();
    const first = await setIdentity(db, orgId, "a", input({ ...base, displayNames: ["A"] }), new Date(), 0);
    await setIdentity(db, orgId, "b", input({ ...base, displayNames: ["B"] }), new Date(), first.version);
    await expect(
      setIdentity(db, orgId, "a", input({ ...base, displayNames: ["A again"] }), new Date(), first.version),
    ).rejects.toThrow(IdentityRefused);
    expect((await getIdentity(db, orgId))?.displayNames).toEqual(["B"]);
    expect((await events(orgId)).map((e) => e.actor)).toEqual(["a", "b"]);
  });
});

describe("round 1", () => {
  it("refuses an edit made against a version another edit replaced, so no event misnames a change", async () => {
    const orgId = await protectableOrg("race.example", "money@race.example");
    await setIdentity(db, orgId, "first", input({ displayNames: ["Old"], financeContact: "money@race.example" }));
    // Admin B's edit commits while admin A's is between its read and its write.
    let raced = false;
    const racing = new Proxy(db, {
      get: (t, p) =>
        p === "batch"
          ? async (statements: D1PreparedStatement[]) => {
              if (!raced) {
                raced = true;
                await setIdentity(
                  db,
                  orgId,
                  "admin-b",
                  input({ displayNames: ["Renamed"], financeContact: "money@race.example" }),
                );
              }
              return t.batch(statements);
            }
          : Reflect.get(t, p).bind(t),
    });
    await expect(
      setIdentity(
        racing,
        orgId,
        "admin-a",
        input({ displayNames: ["Old"], financeContact: "money@race.example", protected: true }),
      ),
    ).rejects.toThrow(/changed meanwhile/);
    expect(await getIdentity(db, orgId)).toMatchObject({ displayNames: ["Renamed"], protected: false });
    expect((await events(orgId)).map((e) => [e.actor, e.detail.fields])).toEqual([
      ["first", ["displayNames", "financeContact", "protected"]],
      ["admin-b", ["displayNames"]],
    ]);
  });
});

describe("protected candidates for the claim match (D02 T01 §9)", () => {
  it("projects every effectively protected identity, allowlisted, in org-id order", async () => {
    const b = await protectableOrg("bravo.example", "money@bravo.example", "Bravo (fictional)");
    const a = await protectableOrg("alpha.example", "money@alpha.example", "Alpha (fictional)");
    await setIdentity(db, b, "u1", {
      displayNames: ["Bravo Movers", "Bravo"],
      financeContact: "money@bravo.example",
      protected: true,
    });
    await setIdentity(db, a, "u1", {
      displayNames: ["Alpha Freight"],
      financeContact: "money@alpha.example",
      protected: true,
    });
    const out = await protectedIdentities(db);
    expect(out.map((c) => c.orgId)).toEqual([a, b].sort());
    const alpha = out.find((c) => c.orgId === a);
    expect(alpha).toEqual({
      orgId: a,
      names: ["Alpha Freight"],
      domains: ["alpha.example"],
      logo: null,
    });
    // The allowlist: no finance contact, no bank field, no other registered detail rides along.
    expect(Object.keys(alpha as object).sort()).toEqual(["domains", "logo", "names", "orgId"]);
    expect(JSON.stringify(out)).not.toContain("money@");
  });

  it("excludes an identity whose protection no longer holds", async () => {
    const off = await protectableOrg("off.example", "money@off.example");
    await setIdentity(db, off, "u1", { displayNames: ["Off"], financeContact: "money@off.example", protected: false });
    const lapsed = await protectableOrg("lapsed.example", "money@lapsed.example");
    await setIdentity(db, lapsed, "u1", {
      displayNames: ["Lapsed"],
      financeContact: "money@lapsed.example",
      protected: true,
    });
    // The verified domain goes away, so protection lapses at read time.
    await db.prepare("DELETE FROM org_domains WHERE org_id = ?").bind(lapsed).run();
    const unverified = await protectableOrg("unverified.example", "money@unverified.example");
    await setIdentity(db, unverified, "u1", {
      displayNames: ["Unverified"],
      financeContact: "money@unverified.example",
      protected: true,
    });
    await db.prepare("UPDATE org_addresses SET state = 'pending' WHERE org_id = ?").bind(unverified).run();
    expect(await protectedIdentities(db)).toEqual([]);
  });
});
