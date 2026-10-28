import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { requireSession } from "../../src/auth/gate";
import { type OrgEnv, requireOrg } from "../../src/auth/org";
import worker from "../../src/index";
import { authEnv, call, ORIGIN, signIn, stubSmtp2go } from "./helpers";

// D07 T02 §3: organisations, their roles, invitations, removal, requireOrg and the switcher's route.
const db = (env as unknown as Env).DB;
const api = () => createAuth(authEnv).api;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id as string;
// An organisation made as §4's signup will make it: the user made through Better Auth, then the organisation through
// the server API for that user, with no session; the user is then a member, whom the allowlist admits (D01 T02 §2).
async function orgFor(email: string, name: string) {
  if (!(await userId(email))) {
    const { internalAdapter } = await createAuth(authEnv).$context;
    await internalAdapter.createUser({ email, name: email, emailVerified: false }, { method: "admin" });
  }
  const made = await api().createOrganization({
    body: { name, slug: `${name.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`, userId: await userId(email) },
  });
  return (made as { id: string }).id;
}
const activeOf = async (cookie: string) =>
  (
    (await (await call("/api/auth/get-session", { headers: { cookie } })).json()) as {
      session?: { activeOrganizationId?: string | null };
    } | null
  )?.session?.activeOrganizationId ?? null;
