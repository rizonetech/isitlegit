import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyVerify } from "../../src/auth/confirm";
import { mailedLink } from "../../src/auth/confirm-page";
import { MAX_RETURN_PATH } from "../../src/auth/paths";
import { SIGNIN_PER_ADDRESS } from "../../src/mail/smtp2go";
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
      // A fetch with no cookie is a browser that did not ask (D07 T02 §12): it reads where to finish and may still sign in
      // here by its own choice.
      expect(html).toContain("Finish in the browser where you asked");
      expect(html).toContain("Sign in in this browser instead");
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
    // Reopened after the outage, the spent link reads the plain page, never "finish in the browser where you asked"
    // (D07 T02 §12 round 1).
    vi.restoreAllMocks();
    const reopened = await (await call(pathOf(smtp.sends[0]?.link ?? ""))).text();
    expect(reopened).not.toContain("Finish in the browser where you asked");
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
    expect(html).toMatch(/<label[^>]*for="signin-email"[^>]*>Work email<\/label>/);
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

// The value of a form field on a rendered page.
const field = (html: string, name: string) =>
  (new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ?? "").replace(/&amp;/g, "&");

describe("recovery and identity (completion review, 2026-10-29)", () => {
  it("stores each member's own address on the session, not one shared bucket (G1)", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    for (const [email, ip] of [
      ["ip-one@demo.isitlegit.co.za", "203.0.113.7"],
      ["ip-two@demo.isitlegit.co.za", "198.51.100.9"],
    ] as const) {
      await requestLink(email);
      const token = new URL(smtp.sends.at(-1)?.link ?? "").searchParams.get("token") ?? "";
      const signed = await call("/signin/confirm", {
        method: "POST",
        body: new URLSearchParams({ token, callbackURL: "/cases" }),
        headers: { "cf-connecting-ip": ip },
      });
      expect(sessionCookie(signed), email).toMatch(/session_token=/);
      const row = await db
        .prepare(`SELECT s.ipAddress AS ip FROM "session" s JOIN "user" u ON u.id = s.userId WHERE lower(u.email) = ?`)
        .bind(email)
        .first<{ ip: string }>();
      expect(row?.ip, email).toBe(ip);
    }
  });

  it("offers a new link on the did-not-finish page that signs in at the same page (G2)", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("unfinished@demo.isitlegit.co.za", "/cases/3");
    const token = new URL(smtp.sends[0]?.link ?? "").searchParams.get("token") ?? "";
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/insert into "session"/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const failed = await post("/signin/confirm", { token, callbackURL: "/cases/3" });
    expect(failed.status).toBe(503);
    const html = await failed.text();
    expect(html).toContain('<form method="post" action="/signin/link"');
    expect(field(html, "callbackURL")).toBe("/cases/3");
    spy.mockRestore();
    const asked = await post("/signin/link", {
      email: "unfinished@demo.isitlegit.co.za",
      callbackURL: field(html, "callbackURL"),
    });
    expect(asked.status).toBe(200);
    const signedIn = await redeem(smtp.sends.at(-1)?.link ?? "");
    expect([signedIn.status, target(signedIn)]).toEqual([303, "/cases/3"]);
  });

  it("keeps the address on a failed send so the retry is one press, and the retry sends (G2)", async () => {
    let answer: "sent" | "refused" = "refused";
    const smtp = stubSmtp2go(() => answer);
    restore = smtp.restore;
    const failed = await post("/signin/link", { email: "retry@demo.isitlegit.co.za", callbackURL: "/cases/8" });
    expect(failed.status).toBe(503);
    const html = await failed.text();
    expect(field(html, "email")).toBe("retry@demo.isitlegit.co.za");
    expect(field(html, "callbackURL")).toBe("/cases/8");
    answer = "sent";
    const retried = await post("/signin/link", {
      email: field(html, "email"),
      callbackURL: field(html, "callbackURL"),
    });
    expect(retried.status).toBe(200);
    expect(await redeem(smtp.sends.at(-1)?.link ?? "").then(target)).toBe("/cases/8");
  });

  it("sends another link from the inbox state, and opens the form to change the address (G3)", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const inbox = await post("/signin/link", { email: "inbox@demo.isitlegit.co.za", callbackURL: "/cases/4" });
    const html = await inbox.text();
    expect(html).toContain("Send another link");
    expect(html).toContain("Use a different email");
    expect(field(html, "email")).toBe("inbox@demo.isitlegit.co.za");
    await post("/signin/link", { email: field(html, "email"), callbackURL: field(html, "callbackURL") });
    expect(smtp.sends).toHaveLength(2);
    const change = await call("/signin/link?email=inbox%40demo.isitlegit.co.za&callbackURL=%2Fcases%2F4");
    expect(change.status).toBe(200);
    const form = await change.text();
    expect(form).toMatch(/<input[^>]*name="email"[^>]*value="inbox@demo.isitlegit.co.za"/);
    expect(field(form, "callbackURL")).toBe("/cases/4");
  });

  it("answers the address's link limit through the form with the same neutral page, and sends nothing more (G5)", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const answers: string[] = [];
    for (let i = 0; i <= SIGNIN_PER_ADDRESS; i++) {
      const asked = await post("/signin/link", { email: "limited@demo.isitlegit.co.za", callbackURL: "/cases" });
      answers.push(`${asked.status} ${(await asked.text()).includes("If that address can sign in")}`);
    }
    expect(new Set(answers)).toEqual(new Set(["200 true"]));
    expect(smtp.sends).toHaveLength(SIGNIN_PER_ADDRESS);
  });
});

