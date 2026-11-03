import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_COOKIE,
  codeMac,
  codeMatches,
  DRAW_LIMIT,
  drawCode,
  handleHash,
  newHandle,
  sealToken,
  unsealToken,
} from "../../src/auth/signin-code";
import {
  askedElsewhere,
  issueSignInCode,
  tokenFingerprint,
  verificationIdentifier,
} from "../../src/auth/signin-code-store";
import { SIGNIN_PER_ADDRESS } from "../../src/mail/smtp2go";
import { addInviteCode } from "../fixtures/auth/members";
import { authEnv, call, ORIGIN, redeem, sessionCookie, stubSmtp2go, target } from "./helpers";

// Sign-in codes (D07 T02 §11): each link is mailed with a 6-digit code that signs in only the browser that asked, three
// wrong codes end it, and the link and its code are one sign-in.
const db = (env as unknown as Env).DB;
const SECRET = authEnv.BETTER_AUTH_SECRET ?? "";
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.restoreAllMocks();
});

const mailed = () => {
  const smtp = stubSmtp2go();
  restore = smtp.restore;
  return smtp;
};

// A browser: its cookies kept from every answer and sent with every request, as a real one does for this origin.
// Each browser has an address of its own, so one test's spent limit (D07 T02 §6) is never another's.
let nextIp = 1;
function browser(ip = `198.51.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`) {
  // Each cookie with its Path, sent only to the paths it matches (RFC 6265 5.1.4), as a browser does.
  const cookies = new Map<string, { value: string; path: string }>();
  const keep = (answer: Response) => {
    for (const cookie of answer.headers.getSetCookie()) {
      const [pair = "", ...attributes] = cookie.split(";");
      const [name = "", ...value] = pair.trim().split("=");
      const path = attributes.map((a) => /^\s*path=(.*)$/i.exec(a)?.[1]?.trim()).find(Boolean) ?? "/";
      if (attributes.some((a) => /^\s*max-age=0\s*$/i.test(a))) cookies.delete(name);
      else cookies.set(name, { value: value.join("="), path });
    }
    return answer;
  };
  const matches = (path: string, cookiePath: string) =>
    path === cookiePath || path.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);
  const headers = (path: string, extra: Record<string, string> = {}) => {
    const sent = [...cookies].filter(([, c]) => matches(path.split("?")[0] ?? path, c.path));
    return {
      ...extra,
      "cf-connecting-ip": ip,
      ...(sent.length ? { cookie: sent.map(([k, c]) => `${k}=${c.value}`).join("; ") } : {}),
    };
  };
  const jar = { get: (name: string) => cookies.get(name)?.value, has: (name: string) => cookies.has(name) };
  return {
    jar,
    post: async (path: string, fields: Record<string, string>) =>
      keep(await call(path, { method: "POST", body: new URLSearchParams(fields), headers: headers(path) })),
    json: async (path: string, body: unknown) =>
      keep(
        await call(path, {
          method: "POST",
          body: JSON.stringify(body),
          headers: headers(path, { "content-type": "application/json" }),
        }),
      ),
    get: async (path: string) => keep(await call(path, { headers: headers(path) })),
  };
}

const codeIn = (text: string) => /\n\n(\d{3}) (\d{3})\n\n/.exec(text)?.slice(1).join("") ?? "";
// The D1 database is shared by the tests in this file, so every test uses addresses of its own and reads its own rows.
const unique = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
const rows = async (email: string) =>
  (await db.prepare("SELECT * FROM signin_codes WHERE email = ?").bind(email).all<Record<string, unknown>>())
    .results as Record<string, unknown>[];
// The latest row a browser's handle holds.
const rowOf = async (handle: string) =>
  db
    .prepare("SELECT * FROM signin_codes WHERE handle_hash = ? ORDER BY issued_at DESC, rowid DESC LIMIT 1")
    .bind(await handleHash(handle))
    .first<{ attempts: number; used_at: number | null; email: string; callback_url: string }>();
