import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { closeOrganisation, purgeOrganisation, scheduledClosurePurge } from "../../src/auth/closure";
import { findMemberBySender } from "../../src/auth/senders";
import { createCase } from "../../src/db/cases";
import { FYNBOS_ORG_ID } from "../../src/demo/seed";
import { authEnv, call, signIn } from "./helpers";

// D07 T02 §9: account closure and the coordinated purge. The owner closes from the Account page; the organisation
// refuses new cases at once; the scheduled purge deletes its artefacts and rows 25 days after closure (inside the
// promised 30), an abandoned signup after 30, and never a protected account or Fynbos Freight.
const db = (env as unknown as Env).DB;
const bucket = (env as unknown as Env).ARTEFACTS;
const tag = () => crypto.randomUUID().slice(0, 8);
const now = () => new Date().toISOString();

async function user(email: string) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, email.split("@")[0], email, now(), now())
    .run();
  return id;
}
async function organisation(name = "Karoo Couriers") {
  const id = `org-${tag()}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, id, now())
    .run();
  return id;
}
async function join(orgId: string, userId: string, role = "member") {
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), orgId, userId, role, now())
    .run();
}
const count = async (sql: string, ...bind: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...bind)
      .first<{ n: number }>()
  )?.n ?? -1;

describe("closing an organisation", () => {
  it("stamps closedAt once for the owner, and a repeat keeps the first stamp", async () => {
    const org = await organisation();
    const owner = await user(`owner-${tag()}@demo.isitlegit.co.za`);
    await join(org, owner, "owner");
    const first = new Date("2026-10-01T00:00:00Z");
    expect(await closeOrganisation(db, org, owner, first)).toEqual({ ok: true, already: false });
    expect(await closeOrganisation(db, org, owner, new Date("2026-10-02T00:00:00Z"))).toEqual({
      ok: true,
      already: true,
    });
    const row = await db.prepare(`SELECT "closedAt" AS c FROM "organization" WHERE id = ?`).bind(org).first();
    expect(row?.c).toBe(first.toISOString());
  });

  it("refuses a non-owner, a non-member, the protected organisation and a protected member's organisation", async () => {
    const org = await organisation();
    const owner = await user(`owner-${tag()}@demo.isitlegit.co.za`);
    const member = await user(`member-${tag()}@demo.isitlegit.co.za`);
    await join(org, owner, "owner");
    await join(org, member);
    expect((await closeOrganisation(db, org, member, new Date())).ok).toBe(false);
    expect((await closeOrganisation(db, org, await user(`x-${tag()}@demo.isitlegit.co.za`), new Date())).ok).toBe(
      false,
    );
    // A protected person belongs to this one: nobody closes it.
    await join(org, await user("demo@rizonetech.com"));
    expect(await closeOrganisation(db, org, owner, new Date())).toEqual({ ok: false, reason: "protected" });
    // Fynbos Freight itself, even for its own owner row.
    const fynbosOwner = await user(`fynbos-${tag()}@demo.isitlegit.co.za`);
    await db
      .prepare(`INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Fynbos Freight', ?, ?)`)
      .bind(FYNBOS_ORG_ID, FYNBOS_ORG_ID, now())
      .run();
    await join(FYNBOS_ORG_ID, fynbosOwner, "owner");
    expect((await closeOrganisation(db, FYNBOS_ORG_ID, fynbosOwner, new Date())).ok).toBe(false);
  });

  it("closes through the Account page route, and only for the owner on the app's own origin", async () => {
    const org = await organisation();
    const email = `owner-${tag()}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const me = await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
    await join(org, me?.id ?? "", "owner");
    await db
      .prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`)
      .bind(org, me?.id ?? "")
      .run();
    // A bare action-and-id post, without the confirmation page's evidence, closes nothing.
    const bare = await call(
      "/settings/account",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ action: "close-account", id: org }),
      },
      authEnv,
    );
    expect(bare.status).toBe(303);
    expect(
      (
        await db
          .prepare(`SELECT "closedAt" AS c FROM "organization" WHERE id = ?`)
          .bind(org)
          .first<{ c: string | null }>()
      )?.c,
    ).toBeNull();
    const confirmPage = await call("/settings/account/close", { headers: { cookie } }, authEnv);
    const confirmHtml = await confirmPage.text();
    expect(confirmHtml).toContain("Karoo Couriers");
    const token = /name="confirm" value="([^"]*)"/.exec(confirmHtml)?.[1] ?? "";
    expect(token).not.toBe("");
    const form = new URLSearchParams({ action: "close-account", id: org, confirm: token });
    const closed = await call(
      "/settings/account",
      { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form },
      authEnv,
    );
    expect(closed.status).toBe(303);
    expect(await db.prepare(`SELECT "closedAt" AS c FROM "organization" WHERE id = ?`).bind(org).first()).toBeTruthy();
    // Already closed: the confirmation route answers with the closed outcome, and the Account page says so.
    const confirm = await call("/settings/account/close", { headers: { cookie } }, authEnv);
    expect(confirm.status).toBe(303);
    const page = await call("/settings/account", { headers: { cookie } }, authEnv);
    expect(await page.text()).toContain("is closed");
    const foreign = await call(
      "/settings/account",
      {
        method: "POST",
        headers: { cookie, origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
        body: form,
      },
      authEnv,
    );
    expect(foreign.status).toBe(403);
  });

  it("refuses forwarded mail for a closed organisation", async () => {
    const org = await organisation();
    const owner = await user(`owner-${tag()}@demo.isitlegit.co.za`);
    await join(org, owner, "owner");
    await db
      .prepare(
        `INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'verified', ?)`,
      )
      .bind(crypto.randomUUID(), org, `mail-${tag()}.example`, "t".repeat(20), now())
      .run();
    const domainRow = await db
      .prepare(`SELECT domain FROM org_domains WHERE org_id = ?`)
      .bind(org)
      .first<{ domain: string }>();
    const sender = `person@${domainRow?.domain}`;
    expect(await findMemberBySender(db, sender)).toBe(org);
    await closeOrganisation(db, org, owner, new Date());
    expect(await findMemberBySender(db, sender)).toBeNull();
  });
});

