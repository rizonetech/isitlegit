import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, redeem, sessionCookie, stubSmtp2go, target } from "../auth/helpers";
import { addInviteCode } from "../fixtures/auth/members";

// The invitation page (D07 T02 §14): `/invite/<id>` answers for who is here, accepts or declines for the signed-in
// invitee only through the page's own POST, keeps each unusable invitation's state, brings someone signed in as another
// address back to the invitation through Sign out, and says every failure as one. Each refusal is tried against a fresh
// pending invitation, its invitation, uses, memberships and active organisation read back unchanged.
const db = (env as unknown as Env).DB;
let smtp: ReturnType<typeof stubSmtp2go>;
afterEach(() => {
  smtp?.restore();
  vi.restoreAllMocks();
});
const tag = () => crypto.randomUUID().slice(0, 8);
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

// An owner of a new organisation, signed in.
async function owner() {
  smtp = stubSmtp2go();
  const email = `owner-${tag()}@example.org`;
  const code = `OWN-${tag()}`;
  await addInviteCode(db, code);
  const made = await call("/api/auth/sign-up/invite-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code, organizationName: "Karoo Couriers", consent: true }),
  });
  if (made.status !== 201) throw new Error(`signup ${made.status}`);
  const cookie = sessionCookie(await redeem(linkIn(smtp.sends.at(-1)?.text ?? "")));
  const orgId = (
    await db.prepare("SELECT org_id FROM invite_redemptions WHERE email = ?").bind(email).first<{ org_id: string }>()
  )?.org_id as string;
  return { cookie, orgId, email };
}
async function invite(ownerCookie: string, role: "member" | "admin" = "member") {
  const email = `invitee-${tag()}@example.org`;
  const res = await call("/api/auth/organization/invite-member", {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (res.status !== 200) throw new Error(`invite ${res.status}`);
  const id = new URL(linkIn(smtp.sends.at(-1)?.text ?? "")).pathname.split("/").at(-1) ?? "";
  return { id, email };
}
async function signedIn(email: string, callbackURL?: string) {
  await call("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, ...(callbackURL ? { callbackURL } : {}) }),
  });
  return redeem(linkIn(smtp.sends.at(-1)?.text ?? ""));
}
const get = (path: string, cookie?: string) =>
  call(path, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
const post = (path: string, fields: Record<string, string>, cookie?: string, origin?: string | null) =>
  call(path, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: {
      accept: "text/html",
      ...(cookie ? { cookie } : {}),
      ...(origin === null ? {} : { origin: origin ?? "http://localhost" }),
    },
  });
const stateOf = async (id: string, email: string, orgId: string) => {
  const invitation = await db
    .prepare(`SELECT status FROM invitation WHERE id = ?`)
    .bind(id)
    .first<{ status: string }>();
  const uses = await db
    .prepare("SELECT COUNT(*) AS n FROM invitation_uses WHERE invitation_id = ?")
    .bind(id)
    .first<{ n: number }>();
  const members = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE lower(u.email) = ? AND m."organizationId" = ?`,
    )
    .bind(email, orgId)
    .first<{ n: number }>();
  const active = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM "session" s JOIN "user" u ON u.id = s."userId" WHERE lower(u.email) = ? AND s."activeOrganizationId" = ?`,
    )
    .bind(email, orgId)
    .first<{ n: number }>();
  return { status: invitation?.status, uses: uses?.n, members: members?.n, active: active?.n };
};
const privateHeaders = (res: Response) => {
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
  expect(res.headers.get("referrer-policy")).toBe("same-origin");
};

