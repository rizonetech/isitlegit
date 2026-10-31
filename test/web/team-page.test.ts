import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { lastActiveText, mayRemove, type Reader, roleChoices, type TeamMember } from "../../src/web/pages/team-view";
import { authEnv, call, ORIGIN, signIn, target } from "../auth/helpers";

// The Team page (D07 T04 §3; board `Team`): the organisation's members, each row's controls by Better Auth's rule, role
// changes and removals through Better Auth's own handler so D07 T02's hooks hold (the member lock, the previous role, the
// audit, the sessions ended, the last-owner rule), and every other answer drawn from the stored state.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id as string;
const tag = () => crypto.randomUUID().slice(0, 8);
// A signed-in person with the organisation active.
async function person(name: string) {
  const email = `team-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const id = await userId(email);
  await db.prepare(`UPDATE "user" SET name = ? WHERE id = ?`).bind(name, id).run();
  return { cookie, email, id, name };
}
async function organisation(owner: { id: string }, name = "Karoo Couriers") {
  const made = (await createAuth(authEnv).api.createOrganization({
    body: { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${tag()}`, userId: owner.id },
  })) as { id: string };
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(made.id, owner.id).run();
  return made.id;
}
async function join(orgId: string, who: { id: string }, role: "owner" | "admin" | "member") {
  const id = `m-${tag()}${tag()}`;
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(id, orgId, who.id, role, new Date().toISOString())
    .run();
  await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, who.id).run();
  return id;
}
const memberRow = async (memberId: string) =>
  db.prepare(`SELECT role FROM "member" WHERE id = ?`).bind(memberId).first<{ role: string }>();
const ownerMemberId = async (orgId: string, uid: string) =>
  (
    await db
      .prepare(`SELECT id FROM "member" WHERE "organizationId" = ? AND "userId" = ?`)
      .bind(orgId, uid)
      .first<{ id: string }>()
  )?.id as string;