describe("the scheduled purge", () => {
  it("deletes a closed organisation's artefacts and rows, and keeps an open one's and a shared user", async () => {
    const org = await organisation();
    const other = await organisation("Swartberg Transport");
    const owner = await user(`owner-${tag()}@demo.isitlegit.co.za`);
    await join(org, owner, "owner");
    await join(other, owner, "owner");
    const caseId = `case-${tag()}`;
    await db
      .prepare(
        `INSERT INTO cases (id, org_id, channel, status, created_at, updated_at) VALUES (?, ?, 'email', 'done', ?, ?)`,
      )
      .bind(caseId, org, now(), now())
      .run();
    const key = `cases/${caseId}/raw.eml`;
    await bucket.put(key, "mail");
    await db
      .prepare(
        `INSERT INTO artefacts (r2_key, case_id, kind, sha256, media_type, bytes) VALUES (?, ?, 'raw', ?, 'message/rfc822', 4)`,
      )
      .bind(key, caseId, "a".repeat(64))
      .run();
    await db
      .prepare(
        `INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'verified', ?)`,
      )
      .bind(crypto.randomUUID(), org, `gone-${tag()}.example`, "t".repeat(20), now())
      .run();
    await db.prepare(`INSERT INTO org_limits (org_id) VALUES (?)`).bind(org).run();
    await closeOrganisation(db, org, owner, new Date(Date.now() - 26 * 86_400_000));
    const report = await scheduledClosurePurge({ DB: db, ARTEFACTS: bucket }, new Date());
    expect(report.purged).toContain(org);
    expect(await bucket.head(key)).toBeNull();
    expect(await count(`SELECT COUNT(*) AS n FROM cases WHERE org_id = ?`, org)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE id = ?`, org)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE id = ?`, other)).toBe(1);
    // The shared user survives, with the open membership.
    expect(await count(`SELECT COUNT(*) AS n FROM "user" WHERE id = ?`, owner)).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM "member" WHERE "userId" = ?`, owner)).toBe(1);
  });

  it("leaves a recently closed and a protected organisation alone", async () => {
    const org = await organisation();
    const owner = await user(`owner-${tag()}@demo.isitlegit.co.za`);
    await join(org, owner, "owner");
    await db
      .prepare(`UPDATE "organization" SET "closedAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 2 * 86_400_000).toISOString(), org)
      .run();
    const report = await scheduledClosurePurge({ DB: db, ARTEFACTS: bucket }, new Date());
    expect(report.purged).not.toContain(org);
    expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE id = ?`, org)).toBe(1);
  });

  it("never purges an eligible organisation with a protected member, and refuses its next case", async () => {
    const org = await organisation();
    const owner = await user(`owner-${tag()}@demo.isitlegit.co.za`);
    await join(org, owner, "owner");
    await join(org, await user("derick@rizonetech.com"));
    await db
      .prepare(`UPDATE "organization" SET "closedAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 26 * 86_400_000).toISOString(), org)
      .run();
    const report = await scheduledClosurePurge({ DB: db, ARTEFACTS: bucket }, new Date());
    expect(report.purged).not.toContain(org);
    expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE id = ?`, org)).toBe(1);
    const admitted = await createCase(db, {
      orgId: org,
      channel: "upload",
      headersAvailable: false,
      uploadedBy: owner,
      sourceKind: "email-file",
    }).catch(() => null);
    expect(admitted && "ok" in admitted ? admitted.ok : false).toBe(false);
    expect(await count(`SELECT COUNT(*) AS n FROM cases WHERE org_id = ?`, org)).toBe(0);
  });

  it("resumes an interrupted purge on the next run", async () => {
    const org = await organisation();
    const owner = await user(`owner-${tag()}@demo.isitlegit.co.za`);
    await join(org, owner, "owner");
    for (const _n of [1, 2]) {
      const caseId = `case-${tag()}`;
      await db
        .prepare(
          `INSERT INTO cases (id, org_id, channel, status, created_at, updated_at) VALUES (?, ?, 'email', 'done', ?, ?)`,
        )
        .bind(caseId, org, now(), now())
        .run();
      const key = `raw/${caseId}/message.eml`;
      await bucket.put(key, "mail");
      await db
        .prepare(
          `INSERT INTO artefacts (r2_key, case_id, kind, sha256, media_type, bytes) VALUES (?, ?, 'raw', ?, 'message/rfc822', 4)`,
        )
        .bind(key, caseId, "a".repeat(64))
        .run();
    }
    const first = await purgeOrganisation({ DB: db, ARTEFACTS: bucket }, org, 1);
    expect(first.done).toBe(false);
    const second = await purgeOrganisation({ DB: db, ARTEFACTS: bucket }, org, 200);
    expect(second.done).toBe(true);
    expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE id = ?`, org)).toBe(0);
  });

  it("cleans up an interrupted signup's user, organisation and redemption together", async () => {
    const code = await db
      .prepare(
        `INSERT INTO invite_codes (id, code_hash, label, max_uses, expires_at, created_at) VALUES (?, ?, 'test', 1, ?, ?) RETURNING id`,
      )
      .bind(crypto.randomUUID(), "c".repeat(64), new Date(Date.now() + 86_400_000).toISOString(), now())
      .first<{ id: string }>();
    const redemptionId = crypto.randomUUID();
    const interrupted = await user(`interrupted-${tag()}@demo.isitlegit.co.za`);
    const orgId = `org-made-${tag()}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Interrupted', ?, ?)`)
      .bind(orgId, `org-${redemptionId}`, now())
      .run();
    await join(orgId, interrupted, "owner");
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await db
      .prepare(
        `INSERT INTO invite_redemptions (id, code_id, email, status, user_id, org_id, consented_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(redemptionId, code?.id, `interrupted-${tag()}@demo.isitlegit.co.za`, interrupted, orgId, old, old)
      .run();
    await scheduledClosurePurge({ DB: db, ARTEFACTS: bucket }, new Date());
    expect(await count(`SELECT COUNT(*) AS n FROM invite_redemptions WHERE id = ?`, redemptionId)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "user" WHERE id = ?`, interrupted)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE id = ?`, orgId)).toBe(0);
  });

  it("deletes an abandoned signup untouched for 30 days, and keeps a completed one", async () => {
    const code = await db
      .prepare(
        `INSERT INTO invite_codes (id, code_hash, label, max_uses, expires_at, created_at) VALUES (?, ?, 'test', 1, ?, ?) RETURNING id`,
      )
      .bind(crypto.randomUUID(), "b".repeat(64), new Date(Date.now() + 86_400_000).toISOString(), now())
      .first<{ id: string }>();
    const orphan = await user(`orphan-${tag()}@demo.isitlegit.co.za`);
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await db
      .prepare(
        `INSERT INTO invite_redemptions (id, code_id, email, status, user_id, consented_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), code?.id, `orphan-${tag()}@demo.isitlegit.co.za`, orphan, old, old)
      .run();
    await scheduledClosurePurge({ DB: db, ARTEFACTS: bucket }, new Date());
    expect(await count(`SELECT COUNT(*) AS n FROM invite_redemptions WHERE user_id = ?`, orphan)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "user" WHERE id = ?`, orphan)).toBe(0);
  });
});
