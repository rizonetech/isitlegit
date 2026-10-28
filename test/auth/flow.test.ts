import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { authOptions } from "../../src/auth/auth";
import { authEnv, call, pathOf, requestLink, sessionCookie, signIn, stubSmtp2go, target } from "./helpers";

// D07 T02 §1: signing in end to end through the Worker's own fetch: the link requested, sent through SMTP2GO, redeemed
// over HTTP, and the session read back from D1.
const db = (env as unknown as Env).DB;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("magic-link sign-in through the Worker", () => {
  it("sends a link, signs in with it, and returns to the page asked for", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const asked = await requestLink("Member@Example.com", "/cases?verdict=bad");
    expect(asked.status).toBe(200);
    expect(smtp.sends).toHaveLength(1);
    const sent = smtp.sends[0] as { to: string; link: string; text: string };
    // To the address as typed; the account is the address in lower case.
    expect(sent.to).toBe("Member@Example.com");
    expect(sent.text).toMatch(/for 15 minutes/);
    // The link is stored to expire 15 minutes from now.
    const stored = await db
      .prepare(`SELECT "expiresAt" AS at FROM "verification" ORDER BY "createdAt" DESC`)
      .first<{ at: string }>();
    const lifetime = new Date(stored?.at as string).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);
    const redeemed = await call(pathOf(sent.link));
    expect(redeemed.status).toBe(302);
    expect(target(redeemed)).toBe("/cases?verdict=bad");
    const cookie = sessionCookie(redeemed);
    expect(cookie).toMatch(/session_token=/);
    // The user and the session, in D1.
    const user = await db
      .prepare(`SELECT id FROM "user" WHERE lower(email) = ?`)
      .bind("member@example.com")
      .first<{ id: string }>();
    expect(user).not.toBeNull();
    const sessions = await db
      .prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`)
      .bind(user?.id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(1);
    // The cookie is a session Better Auth knows.
    const read = await call("/api/auth/get-session", { headers: { cookie } });
    expect(((await read.json()) as { user?: { email: string } } | null)?.user?.email).toBe("member@example.com");
  });

  it("returns to /cases when no destination was asked for", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("nowhere@example.com");
    expect(target(await call(pathOf(smtp.sends[0]?.link ?? "")))).toBe("/cases");
  });

  it("refuses a destination off this site, before any mail goes", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    // Refused by Better Auth's own origin check (403) or by the same-site rule (400).
    for (const callbackURL of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)"])
      expect([400, 403], callbackURL).toContain((await requestLink("member@example.com", callbackURL)).status);
    // Even the app's own origin written out: a destination is a path, which Better Auth's origin check alone allows.
    expect((await requestLink("member@example.com", "http://localhost/cases")).status).toBe(400);
    expect(smtp.sends).toEqual([]);
  });

  it("refuses a used link and an expired one", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("used@example.com");
    const link = pathOf(smtp.sends[0]?.link ?? "");
    expect(sessionCookie(await call(link))).toMatch(/session_token=/);
    // The second time: no session, and to sign-in with the destination kept and the reason, to ask for a new link.
    const again = await call(link);
    expect(sessionCookie(again)).toBe("");
    expect(target(again)).toBe("/signin?next=%2Fcases&error=INVALID_TOKEN");
    // A link past its 15 minutes.
    await requestLink("late@example.com");
    await db
      .prepare(`UPDATE "verification" SET "expiresAt" = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();
    const late = await call(pathOf(smtp.sends[1]?.link ?? ""));
    expect(sessionCookie(late)).toBe("");
    expect(target(late)).toBe("/signin?next=%2Fcases&error=INVALID_TOKEN");
  });

  it("sends a failed link for a page back to sign-in with that page kept", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("keep@example.com", "/cases/42?tab=evidence");
    const link = pathOf(smtp.sends[0]?.link ?? "");
    await call(link);
    expect(target(await call(link))).toBe("/signin?next=%2Fcases%2F42%3Ftab%3Devidence&error=INVALID_TOKEN");
  });

  it("sets the failure and new-user paths itself, and refuses an edited link that leaves the site", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const asked = await call("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "fresh@example.com",
        callbackURL: "/cases",
        errorCallbackURL: "http://localhost/elsewhere",
        newUserCallbackURL: "/welcome",
      }),
    });
    expect(asked.status).toBe(200);
    const link = new URL(smtp.sends[0]?.link ?? "");
    expect(link.searchParams.get("errorCallbackURL")).toBe("/signin?next=%2Fcases");
    expect(link.searchParams.get("newUserCallbackURL")).toBe("/cases");
    // Edited to fail toward another site: refused, and the link is still good.
    for (const name of ["errorCallbackURL", "newUserCallbackURL", "callbackURL"]) {
      for (const value of ["//evil.example/x", "https://evil.example/", "http://localhost/elsewhere"]) {
        const edited = new URL(link);
        edited.searchParams.set(name, value);
        const refused = await call(`${edited.pathname}${edited.search}`);
        // Better Auth's origin check answers 403 for another site; a full URL even on this one is not a path (400).
        expect(value.startsWith("http://localhost") ? [400] : [400, 403], `${name}=${value}`).toContain(refused.status);
        expect(sessionCookie(refused), name).toBe("");
      }
    }
    // A new member lands where the link was asked for, not on a page the client named.
    expect(target(await call(`${link.pathname}${link.search}`))).toBe("/cases");
  });

  it("stores a link's token only as its hash", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("hashed@example.com");
    const token = new URL(smtp.sends[0]?.link ?? "").searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(20);
    const rows = await db
      .prepare(`SELECT identifier, value FROM "verification"`)
      .all<{ identifier: string; value: string }>();
    for (const row of rows.results) expect(`${row.identifier} ${row.value}`).not.toContain(token);
  });

  it("keeps outstanding links across a new secret, and voids them only by deleting their records", async () => {
    // Signed in first: signIn stubs SMTP2GO itself, and restoring that stub would remove this test's.
    const { cookie } = await signIn("rotate@example.com");
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("rotate@example.com");
    await requestLink("rotate@example.com");
    const [kept, voided] = smtp.sends.slice(-2).map((s) => pathOf(s.link));
    const rotated = { ...authEnv, BETTER_AUTH_SECRET: "a-new-secret-0123456789abcdef-0123456789" };
    // The new secret refuses the session it did not sign: the member is signed out.
    expect(
      (await call("/api/auth/get-session", { headers: { cookie } }, rotated).then((r) => r.json())) ?? null,
    ).toBeNull();
    // A link sent before it still signs in.
    const keptAnswer = await call(kept as string, {}, rotated);
    expect([keptAnswer.status, target(keptAnswer)]).toEqual([302, "/cases"]);
    expect(sessionCookie(keptAnswer)).toMatch(/session_token=/);
    // Deleting the outstanding link records (docs/operations.md) voids the rest.
    await db.prepare(`DELETE FROM "verification" WHERE identifier LIKE 'magic-link:%'`).run();
    const late = await call(voided as string, {}, rotated);
    expect(sessionCookie(late)).toBe("");
    expect(target(late)).toBe("/signin?next=%2Fcases&error=INVALID_TOKEN");
  });

  it("sends a new, usable link for each request, under its own send key", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("twice@example.com");
    await requestLink("twice@example.com");
    expect(smtp.sends).toHaveLength(2);
    expect(smtp.sends[0]?.link).not.toBe(smtp.sends[1]?.link);
    const keys = await db
      .prepare(`SELECT send_key FROM mail_sends WHERE kind = 'signin' ORDER BY created_at`)
      .all<{ send_key: string }>();
    const twice = keys.results.slice(-2).map((r) => r.send_key);
    expect(new Set(twice).size).toBe(2);
    for (const key of twice) expect(key).toMatch(/^signin:[0-9a-f]{64}$/);
    expect(sessionCookie(await call(pathOf(smtp.sends[1]?.link ?? "")))).toMatch(/session_token=/);
  });

  it("answers an error, never 'check your email', when the link does not go", async () => {
    for (const answer of ["refused", "silent"] as const) {
      const smtp = stubSmtp2go(() => answer);
      try {
        const asked = await requestLink(`${answer}@example.com`);
        expect(asked.status, answer).toBe(502);
        expect(await asked.text(), answer).toMatch(/could not be sent/);
      } finally {
        smtp.restore();
      }
    }
  });

  it("treats a repeat of an undelivered send as undelivered", async () => {
    // The magic-link plugin's sender, called as Better Auth calls it, for a token whose send is on record.
    const options = authOptions(db, { APP_URL: "http://localhost", BETTER_AUTH_SECRET: "x".repeat(32) }, () => ({
      db,
      apiKey: "key",
      fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch,
    }));
    const plugin = options.plugins[0] as unknown as { options: { sendMagicLink: (d: unknown) => Promise<void> } };
    const send = (token: string) =>
      plugin.options.sendMagicLink({ email: "member@example.com", url: `http://localhost/x?token=${token}`, token });
    // The first send of this token gets no clear answer (a 503): uncertain, and an error.
    await expect(send("uncertain-token")).rejects.toThrow(/could not be sent/);
    // Asked again with the same token: a duplicate of an uncertain send, still an error.
    await expect(send("uncertain-token")).rejects.toThrow(/could not be sent/);
    // A send the allowlist refused (D01 T02 §2) stays refused.
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("refused-token")))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await db
      .prepare(
        "INSERT INTO mail_sends (id, send_key, kind, to_hash, status, attempts, created_at, updated_at, claimed_at) VALUES ('r1', ?, 'signin', ?, 'refused', 0, ?, ?, ?)",
      )
      .bind(
        `signin:${hash}`,
        "0".repeat(64),
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run();
    await expect(send("refused-token")).rejects.toThrow(/could not be sent/);
  });

  it("answers Better Auth's health check", async () => {
    const ok = await call("/api/auth/ok");
    expect(ok.status).toBe(200);
    expect(await signIn("health@example.com")).toMatchObject({ cookie: expect.stringMatching(/session_token=/) });
  });
});