describe("round 1 (2026-10-29)", () => {
  it("refuses a form over its limit before reading it, and never draws an over-long field back into the page", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const huge = await post("/signin/link", { email: `${'"'.repeat(24 * 1024)}@x.org`, callbackURL: "/cases" });
    expect(huge.status).toBe(413);
    const long = `${"a".repeat(3000)}@example.org`;
    const refused = await post("/signin/link", { email: long, callbackURL: "/cases" });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).not.toContain("a".repeat(300));
    expect(html.length).toBeLessThan(20_000);
    expect((await post("/signin/confirm", { token: "t".repeat(9000), callbackURL: "/cases" })).status).toBe(413);
    expect(smtp.sends).toEqual([]);
  });

  it("signs in at a destination whose own query names an error", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("errorpage@demo.isitlegit.co.za", "/cases/42?error=upload_failed");
    const signedIn = await redeem(smtp.sends[0]?.link ?? "");
    expect([signedIn.status, target(signedIn)]).toEqual([303, "/cases/42?error=upload_failed"]);
    expect(sessionCookie(signedIn)).toMatch(/session_token=/);
  });

  it("answers an address Better Auth would refuse as a field error, never as an outage", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    for (const email of ["a..b@example.org", "no-at-sign", "x@"]) {
      const answer = await post("/signin/link", { email, callbackURL: "/cases" });
      expect(answer.status, email).toBe(400);
      expect(await answer.text(), email).toContain("Enter the email you sign in with.");
    }
    expect(smtp.sends).toEqual([]);
  });
});

describe("round 2 (2026-10-29)", () => {
  it("signs in at a destination with non-ASCII characters, sent percent-encoded", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    await requestLink("unicode@demo.isitlegit.co.za", "/cases?search=📧");
    const signedIn = await redeem(smtp.sends[0]?.link ?? "");
    expect(signedIn.status).toBe(303);
    expect(sessionCookie(signedIn)).toMatch(/session_token=/);
    expect(target(signedIn)).toBe("/cases?search=%F0%9F%93%A7");
  });
});

describe("round 3 (2026-10-29)", () => {
  it("never redirects off the site through dot segments, at the request, the confirm page or the POST", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    for (const away of ["/a/..//evil.example/path", "/./..//evil.example", "/x/%2e%2e//evil.example"]) {
      expect((await requestLink("dots@demo.isitlegit.co.za", away)).status, away).toBe(400);
      const shown = await call(`/signin/confirm?token=t&callbackURL=${encodeURIComponent(away)}`);
      expect(await shown.text(), away).toContain('name="callbackURL" value="/cases"');
    }
    await requestLink("dots@demo.isitlegit.co.za");
    const token = new URL(smtp.sends.at(-1)?.link ?? "").searchParams.get("token") ?? "";
    const posted = await post("/signin/confirm", { token, callbackURL: "/a/..//evil.example/path" });
    expect(posted.status).toBe(303);
    const to = new URL(posted.headers.get("location") ?? "", "http://localhost");
    expect([to.origin, to.pathname]).toEqual(["http://localhost", "/cases"]);
  });
});

describe("final review (2026-10-29)", () => {
  const O = "https://app.isitlegit.co.za";
  const redirect = (location: string, cookie?: string) => {
    const headers = new Headers({ location });
    if (cookie) headers.append("set-cookie", cookie);
    return new Response(null, { status: 302, headers });
  };

  it("sorts every answer Better Auth's verify gives into the page's states", () => {
    expect(classifyVerify(redirect(`${O}/cases`, "__Secure-better-auth.session_token=abc; Path=/"), O)).toBe(
      "signed-in",
    );
    expect(classifyVerify(new Response(null, { status: 429 }), O)).toBe("rate-limited");
    expect(classifyVerify(redirect(`${O}/signin?next=%2Fcases&error=INVALID_TOKEN`), O)).toBe("used");
    expect(classifyVerify(redirect(`${O}/signin?next=%2Fcases&error=EXPIRED_TOKEN`), O)).toBe("used");
    for (const code of ["new_user_signup_disabled", "user_not_found", "SOME_API_ERROR"])
      expect(classifyVerify(redirect(`${O}/signin?next=%2Fcases&error=${code}`), O), code).toBe("no-account");
    for (const code of ["failed_to_create_session", "failed_to_create_user"])
      expect(classifyVerify(redirect(`${O}/signin?next=%2Fcases&error=${code}`), O), code).toBe("failed");
    // An error in the member's own destination, with no session, is not a token failure; nor is a 500.
    expect(classifyVerify(redirect(`${O}/cases?error=upload_failed`), O)).toBe("failed");
    expect(classifyVerify(new Response(null, { status: 500 }), O)).toBe("failed");
  });

  it("keeps a return path of the full allowed length to the end, and refuses a longer one at the start", async () => {
    const smtp = stubSmtp2go();
    restore = smtp.restore;
    const longest = `/cases?q=${"a".repeat(MAX_RETURN_PATH - 9)}`;
    expect(longest).toHaveLength(MAX_RETURN_PATH);
    await requestLink("long@demo.isitlegit.co.za", longest);
    expect(target(await redeem(smtp.sends.at(-1)?.link ?? ""))).toBe(longest);
    expect((await requestLink("long@demo.isitlegit.co.za", `${longest}a`)).status).toBe(400);
    const shown = await call(`/signin/confirm?token=t&callbackURL=${encodeURIComponent(`${longest}a`)}`);
    expect(await shown.text()).toContain('name="callbackURL" value="/cases"');
  });
});
