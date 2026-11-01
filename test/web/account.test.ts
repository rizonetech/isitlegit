import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../../src/auth/auth";
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
    const now = new Date("2026-10-27T10:00:00.000Z");
    expect(activeText("2026-10-27T09:58:00.000Z", now)).toBe("Now");
    expect(activeText("2026-10-27T06:41:00.000Z", now)).toBe("Today 08:41");
    expect(activeText("2026-10-25T17:10:00.000Z", now)).toBe("Sun 25 Oct, 19:10");
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
    expect(t).toContain("Passkey 2");
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
    expect(landed.html).toMatch(/name="name"[^>]*value="Stored Name"/);
    expect(await stored(me.id)).toBe("Stored Name");
  });
});
