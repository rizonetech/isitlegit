import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNUP_MAX } from "../../src/auth/ratelimit";
import { CODE_COOKIE } from "../../src/auth/signin-code";
import { call, stubSmtp2go } from "../auth/helpers";
import { addInviteCode } from "../fixtures/auth/members";

// The signup page (D07 T02 §13): `/signup` on A1's frame with A2's words, `POST /signup` guarded as the sign-in forms
// are and counted by the endpoint's own per-IP limit, every refusal drawn on its field storing nothing, both answers,
// and a signup interrupted after its code was used resuming to exactly one of everything.
const db = (env as unknown as Env).DB;
let restore = () => {};
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});
const mailed = (answer: () => "sent" | "refused" | "silent" = () => "sent") => {
  const smtp = stubSmtp2go(answer);
  restore = smtp.restore;
  return smtp;
};
const tag = () => crypto.randomUUID().slice(0, 8);

// A browser: its cookies kept and sent, an address of its own for the limits.
let nextIp = 1;
function browser(ip = `192.0.2.${nextIp++ % 250}`) {
  const cookies = new Map<string, string>();
  const keep = (answer: Response) => {
    for (const cookie of answer.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const [name = "", ...value] = pair.trim().split("=");
      cookies.set(name, value.join("="));
    }
    return answer;
  };
  const headers = (extra: Record<string, string> = {}) => ({
    accept: "text/html",
    "cf-connecting-ip": ip,
    ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
    ...extra,
  });
  return {
    cookies,
    get: async (path: string) => keep(await call(path, { headers: headers() })),
    post: async (path: string, fields: Record<string, string>, extra: Record<string, string> = {}) =>
      keep(await call(path, { method: "POST", body: new URLSearchParams(fields), headers: headers(extra) })),
  };
}
const codeIn = (text: string) => /\n\n(\d{3}) (\d{3})\n\n/.exec(text)?.slice(1).join("") ?? "";
const count = async (sql: string, ...values: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...values)
      .first<{ n: number }>()
  )?.n ?? 0;
const accountOf = async (email: string) => ({
  users: await count(`SELECT COUNT(*) AS n FROM "user" WHERE email = ?`, email),
  owners: await count(
    `SELECT COUNT(*) AS n FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ? AND m.role = 'owner'`,
    email,
  ),
  redemptions: await count("SELECT COUNT(*) AS n FROM invite_redemptions WHERE email = ?", email),
});
const usesOf = async (id: string) =>
  (await db.prepare("SELECT uses FROM invite_codes WHERE id = ?").bind(id).first<{ uses: number }>())?.uses;
const fieldsFor = (invite: string, email: string, extra: Record<string, string> = {}) => ({
  invite,
  email,
  organizationName: "Karoo Couriers",
  consent: "yes",
  ...extra,
});

