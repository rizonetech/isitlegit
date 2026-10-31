import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { authOptions } from "../../src/auth/auth";
import { addMember } from "../fixtures/auth/members";
import { authEnv, call, redeem, requestLink, sessionCookie, signIn, stubSmtp2go, target } from "./helpers";

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
    const asked = await requestLink("Member@Demo.IsItLegit.co.za", "/cases?verdict=bad");
    expect(asked.status).toBe(200);
    expect(smtp.sends).toHaveLength(1);
    const sent = smtp.sends[0] as { to: string; link: string; text: string };
    // To the address as typed; the account is the address in lower case.
    expect(sent.to).toBe("Member@Demo.IsItLegit.co.za");
    expect(sent.text).toMatch(/for 15 minutes/);
    // The link is stored to expire 15 minutes from now.
    const stored = await db
      .prepare(`SELECT "expiresAt" AS at FROM "verification" ORDER BY "createdAt" DESC`)
      .first<{ at: string }>();
    const lifetime = new Date(stored?.at as string).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(14 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);
    const redeemed = await redeem(sent.link);
    expect(redeemed.status).toBe(303);
    expect(target(redeemed)).toBe("/cases?verdict=bad");
    const cookie = sessionCookie(redeemed);
    expect(cookie).toMatch(/session_token=/);
    // The user and the session, in D1.
    const user = await db
      .prepare(`SELECT id FROM "user" WHERE lower(email) = ?`)
      .bind("member@demo.isitlegit.co.za")
      .first<{ id: string }>();
    expect(user).not.toBeNull();
    const sessions = await db
      .prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`)
      .bind(user?.id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(1);
    // The cookie is a session Better Auth knows.
    const read = await call("/api/auth/get-session", { headers: { cookie } });
    expect(((await read.json()) as { user?: { email: string } } | null)?.user?.email).toBe(
      "member@demo.isitlegit.co.za",
    );
  });

  it("returns to /cases when no destination was asked for", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("nowhere@demo.isitlegit.co.za");
    expect(target(await redeem(smtp.sends[0]?.link ?? ""))).toBe("/cases");
  });

  it("refuses a destination off this site, before any mail goes", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    // Refused by Better Auth's own origin check (403) or by the same-site rule (400).
    for (const callbackURL of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)"])
      expect([400, 403], callbackURL).toContain((await requestLink("member@demo.isitlegit.co.za", callbackURL)).status);
    // Even the app's own origin written out: a destination is a path, which Better Auth's origin check alone allows.
    expect((await requestLink("member@demo.isitlegit.co.za", "http://localhost/cases")).status).toBe(400);
    expect(smtp.sends).toEqual([]);
  });

  it("refuses a used link and an expired one", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("used@demo.isitlegit.co.za");
    const link = smtp.sends[0]?.link ?? "";
    expect(sessionCookie(await redeem(link))).toMatch(/session_token=/);
    // The second time: no session, and the "link expired or used" page with its recovery form.
    const again = await redeem(link);
    expect(sessionCookie(again)).toBe("");
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("That link no longer works");
    // A link past its 15 minutes.
    await requestLink("late@demo.isitlegit.co.za");
    await db
      .prepare(`UPDATE "verification" SET "expiresAt" = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();
    const late = await redeem(smtp.sends[1]?.link ?? "");
    expect(sessionCookie(late)).toBe("");
    expect([late.status, (await late.text()).includes("That link no longer works")]).toEqual([400, true]);
  });

  it("keeps a failed link's page for the new link it offers", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("keep@demo.isitlegit.co.za", "/cases/42?tab=evidence");
    const link = smtp.sends[0]?.link ?? "";
    await redeem(link);
    const again = await redeem(link);
    expect(await again.text()).toContain('name="callbackURL" value="/cases/42?tab=evidence"');
  });

  it("mails only the token and a same-site return path, and an edited link cannot leave the site", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const asked = await call("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "fresh@demo.isitlegit.co.za",
        callbackURL: "/cases",
        errorCallbackURL: "http://localhost/elsewhere",
        newUserCallbackURL: "/welcome",
      }),
    });
    expect(asked.status).toBe(200);
    // The confirm page (D07 T02 §10), with the token and the return path and nothing a client named.
    const link = new URL(smtp.sends[0]?.link ?? "");
    expect(link.pathname).toBe("/signin/confirm");
    expect([...link.searchParams.keys()].sort()).toEqual(["callbackURL", "token"]);
    expect(link.searchParams.get("callbackURL")).toBe("/cases");
    // Edited toward another site: the page carries the default path instead, and the link is still good.
    for (const value of ["//evil.example/x", "https://evil.example/", "http://localhost/elsewhere"]) {
      const edited = new URL(link);
      edited.searchParams.set("callbackURL", value);
      const shown = await call(`${edited.pathname}${edited.search}`);
      expect(await shown.text(), value).toContain('name="callbackURL" value="/cases"');
      expect(sessionCookie(shown), value).toBe("");
    }
    // A POST naming another site lands on the default, never there.
    const token = link.searchParams.get("token") ?? "";
    const posted = await call("/signin/confirm", {
      method: "POST",
      body: new URLSearchParams({ token, callbackURL: "https://evil.example/" }),
    });
    expect([posted.status, target(posted)]).toEqual([303, "/cases"]);
    expect(sessionCookie(posted)).toMatch(/session_token=/);
  });

  it("lands a link with its return path removed on /cases, and keeps a page asked for", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("stripped@demo.isitlegit.co.za", "/cases/7");
    expect(target(await redeem(smtp.sends[0]?.link ?? ""))).toBe("/cases/7");
    await requestLink("bare@demo.isitlegit.co.za");
    const bare = new URL(smtp.sends.at(-1)?.link ?? "");
    bare.searchParams.delete("callbackURL");
    const first = await redeem(bare.toString());
    expect([first.status, target(first)]).toEqual([303, "/cases"]);
    expect(sessionCookie(first)).toMatch(/session_token=/);
  });

  it("stores a link's token only as its hash", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("hashed@demo.isitlegit.co.za");
    const token = new URL(smtp.sends[0]?.link ?? "").searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThan(20);
    const rows = await db
      .prepare(`SELECT identifier, value FROM "verification"`)
      .all<{ identifier: string; value: string }>();
    for (const row of rows.results) expect(`${row.identifier} ${row.value}`).not.toContain(token);
  });

  it("keeps outstanding links across a new secret, and voids them only by deleting their records", async () => {
    // Signed in first: signIn stubs SMTP2GO itself, and restoring that stub would remove this test's.
    const { cookie } = await signIn("rotate@demo.isitlegit.co.za");
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("rotate@demo.isitlegit.co.za");
    await requestLink("rotate@demo.isitlegit.co.za");
    const [kept, voided] = smtp.sends.slice(-2).map((s) => s.link);
    const rotated = { ...authEnv, BETTER_AUTH_SECRET: "a-new-secret-0123456789abcdef-0123456789" };
    // The new secret refuses the session it did not sign: the member is signed out.
    expect(
      (await call("/api/auth/get-session", { headers: { cookie } }, rotated).then((r) => r.json())) ?? null,
    ).toBeNull();
    // A link sent before it still signs in.
    const keptAnswer = await redeem(kept as string, rotated);
    expect([keptAnswer.status, target(keptAnswer)]).toEqual([303, "/cases"]);
    expect(sessionCookie(keptAnswer)).toMatch(/session_token=/);
    // Deleting the outstanding link records (docs/operations.md) voids the rest.
    await db.prepare(`DELETE FROM "verification" WHERE identifier LIKE 'magic-link:%'`).run();
    const late = await redeem(voided as string, rotated);
    expect(sessionCookie(late)).toBe("");
    expect(late.status).toBe(400);
  });

  it("sends a new, usable link for each request, under its own send key", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("twice@demo.isitlegit.co.za");
    await requestLink("twice@demo.isitlegit.co.za");
    expect(smtp.sends).toHaveLength(2);
    expect(smtp.sends[0]?.link).not.toBe(smtp.sends[1]?.link);
    const keys = await db
      .prepare(`SELECT send_key FROM mail_sends WHERE kind = 'signin' ORDER BY created_at`)
      .all<{ send_key: string }>();
    const twice = keys.results.slice(-2).map((r) => r.send_key);
    expect(new Set(twice).size).toBe(2);
    for (const key of twice) expect(key).toMatch(/^signin:[0-9a-f]{64}$/);
    expect(sessionCookie(await redeem(smtp.sends[1]?.link ?? ""))).toMatch(/session_token=/);
  });

  it("answers an error, never 'check your email', when the link does not go", async () => {
    for (const answer of ["refused", "silent"] as const) {
      const smtp = stubSmtp2go(() => answer);
      try {
        const asked = await requestLink(`${answer}@demo.isitlegit.co.za`);
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
      plugin.options.sendMagicLink({
        email: "member@demo.isitlegit.co.za",
        url: `http://localhost/x?token=${token}`,
        token,
      });
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

  it("sends a link to a real member by their membership, and refuses an address that is neither member nor invitee", async () => {
    await addMember(db, "realmember@example.com");
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    expect((await requestLink("realmember@example.com")).status).toBe(200);
    expect(smtp.sends.map((s) => s.to)).toEqual(["realmember@example.com"]);
    // A stranger is answered exactly as a member is, sent nothing, and leaves no row behind.
    const before = await db.prepare("SELECT COUNT(*) AS n FROM mail_sends").first<{ n: number }>();
    const member = await requestLink("realmember@example.com");
    const stranger = await requestLink("stranger@example.com");
    expect([stranger.status, await stranger.text()]).toEqual([member.status, await member.text()]);
    expect(smtp.sends.map((s) => s.to)).toEqual(["realmember@example.com", "realmember@example.com"]);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM mail_sends").first<{ n: number }>();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
  });

  it("sends at most five sign-in links to one address in ten minutes, answering the sixth the same", async () => {
    await addMember(db, "busy@example.com");
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    for (let i = 0; i < 6; i++) expect((await requestLink("busy@example.com")).status, `request ${i + 1}`).toBe(200);
    expect(smtp.sends).toHaveLength(5);
    // Another address is not held back by it.
    await addMember(db, "calm@example.com");
    await requestLink("calm@example.com");
    expect(smtp.sends).toHaveLength(6);
  });

  it("answers Better Auth's health check", async () => {
    const ok = await call("/api/auth/ok");
    expect(ok.status).toBe(200);
    expect(await signIn("health@demo.isitlegit.co.za")).toMatchObject({
      cookie: expect.stringMatching(/session_token=/),
    });
  });
});
