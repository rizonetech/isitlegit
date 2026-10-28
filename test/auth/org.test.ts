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
// An organisation made as §4's signup will make it: through the server API, for a user, with no session.
async function orgFor(email: string, name: string) {
  await signIn(email);
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
    const loner = await signIn("loner@example.com");
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
    const stranger = await signIn("stranger@example.com");
    const wrong = await post("/organization/accept-invitation", stranger.cookie, {
      invitationId: invitationId(sent.link),
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const late = await invite(cookie, "late@example.com");
    await db
      .prepare(`UPDATE "invitation" SET "expiresAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 60 * 60_000).toISOString(), invitationId(late.link))
      .run();
    const latecomer = await signIn("late@example.com");
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
        expect(await failed.text()).toMatch(/could not be sent/);
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
  });

  it("revoke an invitation so it cannot be accepted", async () => {
    await orgFor("revoker@example.com", "Revoke");
    const { cookie } = await signIn("revoker@example.com");
    const { link } = await invite(cookie, "uninvited@example.com");
    expect((await post("/organization/cancel-invitation", cookie, { invitationId: invitationId(link) })).status).toBe(
      200,
    );
    const uninvited = await signIn("uninvited@example.com");
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
    const loner = await signIn("orgless@example.com");
    expect((await caseRequest(loner.cookie, own)).status).toBe(403);
    await db
      .prepare(`DELETE FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
      .bind(mine, await userId("scoped@example.com"))
      .run();
    expect(await activeOf(cookie)).toBe(mine);
    expect((await caseRequest(cookie, own)).status).toBe(403);
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
