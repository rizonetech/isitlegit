import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
import { defaultPasskeyName } from "../../src/auth/names";
import { buttonClass } from "../../src/web/components/Button";
import { activeText, dateText, deviceOf } from "../../src/web/pages/settings-account-view";
import { authEnv, call, ORIGIN, signIn, target } from "../auth/helpers";

// The Account page (D07 T08 §3; board `Account`): the member's own name, email, passkeys and sessions from the stored
// rows, the name saved through Better Auth with its refusals, an account with no organisation, the empty states, and
// a read that fails as the retryable outage.
const db = (env as unknown as Env).DB;
afterEach(() => vi.restoreAllMocks());

const tag = () => crypto.randomUUID().slice(0, 8);
async function person(name: string) {
  const email = `acct-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const id = (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())
    ?.id as string;
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
const passkey = (userId: string, name: string | null, addedDaysAgo = 3, deviceType = "multiDevice") =>
  db
    .prepare(
      `INSERT INTO "passkey" (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", "createdAt") VALUES (?, ?, 'pk', ?, ?, 0, ?, 1, ?)`,
    )
    .bind(
      `pk-${tag()}`,
      name,
      userId,
      `cred-${tag()}${tag()}`,
      deviceType,
      new Date(Date.now() - addedDaysAgo * 86_400_000).toISOString(),
    )
    .run();
const session = async (userId: string, ua: string) => {
  const token = `tok-${tag()}${tag()}`;
  await db
    .prepare(
      `INSERT INTO "session" (id, "expiresAt", token, "createdAt", "updatedAt", "userAgent", "userId") VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `s-${tag()}`,
      new Date(Date.now() + 86_400_000).toISOString(),
      token,
      new Date(Date.now() - 86_400_000).toISOString(),
      new Date(Date.now() - 3_600_000).toISOString(),
      ua,
      userId,
    )
    .run();
  return token;
};
const page = async (cookie: string, path = "/settings/account") => {
  const res = await call(path, { headers: { cookie, accept: "text/html" } });
  return { res, html: await res.text() };
};
const post = (cookie: string, fields: Record<string, string>, origin: string | null = ORIGIN) => {
  const headers = new Headers({ cookie, "content-type": "application/x-www-form-urlencoded", accept: "text/html" });
  headers.set("origin", origin ?? "");
  return call("/settings/account", { method: "POST", headers, body: new URLSearchParams(fields).toString() });
};
const text = (h: string) =>
  h
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

const EDGE = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120";
const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17 Mobile Safari/604";
const CHROME = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

describe("the words", () => {
  it("names a device from its user agent without keeping the string, and words dates in SAST", () => {
    expect(deviceOf(EDGE)).toBe("Edge on Windows");
    expect(deviceOf(SAFARI)).toBe("Safari on iPhone");
    expect(deviceOf(CHROME)).toBe("Chrome on Android");
    expect(deviceOf(null)).toBe("Unknown device");
    expect(dateText("2026-10-12T08:00:00.000Z")).toBe("12 Oct 2026");
    // To the day: a session's timestamp is renewed at most once a day, so no time of day is claimed.
    const now = new Date("2026-10-27T10:00:00.000Z");
    expect(activeText("2026-10-27T09:58:00.000Z", now)).toBe("Today");
    expect(activeText("2026-10-27T06:41:00.000Z", now)).toBe("Today");
    expect(activeText("2026-10-26T17:10:00.000Z", now)).toBe("Yesterday");
    expect(activeText("2026-10-25T17:10:00.000Z", now)).toBe("Sun 25 Oct");
  });
});

describe("GET /settings/account", () => {
  it("sends no session to sign-in", async () => {
    const anon = await call("/settings/account", { headers: { accept: "text/html" } });
    expect(anon.status).toBe(303);
    expect(target(anon)).toBe(`/signin?next=${encodeURIComponent("/settings/account")}`);
  });

  it("draws the member's name, read-only email, passkeys and sessions, and nothing of anyone else's, no token", async () => {
    const me = await person("Thandi Nkosi");
    await organisation(me);
    await passkey(me.id, "Windows Hello on the office PC", 20);
    await passkey(me.id, null, 5, "singleDevice");
    const other = await session(me.id, SAFARI);
    const third = await session(me.id, CHROME);
    const stranger = await person("Stranger");
    await passkey(stranger.id, "Stranger's key");
    const strangerToken = await session(stranger.id, EDGE);
    const { res, html } = await page(me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const t = text(html);
    expect(t).toContain("Account");
    expect(html).toMatch(/<input[^>]*name="name"[^>]*value="Thandi Nkosi"/);
    // The email is text, never a field that posts.
    expect(html).not.toMatch(/<input[^>]*name="email"/);
    expect(t).toContain(me.email);
    expect(t).toContain("cannot be changed during the launch");
    expect(t).toContain("Windows Hello on the office PC");
    expect(t).toContain("Unnamed passkey");
    expect(t).toMatch(/Added \d+ \w+ 2026 · Syncs between devices/);
    expect(t).toContain("This device only");
    expect(t).toContain("Safari on iPhone");
    expect(t).toContain("Chrome on Android");
    expect(t).toContain("(this device)");
    expect(t).not.toContain("Stranger");
    // No session token reaches the page: not this one's, the others', nor anyone else's.
    for (const token of [other, third, strangerToken]) expect(html).not.toContain(token);
    const mine = await db
      .prepare(`SELECT token FROM "session" WHERE "userId" = ?`)
      .bind(me.id)
      .all<{ token: string }>();
    for (const row of mine.results) expect(html).not.toContain(row.token);
  });

  it("draws the empty states: no passkeys, and only this session", async () => {
    const me = await person("Solo");
    await organisation(me);
    const t = text((await page(me.cookie)).html);
    expect(t).toContain("No passkeys yet. You sign in with an email link.");
    expect(t).toContain("This is your only session.");
    await passkey(me.id, "One");
    await session(me.id, EDGE);
    const later = text((await page(me.cookie)).html);
    expect(later).not.toContain("No passkeys yet");
    expect(later).not.toContain("This is your only session");
  });

  it("opens in its own frame for a member with no organisation, and one whose active organisation was removed", async () => {
    const lone = await person("Lone");
    const bare = await page(lone.cookie);
    expect(bare.res.status).toBe(200);
    expect(text(bare.html)).toContain("Your sign-in details.");
    expect(bare.html).toMatch(/<a href="\/"[^>]*>\s*<img[^>]*alt="IsItLegit"/);
    const owner = await person("Owner");
    const orgId = await organisation(owner);
    await db.prepare(`DELETE FROM "member" WHERE "organizationId" = ?`).bind(orgId).run();
    await db.prepare(`DELETE FROM "organization" WHERE id = ?`).bind(orgId).run();
    const removed = await page(owner.cookie);
    expect(removed.res.status).toBe(200);
    expect(text(removed.html)).toContain("Your sign-in details.");
  });

  it("answers a read that fails as the retryable outage, then recovers", async () => {
    const me = await person("Outage");
    await organisation(me);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes(`FROM "passkey" WHERE`)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const down = await page(me.cookie);
    vi.restoreAllMocks();
    expect(down.res.status).toBe(503);
    expect(down.html).toContain('href="/settings/account"');
    expect(text(down.html)).not.toContain("No passkeys yet");
    const again = await page(me.cookie);
    expect(again.res.status).toBe(200);
    // The session read fails the same way.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes(`FROM "session" WHERE "userId"`)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const noSessions = await page(me.cookie);
    vi.restoreAllMocks();
    expect(noSessions.res.status).toBe(503);
    expect(noSessions.html).toContain('href="/settings/account"');
  });

  it("is reachable in one action from the no-access page a member with no organisation lands on", async () => {
    const lone = await person("No Org");
    const refusal = await call("/cases", { headers: { cookie: lone.cookie, accept: "text/html" } });
    expect(refusal.status).toBe(403);
    const html = await refusal.text();
    const account = /<a[^>]*href="([^"]+)"[^>]*>\s*Your account\s*<\/a>/.exec(html)?.[1];
    expect(account).toBe("/settings/account");
    expect((await page(lone.cookie, account as string)).res.status).toBe(200);
  });

  it("announces the saved result: the result is focusable and marked for the shared announcer", async () => {
    const me = await person("Announce");
    await organisation(me);
    const res = await post(me.cookie, { action: "name", name: "Announced" });
    const landed = await page(me.cookie, target(res) ?? "");
    expect(landed.html).toMatch(/id="account-outcome"[^>]*role="status"[^>]*/);
    expect(landed.html).toMatch(
      /id="account-outcome"[^>]*tabindex="-1"[^>]*data-announce|data-announce[^>]*tabindex="-1"/,
    );
  });
});

describe("saving the name", () => {
  const stored = async (id: string) =>
    (await db.prepare(`SELECT name FROM "user" WHERE id = ?`).bind(id).first<{ name: string }>())?.name;

  it("saves through Better Auth and says so, with the page showing the stored name", async () => {
    const me = await person("Before");
    await organisation(me);
    const res = await post(me.cookie, { action: "name", name: "  Thandi N.  " });
    expect(res.status).toBe(303);
    expect(await stored(me.id)).toBe("Thandi N.");
    const landed = await page(me.cookie, target(res) ?? "");
    expect(text(landed.html)).toContain("Name saved.");
    expect(landed.html).toMatch(/name="name"[^>]*value="Thandi N\."/);
  });

  it("refuses an empty, over-long or multi-line name under the field with what was typed kept, changing nothing", async () => {
    const me = await person("Keep Me");
    await organisation(me);
    for (const [typed, said] of [
      ["   ", "Enter your name."],
      ["x".repeat(101), "at most 100 characters"],
      ["two\\nlines".replace("\\n", "\n"), "one line"],
    ] as const) {
      const res = await post(me.cookie, { action: "name", name: typed });
      expect(res.status, JSON.stringify(typed)).toBe(400);
      const html = await res.text();
      expect(text(html)).toContain(said);
      expect(html).toContain('aria-invalid="true"');
      expect(await stored(me.id)).toBe("Keep Me");
    }
  });

  it("passes the name as typed to Better Auth's own rule: a leading line break is refused, not trimmed away", async () => {
    const me = await person("Rule Holder");
    await organisation(me);
    const res = await post(me.cookie, { action: "name", name: "\nAlice" });
    expect(res.status).toBe(400);
    expect(await stored(me.id)).toBe("Rule Holder");
  });

  it("changes nothing from another origin or no origin, or for a request the page does not send", async () => {
    const me = await person("Steady");
    await organisation(me);
    expect((await post(me.cookie, { action: "name", name: "Evil" }, "https://evil.example")).status).toBe(403);
    expect((await post(me.cookie, { action: "name", name: "Evil" }, null)).status).toBe(403);
    const odd = await post(me.cookie, { action: "email", name: "Evil" });
    expect(text(await (await page(me.cookie, target(odd) ?? "")).html)).toContain("not one this page sends");
    expect(await stored(me.id)).toBe("Steady");
  });

  it("says a save whose write fails could not be confirmed, over the stored name, never as saved", async () => {
    const me = await person("Stored Name");
    await organisation(me);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/update "user"/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const res = await post(me.cookie, { action: "name", name: "Lost Write" });
    vi.restoreAllMocks();
    expect(res.status).toBe(303);
    const landed = await page(me.cookie, target(res) ?? "");
    expect(text(landed.html)).toContain("could not be confirmed");
    expect(text(landed.html)).not.toContain("Name saved.");
    // What was typed is kept in the field for another try; the stored name is untouched.
    expect(landed.html).toMatch(/name="name"[^>]*value="Lost Write"/);
    expect(landed.html).toMatch(/id="account-outcome"[^>]*data-announce/);
    // The words say what is saved and what the field keeps, and never claim the typed name is stored.
    expect(text(landed.html)).toContain('Your saved name is still "Stored Name"');
    expect(text(landed.html)).not.toContain("as stored now");
    expect(await stored(me.id)).toBe("Stored Name");
  });
});

describe("removing a passkey and signing sessions out", () => {
  const confirm = async (cookie: string, path: string) => page(cookie, path);
  const act = (cookie: string, fields: Record<string, string>) => post(cookie, fields);
  const sessionsOf = async (userId: string) =>
    (
      await db.prepare(`SELECT id, token FROM "session" WHERE "userId" = ? ORDER BY "createdAt", id`).bind(userId).all<{
        id: string;
        token: string;
      }>()
    ).results;
  // Two or three real sessions for one member, each with its own cookie.
  async function sessionsFor(count: number) {
    const email = `acct-${tag()}@demo.isitlegit.co.za`;
    const cookies: string[] = [];
    for (let i = 0; i < count; i++) cookies.push((await signIn(email)).cookie);
    const id = (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())
      ?.id as string;
    await organisation({ id });
    return { cookies, userId: id, email };
  }
  const works = async (cookie: string) => (await page(cookie)).res.status === 200;

  it("asks first, says what stays, removes only after Remove, and Cancel keeps the passkey", async () => {
    const me = await person("Remover");
    await organisation(me);
    await passkey(me.id, "Office laptop");
    const key = (await db.prepare(`SELECT id FROM "passkey" WHERE "userId" = ?`).bind(me.id).first<{ id: string }>())
      ?.id as string;
    const list = (await page(me.cookie)).html;
    expect(list).toContain(`aria-label="Remove passkey Office laptop"`);
    const asked = await confirm(me.cookie, `/settings/account/passkeys/${key}/remove`);
    expect(asked.res.status).toBe(200);
    const t = text(asked.html);
    expect(t).toContain("Remove Office laptop?");
    expect(t).toContain("email link");
    expect(t).toContain("password manager");
    expect(t).toContain("Signed-in sessions are separate");
    // Cancel is a link back; nothing was removed by asking.
    expect(asked.html).toMatch(/<a[^>]*href="\/settings\/account"[^>]*>\s*Cancel/);
    expect(await db.prepare(`SELECT 1 FROM "passkey" WHERE id = ?`).bind(key).first()).not.toBeNull();
    const done = await act(me.cookie, { action: "remove-passkey", id: key });
    expect(text((await page(me.cookie, target(done) ?? "")).html)).toContain("Passkey removed.");
    expect(await db.prepare(`SELECT 1 FROM "passkey" WHERE id = ?`).bind(key).first()).toBeNull();
    expect(text((await page(me.cookie)).html)).toContain("No passkeys yet");
  });

  it("answers another member's passkey as no longer on the account, on the page and on the post, touching nothing", async () => {
    const me = await person("Me");
    await organisation(me);
    const other = await person("Other");
    await passkey(other.id, "Theirs");
    const theirs = (
      await db.prepare(`SELECT id FROM "passkey" WHERE "userId" = ?`).bind(other.id).first<{ id: string }>()
    )?.id as string;
    const asked = await confirm(me.cookie, `/settings/account/passkeys/${theirs}/remove`);
    expect(asked.res.status).toBe(303);
    expect(text((await page(me.cookie, target(asked.res) ?? "")).html)).toContain("no longer on your account");
    const posted = await act(me.cookie, { action: "remove-passkey", id: theirs });
    expect(text((await page(me.cookie, target(posted) ?? "")).html)).toContain("no longer on your account");
    expect(await db.prepare(`SELECT 1 FROM "passkey" WHERE id = ?`).bind(theirs).first()).not.toBeNull();
    expect(text((await page(me.cookie)).html)).not.toContain("Theirs");
  });

  it("says a removal that did not happen is not done, from the stored row, and an unreadable store as unresolved", async () => {
    const me = await person("Stuck");
    await organisation(me);
    await passkey(me.id, "Stays");
    const key = (await db.prepare(`SELECT id FROM "passkey" WHERE "userId" = ?`).bind(me.id).first<{ id: string }>())
      ?.id as string;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/delete from "passkey"/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const failed = await act(me.cookie, { action: "remove-passkey", id: key });
    vi.restoreAllMocks();
    const failedText = text((await page(me.cookie, target(failed) ?? "")).html);
    // Its own words and its own retry: not the name save's.
    expect(failedText).toContain(
      "That passkey was not removed: it is still on your account. Press Remove on it to try again.",
    );
    expect(failedText).not.toContain("press Save");
    expect(await db.prepare(`SELECT 1 FROM "passkey" WHERE id = ?`).bind(key).first()).not.toBeNull();
    // The store cannot be read back after the call: unresolved, never done and never "nothing changed".
    vi.spyOn(console, "log").mockImplementation(() => {});
    let reads = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes('FROM "passkey" WHERE id = ? AND "userId" = ?') && ++reads === 2)
        throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const lost = await act(me.cookie, { action: "remove-passkey", id: key });
    vi.restoreAllMocks();
    expect(text((await page(me.cookie, target(lost) ?? "")).html)).toContain("Reload this page");
  });

  it("signs one other session out, leaves this one, and refuses this device's own and another member's session by page and by post", async () => {
    const two = await sessionsFor(2);
    const [mine, theirs] = await sessionsOf(two.userId);
    const list = (await page(two.cookies[0] as string)).html;
    expect(list).toContain("Sign out Unknown device");
    // This device's own session: refused on the page and on the post, nothing revoked, no token shown.
    const own = await confirm(two.cookies[0] as string, `/settings/account/sessions/${mine?.id}/sign-out`);
    expect(own.res.status).toBe(303);
    expect(text((await page(two.cookies[0] as string, target(own.res) ?? "")).html)).toContain(
      "the session you are using",
    );
    const ownPost = await act(two.cookies[0] as string, { action: "sign-out-session", id: mine?.id as string });
    expect(text((await page(two.cookies[0] as string, target(ownPost) ?? "")).html)).toContain(
      "the session you are using",
    );
    expect(await works(two.cookies[0] as string)).toBe(true);
    // Another member's session: gone, still valid for them, nothing of it shown.
    const stranger = await sessionsFor(1);
    const [strangerSession] = await sessionsOf(stranger.userId);
    const foreign = await confirm(
      two.cookies[0] as string,
      `/settings/account/sessions/${strangerSession?.id}/sign-out`,
    );
    expect(text((await page(two.cookies[0] as string, target(foreign.res) ?? "")).html)).toContain(
      "no longer on your account",
    );
    const foreignPost = await act(two.cookies[0] as string, {
      action: "sign-out-session",
      id: strangerSession?.id as string,
    });
    expect(text((await page(two.cookies[0] as string, target(foreignPost) ?? "")).html)).toContain(
      "no longer on your account",
    );
    expect(await works(stranger.cookies[0] as string)).toBe(true);
    // The other of its own sessions: asked, then signed out; the cookie of it stops working, this one keeps working.
    const asked = await confirm(two.cookies[0] as string, `/settings/account/sessions/${theirs?.id}/sign-out`);
    expect(asked.res.status).toBe(200);
    expect(asked.html).not.toContain(theirs?.token ?? "no-token");
    expect(await works(two.cookies[1] as string)).toBe(true);
    const done = await act(two.cookies[0] as string, { action: "sign-out-session", id: theirs?.id as string });
    expect(text((await page(two.cookies[0] as string, target(done) ?? "")).html)).toContain(
      "That session was signed out.",
    );
    expect(await works(two.cookies[1] as string)).toBe(false);
    expect(await works(two.cookies[0] as string)).toBe(true);
  });

  it("signs every other session out, keeping this one, and Cancel leaves every session working", async () => {
    const three = await sessionsFor(3);
    const asked = await confirm(three.cookies[0] as string, "/settings/account/sessions/sign-out-others");
    expect(text(asked.html)).toContain("This device stays signed in");
    expect(await works(three.cookies[1] as string)).toBe(true);
    expect(await works(three.cookies[2] as string)).toBe(true);
    const done = await act(three.cookies[0] as string, { action: "sign-out-others", id: "others" });
    expect(text((await page(three.cookies[0] as string, target(done) ?? "")).html)).toContain(
      "Every other session was signed out.",
    );
    expect(await works(three.cookies[0] as string)).toBe(true);
    expect(await works(three.cookies[1] as string)).toBe(false);
    expect(await works(three.cookies[2] as string)).toBe(false);
  });

  it("says a partial sign-out as partial, from what is left", async () => {
    const three = await sessionsFor(3);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    // Better Auth ends the other sessions one by one: the second ending fails, the first stands.
    let deletes = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/^delete from "session" where "session"."token" = \?/i.test(sql) && ++deletes === 2)
        throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const done = await act(three.cookies[0] as string, { action: "sign-out-others", id: "others" });
    vi.restoreAllMocks();
    expect(text((await page(three.cookies[0] as string, target(done) ?? "")).html)).toContain("some are still open");
    const open = (await Promise.all([works(three.cookies[1] as string), works(three.cookies[2] as string)])).filter(
      Boolean,
    );
    expect(open).toHaveLength(1);
    // Signing out the rest again finishes it.
    const rest = await act(three.cookies[0] as string, { action: "sign-out-others", id: "others" });
    expect(text((await page(three.cookies[0] as string, target(rest) ?? "")).html)).toContain(
      "Every other session was signed out.",
    );
  });

  it("says a session still signed in after a failed sign-out, and no other session signed out when the call failed first", async () => {
    const three = await sessionsFor(3);
    const [mine, second] = await sessionsOf(three.userId);
    expect(mine).toBeDefined();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/^delete from "session" where "session"."token" = \?/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const one = await act(three.cookies[0] as string, { action: "sign-out-session", id: second?.id as string });
    const all = await act(three.cookies[0] as string, { action: "sign-out-others", id: "others" });
    vi.restoreAllMocks();
    const oneText = text((await page(three.cookies[0] as string, target(one) ?? "")).html);
    expect(oneText).toContain(
      "That session was not signed out: it is still signed in. Press Sign out on it to try again.",
    );
    expect(oneText).not.toContain("press Save");
    const allText = text((await page(three.cookies[0] as string, target(all) ?? "")).html);
    expect(allText).toContain("No other session was signed out; they are all still signed in.");
    expect(allText).not.toContain("Some sessions were signed out");
    expect(await works(three.cookies[1] as string)).toBe(true);
    expect(await works(three.cookies[2] as string)).toBe(true);
  });

  it("puts Sign out other sessions beside the passkey removal when there are other sessions, and focuses each confirmation's heading", async () => {
    const two = await sessionsFor(2);
    await passkey(two.userId, "Lost phone");
    const key = (
      await db.prepare(`SELECT id FROM "passkey" WHERE "userId" = ?`).bind(two.userId).first<{ id: string }>()
    )?.id as string;
    const asked = await confirm(two.cookies[0] as string, `/settings/account/passkeys/${key}/remove`);
    expect(asked.html).toMatch(
      /<a[^>]*href="\/settings\/account\/sessions\/sign-out-others"[^>]*>\s*Sign out other sessions/,
    );
    expect(asked.html).toMatch(/<h1[^>]*id="confirm-title"[^>]*data-announce/);
    expect(asked.html).toMatch(/<h1[^>]*tabindex="-1"/);
    // With no other session there is nothing to offer.
    const solo = await person("Solo Keys");
    await organisation(solo);
    await passkey(solo.id, "Only phone");
    const soloKey = (
      await db.prepare(`SELECT id FROM "passkey" WHERE "userId" = ?`).bind(solo.id).first<{ id: string }>()
    )?.id as string;
    const soloAsked = await confirm(solo.cookie, `/settings/account/passkeys/${soloKey}/remove`);
    expect(soloAsked.html).not.toContain("sign-out-others");
    // The list's controls: Remove is the destructive treatment, and Sign out other sessions sits by the sessions heading.
    const list = (await page(two.cookies[0] as string)).html;
    expect(list).toContain(`aria-label="Remove passkey Lost phone" class="${buttonClass("danger", "small")}"`);
    expect(list.indexOf("sign-out-others")).toBeGreaterThan(list.indexOf('id="sessions-heading"') - 400);
    expect(list.indexOf("sign-out-others")).toBeLessThan(list.indexOf("<tbody", list.indexOf('id="sessions-heading"')));
  });

  it("counts a session opened elsewhere during a sign-out as new, not as one left behind", async () => {
    const two = await sessionsFor(2);
    const prepare = db.prepare.bind(db);
    let selects = 0;
    // The list read back after the sign-out also holds a session that was not there before (a sign-in elsewhere).
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (
        /^SELECT id FROM "session" WHERE "userId" = \? AND id <> \? AND "expiresAt" > \?$/.test(sql) &&
        ++selects === 2
      )
        return prepare(`${sql} UNION ALL SELECT 'session-opened-meanwhile'`);
      return prepare(sql);
    });
    const done = await act(two.cookies[0] as string, { action: "sign-out-others", id: "others" });
    vi.restoreAllMocks();
    const said = text((await page(two.cookies[0] as string, target(done) ?? "")).html);
    expect(said).toContain("Every other session was signed out.");
    expect(said).not.toContain("No other session was signed out");
    expect(await works(two.cookies[1] as string)).toBe(false);
  });
});

describe("adding and renaming a passkey", () => {
  const act = (cookie: string, fields: Record<string, string>) => post(cookie, fields);
  const keyOf = async (userId: string) =>
    (
      await db
        .prepare(`SELECT id FROM "passkey" WHERE "userId" = ? ORDER BY "createdAt" DESC`)
        .bind(userId)
        .first<{ id: string }>()
    )?.id as string;
  const nameOf = async (id: string) =>
    (await db.prepare(`SELECT name FROM "passkey" WHERE id = ?`).bind(id).first<{ name: string | null }>())?.name;
  // A statement that runs for real and then fails, so the change is committed and its answer is lost.
  function failAfterCommit(match: RegExp) {
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (!match.test(sql)) return statement;
      const lose = (bound: D1PreparedStatement) =>
        new Proxy(bound, {
          get(inner, key) {
            const value = Reflect.get(inner, key);
            if (key === "run" || key === "all" || key === "first" || key === "raw")
              return async (...args: unknown[]) => {
                await (value as (...a: unknown[]) => unknown).apply(inner, args);
                throw new Error("D1_ERROR: answer lost");
              };
            return typeof value === "function" ? value.bind(inner) : value;
          },
        });
      return new Proxy(statement, {
        get(inner, key) {
          if (key === "bind") return (...binds: unknown[]) => lose(inner.bind(...binds));
          const value = Reflect.get(inner, key);
          return typeof value === "function" ? value.bind(inner) : value;
        },
      });
    });
  }

  it("draws Add a passkey (revealed by the script) and a Rename for each passkey, named for the passkey", async () => {
    const me = await person("Adder");
    await organisation(me);
    await passkey(me.id, "Office laptop");
    const key = await keyOf(me.id);
    const { html } = await page(me.cookie);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*hidden[^>]*data-passkey-add/);
    // The primary action beside the Passkeys heading, as the board has it.
    expect(html).toContain(`class="${buttonClass("primary", "small")}">\n`.replace("\n", ""));
    expect(html.indexOf("data-passkey-add")).toBeGreaterThan(html.indexOf('id="passkeys-heading"'));
    expect(html.indexOf("data-passkey-add")).toBeLessThan(html.indexOf("Sign in with your fingerprint"));
    expect(html).toContain("data-passkey-add-status");
    expect(text(html)).toContain("Adding a passkey needs a browser that supports passkeys");
    expect(html).toContain(`aria-label="Rename passkey Office laptop"`);
    expect(html).toContain(`/settings/account/passkeys/${key}/rename"`);
  });

  it("asks for a name, leaves it unchanged on Cancel, and stores the trimmed name on Save", async () => {
    const me = await person("Renamer");
    await organisation(me);
    await passkey(me.id, "Old name");
    const key = await keyOf(me.id);
    const asked = await page(me.cookie, `/settings/account/passkeys/${key}/rename`);
    expect(asked.res.status).toBe(200);
    expect(text(asked.html)).toContain("Rename passkey");
    expect(asked.html).toContain('value="Old name"');
    // A rename whose answer never comes can be looked at on the Account page, which lists the stored names.
    expect(asked.html).toMatch(/<form[^>]*data-busy-check="\/settings\/account"/);
    expect(asked.html).toMatch(/<a[^>]*href="\/settings\/account"[^>]*>\s*Cancel/);
    expect(await nameOf(key)).toBe("Old name");
    const done = await act(me.cookie, { action: "rename-passkey", id: key, name: "  Work laptop  " });
    expect(done.status).toBe(303);
    const after = await page(me.cookie, target(done) ?? "");
    expect(text(after.html)).toContain("Passkey renamed.");
    expect(text(after.html)).toContain("Work laptop");
    expect(await nameOf(key)).toBe("Work laptop");
  });

  it("names a passkey just added: the page says so, and keeping the name goes back without a change", async () => {
    const me = await person("Just Added");
    await organisation(me);
    await passkey(me.id, null);
    const key = await keyOf(me.id);
    const { html } = await page(me.cookie, `/settings/account/passkeys/${key}/rename?added=1`);
    expect(text(html)).toContain("Name your new passkey");
    expect(text(html)).toContain("Passkey added.");
    expect(html).toMatch(/<a[^>]*href="\/settings\/account"[^>]*>\s*Keep this name/);
    expect(html).toMatch(/<h1[^>]*id="rename-title"[^>]*data-announce/);
  });

  it("refuses an empty, over-long or multi-line name under the field, keeping what was typed and the stored name", async () => {
    const me = await person("Refuser");
    await organisation(me);
    await passkey(me.id, "Kept");
    const key = await keyOf(me.id);
    for (const [typed, said] of [
      ["   ", "Enter a name for this passkey."],
      ["x".repeat(101), "A name is one line of at most 100 characters."],
      ["two\nlines", "A name is one line of at most 100 characters."],
    ] as const) {
      const res = await act(me.cookie, { action: "rename-passkey", id: key, name: typed });
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain(`id="passkey-name-error"`);
      // The invalid field takes the focus, not the heading (the first announced element wins).
      expect(html).not.toMatch(/<h1[^>]*id="rename-title"[^>]*data-announce/);
      expect(html).toMatch(/<input[^>]*id="passkey-name"[^>]*aria-invalid="true"/);
      expect(html).toMatch(/<input[^>]*id="passkey-name"[^>]*aria-describedby="[^"]*passkey-name-error/);
      expect(text(html)).toContain(said);
      expect(await nameOf(key)).toBe("Kept");
    }
  });

  it("answers another member's passkey, and one that is gone, as no longer on the account, by page and by post", async () => {
    const me = await person("Me");
    await organisation(me);
    const other = await person("Other");
    await passkey(other.id, "Theirs");
    const theirs = await keyOf(other.id);
    for (const id of [theirs, "pk-missing"]) {
      const asked = await page(me.cookie, `/settings/account/passkeys/${id}/rename`);
      expect(asked.res.status).toBe(303);
      expect(text((await page(me.cookie, target(asked.res) ?? "")).html)).toContain("no longer on your account");
      const posted = await act(me.cookie, { action: "rename-passkey", id, name: "Taken" });
      expect(text((await page(me.cookie, target(posted) ?? "")).html)).toContain("no longer on your account");
    }
    expect(await nameOf(theirs)).toBe("Theirs");
    // Signed out, the page and the post go to sign-in.
    const anon = await call(`/settings/account/passkeys/${theirs}/rename`, { headers: { accept: "text/html" } });
    expect(target(anon)).toMatch(/^\/signin/);
  });

  it("holds the name rule at Better Auth too: a direct update with a bad name is refused and changes nothing", async () => {
    const me = await person("Direct");
    await passkey(me.id, "Stays");
    const key = await keyOf(me.id);
    for (const name of ["", "x".repeat(101), "a\nb"]) {
      const res = await call("/api/auth/passkey/update-passkey", {
        method: "POST",
        headers: { cookie: me.cookie, "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ id: key, name }),
      });
      expect(res.status).toBe(400);
      expect(await nameOf(key)).toBe("Stays");
    }
  });

  it("tells a rename whose answer was lost from the stored name: committed is renamed, not committed is still the old name", async () => {
    const me = await person("Lost Answer");
    await organisation(me);
    await passkey(me.id, "Before");
    const key = await keyOf(me.id);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    failAfterCommit(/^update "passkey"/i);
    const committed = await act(me.cookie, { action: "rename-passkey", id: key, name: "After" });
    vi.restoreAllMocks();
    expect(await nameOf(key)).toBe("After");
    const done = text((await page(me.cookie, target(committed) ?? "")).html);
    expect(done).toContain("Passkey renamed.");
    // Not committed: the statement never ran.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/^update "passkey"/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const failed = await act(me.cookie, { action: "rename-passkey", id: key, name: "Never" });
    vi.restoreAllMocks();
    const still = text((await page(me.cookie, target(failed) ?? "")).html);
    expect(still).toContain(
      'That passkey was not renamed: it is still named "After". Press Rename on it to try again.',
    );
    expect(await nameOf(key)).toBe("After");
  });

  it("says an unreadable stored name as unresolved, never as renamed or unchanged", async () => {
    const me = await person("Unreadable");
    await organisation(me);
    await passkey(me.id, "Seen");
    const key = await keyOf(me.id);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    let reads = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      // The check before the change passes; the read after it cannot be made.
      if (sql.includes('FROM "passkey" WHERE id = ? AND "userId" = ?') && ++reads === 2)
        throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const res = await act(me.cookie, { action: "rename-passkey", id: key, name: "Changed" });
    vi.restoreAllMocks();
    expect(text((await page(me.cookie, target(res) ?? "")).html)).toContain("Reload this page");
  });

  const credOf = async (id: string) =>
    (await db.prepare(`SELECT "credentialID" AS c FROM "passkey" WHERE id = ?`).bind(id).first<{ c: string }>())
      ?.c as string;

  it("reads back an add whose answer was lost by the credential the device made, never by what else is new", async () => {
    const me = await person("Reconciler");
    await organisation(me);
    await passkey(me.id, "Earlier", 5);
    const earlier = await keyOf(me.id);
    // The add: its response was sent and its answer never came; the page was opened on the credential it had made.
    const attempted = "attempted-credential-id";
    const none = await page(me.cookie, `/settings/account?reconcile=add&cred=${attempted}`);
    expect(text(none.html)).toContain("No passkey was added: nothing was saved. Press Add a passkey to try again.");
    // Saved, but another passkey was added meanwhile on another device: the attempted one is named, not the newest.
    await db
      .prepare(
        `INSERT INTO "passkey" (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", "createdAt") VALUES ('pk-attempted', NULL, 'pk', ?, ?, 0, 'singleDevice', 0, ?)`,
      )
      .bind(me.id, attempted, new Date(Date.now() - 60_000).toISOString())
      .run();
    await passkey(me.id, "Phone added meanwhile", 0);
    const found = await page(me.cookie, `/settings/account?reconcile=add&cred=${attempted}`);
    expect(text(found.html)).toContain("Your passkey was saved, but we did not get the answer.");
    expect(found.html).toContain(`href="/settings/account/passkeys/pk-attempted/rename?added=1"`);
    expect(found.html).not.toContain(`/passkeys/${await keyOf(me.id)}/rename?added=1`);
    // A credential that is not stored says nothing was added even though other passkeys are new.
    const missing = await page(me.cookie, "/settings/account?reconcile=add&cred=never-made");
    expect(text(missing.html)).toContain("No passkey was added: nothing was saved.");
    // Another member's credential is nothing here, and a malformed one is no read back at all.
    const other = await person("Other");
    await passkey(other.id, "Theirs");
    const theirs = await credOf(await keyOf(other.id));
    expect(text((await page(me.cookie, `/settings/account?reconcile=add&cred=${theirs}`)).html)).toContain(
      "No passkey was added",
    );
    expect(text((await page(me.cookie, "/settings/account?reconcile=add&cred=a%20b")).html)).not.toContain(
      "No passkey was added",
    );
    // Reading the page registers nothing.
    expect(
      await db.prepare(`SELECT COUNT(*) AS n FROM "passkey" WHERE "userId" = ?`).bind(me.id).first<{ n: number }>(),
    ).toEqual({ n: 3 });
    expect(earlier).toBeDefined();
  });

  it("keeps the read back through an outage: Try again opens the same read back and finds the passkey", async () => {
    const me = await person("Outage Retry");
    await organisation(me);
    await db
      .prepare(
        `INSERT INTO "passkey" (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", "createdAt") VALUES ('pk-saved', NULL, 'pk', ?, 'saved-cred', 0, 'singleDevice', 0, ?)`,
      )
      .bind(me.id, new Date().toISOString())
      .run();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.includes('FROM "passkey" WHERE "userId" = ?')) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const down = await page(me.cookie, "/settings/account?reconcile=add&cred=saved-cred");
    vi.restoreAllMocks();
    expect(down.res.status).toBe(503);
    expect(text(down.html)).not.toContain("No passkey was added");
    const retry = /href="([^"]*reconcile=add[^"]*)"/.exec(down.html)?.[1]?.replace(/&amp;/g, "&");
    expect(retry).toBe("/settings/account?reconcile=add&cred=saved-cred");
    const again = await page(me.cookie, retry ?? "");
    expect(again.res.status).toBe(200);
    expect(again.html).toContain(`/settings/account/passkeys/pk-saved/rename?added=1`);
  });

  it("keeps the read back through an outage of the session lookup too", async () => {
    const me = await person("Gate Outage");
    await organisation(me);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/from "session"/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const down = await page(me.cookie, "/settings/account?reconcile=add&cred=saved-cred");
    vi.restoreAllMocks();
    expect(down.res.status).toBe(503);
    const retry = /href="([^"]*reconcile=add[^"]*)"/.exec(down.html)?.[1]?.replace(/&amp;/g, "&");
    expect(retry).toBe("/settings/account?reconcile=add&cred=saved-cred");
    // The plain page keeps the plain retry.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/from "session"/i.test(sql)) throw new Error("D1_ERROR: down");
      return prepare(sql);
    });
    const plain = await page(me.cookie);
    vi.restoreAllMocks();
    expect(plain.html).toContain('href="/settings/account"');
    expect(plain.html).not.toContain("reconcile=add");
  });

  it("names a passkey registered without a name for the day it was added, in South African time", () => {
    expect(defaultPasskeyName(new Date("2026-11-01T22:30:00.000Z"))).toBe("Passkey added 2 Nov 2026");
    expect(defaultPasskeyName(new Date("2026-11-01T10:00:00.000Z"))).toBe("Passkey added 1 Nov 2026");
  });
});