const page = async (cookie: string, path = "/team") => {
  const res = await call(path, { headers: { cookie, accept: "text/html" } });
  return { res, html: await res.text() };
};
const post = (cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) => {
  const headers = new Headers({ cookie, "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
  if (origin) headers.set("origin", origin);
  else headers.set("origin", "");
  return call("/team", { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};
// Follow a 303 back to the page and read what it says.
const landed = async (cookie: string, res: Response) => {
  expect(res.status).toBe(303);
  return (await page(cookie, target(res) ?? "/team")).html;
};
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");

describe("the controls each reader gets", () => {
  const m = (userId: string, role: TeamMember["role"]): TeamMember => ({
    memberId: `m-${userId}`,
    userId,
    name: userId,
    email: `${userId}@x.example`,
    role,
    lastActive: null,
  });
  const owner: Reader = { userId: "o", role: "owner" };
  const admin: Reader = { userId: "a", role: "admin" };
  const plain: Reader = { userId: "p", role: "member" };
  it("follows Better Auth's rule per reader and target", () => {
    expect(roleChoices(owner, m("x", "owner"))).toEqual(["owner", "admin", "member"]);
    expect(roleChoices(owner, m("o", "owner"))).toEqual([]);
    expect(roleChoices(admin, m("x", "owner"))).toEqual([]);
    expect(roleChoices(admin, m("x", "admin"))).toEqual(["admin", "member"]);
    expect(roleChoices(admin, m("x", "member"))).toEqual(["admin", "member"]);
    expect(roleChoices(plain, m("x", "member"))).toEqual([]);
    expect(mayRemove(owner, m("x", "owner"))).toBe(true);
    expect(mayRemove(admin, m("x", "owner"))).toBe(false);
    expect(mayRemove(admin, m("x", "member"))).toBe(true);
    expect(mayRemove(plain, m("x", "member"))).toBe(false);
    expect(mayRemove(owner, m("o", "owner"))).toBe(false);
  });
  it("words Last active in SAST", () => {
    const now = new Date("2026-10-30T10:00:00Z");
    expect(lastActiveText(null, now)).toBe("No recent sign-in");
    expect(lastActiveText("2026-10-30T09:57:00Z", now)).toBe("Now");
    expect(lastActiveText("2026-10-30T09:20:00Z", now)).toBe("Today 11:20");
    // 23:59 SAST on the 29th, read on the 30th.
    expect(lastActiveText("2026-10-29T21:59:00Z", now)).toBe("Yesterday");
    expect(lastActiveText("2026-10-24T08:00:00Z", now)).toBe("Sat 24 Oct");
    expect(lastActiveText("2025-10-24T08:00:00Z", now)).toBe("Fri 24 Oct 2025");
  });
});

describe("GET /team", () => {
  it("lists the organisation's members with their Last active, the reader marked, none of another's", async () => {
    const owner = await person("Thandi Nkosi");
    const orgId = await organisation(owner);
    const ayesha = await person("Ayesha Patel");
    await join(orgId, ayesha, "admin");
    const sipho = await person("Sipho Mokoena");
    await join(orgId, sipho, "member");
    // Sipho's two sessions: the newer is read. Ayesha has none left.
    await db
      .prepare(`UPDATE "session" SET "updatedAt" = ? WHERE "userId" = ?`)
      .bind("2026-10-20T08:00:00.000Z", sipho.id)
      .run();
    await db
      .prepare(
        `INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `s-${tag()}`,
        "2099-01-01T00:00:00.000Z",
        `t-${tag()}`,
        "2026-10-01T00:00:00.000Z",
        new Date().toISOString(),
        sipho.id,
      )
      .run();
    await db.prepare(`DELETE FROM "session" WHERE "userId" = ?`).bind(ayesha.id).run();
    const stranger = await person("Not Ours");
    await organisation(stranger, "Elsewhere");
    const { res, html } = await page(owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const table = text(html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")));
    expect(table).toMatch(/Thandi Nkosi You .*Ayesha Patel .*Sipho Mokoena/);
    expect(table).toContain(ayesha.email);
    expect(text(html)).toContain("People at Karoo Couriers who can check mail and see cases.");
    expect(text(html)).toContain("Owner : everything, including the plan and removing people.");
    const rows = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>")).split("<tr").slice(1);
    expect(text(rows[1] ?? "")).toContain("No recent sign-in");
    expect(text(rows[2] ?? "")).toContain("Now");
    expect(html).not.toContain("Not Ours");
    expect(html).toContain('aria-current="page"');
  });

  it("gives an owner, an admin and a member each their own controls", async () => {
    const owner = await person("Owner One");
    const orgId = await organisation(owner);
    const admin = await person("Admin Two");
    const adminId = await join(orgId, admin, "admin");
    const plain = await person("Member Three");
    const plainId = await join(orgId, plain, "member");
    const ownerId = await ownerMemberId(orgId, owner.id);
    const optionsFor = (html: string, memberId: string) => {
      const select = new RegExp(`<select id="role-${memberId}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? "";
      return [...select.matchAll(/<option value="(\w+)"/g)].map((x) => x[1]);
    };
    const asOwner = (await page(owner.cookie)).html;
    expect(optionsFor(asOwner, adminId)).toEqual(["owner", "admin", "member"]);
    expect(optionsFor(asOwner, ownerId)).toEqual([]);
    expect(asOwner).toContain(`href="/team/remove/${plainId}"`);
    // The only owner's own Remove, disabled with its reason, and the guard.
    expect(asOwner).toMatch(/id="remove-[^"]+"[^>]*disabled/);
    expect(text(asOwner)).toContain("You are the only owner, so you cannot be removed or made an admin.");
    const asAdmin = (await page(admin.cookie)).html;
    expect(optionsFor(asAdmin, plainId)).toEqual(["admin", "member"]);
    expect(optionsFor(asAdmin, ownerId)).toEqual([]);
    expect(asAdmin).not.toContain(`href="/team/remove/${ownerId}"`);
    expect(text(asAdmin)).toContain("Only an owner can change an owner");
    expect(text(asAdmin)).not.toContain("You are the only owner");
    const asMember = (await page(plain.cookie)).html;
    expect(asMember).not.toContain("<select");
    expect(asMember).not.toContain("/team/remove/");
  });

  it("answers no session, no active organisation and a failed read as the Cases list does", async () => {
    const anon = await call("/team", { headers: { accept: "text/html" } });
    expect(anon.status).toBe(303);
    expect(target(anon)).toBe(`/signin?next=${encodeURIComponent("/team")}`);
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = NULL WHERE "userId" = ?`).bind(owner.id).run();
    expect((await page(owner.cookie)).res.status).toBe(403);
    await db.prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`).bind(orgId, owner.id).run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes('FROM "member" m JOIN "user" u')) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const failed = await page(owner.cookie);
    vi.restoreAllMocks();
    expect(failed.res.status).toBe(503);
    expect(failed.html).toContain('href="/team"');
  });
});

describe("changing a role", () => {
  it("runs through Better Auth's handler: the role changed, its audit naming the actor and both roles", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    const res = await post(owner.cookie, { action: "role", org: orgId, member: clerkId, role: "admin" });
    expect(text(await landed(owner.cookie, res))).toContain("Clerk's role was changed.");
    expect(await memberRow(clerkId)).toEqual({ role: "admin" });
    const audit = await db
      .prepare(
        `SELECT actor_id, target_id, outcome, detail_json FROM auth_events WHERE org_id = ? AND kind = 'update-member-role'`,
      )
      .bind(orgId)
      .first<{ actor_id: string; target_id: string; outcome: string; detail_json: string }>();
    expect(audit).toMatchObject({ actor_id: owner.id, target_id: clerk.id, outcome: "changed" });
    expect(JSON.parse(audit?.detail_json ?? "{}")).toMatchObject({ from: "member", to: "admin" });
  });

  it("changes nothing for another organisation's page, another origin, no origin, or a member's post", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    const switched = await post(owner.cookie, { action: "role", org: "org-other", member: clerkId, role: "admin" });
    expect(text(await landed(owner.cookie, switched))).toContain("this page was opened for another organisation");
    expect(
      (await post(owner.cookie, { action: "role", org: orgId, member: clerkId, role: "admin" }, "https://evil.example"))
        .status,
    ).toBe(403);
    expect(
      (await post(owner.cookie, { action: "role", org: orgId, member: clerkId, role: "admin" }, null)).status,
    ).toBe(403);
    const plain = await person("Plain");
    await join(orgId, plain, "member");
    const refused = await post(plain.cookie, { action: "role", org: orgId, member: clerkId, role: "admin" });
    expect(text(await landed(plain.cookie, refused))).toContain("You can no longer change the team.");
    expect(await memberRow(clerkId)).toEqual({ role: "member" });
  });

  it("answers a member another change holds, and releases the hold after a refused change", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    await db
      .prepare("INSERT INTO member_locks (member_id, until, holder) VALUES (?, ?, 'other')")
      .bind(clerkId, Math.floor(Date.now() / 1000) + 60)
      .run();
    const held = await post(owner.cookie, { action: "role", org: orgId, member: clerkId, role: "admin" });
    expect(text(await landed(owner.cookie, held))).toContain(
      "Someone else is changing Clerk now. Try again in a moment.",
    );
    expect(await memberRow(clerkId)).toEqual({ role: "member" });
    await db.prepare("DELETE FROM member_locks WHERE member_id = ?").bind(clerkId).run();
    // The only owner made an admin: taken, refused by the last-owner rule, and released.
    const self = await ownerMemberId(orgId, owner.id);
    const lastOwner = await post(owner.cookie, { action: "role", org: orgId, member: self, role: "admin" });
    expect(text(await landed(owner.cookie, lastOwner))).toContain("You are the only owner");
    expect(await memberRow(self)).toEqual({ role: "owner" });
    const lock = await db
      .prepare("SELECT until FROM member_locks WHERE member_id = ?")
      .bind(self)
      .first<{ until: number }>();
    expect(lock === null || lock.until < Math.floor(Date.now() / 1000) + 1).toBe(true);
  });

  it("says a member already removed is gone, and a change to the role they have is no change", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    const same = await post(owner.cookie, { action: "role", org: orgId, member: clerkId, role: "member" });
    expect(text(await landed(owner.cookie, same))).toContain("Clerk already had that role.");
    await db.prepare(`DELETE FROM "member" WHERE id = ?`).bind(clerkId).run();
    const gone = await post(owner.cookie, { action: "role", org: orgId, member: clerkId, role: "admin" });
    expect(text(await landed(owner.cookie, gone))).toContain("That member is no longer a member.");
  });

  it("answers a change that fails as unconfirmed over the stored state, never a change shown as made", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/^update "member"/i.test(sql.trim())) throw new Error("D1_ERROR: write lost");
      return prepare(sql);
    });
    const res = await post(owner.cookie, { action: "role", org: orgId, member: clerkId, role: "admin" });
    vi.restoreAllMocks();
    const said = text(await landed(owner.cookie, res));
    expect(said).toContain("The change to Clerk could not be confirmed.");
    expect(said).not.toContain("role was changed");
    expect(await memberRow(clerkId)).toEqual({ role: "member" });
  });
});

