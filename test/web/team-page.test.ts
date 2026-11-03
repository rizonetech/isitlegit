import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { lastActiveText, mayRemove, type Reader, roleChoices, type TeamMember } from "../../src/web/pages/team-view";
import { authEnv, call, ORIGIN, signIn, stubSmtp2go, target } from "../auth/helpers";

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
    expect(refused.status).toBe(403);
    expect(text(await refused.text())).toContain("You can no longer change the team.");
    // Not a request the page sends: refused, never a no-op claimed as fact.
    for (const fields of [
      { action: "role", org: orgId, member: clerkId, role: "superuser" },
      { action: "promote", org: orgId, member: clerkId },
    ]) {
      const odd = text(await landed(owner.cookie, await post(owner.cookie, fields)));
      expect(odd).toContain("Nothing was changed: that request is not one this page sends.");
      expect(odd).not.toContain("already had that role");
    }
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

describe("the confirm page and a lost answer", () => {
  it("offers removal only where the reader may make it, even by a typed address", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const admin = await person("Admin");
    const adminId = await join(orgId, admin, "admin");
    const plain = await person("Plain");
    const plainId = await join(orgId, plain, "member");
    const ownerId = await ownerMemberId(orgId, owner.id);
    for (const [cookie, memberId] of [
      [plain.cookie, adminId],
      [admin.cookie, ownerId],
      [owner.cookie, ownerId],
    ] as const) {
      const res = await call(`/team/remove/${memberId}`, { headers: { cookie, accept: "text/html" } });
      expect(res.status).toBe(303);
      expect(text(await landed(cookie, res))).toContain("You can no longer change the team.");
    }
    expect((await page(admin.cookie, `/team/remove/${plainId}`)).res.status).toBe(200);
  });

  it("says a change whose answer was lost may not have been made, over the stored team", async () => {
    const owner = await person("Owner");
    await organisation(owner);
    const said = text((await page(owner.cookie, "/team?unanswered=1")).html);
    expect(said).toContain("Your last change may not have reached us. The team below is as stored now");
  });
});

describe("a post's bounds and a lost permission", () => {
  it("refuses a body past the form's bound before parsing it, nothing changed", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    const big = new URLSearchParams({
      action: "role",
      org: orgId,
      member: clerkId,
      role: "admin",
      pad: "x".repeat(20_000),
    });
    const res = await call("/team", {
      method: "POST",
      headers: { cookie: owner.cookie, "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: big.toString(),
    });
    expect(text(await landed(owner.cookie, res))).toContain(
      "Nothing was changed: that request is not one this page sends.",
    );
    expect(await memberRow(clerkId)).toEqual({ role: "member" });
  });

  it("answers an htmx post from a reader who lost the permission with the notice htmx draws", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    const demoted = await person("Was Admin");
    await join(orgId, demoted, "member");
    const res = await call("/team?unanswered=1", {
      method: "POST",
      headers: {
        cookie: demoted.cookie,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
        "hx-request": "true",
      },
      body: new URLSearchParams({ action: "role", org: orgId, member: clerkId, role: "admin" }).toString(),
    });
    expect(text(await landed(demoted.cookie, res))).toContain("You can no longer change the team.");
    expect(await memberRow(clerkId)).toEqual({ role: "member" });
  });
});

describe("an outcome's address", () => {
  it("stays short whatever a member named themselves, and the page still loads", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const long = await person("x".repeat(20_000));
    const longId = await join(orgId, long, "member");
    const res = await post(owner.cookie, { action: "role", org: orgId, member: longId, role: "admin" });
    expect(res.status).toBe(303);
    expect((target(res) ?? "").length).toBeLessThan(1000);
    const said = text(await landed(owner.cookie, res));
    expect(said).toContain(`${"x".repeat(79)}…'s role was changed.`);
    expect(await memberRow(longId)).toEqual({ role: "admin" });
  });
});

