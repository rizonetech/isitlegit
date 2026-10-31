import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  isProtectedAccount,
  isProtectedOrganisation,
  PROTECTED_ACCOUNT,
  PROTECTED_ACCOUNTS,
  PROTECTED_ORGANISATIONS,
} from "../../src/auth/protected";
import { call, signIn } from "./helpers";

// D07 T02 §21: the protected live test accounts (AGENTS.md) are never removed from an organisation, by an owner or by
// leaving, in any organisation, by member id or by email, in a named or the active organisation. An ordinary member the
// test makes is removed and leaves as before. Every refusal changes nothing and is in the audit trail.
const db = (env as unknown as Env).DB;
const SECRET = (env as unknown as Env).BETTER_AUTH_SECRET;
const COOKIE = "__Secure-better-auth.session_token";
const tag = () => crypto.randomUUID().slice(0, 8);

// A session made for a user directly, its cookie signed as Better Auth signs it (HMAC-SHA256, base64).
async function sessionFor(userId: string, orgId: string) {
  const token = `${tag()}${tag()}${tag()}`;
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "activeOrganizationId") VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), new Date(Date.now() + 86_400_000).toISOString(), token, now, now, userId, orgId)
    .run();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = btoa(
    String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)))),
  );
  return `${COOKIE}=${encodeURIComponent(`${token}.${signature}`)}`;
}
async function user(email: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, email.split("@")[0], email, now, now)
    .run();
  return id;
}
async function join(orgId: string, userId: string, role = "member") {
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(id, orgId, userId, role, new Date().toISOString())
    .run();
  return id;
}
// An organisation with two owners (so no last-owner rule refuses first): the signed-in owner who acts, and a second.
async function organisation(orgId = `org-${tag()}`) {
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Karoo Couriers', ?, ?)`)
    .bind(orgId, orgId, new Date().toISOString())
    .run();
  const ownerEmail = `owner-${tag()}@demo.isitlegit.co.za`;
  await signIn(ownerEmail);
  const ownerId = (await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(ownerEmail).first<{ id: string }>())
    ?.id as string;
  await join(orgId, ownerId, "owner");
  await join(orgId, await user(`second-${tag()}@demo.isitlegit.co.za`), "owner");
  return { orgId, ownerId, owner: await sessionFor(ownerId, orgId) };
}
const post = (path: string, cookie: string, body: unknown) =>
  call(`/api/auth${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
// The rows a removal would change, read back as they stand.
const snapshot = async (orgId: string, userId: string) => ({
  members: (
    await db
      .prepare(`SELECT id, role FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
      .bind(orgId, userId)
      .all()
  ).results,
  sessions: (await db.prepare(`SELECT id FROM "session" WHERE "userId" = ?`).bind(userId).all()).results,
  invitations: (await db.prepare(`SELECT id, status FROM invitation WHERE "organizationId" = ?`).bind(orgId).all())
    .results,
});
const refusals = (orgId: string, targetId: string) =>
  db
    .prepare(
      "SELECT kind, outcome, actor_id, target_id FROM auth_events WHERE org_id = ? AND target_id = ? AND outcome = 'refused-protected'",
    )
    .bind(orgId, targetId)
    .all<{ kind: string; outcome: string; actor_id: string; target_id: string }>();

describe("the protected live accounts", () => {
  it("names both accounts, in any case and any organisation, and the demo organisation", () => {
    expect(PROTECTED_ACCOUNTS).toEqual(["demo@rizonetech.com", "derick@rizonetech.com"]);
    expect(isProtectedAccount("Demo@RizoneTech.com ")).toBe(true);
    expect(isProtectedAccount("derick@rizonetech.com")).toBe(true);
    expect(isProtectedAccount("someone@rizonetech.com")).toBe(false);
    expect(isProtectedAccount(null)).toBe(false);
    expect(PROTECTED_ORGANISATIONS).toEqual(["ZF5SufztotybeXIWVncExFAVu9GYZ8Fu"]);
    expect(isProtectedOrganisation("ZF5SufztotybeXIWVncExFAVu9GYZ8Fu")).toBe(true);
    expect(isProtectedOrganisation("org-other")).toBe(false);
  });

  for (const email of ["demo@rizonetech.com", "derick@rizonetech.com"])
    it(`refuses removing ${email} by member id and by email, named or active organisation, and its leaving, changing nothing`, async () => {
      // Each account in a second, ordinary organisation too: protection is not Fynbos Freight's alone.
      const existing = await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
      const target = existing?.id ?? (await user(email));
      const { orgId, ownerId, owner } = await organisation();
      const memberId = await join(orgId, target);
      const own = await sessionFor(target, orgId);
      const before = await snapshot(orgId, target);
      const attempts = [
        post("/organization/remove-member", owner, { memberIdOrEmail: memberId, organizationId: orgId }),
        post("/organization/remove-member", owner, { memberIdOrEmail: email.toUpperCase() }),
        post("/organization/leave", own, { organizationId: orgId }),
      ];
      for (const answer of await Promise.all(attempts)) {
        expect(answer.status).toBe(403);
        expect(((await answer.json()) as { code?: string }).code).toBe(PROTECTED_ACCOUNT);
      }
      expect(await snapshot(orgId, target)).toEqual(before);
      const audited = (await refusals(orgId, target)).results;
      expect(audited.map((r) => [r.kind, r.actor_id])).toEqual(
        expect.arrayContaining([
          ["remove-member", ownerId],
          ["leave-organization", target],
        ]),
      );
      expect(audited).toHaveLength(3);
    });

  it("still removes and lets leave an ordinary member the test made", async () => {
    const { orgId, owner } = await organisation();
    const removed = await user(`plain-${tag()}@demo.isitlegit.co.za`);
    const removedMember = await join(orgId, removed);
    expect(
      (await post("/organization/remove-member", owner, { memberIdOrEmail: removedMember, organizationId: orgId }))
        .status,
    ).toBe(200);
    const leaver = await user(`leaver-${tag()}@demo.isitlegit.co.za`);
    await join(orgId, leaver);
    expect((await post("/organization/leave", await sessionFor(leaver, orgId), { organizationId: orgId })).status).toBe(
      200,
    );
    const left = await db
      .prepare(`SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ? AND "userId" IN (?, ?)`)
      .bind(orgId, removed, leaver)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("keeps the demo organisation: organisation deletion stays disabled", async () => {
    const { orgId, owner } = await organisation("ZF5SufztotybeXIWVncExFAVu9GYZ8Fu");
    const answer = await post("/organization/delete", owner, { organizationId: orgId });
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await db.prepare(`SELECT id FROM "organization" WHERE id = ?`).bind(orgId).first()).not.toBeNull();
  });
});