describe("removing a member", () => {
  it("asks first, then removes through Better Auth's handler: membership, sessions and audit", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Johan van Wyk");
    const clerkId = await join(orgId, clerk, "member");
    const asked = await page(owner.cookie, `/team/remove/${clerkId}`);
    expect(asked.res.status).toBe(200);
    expect(text(asked.html)).toContain("Remove Johan van Wyk?");
    expect(asked.html).toContain('href="/team"');
    const res = await post(owner.cookie, { action: "remove", org: orgId, member: clerkId });
    expect(text(await landed(owner.cookie, res))).toContain("Johan van Wyk was removed.");
    expect(await memberRow(clerkId)).toBeNull();
    expect(
      await db
        .prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ? AND "activeOrganizationId" = ?`)
        .bind(clerk.id, orgId)
        .first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare(`SELECT actor_id, target_id FROM auth_events WHERE org_id = ? AND kind = 'remove-member'`)
        .bind(orgId)
        .first(),
    ).toEqual({ actor_id: owner.id, target_id: clerk.id });
  });

  it("changes nothing from another origin, for another organisation's member, or after a switch", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    expect(
      (await post(owner.cookie, { action: "remove", org: orgId, member: clerkId }, "https://evil.example")).status,
    ).toBe(403);
    const other = await person("Other Owner");
    const otherOrg = await organisation(other, "Elsewhere");
    const theirs = await person("Theirs");
    const theirsId = await join(otherOrg, theirs, "member");
    const foreign = await post(owner.cookie, { action: "remove", org: orgId, member: theirsId });
    expect(text(await landed(owner.cookie, foreign))).toContain("is no longer a member");
    expect(await memberRow(theirsId)).toEqual({ role: "member" });
    // The confirm page for a member not in the organisation says so.
    const gone = await call(`/team/remove/${theirsId}`, { headers: { cookie: owner.cookie, accept: "text/html" } });
    expect(gone.status).toBe(303);
    // Opened the confirmation, then switched to another organisation in another tab.
    await join(otherOrg, owner, "owner");
    const switched = await post(owner.cookie, { action: "remove", org: orgId, member: clerkId });
    expect(text(await landed(owner.cookie, switched))).toContain("this page was opened for another organisation");
    expect(await memberRow(clerkId)).toEqual({ role: "member" });
  });

  it("refuses an admin removing an owner, and keeps the last owner", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    const ownerId = await ownerMemberId(orgId, owner.id);
    const refused = await post(admin.cookie, { action: "remove", org: orgId, member: ownerId });
    expect(text(await landed(admin.cookie, refused))).toContain("You can no longer change the team.");
    expect(await memberRow(ownerId)).toEqual({ role: "owner" });
    const self = await post(owner.cookie, { action: "remove", org: orgId, member: ownerId });
    expect(text(await landed(owner.cookie, self))).toContain("You are the only owner");
    expect(await memberRow(ownerId)).toEqual({ role: "owner" });
  });
});