const post = (path: string, cookie: string, body: unknown) =>
  call(`/api/auth${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const membersOf = async (orgId: string) =>
  (
    await db
      .prepare(
        `SELECT u.email, m.role FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ? ORDER BY u.email`,
      )
      .bind(orgId)
      .all<{ email: string; role: string }>()
  ).results;
async function addCase(orgId: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .prepare("INSERT INTO cases (id, org_id, channel, created_at, updated_at) VALUES (?, ?, 'upload', ?, ?)")
    .bind(id, orgId, now, now)
    .run();
  return id;
}
// Invite `email` from `cookie`'s active organisation, SMTP2GO answering as told; the invitation id and the link sent.
async function invite(cookie: string, email: string, role = "member", extra: object = {}) {
  const smtp = stubSmtp2go();
  try {
    const answer = await post("/organization/invite-member", cookie, { email, role, ...extra });
    return { answer, link: smtp.sends.at(-1)?.link ?? "" };
  } finally {
    smtp.restore();
  }
}
const invitationId = (link: string) => new URL(link).pathname.split("/").at(-1) as string;

// A member page behind both gates: a case of the active organisation, read only through it.
const app = new Hono<OrgEnv>();
app.use("/cases/*", requireSession, requireOrg);
app.get("/cases/:id", async (c) => {
  const row = await c.env.DB.prepare("SELECT id FROM cases WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), c.get("org").id)
    .first();
  return row ? c.json({ org: c.get("org") }) : c.json({ error: "not found" }, 404);
});
const caseRequest = (cookie: string, caseId: string, query = "") =>
  app.fetch(
    new Request(`${ORIGIN}/cases/${caseId}${query}`, { headers: { cookie, accept: "application/json" } }),
    authEnv,
  );

describe("organisations", () => {
  it("are made by the server path for a user, who owns it; a member cannot make or delete one", async () => {
    const orgId = await orgFor("founder@example.com", "Acme");
    expect(await membersOf(orgId)).toEqual([{ email: "founder@example.com", role: "owner" }]);
    const caseId = await addCase(orgId);
    const { cookie } = await signIn("founder@example.com");
    const made = await post("/organization/create", cookie, { name: "Side", slug: `side-${Date.now()}` });
    expect(made.status).toBe(403);
    const deleted = await post("/organization/delete", cookie, { organizationId: orgId });
    expect(deleted.status).toBeGreaterThanOrEqual(400);
    expect(await db.prepare(`SELECT id FROM "organization" WHERE id = ?`).bind(orgId).first()).not.toBeNull();
    expect(await membersOf(orgId)).toHaveLength(1);
    expect(await db.prepare("SELECT id FROM cases WHERE id = ?").bind(caseId).first()).not.toBeNull();
  });

  it("start a new session in the member's earliest organisation, or none", async () => {
    const first = await orgFor("twohats@example.com", "First");
    await orgFor("twohats@example.com", "Second");
    const { cookie } = await signIn("twohats@example.com");
    expect(await activeOf(cookie)).toBe(first);
    const loner = await signIn("loner@demo.isitlegit.co.za");
    expect(await activeOf(loner.cookie)).toBeNull();
  });
});

describe("invitations", () => {
  it("bring a new address in as a member by magic link, making no organisation", async () => {
    const orgId = await orgFor("boss@example.com", "Hiring");
    const { cookie } = await signIn("boss@example.com");
    const { answer, link } = await invite(cookie, "newbie@example.com");
    expect(answer.status).toBe(200);
    expect(new URL(link).pathname).toBe(`/invite/${invitationId(link)}`);
    const organisations = await db.prepare(`SELECT COUNT(*) AS n FROM "organization"`).first<{ n: number }>();
    // No account yet: the invitee signs in with the invited address, then accepts.
    expect(await userId("newbie@example.com")).toBeUndefined();
    const newbie = await signIn("newbie@example.com");
    const accepted = await post("/organization/accept-invitation", newbie.cookie, { invitationId: invitationId(link) });
    expect(accepted.status).toBe(200);
    expect(await membersOf(orgId)).toContainEqual({ email: "newbie@example.com", role: "member" });
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM "organization"`).first<{ n: number }>())?.n).toBe(
      organisations?.n,
    );
  });

  it("refuse someone signed in with another address, and an invitation past its 48 hours", async () => {
    const orgId = await orgFor("gate@example.com", "Strict");
    const { cookie } = await signIn("gate@example.com");
    const sent = await invite(cookie, "meant@example.com");
    const stranger = await signIn("stranger@demo.isitlegit.co.za");
    const wrong = await post("/organization/accept-invitation", stranger.cookie, {
      invitationId: invitationId(sent.link),
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const late = await invite(cookie, "late@demo.isitlegit.co.za");
    await db
      .prepare(`UPDATE "invitation" SET "expiresAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 60 * 60_000).toISOString(), invitationId(late.link))
      .run();
    const latecomer = await signIn("late@demo.isitlegit.co.za");
    const expired = await post("/organization/accept-invitation", latecomer.cookie, {
      invitationId: invitationId(late.link),
    });
    expect(expired.status).toBeGreaterThanOrEqual(400);
    expect((await membersOf(orgId)).map((m) => m.email)).toEqual(["gate@example.com"]);
  });

  it("answer 502 when the email did not go, keep the invitation, and send it again with resend", async () => {
    await orgFor("sender@example.com", "Mailer");
    const { cookie } = await signIn("sender@example.com");
    for (const answer of ["refused", "silent"] as const) {
      const smtp = stubSmtp2go(() => answer);
      try {
        const email = `${answer}-invitee@example.com`;
        const failed = await post("/organization/invite-member", cookie, { email, role: "member" });
        expect(failed.status, answer).toBe(502);
        // A refusal is a failed send; no answer is an unknown one, which may have gone.
        expect(await failed.text(), answer).toMatch(answer === "refused" ? /could not be sent/ : /not known/);
        const recorded = await db
          .prepare("SELECT status FROM mail_sends WHERE send_key LIKE 'invite:%' ORDER BY created_at DESC")
          .first<{ status: string }>();
        expect(recorded?.status, answer).toBe(answer === "refused" ? "failed" : "uncertain");
        const pending = await db
          .prepare(`SELECT id, status FROM "invitation" WHERE email = ?`)
          .bind(email)
          .first<{ id: string; status: string }>();
        expect(pending?.status, answer).toBe("pending");
        smtp.restore();
        const again = stubSmtp2go();
        restore = again.restore;
        const resent = await post("/organization/invite-member", cookie, { email, role: "member", resend: true });
        expect(resent.status, answer).toBe(200);
        expect(((await resent.json()) as { id: string }).id).toBe(pending?.id);
        const keys = await db
          .prepare(`SELECT send_key, status FROM mail_sends WHERE send_key LIKE ? ORDER BY created_at`)
          .bind(`invite:${pending?.id}:%`)
          .all<{ send_key: string; status: string }>();
        expect(keys.results).toHaveLength(2);
        expect(keys.results[1]?.status).toBe("sent");
        expect(keys.results[0]?.send_key).not.toBe(keys.results[1]?.send_key);
        again.restore();
        restore = null;
      } finally {
        smtp.restore();
      }
    }
  });
});

describe("roles, revocation and removal", () => {
  async function teamOf(owner: string, ...members: string[]) {
    const orgId = await orgFor(owner, "Team");
    const ownerCookie = (await signIn(owner)).cookie;
    for (const email of members) {
      const { link } = await invite(ownerCookie, email);
      const joiner = await signIn(email);
      await post("/organization/accept-invitation", joiner.cookie, { invitationId: invitationId(link) });
    }
    return { orgId, ownerCookie };
  }

  it("let owners and admins invite and remove, and refuse a member", async () => {
    const { orgId, ownerCookie } = await teamOf("lead@example.com", "plain@example.com", "deputy@example.com");
    const deputyMember = (await membersOf(orgId)).find((m) => m.email === "deputy@example.com");
    expect(deputyMember).toBeDefined();
    const deputyId = await userId("deputy@example.com");
    const memberRow = await db
      .prepare(`SELECT id FROM "member" WHERE "userId" = ? AND "organizationId" = ?`)
      .bind(deputyId, orgId)
      .first<{ id: string }>();
    expect(
      (await post("/organization/update-member-role", ownerCookie, { memberId: memberRow?.id, role: "admin" })).status,
    ).toBe(200);
    const plain = (await signIn("plain@example.com")).cookie;
    expect((await invite(plain, "nope@example.com")).answer.status).toBe(403);
    // Better Auth refuses a member's removal with 401, its own status for this refusal; the membership stays.
    const refused = await post("/organization/remove-member", plain, { memberIdOrEmail: "deputy@example.com" });
    expect([401, 403]).toContain(refused.status);
    expect((await membersOf(orgId)).map((m) => m.email)).toContain("deputy@example.com");
    const deputy = (await signIn("deputy@example.com")).cookie;
    expect((await invite(deputy, "welcome@example.com")).answer.status).toBe(200);
    // An admin removes a member.
    expect((await post("/organization/remove-member", deputy, { memberIdOrEmail: "plain@example.com" })).status).toBe(
      200,
    );
    expect((await membersOf(orgId)).map((m) => m.email)).not.toContain("plain@example.com");
  });

  it("spend an invitation once: after an interrupted acceptance, an owner's new invitation brings them in", async () => {
    const orgId = await orgFor("host@example.com", "Resume");
    const { cookie } = await signIn("host@example.com");
    const { link } = await invite(cookie, "halfway@example.com");
    // A stranger's attempt spends nothing.
    const stranger = await signIn("passerby@demo.isitlegit.co.za");
    expect(
      (await post("/organization/accept-invitation", stranger.cookie, { invitationId: invitationId(link) })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      await db.prepare("SELECT 1 FROM invitation_uses WHERE invitation_id = ?").bind(invitationId(link)).first(),
    ).toBeNull();
    // The Worker stopped after recording the use and marking it accepted, before the membership.
    const halfway = await signIn("halfway@example.com");
    await db
      .prepare("INSERT INTO invitation_uses (invitation_id, user_id, used_at) VALUES (?, ?, ?)")
      .bind(invitationId(link), await userId("halfway@example.com"), new Date().toISOString())
      .run();
    await db.prepare(`UPDATE "invitation" SET status = 'accepted' WHERE id = ?`).bind(invitationId(link)).run();
    // Accepted: Better Auth itself refuses it.
    const retried = await post("/organization/accept-invitation", halfway.cookie, { invitationId: invitationId(link) });
    expect(retried.status).toBeGreaterThanOrEqual(400);
    // An owner invites again; the new invitation joins them, once.
    const fresh = await invite(cookie, "halfway@example.com");
    expect(fresh.answer.status).toBe(200);
    expect(
      (await post("/organization/accept-invitation", halfway.cookie, { invitationId: invitationId(fresh.link) }))
        .status,
    ).toBe(200);
    expect((await membersOf(orgId)).filter((m) => m.email === "halfway@example.com")).toEqual([
      { email: "halfway@example.com", role: "member" },
    ]);
  });

  it("do not let a removed member come back through their old invitation", async () => {
    const orgId = await orgFor("strict-host@example.com", "NoReturn");
    const { cookie } = await signIn("strict-host@example.com");
    const { link } = await invite(cookie, "former@demo.isitlegit.co.za", "admin");
    const former = await signIn("former@demo.isitlegit.co.za");
    expect(
      (await post("/organization/accept-invitation", former.cookie, { invitationId: invitationId(link) })).status,
    ).toBe(200);
    expect(
      (await post("/organization/remove-member", cookie, { memberIdOrEmail: "former@demo.isitlegit.co.za" })).status,
    ).toBe(200);
    const back = await signIn("former@demo.isitlegit.co.za");
    const replay = await post("/organization/accept-invitation", back.cookie, { invitationId: invitationId(link) });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect((await membersOf(orgId)).map((m) => m.email)).not.toContain("former@demo.isitlegit.co.za");
  });

  it("let only one of two simultaneous acceptances through", async () => {
    const orgId = await orgFor("twinhost@example.com", "Twins");
    const { cookie } = await signIn("twinhost@example.com");
    const { link } = await invite(cookie, "twice@example.com");
    const twice = await signIn("twice@example.com");
    const accept = () => post("/organization/accept-invitation", twice.cookie, { invitationId: invitationId(link) });
    const statuses = (await Promise.all([accept(), accept()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect((await membersOf(orgId)).filter((m) => m.email === "twice@example.com")).toHaveLength(1);
  });

  it("let an owner invite again after an acceptance stopped before Better Auth wrote its status", async () => {
    // The use is recorded and the invitation still pending: a retry is refused, and inviting again, plainly or as a
    // resend, makes a fresh invitation instead of being refused as already invited or resending the spent one.
    for (const resend of [false, true]) {
      const orgId = await orgFor(`stophost${resend}@example.com`, "Stopped");
      const { cookie } = await signIn(`stophost${resend}@example.com`);
      const invitee = `stopped${resend}@example.com`;
      const { link } = await invite(cookie, invitee);
      const stopped = await signIn(invitee);
      await db
        .prepare("INSERT INTO invitation_uses (invitation_id, user_id, used_at) VALUES (?, ?, ?)")
        .bind(invitationId(link), await userId(invitee), new Date().toISOString())
        .run();
      expect(
        (await post("/organization/accept-invitation", stopped.cookie, { invitationId: invitationId(link) })).status,
      ).toBe(409);
      const fresh = await invite(cookie, invitee, "member", resend ? { resend: true } : {});
      expect(fresh.answer.status, `resend ${resend}`).toBe(200);
      expect(invitationId(fresh.link), `resend ${resend}`).not.toBe(invitationId(link));
      const old = await db
        .prepare(`SELECT status FROM "invitation" WHERE id = ?`)
        .bind(invitationId(link))
        .first<{ status: string }>();
      expect(old?.status).toBe("canceled");
      expect(
        (await post("/organization/accept-invitation", stopped.cookie, { invitationId: invitationId(fresh.link) }))
          .status,
      ).toBe(200);
      expect((await membersOf(orgId)).filter((m) => m.email === invitee)).toHaveLength(1);
    }
  });

  it("cancel a spent invitation only for an owner or admin of its organisation", async () => {
    const orgId = await orgFor("guarded@example.com", "Guarded");
    const { cookie } = await signIn("guarded@example.com");
    const { link } = await invite(cookie, "spentone@example.com");
    await db
      .prepare("INSERT INTO invitation_uses (invitation_id, user_id, used_at) VALUES (?, 'someone', ?)")
      .bind(invitationId(link), new Date().toISOString())
      .run();
    const statusOf = async () =>
      (
        await db
          .prepare(`SELECT status FROM "invitation" WHERE id = ?`)
          .bind(invitationId(link))
          .first<{ status: string }>()
      )?.status;
    // Anonymous, a signed-in outsider, and a plain member: each refused by Better Auth, and the invitation untouched.
    const outsider = await signIn("outsider-x@demo.isitlegit.co.za");
    const { link: memberLink } = await invite(cookie, "plainmember@example.com");
    const plain = await signIn("plainmember@example.com");
    await post("/organization/accept-invitation", plain.cookie, { invitationId: invitationId(memberLink) });
    for (const who of ["", outsider.cookie, (await signIn("plainmember@example.com")).cookie]) {
      const attempt = await post("/organization/invite-member", who, {
        email: "spentone@example.com",
        role: "member",
        organizationId: orgId,
      });
      expect(attempt.status).toBeGreaterThanOrEqual(400);
      expect(await statusOf()).toBe("pending");
    }
  });

  it("refuse a second use even when Better Auth has set the invitation back to pending", async () => {
    // Two acceptances overlapping: the one whose membership write fails has Better Auth reset the invitation to
    // pending (crud-invites.mjs). Removing the member who did join must not leave that invitation usable.
    const orgId = await orgFor("racehost@example.com", "Race");
    const { cookie } = await signIn("racehost@example.com");
    const { link } = await invite(cookie, "racer@demo.isitlegit.co.za", "admin");
    const racer = await signIn("racer@demo.isitlegit.co.za");
    expect(
      (await post("/organization/accept-invitation", racer.cookie, { invitationId: invitationId(link) })).status,
    ).toBe(200);
    await db.prepare(`UPDATE "invitation" SET status = 'pending' WHERE id = ?`).bind(invitationId(link)).run();
    expect(
      (await post("/organization/remove-member", cookie, { memberIdOrEmail: "racer@demo.isitlegit.co.za" })).status,
    ).toBe(200);
    const back = await signIn("racer@demo.isitlegit.co.za");
    const replay = await post("/organization/accept-invitation", back.cookie, { invitationId: invitationId(link) });
    expect(replay.status).toBe(409);
    expect((await membersOf(orgId)).map((m) => m.email)).not.toContain("racer@demo.isitlegit.co.za");
    // And the database holds one membership per person if two writes ever land.
    const racerId = await userId("racer@demo.isitlegit.co.za");
    const insert = () =>
      db
        .prepare(
          `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'member', ?)`,
        )
        .bind(crypto.randomUUID(), orgId, racerId, new Date().toISOString())
        .run();
    await insert();
    await expect(insert()).rejects.toThrow(/UNIQUE/);
  });

  it("revoke an invitation so it cannot be accepted", async () => {
    await orgFor("revoker@example.com", "Revoke");
    const { cookie } = await signIn("revoker@example.com");
    const { link } = await invite(cookie, "uninvited@demo.isitlegit.co.za");
    expect((await post("/organization/cancel-invitation", cookie, { invitationId: invitationId(link) })).status).toBe(
      200,
    );
    const uninvited = await signIn("uninvited@demo.isitlegit.co.za");
    const accepted = await post("/organization/accept-invitation", uninvited.cookie, {
      invitationId: invitationId(link),
    });
    expect(accepted.status).toBeGreaterThanOrEqual(400);
  });

  it("remove a member, ending their sessions in that organisation", async () => {
    const { orgId, ownerCookie } = await teamOf("remover@example.com", "leaver@example.com");
    const leaver = (await signIn("leaver@example.com")).cookie;
    // The leaver's new session is in the organisation they joined.
    expect(await activeOf(leaver)).toBe(orgId);
    const caseId = await addCase(orgId);
    expect((await caseRequest(leaver, caseId)).status).toBe(200);
    expect(
      (await post("/organization/remove-member", ownerCookie, { memberIdOrEmail: "leaver@example.com" })).status,
    ).toBe(200);
    const sessions = await db
      .prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ? AND "activeOrganizationId" = ?`)
      .bind(await userId("leaver@example.com"), orgId)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    expect((await caseRequest(leaver, caseId)).status).toBe(401);
  });
});