// The sign-in failures recorded since `after` (a rowid from `mark`).
const mark = async () =>
  (await db.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM auth_events").first<{ n: number }>())?.n ?? 0;
const failures = async (after: number) =>
  (
    await db
      .prepare("SELECT outcome FROM auth_events WHERE kind = 'sign-in-failed' AND rowid > ? ORDER BY rowid")
      .bind(after)
      .all<{ outcome: string }>()
  ).results.map((r) => r.outcome);

describe("the code itself", () => {
  it("creates the table it is stored in", async () => {
    const columns = (await db.prepare("PRAGMA table_info(signin_codes)").all<{ name: string }>()).results.map(
      (c) => c.name,
    );
    expect(columns).toEqual([
      "id",
      "handle_hash",
      "email",
      "token_box",
      "code_mac",
      "callback_url",
      "issued_at",
      "expires_at",
      "attempts",
      "used_at",
      "token_hash",
    ]);
  });

  it("draws every code alike: a draw past the last whole million is drawn again, and short codes are padded", () => {
    const draws = [DRAW_LIMIT, 2 ** 32 - 1, 7];
    expect(drawCode(() => draws.shift() as number)).toBe("000007");
    expect(drawCode(() => DRAW_LIMIT - 1)).toBe("999999");
    expect(drawCode(() => 1_000_000)).toBe("000000");
    expect(drawCode()).toMatch(/^\d{6}$/);
  });

  it("seals the token so only the auth secret opens it, and refuses a changed box", async () => {
    const box = await sealToken(SECRET, "token-abc");
    expect(box).not.toContain("token-abc");
    expect(await unsealToken(SECRET, box)).toBe("token-abc");
    // Two seals of one token differ (a fresh IV each).
    expect(await sealToken(SECRET, "token-abc")).not.toBe(box);
    const bytes = [...box];
    bytes[20] = bytes[20] === "A" ? "B" : "A";
    expect(await unsealToken(SECRET, bytes.join(""))).toBeNull();
    expect(await unsealToken(`${SECRET}-other`, box)).toBeNull();
  });

  it("keeps the code as a MAC that depends on the handle and the secret", async () => {
    const [a, b] = [newHandle(), newHandle()];
    const mac = await codeMac(SECRET, a, "123456");
    expect(mac).not.toContain("123456");
    expect(await codeMac(SECRET, b, "123456")).not.toBe(mac);
    expect(await codeMac(`${SECRET}-other`, a, "123456")).not.toBe(mac);
    expect(await codeMatches(SECRET, a, "123456", mac)).toBe(true);
    expect(await codeMatches(SECRET, a, "123457", mac)).toBe(false);
    expect(await codeMatches(SECRET, b, "123456", mac)).toBe(false);
  });

  it("stores no token or code in clear, and sweeps expired rows as new ones are issued", async () => {
    const email = unique("sweep");
    const old = newHandle();
    await issueSignInCode(
      db,
      SECRET,
      { email, token: "tok-old", callbackURL: "/cases", handle: old, now: 0 },
      "111111",
    );
    const handle = newHandle();
    await issueSignInCode(db, SECRET, { email, token: "tok-new", callbackURL: "/cases", handle }, "222222");
    expect(await rowOf(old)).toBeNull();
    const text = JSON.stringify(await rows(email));
    for (const secret of ["tok-new", "222222", handle]) expect(text).not.toContain(secret);
  });
});

describe("a link request", () => {
  it("mails the code beside the link and binds it to the asking browser with an HttpOnly cookie", async () => {
    const smtp = mailed();
    const laptop = browser();
    const email = unique("code");
    const asked = await laptop.post("/signin/link", { email, callbackURL: "/cases/7" });
    expect(asked.status).toBe(200);
    const cookie = asked.headers.getSetCookie().find((c) => c.startsWith(`${CODE_COOKIE}=`)) ?? "";
    expect(cookie).toMatch(/; Path=\/(;|$)/);
    expect(cookie).toMatch(/; Max-Age=900/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    const text = smtp.sends[0]?.text ?? "";
    expect(text).toContain("Or type this code in the browser where you asked for the link");
    expect(codeIn(text)).toMatch(/^\d{6}$/);
    const all = await rows(email);
    expect(all).toHaveLength(1);
    expect(all[0]?.callback_url).toBe("/cases/7");
    const html = await asked.text();
    expect(html).toContain('<form method="post" action="/signin/code"');
    expect(html).toContain("Code from the email");
    expect(html).toContain('autocomplete="one-time-code"');
  });

  it("gives an address that cannot sign in the same cookie and a row whose token opens nothing", async () => {
    const smtp = mailed();
    const stranger = browser();
    const email = `nobody-${crypto.randomUUID().slice(0, 8)}@example.org`;
    const asked = await stranger.post("/signin/link", { email, callbackURL: "/cases" });
    expect(asked.status).toBe(200);
    expect(stranger.jar.get(CODE_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(smtp.sends).toHaveLength(0);
    // The row a sent link leaves, with a decoy token: the browser cannot tell the two apart.
    const [row] = await rows(email);
    expect(await unsealToken(SECRET, String(row?.token_box))).toMatch(/^decoy-/);
  });

  it("sends nothing and says so when the code cannot be stored, for a link request and for signup", async () => {
    const smtp = mailed();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/insert into signin_codes/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const asker = browser();
    const asked = await asker.post("/signin/link", { email: unique("unstored"), callbackURL: "/cases" });
    expect(asked.status).toBe(503);
    expect(await asked.text()).toContain("The link could not be sent");
    expect(smtp.sends).toHaveLength(0);
    const code = `code-${crypto.randomUUID()}`;
    await addInviteCode(db, code);
    const signedUp = await asker.json("/api/auth/sign-up/invite-code", {
      code,
      email: `unstored-${crypto.randomUUID().slice(0, 8)}@karoo-signup.example`,
      organizationName: "Karoo Unstored",
      consent: true,
    });
    expect(signedUp.status).toBe(201);
    expect(((await signedUp.json()) as { linkSent: boolean }).linkSent).toBe(false);
    expect(smtp.sends).toHaveLength(0);
  });

  it("answers a browser that holds a handle the same for a refused address as for a sent one", async () => {
    mailed();
    const asker = browser();
    await asker.post("/signin/link", { email: unique("holder"), callbackURL: "/cases" });
    const handle = asker.jar.get(CODE_COOKIE);
    const cookieOf = (answer: Response) =>
      answer.headers
        .getSetCookie()
        .filter((c) => c.startsWith(`${CODE_COOKIE}=`))
        .map((c) => c.split(";")[0]);
    const refused = await asker.post("/signin/link", {
      email: `nobody-${crypto.randomUUID().slice(0, 8)}@example.org`,
      callbackURL: "/cases",
    });
    const sent = await asker.post("/signin/link", { email: unique("holder-2"), callbackURL: "/cases" });
    expect(cookieOf(refused)).toEqual([`${CODE_COOKIE}=${handle}`]);
    expect(cookieOf(sent)).toEqual([`${CODE_COOKIE}=${handle}`]);
    expect(refused.status).toBe(sent.status);
  });

  it("keeps a mailed code working when a resend is refused by the address's limit", async () => {
    const smtp = mailed();
    const laptop = browser();
    const email = unique("limit");
    for (let i = 0; i < SIGNIN_PER_ADDRESS; i++) await laptop.post("/signin/link", { email, callbackURL: "/cases/9" });
    expect(smtp.sends).toHaveLength(SIGNIN_PER_ADDRESS);
    const handle = laptop.jar.get(CODE_COOKIE);
    const refused = await laptop.post("/signin/link", { email, callbackURL: "/cases/9" });
    expect(refused.status).toBe(200);
    expect(smtp.sends).toHaveLength(SIGNIN_PER_ADDRESS);
    expect(laptop.jar.get(CODE_COOKIE)).toBe(handle);
    const signedIn = await laptop.post("/signin/code", {
      code: codeIn(smtp.sends.at(-1)?.text ?? ""),
      email,
      callbackURL: "/cases/9",
    });
    expect(signedIn.status).toBe(303);
    expect(target(signedIn)).toBe("/cases/9");
  });

  it("keeps the browser's handle and its codes when links are asked for through Better Auth's own endpoint", async () => {
    const smtp = mailed();
    const laptop = browser();
    const email = unique("api");
    for (let i = 0; i < SIGNIN_PER_ADDRESS; i++)
      await laptop.json("/api/auth/sign-in/magic-link", { email, callbackURL: "/cases/3" });
    const handle = laptop.jar.get(CODE_COOKIE);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The sixth, held back by the address's limit, answers as sent and keeps the same handle.
    expect((await laptop.json("/api/auth/sign-in/magic-link", { email, callbackURL: "/cases/3" })).status).toBe(200);
    expect(smtp.sends).toHaveLength(SIGNIN_PER_ADDRESS);
    expect(laptop.jar.get(CODE_COOKIE)).toBe(handle);
    const done = await laptop.post("/signin/code", {
      code: codeIn(smtp.sends.at(-1)?.text ?? ""),
      email,
      callbackURL: "/cases/3",
    });
    expect(target(done)).toBe("/cases/3");
  });

  it("gives a fresh browser its handle with the form, so two links asked for at once both stay its own", async () => {
    const smtp = mailed();
    const fresh = browser();
    const form = await fresh.get("/signin/link?callbackURL=%2Fcases%2F5");
    expect(form.status).toBe(200);
    const handle = fresh.jar.get(CODE_COOKIE);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [a, b] = [unique("tab-a"), unique("tab-b")];
    await Promise.all([
      fresh.post("/signin/link", { email: a, callbackURL: "/cases/5" }),
      fresh.post("/signin/link", { email: b, callbackURL: "/cases/5" }),
    ]);
    expect(fresh.jar.get(CODE_COOKIE)).toBe(handle);
    const hash = await handleHash(handle ?? "");
    expect((await rows(a))[0]?.handle_hash).toBe(hash);
    expect((await rows(b))[0]?.handle_hash).toBe(hash);
    const mailToA = smtp.sends.find((m) => m.to === a)?.text ?? "";
    expect(target(await fresh.post("/signin/code", { code: codeIn(mailToA), email: a, callbackURL: "/cases/5" }))).toBe(
      "/cases/5",
    );
  });

  it("binds the first code of an invite-code signup to the browser that signed up", async () => {
    const smtp = mailed();
    const code = `code-${crypto.randomUUID()}`;
    const founder = `founder-${crypto.randomUUID().slice(0, 8)}@karoo-signup.example`;
    await addInviteCode(db, code);
    const owner = browser();
    const signedUp = await owner.json("/api/auth/sign-up/invite-code", {
      code,
      email: founder,
      organizationName: "Karoo Signup",
      consent: true,
    });
    expect(signedUp.status).toBe(201);
    expect(owner.jar.get(CODE_COOKIE)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const first = smtp.sends.at(-1)?.text ?? "";
    const done = await owner.post("/signin/code", {
      code: codeIn(first),
      email: founder,
      callbackURL: "/cases",
    });
    expect(done.status).toBe(303);
    expect(sessionCookie(done)).toMatch(/session_token=/);
    expect(await rows(founder)).toHaveLength(1);
  });
});

describe("signing in by code", () => {
  async function asked(email = unique("reader"), callbackURL = "/cases/12") {
    const smtp = mailed();
    const laptop = browser();
    await laptop.post("/signin/link", { email, callbackURL });
    return {
      smtp,
      laptop,
      email,
      callbackURL,
      code: codeIn(smtp.sends.at(-1)?.text ?? ""),
      link: smtp.sends.at(-1)?.link ?? "",
    };
  }

  it("signs in the browser that asked, once, at its return path, typed as the mail shows it", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    const done = await laptop.post("/signin/code", {
      code: `${code.slice(0, 3)} ${code.slice(3)}`,
      email,
      callbackURL,
    });
    expect(done.status).toBe(303);
    expect(target(done)).toBe("/cases/12");
    expect(laptop.jar.has(CODE_COOKIE)).toBe(false);
    const session = await call("/api/auth/get-session", { headers: { cookie: sessionCookie(done) } });
    expect(((await session.json()) as { user?: { email?: string } } | null)?.user?.email).toBe(email);
    const again = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("works only in the browser where you asked");
  });

  it("refuses the code in another browser, and spends no attempt doing so", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    const phone = browser();
    const refused = await phone.post("/signin/code", { code, email, callbackURL });
    expect(refused.status).toBe(400);
    expect(sessionCookie(refused)).toBe("");
    expect((await laptop.post("/signin/code", { code, email, callbackURL })).status).toBe(303);
  });

  it("counts wrong codes, ends the code at the third, and keeps the page's recovery working", async () => {
    const since = await mark();
    const { smtp, laptop, email, callbackURL, code } = await asked();
    const wrong = code === "000000" ? "000001" : "000000";
    const first = await laptop.post("/signin/code", { code: wrong, email, callbackURL });
    const html = await first.text();
    expect(html).toContain("That code is not right. 2 tries left.");
    expect(html).toMatch(/<input[^>]*aria-describedby="[^"]*signin-code-error[^"]*"/);
    expect(await (await laptop.post("/signin/code", { code: wrong, email, callbackURL })).text()).toContain(
      "1 try left.",
    );
    expect(await (await laptop.post("/signin/code", { code: wrong, email, callbackURL })).text()).toContain(
      "after three wrong tries",
    );
    const right = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(right.status).toBe(400);
    expect(sessionCookie(right)).toBe("");
    // The refused page's own controls: Send another link, with the address and return path it carried.
    const page = await right.text();
    const field = (name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1] ?? "";
    expect(field("email")).toBe(email);
    await laptop.post("/signin/link", { email: field("email"), callbackURL: field("callbackURL") });
    const fresh = codeIn(smtp.sends.at(-1)?.text ?? "");
    const done = await laptop.post("/signin/code", { code: fresh, email, callbackURL });
    expect(target(done)).toBe("/cases/12");
    expect(await failures(since)).toEqual(["code-wrong", "code-wrong", "code-locked", "code-locked"]);
  });

  it("lets ten parallel guesses claim no more than three attempts", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    const wrong = Array.from({ length: 10 }, (_, i) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, "0"));
    const answers = await Promise.all(
      wrong.map((guess) => laptop.post("/signin/code", { code: guess, email, callbackURL })),
    );
    const texts = await Promise.all(answers.map((a) => a.text()));
    expect(texts.filter((t) => t.includes("That code is not right")).length).toBeLessThanOrEqual(2);
    expect((await rowOf(laptop.jar.get(CODE_COOKIE) ?? ""))?.attempts).toBe(3);
    expect((await laptop.post("/signin/code", { code, email, callbackURL })).status).toBe(400);
  });

  it("spends no attempt on a code that is not six digits", async () => {
    const { laptop, email, callbackURL } = await asked();
    const slip = await laptop.post("/signin/code", { code: "12345", email, callbackURL });
    expect(await slip.text()).toContain("Enter the 6-digit code from the email.");
    expect((await rowOf(laptop.jar.get(CODE_COOKIE) ?? ""))?.attempts).toBe(0);
  });

  it("refuses an expired code", async () => {
    const since = await mark();
    const { laptop, email, callbackURL, code } = await asked();
    await db.prepare("UPDATE signin_codes SET expires_at = 0 WHERE email = ?").bind(email).run();
    const late = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(await late.text()).toContain("That code has run out");
    expect(await failures(since)).toEqual(["code-expired"]);
  });

  it("spends the link and the code together, whichever comes first", async () => {
    const byLink = await asked(unique("first-link"));
    expect(sessionCookie(await redeem(byLink.link))).toMatch(/session_token=/);
    const late = await byLink.laptop.post("/signin/code", {
      code: byLink.code,
      email: byLink.email,
      callbackURL: byLink.callbackURL,
    });
    expect(late.status).toBe(400);
    expect(await late.text()).toContain("its link was already used");
    restore?.();
    const byCode = await asked(unique("first-code"));
    expect(
      (
        await byCode.laptop.post("/signin/code", {
          code: byCode.code,
          email: byCode.email,
          callbackURL: byCode.callbackURL,
        })
      ).status,
    ).toBe(303);
    const link = await redeem(byCode.link);
    expect(sessionCookie(link)).toBe("");
    expect(await link.text()).toContain("That link no longer works");
  });

  it("gives the attempt back when verify is throttled, so the same code works once the window passes", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    // The verify limit (D07 T02 §6) spent from this browser's address with links that are not real.
    for (let i = 0; i < 20; i++) await laptop.post("/signin/confirm", { token: `not-a-token-${i}`, callbackURL });
    const throttled = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(throttled.status).toBe(429);
    expect(await throttled.text()).toContain("Type the code again in");
    expect((await rowOf(laptop.jar.get(CODE_COOKIE) ?? ""))?.attempts).toBe(0);
    // The limiter's window passing, as the bucket's expiry would.
    await db.prepare("DELETE FROM rate_limits").run();
    expect(target(await laptop.post("/signin/code", { code, email, callbackURL }))).toBe("/cases/12");
  });

  it("ends the code with the no-account page when the address may not have an account", async () => {
    const smtp = mailed();
    const minted = { ...authEnv, OPERATOR_EMAIL: "stranger@example.org" };
    const ask = await call(
      "/signin/link",
      { method: "POST", body: new URLSearchParams({ email: "stranger@example.org", callbackURL: "/cases" }) },
      minted,
    );
    const handle =
      ask.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${CODE_COOKIE}=`))
        ?.split(";")[0] ?? "";
    const code = codeIn(smtp.sends.at(-1)?.text ?? "");
    const refused = await call("/signin/code", {
      method: "POST",
      body: new URLSearchParams({ code, email: "stranger@example.org", callbackURL: "/cases" }),
      headers: { cookie: handle },
    });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("This address has no IsItLegit account");
    expect((await rows("stranger@example.org")).at(-1)?.used_at).not.toBeNull();
  });

  it("ends the code with a new-link page when the service fails after the token was taken", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/insert into "session"/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const failed = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain("Sign-in did not finish on our side");
    vi.restoreAllMocks();
    expect((await rowOf(laptop.jar.get(CODE_COOKIE) ?? ""))?.used_at).not.toBeNull();
  });

  it("tells a browser nothing about a later request's address through its own code", async () => {
    // Its own code, one wrong try, then a link asked for someone else's address: one that may sign in, one that may
    // not. What the browser sees of its own code afterwards is the same in both.
    const seen: string[][] = [];
    for (const other of [unique("target"), `outsider-${crypto.randomUUID().slice(0, 8)}@example.org`]) {
      const { laptop, email, callbackURL, code } = await asked();
      const wrong = code === "000000" ? "000001" : "000000";
      await laptop.post("/signin/code", { code: wrong, email, callbackURL });
      await laptop.post("/signin/link", { email: other, callbackURL: "/cases" });
      const again = await (await laptop.post("/signin/code", { code: wrong, email, callbackURL })).text();
      const done = await laptop.post("/signin/code", { code, email, callbackURL });
      seen.push([/That code[^<]*/.exec(again)?.[0] ?? "", String(done.status), target(done) ?? ""]);
      restore?.();
    }
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]?.[1]).toBe("303");
  });

  it("says to try again when the code cannot be checked, spending nothing", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/set attempts = attempts \+ 1/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const failed = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(failed.status).toBe(503);
    expect(await failed.text()).toContain("We could not check the code just now");
    vi.restoreAllMocks();
    expect(target(await laptop.post("/signin/code", { code, email, callbackURL }))).toBe("/cases/12");
  });

  it("still signs in when the row cannot be marked used after verify", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/set used_at = /i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const done = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(done.status).toBe(303);
    expect(sessionCookie(done)).toMatch(/session_token=/);
  });

  it("counts code posts per IP before reading them, so refusals cannot flood the audit trail", async () => {
    const since = await mark();
    const stranger = browser();
    const answers: number[] = [];
    for (let i = 0; i < 22; i++)
      answers.push(
        (await stranger.post("/signin/code", { code: "111111", email: "x@example.org", callbackURL: "/cases" })).status,
      );
    expect(answers.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(answers.slice(20)).toEqual([429, 429]);
    const outcomes = await failures(since);
    expect(outcomes.filter((o) => o === "code-no-request")).toHaveLength(20);
    const limited = await db
      .prepare("SELECT COUNT(*) AS n FROM auth_events WHERE kind = 'rate-limited' AND rowid > ?")
      .bind(since)
      .first<{ n: number }>();
    expect(limited?.n).toBe(1);
  });

  it("points to a new link when a throttled code's attempt cannot be given back", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    for (let i = 0; i < 20; i++) await laptop.post("/signin/confirm", { token: `not-a-token-${i}`, callbackURL });
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/attempts = attempts - 1/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const throttled = await laptop.post("/signin/code", { code, email, callbackURL });
    expect(throttled.status).toBe(429);
    expect(await throttled.text()).toContain("this code could not be kept for later. Send another link in");
  });

  it("refuses a code posted from another origin", async () => {
    const { email, callbackURL, code } = await asked();
    const forged = await call("/signin/code", {
      method: "POST",
      body: new URLSearchParams({ code, email, callbackURL }),
      headers: { origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
  });

  it("writes no code or handle into the audit trail", async () => {
    const { laptop, email, callbackURL, code } = await asked();
    const wrong = code === "999999" ? "999998" : "999999";
    await laptop.post("/signin/code", { code: wrong, email, callbackURL });
    const all = JSON.stringify((await db.prepare("SELECT * FROM auth_events").all()).results);
    expect(all).toContain("code-wrong");
    for (const secret of [code, wrong, laptop.jar.get(CODE_COOKIE) ?? ""]) expect(all).not.toContain(secret);
    void ORIGIN;
  });
});

// D07 T02 §12: a link opened in another browser than the one that asked says where to finish, and the asking browser's
// code stays good until a sign-in happens.
describe("a link opened on another device", () => {
  const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";
  async function asked() {
    const smtp = mailed();
    const laptop = browser();
    const email = unique("device");
    await laptop.post("/signin/link", { email, callbackURL: "/cases/5" });
    const sent = smtp.sends.at(-1);
    return { laptop, email, link: sent?.link ?? "", code: codeIn(sent?.text ?? ""), smtp };
  }
  const rowCount = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM signin_codes").first<{ n: number }>())?.n ?? 0;
  const eventCount = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM auth_events").first<{ n: number }>())?.n ?? 0;
  const sessions = async () => (await db.prepare('SELECT COUNT(*) AS n FROM "session"').first<{ n: number }>())?.n ?? 0;

  it("keeps the token's fingerprint with its row, never the token", async () => {
    const { email, link } = await asked();
    const [row] = await rows(email);
    expect(row?.token_hash).toBe(await tokenFingerprint(tokenOf(link)));
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(tokenOf(link));
  });

  it("tells a link another browser asked for, and nothing else, by one read that writes nothing", async () => {
    const { laptop, link } = await asked();
    const token = tokenOf(link);
    const mine = laptop.jar.get(CODE_COOKIE);
    const before = [await rowCount(), await eventCount(), await sessions()];
    expect(await askedElsewhere(db, mine, token)).toBe(false);
    expect(await askedElsewhere(db, undefined, token)).toBe(true);
    expect(await askedElsewhere(db, newHandle(), token)).toBe(true);
    // A token no row names (an invitation, a link from before the column).
    expect(await askedElsewhere(db, undefined, `unknown-${newHandle()}`)).toBe(false);
    expect([await rowCount(), await eventCount(), await sessions()]).toEqual(before);
    // Not an expired, a used, or an attempts-exhausted row: the asking device's code no longer signs in.
    const hash = await tokenFingerprint(token);
    await db.prepare("UPDATE signin_codes SET attempts = 3 WHERE token_hash = ?").bind(hash).run();
    expect(await askedElsewhere(db, undefined, token)).toBe(false);
    await db.prepare("UPDATE signin_codes SET attempts = 0, used_at = 1 WHERE token_hash = ?").bind(hash).run();
    expect(await askedElsewhere(db, undefined, token)).toBe(false);
    await db.prepare("UPDATE signin_codes SET used_at = NULL, expires_at = 1 WHERE token_hash = ?").bind(hash).run();
    expect(await askedElsewhere(db, undefined, token)).toBe(false);
    // A live row whose link Better Auth no longer holds (consumed, whatever happened after) is spent.
    await db
      .prepare("UPDATE signin_codes SET expires_at = ? WHERE token_hash = ?")
      .bind(Date.now() + 600_000, hash)
      .run();
    expect(await askedElsewhere(db, undefined, token)).toBe(true);
    const held = await db
      .prepare('SELECT COUNT(*) AS n FROM "verification" WHERE identifier = ?')
      .bind(await verificationIdentifier(token))
      .first<{ n: number }>();
    expect(held?.n).toBe(1);
    await db
      .prepare('DELETE FROM "verification" WHERE identifier = ?')
      .bind(await verificationIdentifier(token))
      .run();
    expect(await askedElsewhere(db, undefined, token)).toBe(false);
  });

  it("shows the asking browser the plain page and another browser where to finish, a scanner's fetch changing nothing", async () => {
    const { laptop, link } = await asked();
    const path = link.replace(ORIGIN, "");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
    const before = [await rowCount(), await eventCount(), await sessions()];
    const mine = await (await laptop.get(path)).text();
    expect(mine).toContain("Sign in to IsItLegit");
    expect(mine).not.toContain("Finish in the browser where you asked");
    const phone = browser();
    const theirs = await phone.get(path);
    const html = await theirs.text();
    expect(theirs.status).toBe(200);
    expect(sessionCookie(theirs)).toBe("");
    expect(html).toContain("Finish in the browser where you asked");
    expect(html).toContain("6-digit code from the same email");
    expect(html).toContain("Sign in in this browser instead");
    expect(html).toContain('<form method="post" action="/signin/confirm"');
    // A scanner has no cookie at all and reads the same page; nothing is created, spent or audited.
    const scanner = await call(path);
    expect(await scanner.text()).toContain("Finish in the browser where you asked");
    expect(sessionCookie(scanner)).toBe("");
    expect([await rowCount(), await eventCount(), await sessions()]).toEqual(before);
    // The one token-free diagnostic stays, apart from the audit trail.
    const shown = lines.filter((l) => l.includes('"signin-confirm"') && l.includes('"shown"'));
    expect(shown.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l).not.toContain(tokenOf(link));
  });

  it("signs the second browser in on its own choice and spends the first browser's code", async () => {
    const { laptop, link, code, email } = await asked();
    const phone = browser();
    const done = await phone.post("/signin/confirm", { token: tokenOf(link), callbackURL: "/cases/5" });
    expect(done.status).toBe(303);
    expect(sessionCookie(done)).toMatch(/session_token=/);
    const late = await laptop.post("/signin/code", { code, email, callbackURL: "/cases/5" });
    expect(sessionCookie(late)).toBe("");
  });

  it("reads the plain page when a link already used to sign in is opened again, on either device (completion review G1)", async () => {
    const { laptop, link } = await asked();
    const path = link.replace(ORIGIN, "");
    const phone = browser();
    const done = await phone.post("/signin/confirm", { token: tokenOf(link), callbackURL: "/cases/5" });
    expect(sessionCookie(done)).toMatch(/session_token=/);
    for (const device of [phone, laptop, browser()]) {
      const html = await (await device.get(path)).text();
      expect(html).toContain("Sign in to IsItLegit");
      expect(html).not.toContain("Finish in the browser where you asked");
    }
    expect(await askedElsewhere(db, undefined, tokenOf(link))).toBe(false);
  });

  it("keeps the first browser's code good when the second never presses", async () => {
    const { laptop, link, code, email } = await asked();
    await browser().get(link.replace(ORIGIN, ""));
    const done = await laptop.post("/signin/code", { code, email, callbackURL: "/cases/5" });
    expect(done.status).toBe(303);
    expect(sessionCookie(done)).toMatch(/session_token=/);
  });

  it("gives an invite-code signup's first link the same state in another browser", async () => {
    const smtp = mailed();
    const code = `code-${crypto.randomUUID()}`;
    await addInviteCode(db, code);
    const owner = browser();
    const signedUp = await owner.json("/api/auth/sign-up/invite-code", {
      code,
      email: `first-${crypto.randomUUID().slice(0, 8)}@karoo-signup.example`,
      organizationName: "Karoo First Link",
      consent: true,
    });
    expect(signedUp.status).toBe(201);
    const path = (smtp.sends.at(-1)?.link ?? "").replace(ORIGIN, "");
    expect(await (await owner.get(path)).text()).not.toContain("Finish in the browser where you asked");
    expect(await (await browser().get(path)).text()).toContain("Finish in the browser where you asked");
  });

  it("shows the plain page once the asking device's code tries are used up, since this device is the way", async () => {
    const { laptop, link, code, email } = await asked();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 3; i++) await laptop.post("/signin/code", { code: wrong, email, callbackURL: "/cases/5" });
    const html = await (await browser().get(link.replace(ORIGIN, ""))).text();
    expect(html).toContain("Sign in to IsItLegit");
    expect(html).not.toContain("Finish in the browser where you asked");
  });

  it("answers a check that could not be made with a retryable page that spends nothing, then works on retry", async () => {
    const { link } = await asked();
    const path = link.replace(ORIGIN, "");
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM signin_codes WHERE token_hash/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const before = [await rowCount(), await eventCount(), await sessions()];
    const failed = await call(path);
    expect(failed.status).toBe(503);
    const html = await failed.text();
    expect(html).toContain("We could not check this link just now");
    expect(html).toContain("Try again");
    // The retry keeps the token and the destination, so the same link goes on.
    expect(html).toContain(`token=${tokenOf(link)}`);
    expect(html).toContain("callbackURL=%2Fcases%2F5");
    expect(sessionCookie(failed)).toBe("");
    vi.restoreAllMocks();
    expect([await rowCount(), await eventCount(), await sessions()]).toEqual(before);
    expect(await (await call(path)).text()).toContain("Finish in the browser where you asked");
  });
});
