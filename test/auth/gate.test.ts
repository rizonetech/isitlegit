import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type GateEnv, requireSession } from "../../src/auth/gate";
import { authEnv, call, ORIGIN, sessionCookie, signIn, target } from "./helpers";

// D07 T02 §1: the session gate member pages use, and the browser sign-out route.
const db = (env as unknown as Env).DB;

// A member page mounted for the test behind the gate.
const app = new Hono<GateEnv>();
app.use("/probe", requireSession);
app.get("/probe", (c) => c.json({ email: c.get("signedIn").user.email }));
const page = (cookie: string, accept = "text/html", path = "/probe?x=1") =>
  app.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie, accept } }), authEnv);

const sessionOf = (cookie: string) => {
  const raw = decodeURIComponent(cookie.split("=").slice(1).join("="));
  return raw.split(".")[0] as string;
};
const expiryOf = async (cookie: string) =>
  (
    await db
      .prepare(`SELECT "expiresAt" AS at FROM "session" WHERE token = ?`)
      .bind(sessionOf(cookie))
      .first<{ at: string }>()
  )?.at;

describe("requireSession", () => {
  it("lets a signed-in request through with its user", async () => {
    const { cookie } = await signIn("gate@example.com");
    const through = await page(cookie);
    expect(through.status).toBe(200);
    expect(await through.json()).toEqual({ email: "gate@example.com" });
  });

  it("renews a session past its update age, in D1 and on the response's cookie", async () => {
    const { cookie } = await signIn("renew@example.com");
    // Two days into a seven-day session: past Better Auth's one-day update age.
    const aged = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await db.prepare(`UPDATE "session" SET "expiresAt" = ? WHERE token = ?`).bind(aged, sessionOf(cookie)).run();
    const renewed = await page(cookie);
    expect(renewed.status).toBe(200);
    expect(new Date((await expiryOf(cookie)) as string).getTime()).toBeGreaterThan(new Date(aged).getTime());
    expect(renewed.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);
  });

  it("refuses an expired session", async () => {
    const { cookie } = await signIn("expired@example.com");
    await db
      .prepare(`UPDATE "session" SET "expiresAt" = ? WHERE token = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString(), sessionOf(cookie))
      .run();
    const refused = await page(cookie, "application/json");
    expect(refused.status).toBe(401);
  });

  it("sends an anonymous page request to /signin with next, and answers anything else 401", async () => {
    const browser = await page("", "text/html,application/xhtml+xml");
    expect(browser.status).toBe(303);
    expect(browser.headers.get("location")).toBe("/signin?next=%2Fprobe%3Fx%3D1");
    const api = await page("", "application/json");
    expect(api.status).toBe(401);
    expect(api.headers.get("cache-control")).toBe("no-store");
  });

  it("drops a next that is not a same-site path", async () => {
    // Every path behind the gate, so a request whose path reads as protocol-relative reaches it.
    const anywhere = new Hono<GateEnv>();
    anywhere.use("*", requireSession);
    anywhere.get("*", (c) => c.text("in"));
    const reach = (path: string) =>
      anywhere.fetch(new Request(`${ORIGIN}${path}`, { headers: { accept: "text/html" } }), authEnv);
    expect((await reach("/cases?verdict=bad")).headers.get("location")).toBe("/signin?next=%2Fcases%3Fverdict%3Dbad");
    expect((await reach("//evil.example/x")).headers.get("location")).toBe("/signin");
  });
});

describe("POST /auth/sign-out", () => {
  const signOut = (cookie: string, origin = ORIGIN) =>
    call("/auth/sign-out", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });

  it("ends the session, clears the cookie and goes to /signin", async () => {
    const { cookie } = await signIn("leaving@example.com");
    const out = await signOut(cookie);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/signin");
    const cleared = out.headers.getSetCookie().find((c) => c.includes("session_token")) ?? "";
    expect(cleared).toMatch(/Max-Age=0/i);
    const row = await db.prepare(`SELECT 1 FROM "session" WHERE token = ?`).bind(sessionOf(cookie)).first();
    expect(row).toBeNull();
    // The old cookie no longer gets through the gate.
    expect(target(await page(cookie))).toMatch(/^\/signin/);
    // Posting again, with no session, still lands on /signin.
    const again = await signOut(cookie);
    expect([again.status, again.headers.get("location")]).toEqual([303, "/signin"]);
  });

  it("answers 503 and keeps the cookie when the session is not deleted, then finishes on a retry", async () => {
    const { cookie } = await signIn("stuck@example.com");
    // D1 failing the session delete, as a lost connection would; every other statement runs.
    const failingDeletes = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            /^delete from "session"/i.test(sql)
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
    const stuck = await call(
      "/auth/sign-out",
      { method: "POST", headers: { cookie, origin: ORIGIN } },
      { ...authEnv, DB: failingDeletes },
    );
    expect(stuck.status).toBe(503);
    expect(await stuck.text()).toMatch(/did not finish/);
    expect(stuck.headers.getSetCookie()).toEqual([]);
    // Still signed in, and told so: not a sign-out that only looked done.
    expect((await page(cookie)).status).toBe(200);
    const retried = await signOut(cookie);
    expect([retried.status, retried.headers.get("location")]).toEqual([303, "/signin"]);
    expect(await db.prepare(`SELECT 1 FROM "session" WHERE token = ?`).bind(sessionOf(cookie)).first()).toBeNull();
  });

  it("refuses a post from another origin and leaves the session", async () => {
    const { cookie } = await signIn("stays@example.com");
    const refused = await signOut(cookie, "https://evil.example");
    expect(refused.status).toBe(403);
    expect((await page(cookie)).status).toBe(200);
    expect(sessionCookie(refused)).toBe("");
  });
});