describe("the invitation page", () => {
  it("shows a signed-out invitee the invitation and the way to sign in as the invited address, back to it", async () => {
    const o = await owner();
    const inv = await invite(o.cookie);
    const res = await get(`/invite/${inv.id}`);
    expect(res.status).toBe(200);
    privateHeaders(res);
    const html = await res.text();
    expect(html).toContain("Your team checks suspicious mail with IsItLegit.");
    expect(html).toMatch(/invited you to join Karoo Couriers/);
    expect(html).toContain(inv.email);
    expect(html).toMatch(/Invitation expires<\/dt><dd[^>]*>\w{3} \d+ \w{3} \d\d:\d\d SAST/);
    expect(html).toContain('<form method="post" action="/signin/link"');
    expect(html).toContain(`name="email" value="${inv.email}"`);
    expect(html).toContain(`name="callbackURL" value="/invite/${inv.id}"`);
    // The page's own form: the link goes to the invited address and returns to the invitation.
    const asked = await post("/signin/link", { email: inv.email, callbackURL: `/invite/${inv.id}` });
    expect(asked.status).toBe(200);
    const back = await redeem(linkIn(smtp.sends.at(-1)?.text ?? ""));
    expect(target(back)).toBe(`/invite/${inv.id}`);
    const shown = await (await get(`/invite/${inv.id}`, sessionCookie(back))).text();
    expect(shown).toContain("Accept and join");
    expect(shown).toMatch(/Signing in as<\/dt><dd[^>]*>/);
    expect(shown).toContain("You will join as a <strong");
  });

  it("accepts for the invitee: one membership, one use, the organisation active, and on to the Cases list", async () => {
    const o = await owner();
    const inv = await invite(o.cookie);
    const cookie = sessionCookie(await signedIn(inv.email));
    const accepted = await post(`/invite/${inv.id}`, { action: "accept" }, cookie);
    expect(accepted.status).toBe(303);
    expect(target(accepted)).toBe("/cases");
    privateHeaders(accepted);
    expect(await stateOf(inv.id, inv.email, o.orgId)).toEqual({ status: "accepted", uses: 1, members: 1, active: 1 });
    const cases = await get("/cases", cookie);
    expect(await cases.text()).toContain("Everything Karoo Couriers has checked");
    // Again: the used state, nothing changed.
    const again = await post(`/invite/${inv.id}`, { action: "accept" }, cookie);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("This invitation has been used");
    expect(await stateOf(inv.id, inv.email, o.orgId)).toEqual({ status: "accepted", uses: 1, members: 1, active: 1 });
  });

  it("refuses every other actor and every stale form, each on a fresh invitation, changing nothing", async () => {
    const o = await owner();
    const stranger = sessionCookie(await signedIn(o.email));
    const unchanged = { status: "pending", uses: 0, members: 0, active: 0 };
    for (const action of ["accept", "decline"]) {
      const anonymous = await invite(o.cookie);
      expect((await post(`/invite/${anonymous.id}`, { action })).status, `${action} anonymous`).toBe(401);
      expect(await stateOf(anonymous.id, anonymous.email, o.orgId)).toEqual(unchanged);
      const foreign = await invite(o.cookie);
      const cookie = sessionCookie(await signedIn(foreign.email));
      expect((await post(`/invite/${foreign.id}`, { action }, cookie, "https://evil.example")).status).toBe(403);
      // An opaque origin, as a browser sends from a sandboxed or privacy-sensitive context.
      expect((await post(`/invite/${foreign.id}`, { action }, cookie, "null")).status).toBe(403);
      expect(await stateOf(foreign.id, foreign.email, o.orgId)).toEqual(unchanged);
      const other = await invite(o.cookie);
      expect((await post(`/invite/${other.id}`, { action }, stranger)).status, `${action} other`).toBe(403);
      expect(await stateOf(other.id, other.email, o.orgId)).toEqual(unchanged);
      // Stale forms: after expiry, after the owner withdrew it.
      const expired = await invite(o.cookie);
      const expiredCookie = sessionCookie(await signedIn(expired.email));
      await db
        .prepare(`UPDATE invitation SET "expiresAt" = ? WHERE id = ?`)
        .bind(new Date(Date.now() - 60_000).toISOString(), expired.id)
        .run();
      const late = await post(`/invite/${expired.id}`, { action }, expiredCookie);
      expect(late.status).toBe(409);
      expect(await late.text()).toContain("This invitation has expired");
      expect(await stateOf(expired.id, expired.email, o.orgId)).toMatchObject({ uses: 0, members: 0 });
      const revoked = await invite(o.cookie);
      const revokedCookie = sessionCookie(await signedIn(revoked.email));
      await db.prepare(`UPDATE invitation SET status = 'canceled' WHERE id = ?`).bind(revoked.id).run();
      const withdrawn = await post(`/invite/${revoked.id}`, { action }, revokedCookie);
      expect(withdrawn.status).toBe(409);
      expect(await withdrawn.text()).toContain("Nothing was shared with you.");
      expect(await stateOf(revoked.id, revoked.email, o.orgId)).toMatchObject({
        status: "canceled",
        uses: 0,
        members: 0,
      });
    }
  });

  it("declines for the invitee, keeps the declined state on every later visit, and takes no accept after", async () => {
    const o = await owner();
    const inv = await invite(o.cookie);
    const cookie = sessionCookie(await signedIn(inv.email));
    const declined = await post(`/invite/${inv.id}`, { action: "decline" }, cookie);
    expect(declined.status).toBe(200);
    expect(await declined.text()).toContain("You declined this invitation");
    for (const visitor of [cookie, undefined]) {
      const again = await (await get(`/invite/${inv.id}`, visitor)).text();
      expect(again).toContain("If you declined by mistake, ask");
      expect(again).not.toContain("Accept and join");
    }
    expect((await post(`/invite/${inv.id}`, { action: "accept" }, cookie)).status).toBe(409);
    expect((await post(`/invite/${inv.id}`, { action: "decline" }, cookie)).status).toBe(409);
    expect(await stateOf(inv.id, inv.email, o.orgId)).toEqual({ status: "rejected", uses: 0, members: 0, active: 0 });
  });

  it("takes someone signed in as another address through Sign out back to the invitation, to accept as the invitee", async () => {
    const o = await owner();
    const inv = await invite(o.cookie);
    const page = await (await get(`/invite/${inv.id}`, o.cookie)).text();
    expect(page).toContain("This invitation is for another address");
    expect(page).toContain('<form method="post" action="/auth/sign-out"');
    expect(page).toContain(`name="next" value="/invite/${inv.id}"`);
    const out = await post("/auth/sign-out", { next: `/invite/${inv.id}` }, o.cookie);
    expect(out.status).toBe(303);
    expect(target(out)).toBe(`/invite/${inv.id}`);
    expect(out.headers.getSetCookie().some((c) => /session_token=;/.test(c) || /max-age=0/i.test(c))).toBe(true);
    expect(await (await get("/api/auth/get-session", o.cookie)).json()).toBeNull();
    const cookie = sessionCookie(await signedIn(inv.email, `/invite/${inv.id}`));
    expect((await post(`/invite/${inv.id}`, { action: "accept" }, cookie)).status).toBe(303);
    // An address off the site is no return path: plain /signin.
    expect(target(await post("/auth/sign-out", { next: "https://evil.example" }, cookie))).toBe("/signin");
  });

  it("says each failure as one: an unreadable invitation, an accept that did not finish, and a spent invitation", async () => {
    const o = await owner();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    // The invitation unreadable.
    const unreadable = await invite(o.cookie);
    const reads = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM invitation i JOIN/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const down = await get(`/invite/${unreadable.id}`);
    reads.mockRestore();
    expect(down.status).toBe(503);
    privateHeaders(down);
    const downHtml = await down.text();
    expect(downHtml).toContain("Sorry, something broke on our side.");
    expect(downHtml).toContain(`href="/invite/${unreadable.id}"`);
    // An accept whose write fails before the use is kept: no success, and nothing changed.
    const failing = await invite(o.cookie);
    const cookie = sessionCookie(await signedIn(failing.email));
    const writes = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/INSERT INTO invitation_uses/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const stuck = await post(`/invite/${failing.id}`, { action: "accept" }, cookie);
    writes.mockRestore();
    expect(stuck.status).toBe(503);
    expect(await stuck.text()).toContain("That did not finish just now. Nothing changed: press it again in a moment.");
    expect(await stateOf(failing.id, failing.email, o.orgId)).toEqual({
      status: "pending",
      uses: 0,
      members: 0,
      active: 0,
    });
    // Spent without a membership (an acceptance interrupted between its writes): ask for a new invitation.
    const spent = await invite(o.cookie);
    await db
      .prepare("INSERT INTO invitation_uses (invitation_id, user_id, used_at) VALUES (?, 'someone', ?)")
      .bind(spent.id, new Date().toISOString())
      .run();
    const html = await (await get(`/invite/${spent.id}`)).text();
    expect(html).toContain("This invitation was used but did not finish");
    expect(html).not.toContain("Accept and join");
    // Unknown.
    expect((await get(`/invite/no-such-invitation-${tag()}`)).status).toBe(404);
  });
});
