import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailedLink } from "../../src/auth/confirm-page";
import { authEnv, call, pathOf, redeem, requestLink, sessionCookie, stubSmtp2go, target } from "./helpers";

// Sign-in links that survive link scanners (D07 T02 §10): the mailed link only shows a page, its form's POST signs in,
// and every failure says what to do next.
const db = (env as unknown as Env).DB;
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

const sessionsOf = async (email: string) =>
  (
    await db
      .prepare(`SELECT COUNT(*) AS n FROM "session" s JOIN "user" u ON u.id = s.userId WHERE lower(u.email) = ?`)
      .bind(email)
      .first<{ n: number }>()
  )?.n ?? 0;

const post = (path: string, fields: Record<string, string>, origin?: string) =>
  call(path, {
    method: "POST",
    body: new URLSearchParams(fields),
    ...(origin === undefined ? {} : { headers: { origin } }),
  });

describe("the confirm page", () => {
  it("creates nothing when the mailed link is fetched, however often, and the member's click still signs in", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
    await requestLink("scanned@demo.isitlegit.co.za", "/cases/42?tab=evidence");
    const link = smtp.sends[0]?.link ?? "";
    expect(new URL(link).pathname).toBe("/signin/confirm");
    for (const _ of [1, 2]) {
      const shown = await call(pathOf(link));
      expect(shown.status).toBe(200);
      expect(sessionCookie(shown)).toBe("");
      expect(shown.headers.get("cache-control")).toBe("no-store");
      expect(shown.headers.get("referrer-policy")).toBe("same-origin");
      expect(shown.headers.get("x-robots-tag")).toBe("noindex");
      const html = await shown.text();
      expect(html).toContain('<form method="post" action="/signin/confirm"');
      expect(html).toContain('name="callbackURL" value="/cases/42?tab=evidence"');
      expect(html).toContain("Sign in to IsItLegit");
    }
    expect(await sessionsOf("scanned@demo.isitlegit.co.za")).toBe(0);
    // The fetches are logged, with no token.
    const token = new URL(link).searchParams.get("token") ?? "";
    const shownLines = lines.filter((line) => line.includes('"signin-confirm"') && line.includes('"shown"'));
    expect(shownLines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain(token);
    // The click: signed in, at the exact page the link named.
    const signedIn = await redeem(link);
    expect([signedIn.status, target(signedIn)]).toEqual([303, "/cases/42?tab=evidence"]);
    expect(sessionCookie(signedIn)).toMatch(/session_token=/);
    expect(await sessionsOf("scanned@demo.isitlegit.co.za")).toBe(1);
  });

  it("refuses a POST from another origin, and from a page that sent Origin: null", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("origin@demo.isitlegit.co.za");
    const token = new URL(smtp.sends[0]?.link ?? "").searchParams.get("token") ?? "";
    for (const origin of ["https://evil.example", "null"]) {
      const refused = await post("/signin/confirm", { token, callbackURL: "/cases" }, origin);
      expect(refused.status, origin).toBe(403);
      expect(sessionCookie(refused), origin).toBe("");
    }
    // The token was not spent by the refusals.
    expect(sessionCookie(await post("/signin/confirm", { token, callbackURL: "/cases" }))).toMatch(/session_token=/);
  });

  it("answers a service failure after the token was taken apart from a used link", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("broken@demo.isitlegit.co.za");
    const token = new URL(smtp.sends[0]?.link ?? "").searchParams.get("token") ?? "";
    // The session table refuses the insert, as a D1 outage would.
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/insert into "session"/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const failed = await post("/signin/confirm", { token, callbackURL: "/cases" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain("Sign-in did not finish");
    expect(sessionCookie(failed)).toBe("");
  });
});

describe("a link mailed before the confirm page", () => {
  it("goes to the confirm page with its token and return path, signs no one in on GET, and completes from there", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("old@demo.isitlegit.co.za", "/cases/9");
    const token = new URL(smtp.sends[0]?.link ?? "").searchParams.get("token") ?? "";
    const old = `/api/auth/magic-link/verify?token=${token}&callbackURL=%2Fcases%2F9`;
    const sent = await call(old);
    expect(sent.status).toBe(303);
    expect(sessionCookie(sent)).toBe("");
    const confirm = new URL(sent.headers.get("location") ?? "");
    expect([confirm.pathname, confirm.searchParams.get("token"), confirm.searchParams.get("callbackURL")]).toEqual([
      "/signin/confirm",
      token,
      "/cases/9",
    ]);
    expect(await sessionsOf("old@demo.isitlegit.co.za")).toBe(0);
    const signedIn = await redeem(confirm.toString());
    expect([signedIn.status, target(signedIn)]).toEqual([303, "/cases/9"]);
  });
});

describe("the link expired or used state", () => {
  it("sends a new link from its form that signs in at the same page", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("again@demo.isitlegit.co.za", "/cases/5");
    const link = smtp.sends[0]?.link ?? "";
    await redeem(link);
    const used = await redeem(link);
    const html = await used.text();
    expect(html).toContain('<form method="post" action="/signin/link"');
    expect(html).toContain('name="callbackURL" value="/cases/5"');
    expect(html).toMatch(/<label[^>]*for="signin-email"[^>]*>Email<\/label>/);
    const asked = await post("/signin/link", { email: "again@demo.isitlegit.co.za", callbackURL: "/cases/5" });
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain("If that address can sign in, a new link is on its way");
    expect(smtp.sends).toHaveLength(2);
    const signedIn = await redeem(smtp.sends[1]?.link ?? "");
    expect([signedIn.status, target(signedIn)]).toEqual([303, "/cases/5"]);
  });

  it("answers an unknown address as it answers a sent one, and a failed send with a retry", async () => {
    let answer: "sent" | "refused" = "sent";
    const smtp = stubSmtp2go(() => answer);
    restore = smtp.restore;
    const unknown = await post("/signin/link", { email: "nobody@example.org", callbackURL: "/cases" });
    expect([unknown.status, (await unknown.text()).includes("If that address can sign in")]).toEqual([200, true]);
    expect(smtp.sends).toHaveLength(0);
    answer = "refused";
    const failed = await post("/signin/link", { email: "member@demo.isitlegit.co.za", callbackURL: "/cases" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain("The link could not be sent");
    // Another origin and a malformed address.
    expect((await post("/signin/link", { email: "member@demo.isitlegit.co.za" }, "https://evil.example")).status).toBe(
      403,
    );
    const bad = await post("/signin/link", { email: "not an address", callbackURL: "/cases" });
    expect([bad.status, (await bad.text()).includes("Enter the email you sign in with.")]).toEqual([400, true]);
  });
});

describe("the mailed link", () => {
  it("is the confirm page on the app's origin, with the token and a same-site return path only", () => {
    const verify = "https://app.isitlegit.co.za/api/auth/magic-link/verify?token=abc&callbackURL=%2Fcases%2F1&x=1";
    expect(mailedLink("https://app.isitlegit.co.za", verify, "abc")).toBe(
      "https://app.isitlegit.co.za/signin/confirm?token=abc&callbackURL=%2Fcases%2F1",
    );
    const away =
      "https://app.isitlegit.co.za/api/auth/magic-link/verify?token=abc&callbackURL=https%3A%2F%2Fevil.example";
    expect(new URL(mailedLink("https://app.isitlegit.co.za", away, "abc")).searchParams.get("callbackURL")).toBe(
      "/cases",
    );
    expect(authEnv.APP_URL).toBeTruthy();
  });
});