describe("invitations", () => {
  const invitee = () => `inv-${tag()}@example.com`;
  const stored = (orgId: string, email: string) =>
    db
      .prepare(
        `SELECT id, role, status, "expiresAt" AS expires FROM "invitation" WHERE "organizationId" = ? AND email = ?`,
      )
      .bind(orgId, email)
      .first<{ id: string; role: string; status: string; expires: string | number }>();
  const count = async (orgId: string, email: string) =>
    (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM "invitation" WHERE "organizationId" = ? AND email = ? AND status = 'pending'`,
        )
        .bind(orgId, email)
        .first<{ n: number }>()
    )?.n;
  const sendStatus = async (id: string) =>
    (
      await db
        .prepare(`SELECT status FROM mail_sends WHERE send_key LIKE ?`)
        .bind(`invite:${id}:%`)
        .all<{ status: string }>()
    ).results.map((r) => r.status);
  const send = (cookie: string, orgId: string, email: string, role = "member") =>
    post(cookie, { action: "invite", org: orgId, email, role });

  it("sends an invitation through Better Auth: stored, its send recorded, listed with who sent it, role choices per reader", async () => {
    const owner = await person("Thandi Nkosi");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const empty = (await page(owner.cookie)).html;
    expect(text(empty)).toContain("Invite by email");
    expect(text(empty)).toContain("No pending invitations.");
    expect(empty).toMatch(/<option value="owner"[^>]*>Owner/);
    const email = invitee();
    const res = await send(owner.cookie, orgId, email, "admin");
    const after = await landed(owner.cookie, res);
    expect(text(after)).toContain(`Invitation sent to ${email}.`);
    const row = await stored(orgId, email);
    expect(row).toMatchObject({ role: "admin", status: "pending" });
    expect(await sendStatus(row?.id as string)).toEqual(["sent"]);
    expect(smtp.sends.at(-1)?.to).toBe(email);
    expect(text(after)).toMatch(new RegExp(`${email} Admin Today \\d\\d:\\d\\d by Thandi N\\.`));
    expect(text(after)).toContain("by Thandi N.");
    expect(after).not.toContain("No pending invitations.");
    expect(text(after)).not.toContain("Email not sent");
    // An admin chooses between Admin and Member only; a member sees neither panel nor table and cannot post one.
    const admin = await person("Ayesha Patel");
    await join(orgId, admin, "admin");
    const adminPage = (await page(admin.cookie)).html;
    expect(adminPage).not.toMatch(/<option value="owner"/);
    expect(adminPage).toMatch(/<option value="admin"/);
    const member = await person("Sipho");
    await join(orgId, member, "member");
    const memberPage = (await page(member.cookie)).html;
    expect(text(memberPage)).not.toContain("Invite by email");
    expect(text(memberPage)).not.toContain("Pending invitations");
    const before = await stored(orgId, "nope@example.com");
    const refused = await send(member.cookie, orgId, "nope@example.com");
    expect(refused.status).toBe(403);
    expect(await stored(orgId, "nope@example.com")).toEqual(before);
  });

  it("lists only this organisation's pending invitations, marks an expired one, and renews it with Resend", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const other = await person("Other Owner");
    const otherOrg = await organisation(other, "Other Org");
    const smtp = stubSmtp2go();
    const stranger = invitee();
    await send(other.cookie, otherOrg, stranger);
    const mine = invitee();
    await send(owner.cookie, orgId, mine);
    const html = (await page(owner.cookie)).html;
    expect(html).toContain(mine);
    expect(html).not.toContain(stranger);
    const row = await stored(orgId, mine);
    await db
      .prepare(`UPDATE "invitation" SET "expiresAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 3_600_000).toISOString(), row?.id)
      .run();
    const lapsed = (await page(owner.cookie)).html;
    expect(text(lapsed)).toContain("Expired");
    const res = await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    expect(text(await landed(owner.cookie, res))).toContain(`Invitation sent again to ${mine}.`);
    const renewed = await db
      .prepare(
        `SELECT "expiresAt" AS expires FROM "invitation" WHERE "organizationId" = ? AND email = ? AND status = 'pending'`,
      )
      .bind(orgId, mine)
      .first<{ expires: string | number }>();
    expect(await count(orgId, mine)).toBe(1);
    expect(Date.parse(new Date(renewed?.expires as string | number).toISOString())).toBeGreaterThan(Date.now());
    expect(text((await page(owner.cookie)).html)).not.toContain("Expired");
    smtp.restore();
  });

  it("revokes an invitation: gone from the table, cancelled in storage, and no longer acceptable", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const email = invitee();
    await send(owner.cookie, orgId, email);
    const row = await stored(orgId, email);
    const res = await post(owner.cookie, { action: "revoke", org: orgId, invitation: row?.id as string });
    const after = await landed(owner.cookie, res);
    expect(text(after)).toContain(`The invitation to ${email} was revoked.`);
    expect(text(after)).toContain("No pending invitations.");
    expect((await stored(orgId, email))?.status).toBe("canceled");
    const link = await call(`/invite/${row?.id}`, { headers: { cookie: owner.cookie, accept: "text/html" } });
    expect(text(await link.text())).not.toMatch(/Accept/);
    // A second revoke of the same invitation says it is no longer pending.
    const again = await post(owner.cookie, { action: "revoke", org: orgId, invitation: row?.id as string });
    expect(text(await landed(owner.cookie, again))).toContain("is no longer pending");
    smtp.restore();
  });

  it("marks an invitation whose email did not go from the stored send, across a fresh load, until a send is confirmed", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const email = invitee();
    let smtp = stubSmtp2go(() => "refused");
    const first = await send(owner.cookie, orgId, email);
    expect(text(await landed(owner.cookie, first))).toContain("may not have gone");
    let html = (await page(owner.cookie)).html;
    expect(text(html)).toContain("Email not sent.");
    expect(text(html)).toContain("Send again");
    const row = await stored(orgId, email);
    // A resend whose answer is lost may have gone: said so, not "not sent".
    smtp.restore();
    smtp = stubSmtp2go(() => "silent");
    await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    html = (await page(owner.cookie)).html;
    expect(text(html)).toContain("Not known if the email went.");
    expect(text(html)).not.toContain("Email not sent.");
    smtp.restore();
    smtp = stubSmtp2go();
    const sent = await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    expect(text(await landed(owner.cookie, sent))).toContain("sent again");
    html = (await page(owner.cookie)).html;
    expect(text(html)).not.toContain("Email not sent.");
    expect(text(html)).not.toContain("Not known if the email went.");
    // The mark reads the real send key: an earlier row under another expiry does not stand in for the current one.
    await db.prepare(`DELETE FROM mail_sends WHERE send_key LIKE ?`).bind(`invite:${row?.id}:%`).run();
    expect(text((await page(owner.cookie)).html)).toContain("Email not sent.");
    smtp.restore();
  });

  it("draws a refusal under the address with it kept, and a failure or lost answer as unconfirmed, never as sent", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const colleague = await person("Colleague");
    await join(orgId, colleague, "member");
    const smtp = stubSmtp2go();
    const taken = await send(owner.cookie, orgId, colleague.email);
    expect(taken.status).toBe(400);
    const takenHtml = await taken.text();
    expect(text(takenHtml)).toContain("already a member");
    expect(takenHtml).toContain(`>${colleague.email}</textarea>`);
    expect(await stored(orgId, colleague.email)).toBeNull();
    const bad = await send(owner.cookie, orgId, "not an address");
    expect(bad.status).toBe(400);
    expect(text(await bad.text())).toContain("Enter the email address to invite.");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const email = invitee();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/insert into "invitation"/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const failed = await send(owner.cookie, orgId, email);
    vi.restoreAllMocks();
    expect(text(await landed(owner.cookie, failed))).not.toContain("Invitation sent");
    expect(await stored(orgId, email)).toBeNull();
    smtp.restore();
  });

  const bulk = async (orgId: string, inviterId: string, count: number, expired = false) => {
    const at = Date.now();
    for (let start = 0; start < count; start += 25) {
      const batch = [];
      for (let i = start; i < Math.min(count, start + 25); i++)
        batch.push(
          db
            .prepare(
              `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?)`,
            )
            .bind(
              `bulk-${tag()}${i}`,
              orgId,
              `bulk${i}-${tag()}@example.com`,
              new Date(at + (expired ? -3_600_000 : 86_400_000)).toISOString(),
              new Date(at - i * 1000).toISOString(),
              inviterId,
            ),
        );
      await db.batch(batch);
    }
  };

  it("lists more than a hundred pending invitations without failing, and names the open-invitation limit as the field's error", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await bulk(orgId, owner.id, 120, true);
    const listed = await page(owner.cookie);
    expect(listed.res.status).toBe(200);
    expect((listed.html.match(/Expired/g) ?? []).length).toBeGreaterThanOrEqual(120);
    // Better Auth's limit of 100 open invitations, on an organisation with that many unexpired ones.
    const full = await person("Full Owner");
    const fullOrg = await organisation(full, "Full Org");
    await bulk(fullOrg, full.id, 100);
    const smtp = stubSmtp2go();
    const refused = await send(full.cookie, fullOrg, invitee());
    expect(refused.status).toBe(403);
    const refusedHtml = await refused.text();
    expect(text(refusedHtml)).toContain("too many open invitations");
    expect(refusedHtml).toContain('aria-invalid="true"');
    expect(text(refusedHtml)).not.toContain("You can no longer change the team");
    smtp.restore();
  });

  it("keeps the lapsed invitation to retry from when its renewal fails, and shows only the newer one when both exist", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const email = invitee();
    await send(owner.cookie, orgId, email);
    const row = await stored(orgId, email);
    await db
      .prepare(`UPDATE "invitation" SET "expiresAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 3_600_000).toISOString(), row?.id)
      .run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/insert into "invitation"/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const failed = await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    vi.restoreAllMocks();
    smtp.restore();
    const smtpAgain = stubSmtp2go();
    expect(text(await landed(owner.cookie, failed))).toContain("could not be confirmed");
    // Nothing was cancelled: the lapsed invitation is still pending, with its Send again to try from.
    expect((await stored(orgId, email))?.status).toBe("pending");
    expect(await count(orgId, email)).toBe(1);
    const retry = await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    expect(text(await landed(owner.cookie, retry))).toContain(`Invitation sent again to ${email}.`);
    expect(await count(orgId, email)).toBe(1);
    // A cancel that did not finish leaves both pending; only the newer is listed.
    const fresh = await db
      .prepare(`SELECT id FROM "invitation" WHERE "organizationId" = ? AND email = ? AND status = 'pending'`)
      .bind(orgId, email)
      .first<{ id: string }>();
    await db
      .prepare(`UPDATE "invitation" SET status = 'pending', "expiresAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 3_600_000).toISOString(), row?.id)
      .run();
    const listed = (await page(owner.cookie)).html;
    // One row, drawn once for wide screens and once for phones: two Revoke buttons, not four.
    expect(listed.split(`aria-label="Revoke invitation to ${email}"`).length - 1).toBe(2);
    expect(fresh?.id).not.toBe(row?.id);
    smtpAgain.restore();
  });

  it("keeps a revocation another admin made while a resend was in flight, and cancels the invitation the resend made", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const email = invitee();
    await send(owner.cookie, orgId, email);
    const row = await stored(orgId, email);
    smtp.restore();
    // The other admin's revocation lands while the resend is sending its mail (after the new invitation exists).
    const real = globalThis.fetch;
    let revoked = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("smtp2go")) return real(input, init);
      if (!revoked) {
        revoked = true;
        await db.prepare(`UPDATE "invitation" SET status = 'canceled' WHERE id = ?`).bind(row?.id).run();
      }
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-race" } });
    });
    // The page's resend was asked of an invitation that was pending when the page was drawn.
    const res = await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    vi.restoreAllMocks();
    expect(text(await landed(owner.cookie, res))).toContain("is no longer pending");
    expect(await count(orgId, email)).toBe(0);
    expect(text((await page(owner.cookie)).html)).toContain("No pending invitations.");
  });

  it("keeps a revocation made while an expired invitation was being renewed too", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const email = invitee();
    await send(owner.cookie, orgId, email);
    const row = await stored(orgId, email);
    await db
      .prepare(`UPDATE "invitation" SET "expiresAt" = ? WHERE id = ?`)
      .bind(new Date(Date.now() - 3_600_000).toISOString(), row?.id)
      .run();
    smtp.restore();
    const real = globalThis.fetch;
    let revoked = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes("smtp2go")) return real(input, init);
      if (!revoked) {
        revoked = true;
        await db.prepare(`UPDATE "invitation" SET status = 'canceled' WHERE id = ?`).bind(row?.id).run();
      }
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: "email-race" } });
    });
    const res = await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    vi.restoreAllMocks();
    expect(text(await landed(owner.cookie, res))).toContain("is no longer pending");
    expect(await count(orgId, email)).toBe(0);
  });

  it("keeps the fresh invitation made after an acceptance that did not finish, which is a recovery and not a revocation", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const email = invitee();
    await send(owner.cookie, orgId, email);
    const row = await stored(orgId, email);
    await db
      .prepare(`INSERT INTO invitation_uses (invitation_id, user_id, used_at) VALUES (?, ?, ?)`)
      .bind(row?.id, owner.id, new Date().toISOString())
      .run();
    const res = await post(owner.cookie, { action: "resend", org: orgId, invitation: row?.id as string });
    expect(text(await landed(owner.cookie, res))).toContain(`Invitation sent again to ${email}.`);
    expect(await count(orgId, email)).toBe(1);
    expect((await stored(orgId, email))?.status).toBe("canceled");
    smtp.restore();
  });

  it("explains a resend refused for too many open invitations, never as a lost permission", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    // Better Auth reads its first hundred pending invitations: the lapsed one is written last so they are all open.
    await bulk(orgId, owner.id, 130);
    const email = invitee();
    const lapsedId = `lapsed-${tag()}`;
    await db
      .prepare(
        `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES (?, ?, ?, 'member', 'pending', ?, ?, ?)`,
      )
      .bind(lapsedId, orgId, email, new Date(Date.now() - 3_600_000).toISOString(), new Date().toISOString(), owner.id)
      .run();
    const res = await post(owner.cookie, { action: "resend", org: orgId, invitation: lapsedId });
    const said = text(await landed(owner.cookie, res));
    expect(said).toContain("too many open invitations");
    expect(said).not.toContain("You can no longer change the team");
    smtp.restore();
  });

  it("refuses the recipient a revoked invitation and lets them join by a renewed one", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const email = `inv-${tag()}@demo.isitlegit.co.za`;
    await send(owner.cookie, orgId, email);
    const first = await stored(orgId, email);
    await post(owner.cookie, { action: "revoke", org: orgId, invitation: first?.id as string });
    smtp.restore();
    const recipient = await signIn(email);
    const accept = (id: string) =>
      call("/api/auth/organization/accept-invitation", {
        method: "POST",
        headers: { cookie: recipient.cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ invitationId: id }),
      });
    expect((await accept(first?.id as string)).status).toBeGreaterThanOrEqual(400);
    const again = stubSmtp2go();
    await send(owner.cookie, orgId, email);
    const second = await db
      .prepare(`SELECT id FROM "invitation" WHERE "organizationId" = ? AND email = ? AND status = 'pending'`)
      .bind(orgId, email)
      .first<{ id: string }>();
    again.restore();
    expect((await accept(second?.id as string)).status).toBe(200);
    const joined = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE m."organizationId" = ? AND lower(u.email) = ?`,
      )
      .bind(orgId, email)
      .first<{ n: number }>();
    expect(joined?.n).toBe(1);
  });
});

describe("protected accounts on the Team page (D07 T04 §25)", () => {
  const FYNBOS = "ZF5SufztotybeXIWVncExFAVu9GYZ8Fu";
  // A protected account as a member of the organisation, with the name the board would show.
  async function protectedMember(
    orgId: string,
    email: string,
    name: string,
    role: "owner" | "admin" | "member" = "member",
  ) {
    // The account is one row however many organisations it belongs to.
    const existing = await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
    const id = existing?.id ?? crypto.randomUUID();
    if (!existing) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .bind(id, name, email, now, now)
        .run();
    }
    return { id, email, name, memberId: await join(orgId, { id }, role) };
  }
  const refused = (orgId: string, targetId: string) =>
    db
      .prepare(
        `SELECT kind, outcome, actor_id FROM auth_events WHERE org_id = ? AND target_id = ? AND outcome = 'refused-protected'`,
      )
      .bind(orgId, targetId)
      .all<{ kind: string; outcome: string; actor_id: string }>();
  const REASON = "This is a protected demo account";
  const NOTICE = (name: string) => `${name} is a protected demo account and cannot be removed.`;

  it("draws Remove disabled with its reason for an owner and an admin, and an ordinary member still gets an active Remove", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const demo = await protectedMember(orgId, "demo@rizonetech.com", "Demo Account");
    const derick = await protectedMember(orgId, "derick@rizonetech.com", "Derick Payne", "admin");
    const clerk = await person("Clerk");
    const clerkId = await join(orgId, clerk, "member");
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    for (const reader of [owner, admin]) {
      const { html } = await page(reader.cookie);
      for (const who of [demo, derick]) {
        // Not an active link; the reason is on the page, on the row's control.
        expect(html).not.toContain(`href="/team/remove/${who.memberId}"`);
      }
      expect(html).toContain(`href="/team/remove/${clerkId}"`);
      expect(html.split(REASON).length - 1).toBeGreaterThanOrEqual(2);
      expect(html).toMatch(new RegExp(`id="remove-${demo.memberId}"[^>]*disabled`));
      // Each disabled Remove names who it acts on, so a list of controls tells them apart.
      expect(html).toContain(`aria-label="Remove ${demo.name}"`);
      expect(html).toContain(`aria-label="Remove ${derick.name}"`);
      expect(html).toContain(`aria-describedby="remove-${demo.memberId}-reason"`);
    }
    // A member reader gets no Remove and no mention of protection at all.
    const clerkView = (await page(clerk.cookie)).html;
    expect(clerkView).not.toContain(REASON);
    expect(clerkView).not.toContain("protected");
    expect(clerkView).not.toContain("/team/remove/");
  });

  it("tells an admin looking at a protected owner only the owner rule's words, on that row", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    const derickOwner = await protectedMember(orgId, "derick@rizonetech.com", "Derick Payne", "owner");
    const html = (await page(admin.cookie)).html;
    // That row's own control: named for the member, and described by the owner rule alone.
    expect(html).toMatch(new RegExp(`aria-label="Remove Derick Payne" id="remove-${derickOwner.memberId}"`));
    expect(html).toMatch(
      new RegExp(`id="remove-${derickOwner.memberId}-reason"[^>]*>\\s*Only an owner can change an owner`),
    );
    expect(html).not.toContain(REASON);
    // The owner reading the same row is told it is protected.
    expect((await page(owner.cookie)).html).toContain(REASON);
  });

  it("answers an admin's hand-made removal of a protected owner with the permission refusal, never the protection notice", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const admin = await person("Admin");
    await join(orgId, admin, "admin");
    const derickOwner = await protectedMember(orgId, "derick@rizonetech.com", "Derick Payne", "owner");
    const res = await post(admin.cookie, { action: "remove", org: orgId, member: derickOwner.memberId });
    const said = text(await landed(admin.cookie, res));
    expect(said).toContain("You can no longer change the team.");
    expect(said).not.toContain("protected");
    expect(await memberRow(derickOwner.memberId)).toEqual({ role: "owner" });
    expect((await refused(orgId, derickOwner.id)).results).toHaveLength(0);
  });

  it("answers the typed removal address with the notice instead of asking, for both accounts, and tells those who could not remove nothing", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const demo = await protectedMember(orgId, "demo@rizonetech.com", "Demo Account");
    const derick = await protectedMember(orgId, "derick@rizonetech.com", "Derick Payne", "admin");
    const clerk = await person("Clerk");
    await join(orgId, clerk, "member");
    for (const who of [demo, derick]) {
      const asked = await page(owner.cookie, `/team/remove/${who.memberId}`);
      expect(asked.res.status).toBe(303);
      const said = text((await page(owner.cookie, target(asked.res) ?? "")).html);
      expect(said).toContain(NOTICE(who.name));
      expect(asked.html).not.toContain(`Remove ${who.name}?`);
      expect(await memberRow(who.memberId)).not.toBeNull();
      // A member who typed it gets the permission answer, with no word of protection.
      const typed = await page(clerk.cookie, `/team/remove/${who.memberId}`);
      expect(typed.res.status).toBe(303);
      const clerkSaid = text((await page(clerk.cookie, target(typed.res) ?? "")).html);
      expect(clerkSaid).toContain("You can no longer change the team.");
      expect(clerkSaid).not.toContain("protected");
    }
  });

  it("keeps both protected accounts through a real removal post, in an ordinary organisation and in Fynbos Freight, with the refusal recorded", async () => {
    const ordinary = await person("Owner");
    const ordinaryOrg = await organisation(ordinary);
    const fynbosOwner = await person("Fynbos Owner");
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Fynbos Freight', ?, ?)`)
      .bind(FYNBOS, `fynbos-freight-${tag()}`, new Date().toISOString())
      .run();
    await join(FYNBOS, fynbosOwner, "owner");
    for (const [reader, orgId] of [
      [ordinary, ordinaryOrg],
      [fynbosOwner, FYNBOS],
    ] as const) {
      for (const [email, name] of [
        ["demo@rizonetech.com", "Demo Account"],
        ["derick@rizonetech.com", "Derick Payne"],
      ] as const) {
        // A fresh member row for the account in this organisation (the same account may belong to both).
        const existing = await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
        const who = existing
          ? { id: existing.id, email, name, memberId: await join(orgId, existing, "member") }
          : await protectedMember(orgId, email, name);
        const res = await post(reader.cookie, { action: "remove", org: orgId, member: who.memberId });
        const said = text(await landed(reader.cookie, res));
        expect(said).toContain(NOTICE(name));
        expect(said).not.toContain("was removed");
        expect(await memberRow(who.memberId)).toEqual({ role: "member" });
        const recorded = await refused(orgId, who.id);
        expect(recorded.results.some((r) => r.kind === "remove-member" && r.actor_id === reader.id)).toBe(true);
        // The sessions of the account were not ended either.
        expect(await page(reader.cookie).then((p) => p.html)).toContain(name);
      }
    }
  });

  it("refuses a hand-made or stale post too: the same notice, the member kept", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const demo = await protectedMember(orgId, "demo@rizonetech.com", "Demo Account");
    // A page opened before the account was protected would still post the removal: the answer is the notice.
    const res = await post(owner.cookie, { action: "remove", org: orgId, member: demo.memberId });
    expect(text(await landed(owner.cookie, res))).toContain(NOTICE("Demo Account"));
    expect(await memberRow(demo.memberId)).toEqual({ role: "member" });
  });
});

