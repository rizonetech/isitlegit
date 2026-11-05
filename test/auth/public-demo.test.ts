import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PROTECTED_ORGANISATIONS } from "../../src/auth/protected";
import { call, sessionCookie } from "./helpers";

const db = (env as unknown as Env).DB;
const start = (body: object = { consent: true }, origin = "http://localhost") =>
  call("/api/auth/sign-in/public-demo", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });

describe("public Fynbos demo", () => {
  it("requires consent and refuses an unrelated origin", async () => {
    expect((await start({ consent: false })).status).toBe(400);
    expect((await start({ consent: true }, "https://evil.example")).status).toBe(403);
  });
  it("fails closed when the fixed demo organisation is absent", async () => {
    expect((await start()).status).toBe(503);
  });
  it("creates a fresh demo-only identity and session without exposing protected users", async () => {
    const org = PROTECTED_ORGANISATIONS[0];
    await db
      .prepare('INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)')
      .bind(org, "Fynbos Freight", "fynbos-public-test", Date.now())
      .run();
    const first = await start();
    expect(first.status).toBe(200);
    const cookie = sessionCookie(first);
    expect(cookie).toBeTruthy();
    const session = (await (await call("/api/auth/get-session", { headers: { cookie } })).json()) as {
      user: { id: string; email: string };
      session: { activeOrganizationId: string };
    };
    expect(session.user.email).toMatch(/^public-demo-[a-f0-9-]+@example\.invalid$/);
    expect(session.session.activeOrganizationId).toBe(org);
    const rows = await db
      .prepare('SELECT "organizationId", role FROM member WHERE "userId" = ?')
      .bind(session.user.id)
      .all();
    expect(rows.results).toEqual([{ organizationId: org, role: "owner" }]);
    const second = await start();
    const secondSession = (await (
      await call("/api/auth/get-session", { headers: { cookie: sessionCookie(second) } })
    ).json()) as { user: { id: string } };
    expect(secondSession.user.id).not.toBe(session.user.id);
    const cases = await call("/cases", { headers: { cookie } });
    expect(cases.status).toBe(200);
    expect(await cases.text()).toContain("Public Fynbos demo.");
    const entry = await call("/demo");
    expect(entry.status).toBe(303);
    expect(entry.headers.get("location")).toBe("/cases");
    expect(sessionCookie(entry)).toBeTruthy();
    expect(entry.headers.get("cache-control")).toBe("private, no-store");
    expect((await call("/upload", { headers: { cookie } })).status).toBe(200);
    expect((await start({ consent: true, userId: "operator", organizationId: "other" })).status).toBe(400);
    await db
      .prepare("UPDATE rate_limits SET count = 100, window_start = ? WHERE key = 'public-demo-global'")
      .bind(Math.floor(Date.now() / 1000))
      .run();
    expect((await start()).status).toBe(429);
    await db
      .prepare("UPDATE rate_limits SET window_start = ? WHERE key = 'public-demo-global'")
      .bind(Math.floor(Date.now() / 1000) - 601)
      .run();
    expect((await start()).status).toBe(200);
  });
});
