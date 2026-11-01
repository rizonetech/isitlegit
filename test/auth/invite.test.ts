import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { addInviteCode } from "../fixtures/auth/members";
import { authEnv, call, redeem, requestLink, sessionCookie, stubSmtp2go, target } from "./helpers";

// D07 T02 §4: invite-code signup through the Worker's own fetch, resumable from its redemption, and the gate on every
// other way of making an account.
const db = (env as unknown as Env).DB;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const signUp = (body: Record<string, unknown>, workerEnv?: Env) =>
  call(
    "/api/auth/sign-up/invite-code",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    workerEnv,
  );
const usesOf = async (codeId: string) =>
  (await db.prepare("SELECT uses FROM invite_codes WHERE id = ?").bind(codeId).first<{ uses: number }>())?.uses;
const count = async (sql: string, ...values: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n ?? 0;
const accountOf = async (email: string) => ({
  users: await count(`SELECT COUNT(*) AS n FROM "user" WHERE email = ?`, email),
  organisations: await count(
    `SELECT COUNT(*) AS n FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ? AND m.role = 'owner'`,
    email,
  ),
  redemptions: await count("SELECT COUNT(*) AS n FROM invite_redemptions WHERE email = ?", email),
});
const activeOf = async (cookie: string) =>
  (
    (await (await call("/api/auth/get-session", { headers: { cookie } })).json()) as {
      session?: { activeOrganizationId?: string | null };
    } | null
  )?.session?.activeOrganizationId ?? null;

describe("invite-code signup", () => {
  it("makes the account, organisation and owner membership, sends the first link, and signs in to the new organisation", async () => {
    const codeId = await addInviteCode(db, "WELCOME-1", { maxUses: 3 });
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const answer = await signUp({
      email: "Founder@Example.org",
      code: "WELCOME-1",
      organizationName: "Acme",
      consent: true,
    });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ registered: true, linkSent: true });
    expect(await accountOf("founder@example.org")).toEqual({ users: 1, organisations: 1, redemptions: 1 });
    expect(await usesOf(codeId)).toBe(1);
    const redemption = await db
      .prepare("SELECT status, org_id, consented_at FROM invite_redemptions WHERE email = 'founder@example.org'")
      .first<{ status: string; org_id: string; consented_at: string }>();
    expect(redemption?.status).toBe("complete");
    // The first link went (the membership admits the address), and redeeming it signs in to the new organisation.
    expect(smtp.sends.map((s) => s.to)).toEqual(["Founder@Example.org".toLowerCase()]);
    const redeemed = await redeem(smtp.sends[0]?.link ?? "");
    // A newly made organisation lands on its setup list (D07 T08 §17); an ordinary sign-in link still lands on /cases
    // (test/auth/flow.test.ts), a member's return path included.
    expect(target(redeemed)).toBe("/welcome");
    expect(await activeOf(sessionCookie(redeemed))).toBe(redemption?.org_id);
  });

  it("refuses an unknown, expired, used-up or missing code and a missing consent, making nothing", async () => {
    const usedUp = await addInviteCode(db, "SPENT", { maxUses: 1, uses: 1 });
    await addInviteCode(db, "OLD", { expiresAt: new Date(Date.now() - 60_000) });
    await addInviteCode(db, "GOOD");
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    for (const [label, body] of [
      ["unknown", { code: "NOPE" }],
      ["expired", { code: "OLD" }],
      ["used up", { code: "SPENT" }],
      ["missing", {}],
      ["no consent", { code: "GOOD", consent: false }],
    ] as const) {
      const answer = await signUp({
        email: `refused-${label.replace(" ", "")}@example.org`,
        organizationName: "Nope",
        consent: true,
        ...body,
      });
      expect(answer.status, label).toBe(400);
      expect(await accountOf(`refused-${label.replace(" ", "")}@example.org`), label).toEqual({
        users: 0,
        organisations: 0,
        redemptions: 0,
      });
    }
    // The same answer for every unusable code, so a guess learns nothing.
    const texts = await Promise.all(
      ["NOPE", "OLD", "SPENT"].map(async (code) =>
        (await signUp({ email: `same-${code}@example.org`, code, organizationName: "x", consent: true })).text(),
      ),
    );
    expect(new Set(texts).size).toBe(1);
    expect(await usesOf(usedUp)).toBe(1);
    expect(smtp.sends).toEqual([]);
  });

  it("refuses an organisation name that is not one line, at signup and on rename", async () => {
    await addInviteCode(db, "NAMES", { maxUses: 2 });
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    for (const name of ["Acme\n\nUse attacker.example instead", "Ac\rme", "Tab\there", "a".repeat(121), "   "]) {
      const answer = await signUp({ email: "names@example.org", code: "NAMES", organizationName: name, consent: true });
      expect(answer.status, JSON.stringify(name)).toBe(400);
    }
    expect(await accountOf("names@example.org")).toEqual({ users: 0, organisations: 0, redemptions: 0 });
    // A good name signs up; the owner then cannot rename it to two lines through Better Auth's own endpoint.
    expect(
      (await signUp({ email: "names@example.org", code: "NAMES", organizationName: "Acme (Pty) Ltd", consent: true }))
        .status,
    ).toBe(201);
    const link = smtp.sends.at(-1)?.link ?? "";
    const cookie = sessionCookie(await redeem(link));
    const renamed = await call("/api/auth/organization/update", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ data: { name: "Acme\nInc" } }),
    });
    expect(renamed.status).toBe(400);
    const names = await db
      .prepare(
        `SELECT o.name FROM "organization" o JOIN invite_redemptions r ON r.org_id = o.id WHERE r.email = 'names@example.org'`,
      )
      .first<{ name: string }>();
    expect(names?.name).toBe("Acme (Pty) Ltd");
  });

  it("tells an address that already belongs to an organisation to sign in instead", async () => {
    await addInviteCode(db, "TWICE", { maxUses: 2 });
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    expect(
      (await signUp({ email: "twice@example.org", code: "TWICE", organizationName: "One", consent: true })).status,
    ).toBe(201);
    const again = await signUp({ email: "twice@example.org", code: "TWICE", organizationName: "Two", consent: true });
    expect(again.status).toBe(409);
    expect(await accountOf("twice@example.org")).toEqual({ users: 1, organisations: 1, redemptions: 1 });
  });

  it("gives a code's last use to one of two signups racing for it", async () => {
    const codeId = await addInviteCode(db, "LAST", { maxUses: 1 });
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const answers = await Promise.all(
      ["racer-a@example.org", "racer-b@example.org"].map((email) =>
        signUp({ email, code: "LAST", organizationName: "Race", consent: true }),
      ),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([201, 400]);
    expect(await usesOf(codeId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM invite_redemptions WHERE code_id = ?", codeId)).toBe(1);
  });

  it("makes one organisation for one address, however its signups overlap", async () => {
    const codeId = await addInviteCode(db, "OVERLAP", { maxUses: 4 });
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    // Two at once for the same address.
    const both = await Promise.all(
      [0, 1].map(() =>
        signUp({ email: "overlap@example.org", code: "OVERLAP", organizationName: "Once", consent: true }),
      ),
    );
    expect(both.every((a) => [201, 409].includes(a.status))).toBe(true);
    expect(await accountOf("overlap@example.org")).toEqual({ users: 1, organisations: 1, redemptions: 1 });
    expect(await usesOf(codeId)).toBe(1);
    // One that read "not a member" before the other completed: its redemption fails and rolls back, the use with it.
    const now = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO invite_redemptions (id, code_id, email, status, consented_at, created_at) VALUES ('done-1', ?, 'late@example.org', 'complete', ?, ?)",
      )
      .bind(codeId, now, now)
      .run();
    const late = await signUp({ email: "late@example.org", code: "OVERLAP", organizationName: "Twice", consent: true });
    expect(late.status).toBe(409);
    expect(await usesOf(codeId)).toBe(1);
    expect(await accountOf("late@example.org")).toEqual({ users: 0, organisations: 0, redemptions: 1 });
  });

  it("resumes when an overlapping signup for the address spent a single-use code first", async () => {
    // The other request redeemed the code's only use and stopped before provisioning. This request read "no pending
    // redemption" just before that happened (the race), so its batch finds the code spent and changes nothing: it must
    // resume the other's redemption, not call the code invalid. The read is made to miss, as in the race.
    const codeId = await addInviteCode(db, "SINGLE", { maxUses: 1 });
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE invite_codes SET uses = 1 WHERE id = ?").bind(codeId),
      db
        .prepare(
          "INSERT INTO invite_redemptions (id, code_id, email, status, consented_at, created_at) VALUES ('first-1', ?, 'single@example.org', 'pending', ?, ?)",
        )
        .bind(codeId, now, now),
    ]);
    const racedRead = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            sql.includes("FROM invite_redemptions WHERE email = ? AND status = 'pending'")
              ? { bind: () => ({ first: async () => null }) }
              : target.prepare(sql);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const answer = await signUp(
      { email: "single@example.org", code: "SINGLE", organizationName: "Single", consent: true },
      { ...authEnv, DB: racedRead },
    );
    expect(answer.status).toBe(201);
    expect(await accountOf("single@example.org")).toEqual({ users: 1, organisations: 1, redemptions: 1 });
    expect(await usesOf(codeId)).toBe(1);
  });

  it("tells a stopped signup to sign in instead when the address has since joined another organisation", async () => {
    const codeId = await addInviteCode(db, "JOINED");
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("UPDATE invite_codes SET uses = 1 WHERE id = ?").bind(codeId),
      db
        .prepare(
          "INSERT INTO invite_redemptions (id, code_id, email, status, consented_at, created_at) VALUES ('joined-1', ?, 'joined@example.org', 'pending', ?, ?)",
        )
        .bind(codeId, now, now),
      // Meanwhile the address accepted an invitation to another organisation.
      db
        .prepare(
          `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('joined-user', 'j', 'joined@example.org', 1, ?, ?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ('elsewhere', 'Elsewhere', 'elsewhere', ?)`,
        )
        .bind(now),
      db
        .prepare(
          `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ('joined-member', 'elsewhere', 'joined-user', 'member', ?)`,
        )
        .bind(now),
    ]);
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const retried = await signUp({ email: "joined@example.org", organizationName: "Second", consent: true });
    expect(retried.status).toBe(409);
    expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE slug = 'org-joined-1'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM "member" WHERE "userId" = 'joined-user'`)).toBe(1);
  });

  it("answers 503, not an invalid code, when the database fails the redemption, and the code still works after", async () => {
    const codeId = await addInviteCode(db, "TRANSIENT");
    const failingBatch = new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("D1_ERROR: Network connection lost.");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const body = { email: "transient@example.org", code: "TRANSIENT", organizationName: "Flaky", consent: true };
    const failed = await signUp(body, { ...authEnv, DB: failingBatch });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toMatch(/try again/);
    expect(await usesOf(codeId)).toBe(0);
    expect((await signUp(body)).status).toBe(201);
    expect(await usesOf(codeId)).toBe(1);
  });

  it("completes a signup stopped after any of its writes, with one of everything and the code used once", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    for (const stop of ["redemption", "user", "organisation", "membership"] as const) {
      const email = `stopped-${stop}@example.org`;
      const codeId = await addInviteCode(db, `STOP-${stop}`);
      // The first write: the code's use and the pending redemption, together.
      const redemptionId = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.batch([
        db.prepare("UPDATE invite_codes SET uses = uses + 1 WHERE id = ?").bind(codeId),
        db
          .prepare(
            "INSERT INTO invite_redemptions (id, code_id, email, status, consented_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
          )
          .bind(redemptionId, codeId, email, now, now),
      ]);
      if (stop !== "redemption")
        await db
          .prepare(
            `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 0, ?, ?)`,
          )
          .bind(`user-${stop}`, email, email, now, now)
          .run();
      if (stop === "organisation" || stop === "membership")
        await db
          .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Stopped', ?, ?)`)
          .bind(`org-${stop}`, `org-${redemptionId}`, now)
          .run();
      if (stop === "membership")
        await db
          .prepare(
            `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)`,
          )
          .bind(`member-${stop}`, `org-${stop}`, `user-${stop}`, now)
          .run();
      const linksBefore = smtp.sends.length;
      // The retry, with no code: it resumes the pending redemption.
      const retried = await signUp({ email, organizationName: "Stopped", consent: true });
      expect(retried.status, stop).toBe(201);
      expect(await accountOf(email), stop).toEqual({ users: 1, organisations: 1, redemptions: 1 });
      expect(await count(`SELECT COUNT(*) AS n FROM "organization" WHERE slug = ?`, `org-${redemptionId}`), stop).toBe(
        1,
      );
      expect(await usesOf(codeId), stop).toBe(1);
      const status = await db
        .prepare("SELECT status FROM invite_redemptions WHERE id = ?")
        .bind(redemptionId)
        .first<{ status: string }>();
      expect(status?.status, stop).toBe("complete");
      // The first link is sent on the retry too.
      expect(smtp.sends.length, stop).toBe(linksBefore + 1);
    }
  });

  it("judges linkSent by its own send, not another mail to the address landing at the same time", async () => {
    const email = "crowded@example.org";
    await addInviteCode(db, "CROWDED");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    // Four links already, and an invitation sent while the signup runs (timed just after it starts): the limit is
    // reached, so the signup's own link is held back, and the invitation must not be taken for it.
    const now = Date.now();
    const rows: [string, string][] = [0, 1, 2, 3].map((i) => [`crowd-${i}`, new Date(now - 60_000).toISOString()]);
    rows.push(["crowd-invite", new Date(now + 2_000).toISOString()]);
    for (const [key, at] of rows)
      await db
        .prepare(
          "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, attempts, created_at, updated_at) VALUES (?, ?, 'signin', ?, 'sent', 1, ?, ?)",
        )
        .bind(key, key, hash, at, at)
        .run();
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const answer = await signUp({ email, code: "CROWDED", organizationName: "Crowd", consent: true });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ linkSent: false });
    expect(smtp.sends).toEqual([]);
  });

  it("answers linkSent false when the sign-in limit holds the first link back", async () => {
    // An invitee who already had their five sign-in links in ten minutes, then signs up with a code.
    const email = "limited@example.org";
    await addInviteCode(db, "LIMITED");
    const now = new Date().toISOString();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    for (let i = 0; i < 5; i++)
      await db
        .prepare(
          "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, attempts, created_at, updated_at) VALUES (?, ?, 'signin', ?, 'sent', 1, ?, ?)",
        )
        .bind(`limit-${i}`, `signin:limit-${i}`, hash, now, now)
        .run();
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const answer = await signUp({ email, code: "LIMITED", organizationName: "Busy", consent: true });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toMatchObject({ registered: true, linkSent: false });
    expect(smtp.sends).toEqual([]);
  });

  it("answers linkSent false when the first link does not go, and a link asked for later signs in, the account unchanged", async () => {
    for (const answer of ["refused", "silent"] as const) {
      const email = `nolink-${answer}@example.org`;
      const codeId = await addInviteCode(db, `NOLINK-${answer}`);
      const failing = stubSmtp2go(() => answer);
      let body: { linkSent?: boolean; message?: string };
      try {
        const signedUp = await signUp({ email, code: `NOLINK-${answer}`, organizationName: "Quiet", consent: true });
        expect(signedUp.status, answer).toBe(201);
        body = (await signedUp.json()) as typeof body;
      } finally {
        failing.restore();
      }
      expect(body.linkSent, answer).toBe(false);
      expect(body.message, answer).toMatch(/could not be confirmed/);
      const working = stubSmtp2go();
      restore = working.restore;
      expect((await requestLink(email)).status, answer).toBe(200);
      const redeemed = await redeem(working.sends.at(-1)?.link ?? "");
      expect(sessionCookie(redeemed), answer).toMatch(/session_token=/);
      expect(await accountOf(email), answer).toEqual({ users: 1, organisations: 1, redemptions: 1 });
      expect(await usesOf(codeId), answer).toBe(1);
      working.restore();
      restore = null;
    }
  });
});

describe("making an account any other way", () => {
  it("gives a stranger with a link minted for them no account", async () => {
    // The only way to mail a stranger a link is to make them the operator for the request; redeemed under the real
    // configuration, the link makes no user.
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const minted = { ...authEnv, OPERATOR_EMAIL: "stranger@example.org" };
    expect((await requestLink("stranger@example.org", undefined, minted)).status).toBe(200);
    const link = smtp.sends.at(-1)?.link ?? "";
    expect(link).not.toBe("");
    const redeemed = await redeem(link);
    expect(sessionCookie(redeemed)).toBe("");
    // No account and no session: the page says the address has no account and to ask for an invitation (a new link
    // would be refused the same way). The mail went to this address, so it tells its reader nothing new.
    expect(redeemed.status).toBe(403);
    expect(await redeemed.text()).toContain("This address has no IsItLegit account");
    expect(await count(`SELECT COUNT(*) AS n FROM "user" WHERE email = 'stranger@example.org'`)).toBe(0);
  });
});