describe("inviting several colleagues at once (D07 T04 §22)", () => {
  const stored = (orgId: string, email: string) =>
    db
      .prepare(`SELECT role, status FROM "invitation" WHERE "organizationId" = ? AND lower(email) = lower(?)`)
      .bind(orgId, email)
      .first<{ role: string; status: string }>();
  const send = (cookie: string, orgId: string, email: string, role = "member", batch = "") =>
    post(cookie, { action: "invite", org: orgId, email, role, ...(batch ? { batch } : {}) });

  it("invites ten with one submit, lists ten outcomes, and retries only the one that did not go", async () => {
    const owner = await person("Thandi Nkosi");
    const orgId = await organisation(owner);
    let calls = 0;
    const smtp = stubSmtp2go(() => (++calls === 3 ? "refused" : "sent"));
    const emails = Array.from({ length: 10 }, (_, i) => `bulk-${i}-${tag()}@example.com`);
    const res = await send(owner.cookie, orgId, emails.join("\n"));
    expect(res.status).toBe(200);
    const html = text(await res.text());
    for (const email of emails) expect(html).toContain(email);
    expect(html).toContain("Not sent");
    expect(html).toContain("Retry the ones that did not go");
    expect(smtp.sends.map((s) => s.to).sort()).toEqual(emails.filter((_, i) => i !== 2).sort());
    for (const email of emails) expect(await stored(orgId, email)).toMatchObject({ status: "pending" });
    // Retry: only the failed address is sent again.
    calls = 0;
    const beforeRetry = smtp.sends.length;
    const retry = await send(owner.cookie, orgId, emails[2] as string, "member", "1");
    expect(retry.status).toBe(200);
    expect(smtp.sends.slice(beforeRetry).map((s) => s.to)).toEqual([emails[2]]);
    expect(text(await retry.text())).toContain("Sent");
    smtp.restore();
  });

  it("refuses twenty-one without sending any, invites a duplicate once, and keeps a member out", async () => {
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    const smtp = stubSmtp2go();
    const many = Array.from({ length: 21 }, (_, i) => `many-${i}-${tag()}@example.com`).join(", ");
    const refused = await send(owner.cookie, orgId, many);
    expect(refused.status).toBe(400);
    expect(text(await refused.text())).toContain("Up to 20 addresses at a time");
    expect(smtp.sends).toEqual([]);
    const one = `dup-${tag()}@example.com`;
    const res = await send(owner.cookie, orgId, `${one}\n${one.toUpperCase()}`);
    expect(text(await res.text())).toContain("Listed twice, invited once");
    expect(smtp.sends.map((s) => s.to)).toEqual([one]);
    const member = await person("Member");
    await join(orgId, member, "member");
    expect((await send(member.cookie, orgId, `x-${tag()}@example.com\ny-${tag()}@example.com`)).status).toBe(403);
    smtp.restore();
  });
});

describe("inviting several: uncertain delivery (D07 T04 §22)", () => {
  it("names a lost answer Unknown from the stored delivery and keeps it out of Retry", async () => {
    const owner = await person("Thandi Nkosi");
    const orgId = await organisation(owner);
    let calls = 0;
    const smtp = stubSmtp2go(() => (++calls === 1 ? "silent" : "sent"));
    const lost = `lost-${tag()}@example.com`;
    const fine = `fine-${tag()}@example.com`;
    const res = await post(owner.cookie, { action: "invite", org: orgId, email: `${lost}\n${fine}`, role: "member" });
    expect(res.status).toBe(200);
    const html = text(await res.text());
    expect(html).toMatch(new RegExp(`${lost.replace(/[.]/g, "\\.")} : Unknown`));
    expect(html).toMatch(new RegExp(`${fine.replace(/[.]/g, "\\.")} : Sent`));
    expect(html).not.toContain("Retry the ones that did not go");
    smtp.restore();
  });
});