describe("requireOrg", () => {
  it("reads only the session's organisation, rechecks the membership, and hides another organisation's cases", async () => {
    const mine = await orgFor("scoped@example.com", "Mine");
    const theirs = await orgFor("other@example.com", "Theirs");
    const { cookie } = await signIn("scoped@example.com");
    const own = await addCase(mine);
    const foreign = await addCase(theirs);
    const ok = await caseRequest(cookie, own);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ org: { id: mine, role: "owner" } });
    expect((await caseRequest(cookie, foreign)).status).toBe(404);
    // Naming the other organisation in the request changes nothing.
    expect((await caseRequest(cookie, foreign, `?organizationId=${theirs}`)).status).toBe(404);
    // A session with no active organisation, and one whose membership went without the removal hook.
    const loner = await signIn("orgless@demo.isitlegit.co.za");
    expect((await caseRequest(loner.cookie, own)).status).toBe(403);
    await db
      .prepare(`DELETE FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
      .bind(mine, await userId("scoped@example.com"))
      .run();
    expect(await activeOf(cookie)).toBe(mine);
    expect((await caseRequest(cookie, own)).status).toBe(403);
  });
});

describe("an unreachable database", () => {
  // D1 failing every read of the member table, as an outage would; everything else answers.
  const failingMembers = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          /from "member"/i.test(sql)
            ? {
                bind: () => ({
                  all: async () => {
                    throw new Error("D1_ERROR: Network connection lost.");
                  },
                }),
              }
            : target.prepare(sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const down = { ...authEnv, DB: failingMembers };

  it("answers 503 to a member, not 'not a member', and still refuses", async () => {
    const orgId = await orgFor("outage@example.com", "Outage");
    const { cookie } = await signIn("outage@example.com");
    const caseId = await addCase(orgId);
    const answer = await app.fetch(
      new Request(`${ORIGIN}/cases/${caseId}`, { headers: { cookie, accept: "application/json" } }),
      down,
    );
    expect(answer.status).toBe(503);
    expect(answer.headers.get("retry-after")).toBe("5");
    expect((await answer.json()) as object).toEqual({
      error: "the organisation could not be checked just now; try again in a moment",
    });
  });

  it("answers 503 when the session itself cannot be read, at the gate and at the switch", async () => {
    const first = await orgFor("nosession@example.com", "Down");
    const second = await orgFor("nosession@example.com", "Up");
    const { cookie } = await signIn("nosession@example.com");
    const failingSessions = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            /from "session"/i.test(sql)
              ? {
                  bind: () => ({
                    all: async () => {
                      throw new Error("D1_ERROR: Network connection lost.");
                    },
                  }),
                }
              : target.prepare(sql);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const storeDown = { ...authEnv, DB: failingSessions };
    const caseId = await addCase(first);
    const gated = await app.fetch(
      new Request(`${ORIGIN}/cases/${caseId}`, { headers: { cookie, accept: "application/json" } }),
      storeDown,
    );
    expect(gated.status).toBe(503);
    const switched = await worker.fetch(
      new Request(`${ORIGIN}/orgs/switch`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: `organizationId=${second}`,
        redirect: "manual",
      }),
      storeDown,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    );
    expect(switched.status).toBe(503);
    expect(await activeOf(cookie)).toBe(first);
  });

  it("answers the switcher 503 too, the active organisation as it was", async () => {
    const first = await orgFor("stuckswitch@example.com", "One");
    const second = await orgFor("stuckswitch@example.com", "Two");
    const { cookie } = await signIn("stuckswitch@example.com");
    const answer = await worker.fetch(
      new Request(`${ORIGIN}/orgs/switch`, {
        method: "POST",
        headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: `organizationId=${second}`,
        redirect: "manual",
      }),
      down,
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    );
    expect(answer.status).toBe(503);
    expect(await activeOf(cookie)).toBe(first);
  });
});

describe("POST /orgs/switch", () => {
  const context = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
  const switchTo = (cookie: string, organizationId: string, origin: string | null = ORIGIN) => {
    const headers = new Headers({ cookie, "content-type": "application/x-www-form-urlencoded" });
    if (origin !== null) headers.set("origin", origin);
    return worker.fetch(
      new Request(`${ORIGIN}/orgs/switch`, {
        method: "POST",
        headers,
        body: `organizationId=${organizationId}`,
        redirect: "manual",
      }),
      authEnv,
      context,
    );
  };

  it("switches between the member's organisations from the app's own pages only", async () => {
    const first = await orgFor("switcher@example.com", "Alpha");
    const second = await orgFor("switcher@example.com", "Beta");
    const foreign = await orgFor("outsider@example.com", "Gamma");
    const { cookie } = await signIn("switcher@example.com");
    expect(await activeOf(cookie)).toBe(first);
    const moved = await switchTo(cookie, second);
    expect([moved.status, moved.headers.get("location")]).toEqual([303, "/cases"]);
    expect(await activeOf(cookie)).toBe(second);
    const caseId = await addCase(second);
    expect((await caseRequest(cookie, caseId)).status).toBe(200);
    // Refused, the active organisation unchanged: a foreign organisation, another origin, no origin.
    expect((await switchTo(cookie, foreign)).status).toBe(403);
    expect((await switchTo(cookie, first, "https://evil.example")).status).toBe(403);
    expect((await switchTo(cookie, first, null)).status).toBe(403);
    expect(await activeOf(cookie)).toBe(second);
    // Better Auth's own endpoint holds the same rule: a foreign organisation refused, the active one kept.
    const direct = await post("/organization/set-active", cookie, { organizationId: foreign });
    expect(direct.status).toBe(403);
    expect(await activeOf(cookie)).toBe(second);
  });
});