describe("the signup page", () => {
  it("draws A2's form on A1's frame, each control by name, a shared code filled in, the notice on the public site", async () => {
    const code = `SHARE-${tag()}`;
    const res = await browser().get(`/signup?code=${code}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    const html = await res.text();
    expect(html).toContain("Protect your business from fake invoices and phishing.");
    expect(html).toMatch(/<h1[^>]*>Create an account<\/h1>/);
    expect(html).toMatch(/Already have one\?\s*<a href="\/signin"[^>]*>Sign in<\/a>/);
    for (const label of ["Invite code", "Work email", "Organisation name"])
      expect(html).toMatch(new RegExp(`<label[^>]*>${label}</label>`));
    expect(html).toMatch(new RegExp(`name="invite"[^>]*value="${code}"`));
    expect(html).toMatch(/<a href="https:\/\/isitlegit.co.za\/privacy"[^>]*>Read the privacy notice<\/a>/);
    expect(html).toContain("I agree to IsItLegit processing mail I forward, as the privacy notice describes.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Create account<\/button>/);
  });

  it("refuses a post from another site or too large, creating nothing", async () => {
    const codeId = await addInviteCode(db, `GUARD-${tag()}`);
    const email = `guard-${tag()}@example.org`;
    const b = browser();
    const foreign = await b.post("/signup", fieldsFor("GUARD", email), { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    const huge = await b.post("/signup", fieldsFor("GUARD", email, { organizationName: "x".repeat(20_000) }));
    expect(huge.status).toBe(413);
    const hugeHtml = await huge.text();
    expect(hugeHtml).toContain("That was more than the form can take. Check each field and try again.");
    expect(hugeHtml).toMatch(/<button[^>]*type="submit"[^>]*>Create account<\/button>/);
    expect(await accountOf(email)).toEqual({ users: 0, owners: 0, redemptions: 0 });
    expect(await usesOf(codeId)).toBe(0);
  });

  it("answers each refusal on its field, the form kept, storing nothing", async () => {
    mailed();
    const spent = `SPENT-${tag()}`;
    const old = `OLD-${tag()}`;
    const good = `GOOD-${tag()}`;
    const spentId = await addInviteCode(db, spent, { maxUses: 1, uses: 1 });
    await addInviteCode(db, old, { expiresAt: new Date(Date.now() - 60_000) });
    const goodId = await addInviteCode(db, good);
    const b = browser();
    // No consent: the box's own error, the other fields kept.
    const email = `refused-${tag()}@example.org`;
    const noConsent = await b.post("/signup", { invite: good, email, organizationName: "Karoo Couriers" });
    expect(noConsent.status).toBe(400);
    const noConsentHtml = await noConsent.text();
    expect(noConsentHtml).toContain("Tick the box to agree before creating your account.");
    expect(noConsentHtml).toContain(`value="${email}"`);
    expect(noConsentHtml).toContain('value="Karoo Couriers"');
    // Every unusable code: one sentence, whatever the reason.
    for (const code of [`NOPE-${tag()}`, spent, old]) {
      const html = await (await b.post("/signup", fieldsFor(code, email))).text();
      expect(html, code).toContain("We do not recognise that code, or it has been used up or has expired.");
    }
    // A bad address and a bad name, each on its field.
    expect(await (await b.post("/signup", fieldsFor(good, "not-an-address"))).text()).toContain(
      "Enter your work email.",
    );
    expect(await (await b.post("/signup", fieldsFor(good, email, { organizationName: "" }))).text()).toContain(
      "Enter your organisation&#39;s name, on one line, up to 120 characters.",
    );
    expect(await accountOf(email)).toEqual({ users: 0, owners: 0, redemptions: 0 });
    expect(await usesOf(goodId)).toBe(0);
    expect(await usesOf(spentId)).toBe(1);
  });

  it("says an address that already has an account should sign in", async () => {
    mailed();
    const code = `TWICE-${tag()}`;
    await addInviteCode(db, code, { maxUses: 2 });
    const email = `twice-${tag()}@example.org`;
    expect((await browser().post("/signup", fieldsFor(code, email))).status).toBe(201);
    const again = await browser().post("/signup", fieldsFor(code, email));
    expect(again.status).toBe(409);
    const html = await again.text();
    expect(html).toContain("This address already has an account. Sign in instead.");
    expect(html).toMatch(/<a href="\/signin"[^>]*>Sign in instead<\/a>/);
  });

  it("is counted by the endpoint's own per-IP limit, and says when it lifts", async () => {
    const b = browser();
    let last: Response | undefined;
    for (let i = 0; i <= SIGNUP_MAX; i++)
      last = await b.post("/signup", fieldsFor(`NOPE-${tag()}`, `limit-${tag()}@example.org`));
    expect(last?.status).toBe(429);
    const html = (await last?.text()) ?? "";
    expect(html).toMatch(/Too many signups from here\. You can try again at \d\d:\d\d SAST\./);
    expect(html).toMatch(/data-retry-at="\d+"/);
    // Another address is not this one's limit.
    expect((await browser().post("/signup", fieldsFor(`NOPE-${tag()}`, `other-${tag()}@example.org`))).status).toBe(
      400,
    );
  });

  it("signs up, shows the inbox with the code field, and signs in by the first code onto the Cases list", async () => {
    const smtp = mailed();
    const code = `WELCOME-${tag()}`;
    const codeId = await addInviteCode(db, code);
    const email = `owner-${tag()}@example.org`;
    const b = browser();
    await b.get("/signup");
    expect(b.cookies.get(CODE_COOKIE)).toBeTruthy();
    const done = await b.post("/signup", fieldsFor(code, email));
    expect(done.status).toBe(201);
    const html = await done.text();
    expect(html).toMatch(/<h1[^>]*>Check your inbox<\/h1>/);
    expect(html).toContain("Code from the email");
    const signedIn = await b.post("/signin/code", {
      email,
      code: codeIn(smtp.sends.at(-1)?.text ?? ""),
      callbackURL: "/cases",
    });
    expect(signedIn.status).toBe(303);
    const cases = await b.get("/cases");
    expect(cases.status).toBe(200);
    expect(await cases.text()).toContain("Everything Karoo Couriers has checked");
    expect(await accountOf(email)).toEqual({ users: 1, owners: 1, redemptions: 1 });
    expect(await usesOf(codeId)).toBe(1);
  });

  // The server's part of the one-minute goal (the form posted to the inbox page drawn), timed over ten signups.
  it("creates an organisation within two seconds at p95 on the server", async () => {
    mailed();
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const code = `TIMED-${tag()}`;
      await addInviteCode(db, code);
      const started = performance.now();
      const res = await browser().post("/signup", fieldsFor(code, `timed-${tag()}@example.org`));
      times.push(performance.now() - started);
      expect(res.status).toBe(201);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.NaN;
    console.log(JSON.stringify({ event: "signup-timing", signups: times.length, p95Ms: Math.round(p95) }));
    expect(p95).toBeLessThan(2000);
  });

  it("says the account is ready when its first link could not be confirmed, with a form for a new one", async () => {
    mailed(() => "refused");
    const code = `QUIET-${tag()}`;
    await addInviteCode(db, code);
    const email = `quiet-${tag()}@example.org`;
    const res = await browser().post("/signup", fieldsFor(code, email));
    expect(res.status).toBe(201);
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>Your account is ready<\/h1>/);
    expect(html).toContain('<form method="post" action="/signin/link"');
    expect(html).toContain(`value="${email}"`);
    expect(html).toMatch(/<button[^>]*>Email me a new link<\/button>/);
  });

  it("keeps the form when a signup is interrupted after its code was used, and resumes it to one of everything", async () => {
    mailed();
    const code = `RESUME-${tag()}`;
    const codeId = await addInviteCode(db, code);
    const email = `resume-${tag()}@example.org`;
    const b = browser();
    // The organisation's write fails once, after the code was used and the redemption made.
    const prepare = db.prepare.bind(db);
    let failed = false;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (!failed && /insert into "organization"/i.test(sql)) {
        failed = true;
        throw new Error("D1_ERROR: Network connection lost.");
      }
      return prepare(sql);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const interrupted = await b.post("/signup", fieldsFor(code, email));
    expect(interrupted.status).toBe(503);
    const html = await interrupted.text();
    expect(html).toContain("Your account could not be finished just now. Press Create account again in a moment.");
    expect(html).toContain(`value="${email}"`);
    expect(html).toContain(`value="${code}"`);
    expect(html).toContain('value="Karoo Couriers"');
    expect(failed).toBe(true);
    // Sent again: resumed, not refused for a code now used up.
    const resumed = await b.post("/signup", fieldsFor(code, email));
    expect(resumed.status).toBe(201);
    expect(await accountOf(email)).toEqual({ users: 1, owners: 1, redemptions: 1 });
    expect(await usesOf(codeId)).toBe(1);
    const redemption = await db
      .prepare("SELECT status, consented_at FROM invite_redemptions WHERE email = ?")
      .bind(email)
      .first<{ status: string; consented_at: string | null }>();
    expect(redemption?.status).toBe("complete");
    expect(redemption?.consented_at).toBeTruthy();
    expect(
      await count(
        `SELECT COUNT(*) AS n FROM "organization" WHERE name = 'Karoo Couriers' AND slug LIKE 'org-%' AND id IN (SELECT "organizationId" FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?)`,
        email,
      ),
    ).toBe(1);
  });
});
