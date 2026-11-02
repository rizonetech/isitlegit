import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOH_URL } from "../../src/auth/domains";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { call, signIn, target } from "../auth/helpers";

// The domain verification page (D07 T02 §15): an owner or admin verifies a domain by DNS and by a code through the
// page's own forms, each outcome and stored state drawn in words, and every refusal (anonymous, a member, a removed
// member, another organisation, another site, a form drawn for another organisation) changing nothing.
const db = (env as unknown as Env).DB;

const world = {
  doh: (): Response | "throw" => Response.json({ Status: 3 }),
  smtp: "sent" as "sent" | "refused" | "silent",
  sends: [] as { to: string; text: string }[],
};
let spy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  world.doh = () => Response.json({ Status: 3 });
  world.smtp = "sent";
  world.sends = [];
  stubNetwork();
});
// DNS-over-HTTPS and SMTP2GO as `world` says. Installed again after each sign-in, whose own mail stub restores fetch.
function stubNetwork() {
  spy?.mockRestore();
  const real = globalThis.fetch;
  spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(DOH_URL)) {
      const answer = world.doh();
      if (answer === "throw") throw new DOMException("timed out", "TimeoutError");
      return answer;
    }
    if (url === SMTP2GO_URL) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; text_body: string };
      if (world.smtp === "silent") throw new DOMException("timed out", "TimeoutError");
      if (world.smtp === "refused")
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      world.sends.push({ to: body.to[0] ?? "", text: body.text_body });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${world.sends.length}` } });
    }
    return real(input, init);
  });
}
afterEach(() => {
  spy?.mockRestore();
  vi.restoreAllMocks();
});
const txt = (value: string) => Response.json({ Status: 0, Answer: [{ type: 16, data: `"${value}"` }] });
const lastCode = () => /\b(\d{6})\b/.exec(world.sends.at(-1)?.text ?? "")?.[1] ?? "";

let n = 0;
const tag = () => `${++n}${crypto.randomUUID().slice(0, 6)}`;
async function org(name: string) {
  const id = `org-dom-${tag()}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, id, new Date().toISOString())
    .run();
  return id;
}
const userId = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>())?.id;
async function join(email: string, orgId: string, role: string) {
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, await userId(email), role, new Date().toISOString())
    .run();
}
const activate = async (email: string, orgId: string) =>
  db
    .prepare(`UPDATE "session" SET "activeOrganizationId" = ? WHERE "userId" = ?`)
    .bind(orgId, await userId(email))
    .run();
async function person(orgId: string, role = "owner") {
  const email = `dom-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  stubNetwork();
  await join(email, orgId, role);
  await activate(email, orgId);
  return { cookie, email };
}
async function claim(orgId: string, domain: string) {
  const id = crypto.randomUUID();
  await db
    .prepare("INSERT INTO org_domains (id, org_id, domain, token, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
    .bind(id, orgId, domain, `tok${tag()}`.padEnd(20, "x"), new Date().toISOString())
    .run();
  return id;
}
const page = (domain: string, cookie?: string, query = "") =>
  call(`/settings/domains/${domain}${query}`, { headers: { accept: "text/html", ...(cookie ? { cookie } : {}) } });
const post = (domain: string, cookie: string | undefined, fields: Record<string, string>, origin?: string) =>
  call(`/settings/domains/${domain}`, {
    method: "POST",
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
// Post a form and follow its redirect back to the page, as a browser does.
async function act(domain: string, cookie: string, fields: Record<string, string>) {
  const res = await post(domain, cookie, fields);
  expect(res.status, JSON.stringify(fields)).toBe(303);
  const to = target(res) ?? "";
  const landed = await call(to, { headers: { accept: "text/html", cookie } });
  return { to, status: landed.status, html: await landed.text() };
}
// The Send code button's opening tag, its class list set aside (it names `disabled:` styles whether or not it is).
const sendButton = (html: string) =>
  (/<button[^>]*id="send-code"[^>]*>/.exec(html)?.[0] ?? "").replace(/class="[^"]*"/, "");
const stored = (id: string) =>
  db
    .prepare(
      `SELECT d.state, d.method, d.verified_at AS verifiedAt,
        (SELECT COUNT(*) FROM verification_codes WHERE claim_id = d.id) AS codes,
        (SELECT COALESCE(SUM(attempts), 0) FROM verification_codes WHERE claim_id = d.id) AS attempts
       FROM org_domains d WHERE d.id = ?`,
    )
    .bind(id)
    .first<{ state: string; method: string | null; verifiedAt: string | null; codes: number; attempts: number }>();

describe("the domain verification page", () => {
  it("draws a pending claim: the breadcrumb, the record to copy, Check now and the email card", async () => {
    const o = await org("Karoo Couriers");
    const d = `kc-${tag()}.example`;
    await claim(o, d);
    const { cookie } = await person(o);
    const res = await page(d, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain('href="/settings/domains"');
    expect(html).toContain(`Prove you own ${d}`);
    expect(html).toContain(">Pending<");
    expect(html).toContain(`_isitlegit.${d}`);
    expect(html).toMatch(/isitlegit-verify=tok/);
    expect(html).toContain("Check now");
    expect(html).toContain(`admin@${d}`);
    expect(html).toContain(`postmaster@${d}`);
    expect(html).toContain(`name="org" value="${o}"`);
    // No code has gone yet, so there is nothing to type it into.
    expect(html).not.toContain("Code from the email");
  });

  it("verifies a domain by DNS through the page, and reads it back", async () => {
    const o = await org("Karoo Couriers");
    const d = `dns-${tag()}.example`;
    const id = await claim(o, d);
    const { cookie } = await person(o);
    const token = (await db.prepare("SELECT token FROM org_domains WHERE id = ?").bind(id).first<{ token: string }>())
      ?.token;
    world.doh = () => txt(`isitlegit-verify=${token}`);
    const done = await act(d, cookie, { org: o, action: "check" });
    expect(done.html).toContain(`${d} is verified`);
    expect(done.html).toContain("Checked by DNS at");
    expect(await stored(id)).toMatchObject({ state: "verified", method: "dns", codes: 0 });
    // A plain reload shows the same.
    expect(await (await page(d, cookie)).text()).toContain(`${d} is verified`);
  });

  it("says what a check found: not yet, a different record, a lookup that failed", async () => {
    const o = await org("Karoo Couriers");
    const d = `chk-${tag()}.example`;
    await claim(o, d);
    const { cookie } = await person(o);
    const absent = await act(d, cookie, { org: o, action: "check" });
    expect(absent.html).toContain("The record is not visible yet.");
    expect(absent.html).toMatch(/Last checked \d\d:\d\d SAST: record not found yet\./);
    world.doh = () => txt("isitlegit-verify=0b19aaaabbbbccccddddeeeeffff0000");
    const different = await act(d, cookie, { org: o, action: "check" });
    expect(different.html).toContain("We found a different record");
    expect(different.html).toContain(`_isitlegit.${d} holds isitlegit-verify=0b19... which is not your code.`);
    expect((await (await page(d, cookie)).text()).includes("a different record was found in its place.")).toBe(true);
    world.doh = () => "throw";
    const failing = await act(d, cookie, { org: o, action: "check" });
    expect(failing.html).toContain("The DNS lookup could not be made just now.");
  });

  it("verifies a domain by a code through the page: sent, two wrong tries counted down, a grouped code accepted", async () => {
    const o = await org("Karoo Couriers");
    const d = `code-${tag()}.example`;
    const id = await claim(o, d);
    const { cookie } = await person(o);
    const sent = await act(d, cookie, { org: o, action: "send", local: "postmaster" });
    expect(world.sends.at(-1)?.to).toBe(`postmaster@${d}`);
    expect(sent.html).toContain(`We sent a code to postmaster@${d}. It works for 30 minutes.`);
    expect(sent.html).toContain("Code from the email");
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    const first = await act(d, cookie, { org: o, action: "verify", code: wrong, local: "postmaster" });
    expect(first.html).toContain("That code is not right. 2 tries left before this is locked for an hour.");
    const second = await act(d, cookie, { org: o, action: "verify", code: wrong, local: "postmaster" });
    expect(second.html).toContain("That code is not right. 1 try left before this is locked for an hour.");
    // A plain visit still says how many tries are left, and keeps postmaster@ chosen after the send.
    // The wrong code's answer keeps postmaster@ chosen, so a resend goes where the first code went.
    expect(second.html).toMatch(/value="postmaster" checked/);
    const checked = await act(d, cookie, { org: o, action: "check", local: "postmaster" });
    expect(checked.html).toMatch(/value="postmaster" checked/);
    const plain = await (await page(d, cookie)).text();
    expect(plain).toContain("1 try left before this is locked for an hour.");
    expect(sent.html).toMatch(/value="postmaster" checked/);
    const malformed = await act(d, cookie, { org: o, action: "verify", code: "48a107" });
    expect(malformed.html).toContain("Type the 6 digits from the email.");
    expect((await stored(id))?.attempts).toBe(2);
    const right = await act(d, cookie, { org: o, action: "verify", code: `${code.slice(0, 3)} ${code.slice(3)}` });
    expect(right.html).toContain(`${d} is verified`);
    expect(right.html).toContain("Proved by a code to its mailbox at");
    expect(await stored(id)).toMatchObject({ state: "verified", method: "email", codes: 0 });
    expect((await stored(id))?.verifiedAt).toBeTruthy();
  });

  it("locks code entry after three wrong codes, leaving the DNS way open, on a plain load too", async () => {
    const o = await org("Karoo Couriers");
    const d = `lock-${tag()}.example`;
    await claim(o, d);
    const { cookie } = await person(o);
    await act(d, cookie, { org: o, action: "send", local: "admin" });
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    await act(d, cookie, { org: o, action: "verify", code: wrong });
    await act(d, cookie, { org: o, action: "verify", code: wrong });
    const locked = await act(d, cookie, { org: o, action: "verify", code: wrong });
    for (const html of [locked.html, await (await page(d, cookie)).text()]) {
      expect(html).toMatch(/Code entry is locked until \d\d:\d\d SAST/);
      expect(html).toContain("You can still verify with the DNS record at any time.");
      expect(html).not.toContain("Code from the email");
      expect(html).toContain("Check now");
    }
    // Once the lock ends (and the code with it), Send code is back.
    await db
      .prepare("UPDATE verification_codes SET locked_until = ?, expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), new Date(Date.now() - 1000).toISOString())
      .run();
    const after = await (await page(d, cookie)).text();
    expect(after).not.toContain("Code entry is locked");
    expect(after).toContain("Send code");
  });

  it("words every send outcome: uncertain, failed, and the hourly limit with Send code disabled until then", async () => {
    const o = await org("Karoo Couriers");
    const d = `send-${tag()}.example`;
    await claim(o, d);
    const { cookie } = await person(o);
    world.smtp = "silent";
    const unknown = await act(d, cookie, { org: o, action: "send", local: "admin" });
    expect(unknown.html).toContain(
      `The code may have gone to admin@${d}. Check that inbox before sending another, because a new code replaces it.`,
    );
    world.smtp = "refused";
    const failed = await act(d, cookie, { org: o, action: "send", local: "admin" });
    expect(failed.html).toContain(`The code could not be sent to admin@${d}. Send another.`);
    world.smtp = "sent";
    for (let i = 0; i < 3; i++) await act(d, cookie, { org: o, action: "send", local: "admin" });
    const limited = await act(d, cookie, { org: o, action: "send", local: "admin" });
    expect(limited.html).toMatch(/Five codes an hour can go for this domain\. The next can go at \d\d:\d\d SAST\./);
    expect(sendButton(limited.html)).toMatch(/\sdisabled(="")?[\s>]/);
    expect(limited.html).toMatch(/The next code can go at \d\d:\d\d SAST\./);
    // Once the hour has passed, Send code is back.
    await db
      .prepare("UPDATE verification_sends SET sent_at = ? WHERE target = ?")
      .bind(new Date(Date.now() - 2 * 3_600_000).toISOString(), `domain:${d}`)
      .run();
    const later = await (await page(d, cookie)).text();
    expect(sendButton(later)).not.toMatch(/\sdisabled(="")?[\s>]/);
    expect(later).not.toContain("The next code can go at");
  });

  it("says the last code is still on its way rather than replacing it", async () => {
    const o = await org("Karoo Couriers");
    const d = `wait-${tag()}.example`;
    const id = await claim(o, d);
    const { cookie } = await person(o);
    await act(d, cookie, { org: o, action: "send", local: "admin" });
    await db.prepare("UPDATE mail_sends SET status = 'pending' WHERE send_key LIKE ?").bind(`claim:${id}:%`).run();
    const mailed = world.sends.length;
    const res = await act(d, cookie, { org: o, action: "send", local: "admin" });
    expect(res.html).toContain("The last code is still on its way. Check the inbox before asking for another");
    expect(world.sends.length).toBe(mailed);
  });

  it("says when a code has expired or none is waiting", async () => {
    const o = await org("Karoo Couriers");
    const d = `exp-${tag()}.example`;
    await claim(o, d);
    const { cookie } = await person(o);
    const none = await act(d, cookie, { org: o, action: "verify", code: "123456" });
    expect(none.html).toContain("No code is waiting. Send one first.");
    await act(d, cookie, { org: o, action: "send", local: "admin" });
    await db
      .prepare("UPDATE verification_codes SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect(await (await page(d, cookie)).text()).not.toContain("Code from the email");
    // Said on a plain visit, not only after a guess.
    expect(await (await page(d, cookie)).text()).toContain("The code we sent has expired. Send a new one.");
    const expired = await act(d, cookie, { org: o, action: "verify", code: lastCode() });
    expect(expired.html).toContain("The code we sent has expired. Send a new one.");
  });

  it("refuses a domain another organisation verified while this one waited", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const d = `taken-${tag()}.example`;
    await claim(a, d);
    const theirs = await claim(b, d);
    const { cookie } = await person(a);
    await act(d, cookie, { org: a, action: "send", local: "admin" });
    await db
      .prepare("UPDATE org_domains SET state = 'verified', method = 'dns', verified_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), theirs)
      .run();
    const taken = await act(d, cookie, { org: a, action: "verify", code: lastCode() });
    expect(taken.html).toContain(`${d} is verified by another organisation, so it cannot be verified here.`);
  });

  it("does nothing with a form drawn for another organisation than the active one", async () => {
    const [a, b] = [await org("Alpha Freight"), await org("Bravo Couriers")];
    const d = `both-${tag()}.example`;
    const [ca, cb] = [await claim(a, d), await claim(b, d)];
    const { cookie, email } = await person(a);
    await join(email, b, "owner");
    // A's page is drawn (its form names A); B becomes active in another tab; A's form is posted.
    expect(await (await page(d, cookie)).text()).toContain(`name="org" value="${a}"`);
    await activate(email, b);
    for (const fields of [
      { org: a, action: "send", local: "admin" },
      { org: a, action: "verify", code: "123456" },
      { org: a, action: "check" },
    ]) {
      const res = await act(d, cookie, fields);
      expect(res.html).toContain("Your organisation changed in another tab, so nothing was done.");
      expect(res.html).toContain("This page is now for Bravo Couriers.");
    }
    expect(world.sends).toEqual([]);
    for (const id of [ca, cb]) expect(await stored(id)).toMatchObject({ state: "pending", codes: 0, attempts: 0 });
    const checks = await db
      .prepare("SELECT COUNT(*) AS n FROM auth_events WHERE target_id IN (?, ?)")
      .bind(ca, cb)
      .first<{ n: number }>();
    expect(checks?.n).toBe(0);
  });

  it("refuses everyone else, changing nothing: anonymous, a member, a removed member, another organisation, another site", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const d = `gate-${tag()}.example`;
    const id = await claim(a, d);
    const owner = await person(a);
    const ordinary = await person(a, "member");
    const removed = await person(a, "admin");
    await db
      .prepare(`DELETE FROM "member" WHERE "userId" = ?`)
      .bind(await userId(removed.email))
      .run();
    const outsider = await person(b);
    const actions = [{ action: "check" }, { action: "send", local: "admin" }, { action: "verify", code: "123456" }];
    // Anonymous: sent to sign in.
    expect(target(await page(d))).toBe(`/signin?next=${encodeURIComponent(`/settings/domains/${d}`)}`);
    // A member: told an owner or admin verifies, with the way to their cases.
    const member = await page(d, ordinary.cookie);
    expect(member.status).toBe(403);
    const memberHtml = await member.text();
    expect(memberHtml).toContain("Only an owner or admin verifies domains.");
    expect(memberHtml).toContain("An owner or admin of Karoo Couriers verifies its domains.");
    expect(memberHtml).toContain('href="/cases"');
    // A removed member: not a member.
    expect((await page(d, removed.cookie)).status).toBe(403);
    // Another organisation's owner: no such claim here.
    const foreign = await page(d, outsider.cookie);
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toContain("That domain is not claimed here.");
    for (const fields of actions) {
      for (const [who, expected] of [
        [undefined, 303],
        [ordinary.cookie, 403],
        [removed.cookie, 403],
      ] as const) {
        const res = await post(d, who, { org: a, ...fields });
        expect(res.status, `${fields.action} ${who ? "signed in" : "anonymous"}`).toBe(expected);
        expect(res.headers.get("cache-control")).toBe("private, no-store");
      }
      // Another organisation's owner posts naming that organisation: its own (missing) claim, nothing of A's.
      await post(d, outsider.cookie, { org: b, ...fields });
      // Another site: refused outright.
      const offsite = await post(d, owner.cookie, { org: a, ...fields }, "https://evil.example");
      expect(offsite.status).toBe(403);
    }
    expect(world.sends).toEqual([]);
    expect(await stored(id)).toMatchObject({ state: "pending", codes: 0, attempts: 0 });
  });

  it("answers a claim removed meanwhile with its not-claimed page, and a store failing mid-action with try again", async () => {
    const o = await org("Karoo Couriers");
    const d = `gone-${tag()}.example`;
    const id = await claim(o, d);
    const { cookie } = await person(o);
    const prepare = db.prepare.bind(db);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM org_domains WHERE org_id = \? AND domain = \?/.test(sql) && !/verified_at/.test(sql))
        throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const failing = await act(d, cookie, { org: o, action: "check" });
    vi.restoreAllMocks();
    expect(failing.html).toContain("That could not be done just now. Try again in a moment.");
    await db.prepare("DELETE FROM org_domains WHERE id = ?").bind(id).run();
    const gone = await act(d, cookie, { org: o, action: "check" });
    expect(gone.status).toBe(404);
    expect(gone.html).toContain("That domain is not claimed here.");
    expect(gone.html).toContain('href="/settings/domains"');
    const badLocal = await claim(o, `local-${d}`);
    expect(badLocal).toBeTruthy();
    const refused = await act(`local-${d}`, cookie, { org: o, action: "send", local: "hostmaster" });
    expect(refused.html).toContain("Choose admin@ or postmaster@ to send the code to.");
    expect(world.sends).toEqual([]);
  });

  it("shows only a result an action of this organisation signed here in the last ten minutes", async () => {
    const [a, b] = [await org("Karoo Couriers"), await org("Elsewhere")];
    const d = `forge-${tag()}.example`;
    await claim(a, d);
    await claim(b, d);
    const owner = await person(a);
    const other = await person(b);
    // Unsigned: a crafted link claims success, a mailbox and a DNS finding.
    const forged = await (
      await page(d, owner.cookie, "?r=verify-verified&to=attacker%40evil.example&seen=isitlegit-verify%3Dbeef")
    ).text();
    expect(forged).not.toContain("Done:");
    expect(forged).not.toContain("attacker@evil.example");
    expect(forged).not.toContain("beef");
    // A real result of A's, edited, or opened by B, or too old: ignored.
    const real = await post(d, owner.cookie, { org: a, action: "send", local: "admin" });
    const query = new URL(target(real) ?? "", "http://localhost").search;
    expect(await (await page(d, owner.cookie, query)).text()).toContain(`We sent a code to admin@${d}.`);
    expect(await (await page(d, owner.cookie, query.replace("send-sent", "send-failed"))).text()).not.toContain(
      "could not be sent",
    );
    expect(await (await page(d, other.cookie, query)).text()).not.toContain("We sent a code");
    const old = new URLSearchParams(query);
    old.set("t", String(Date.now() - 11 * 60_000));
    expect(await (await page(d, owner.cookie, `?${old}`)).text()).not.toContain("We sent a code");
    // A verified notice is never drawn over a pending claim, signed or not.
    expect(await (await page(d, owner.cookie, "?r=check-verified")).text()).not.toContain("Done:");
  });

  it("answers a store failing while it names the organisation for a member's refusal with the 503 page", async () => {
    const o = await org("Karoo Couriers");
    const d = `role-${tag()}.example`;
    await claim(o, d);
    const { cookie } = await person(o, "member");
    const prepare = db.prepare.bind(db);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/SELECT name FROM "organization" WHERE id = \?/.test(sql))
        throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    for (const res of [await page(d, cookie), await post(d, cookie, { org: o, action: "check" })]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.text()).toContain("Sorry, something broke on our side.");
    }
  });

  it("answers a session store it cannot read with the 503 page", async () => {
    const o = await org("Karoo Couriers");
    const d = `down-${tag()}.example`;
    await claim(o, d);
    const { cookie } = await person(o);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/from "session"/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await page(d, cookie);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Sorry, something broke on our side.");
  });
});

describe("provider DNS help (D07 T04 §11)", () => {
  it("opens every provider's steps from the DNS card, with this claim's record in each", async () => {
    const o = await org("Karoo Couriers");
    const { cookie } = await person(o);
    await claim(o, "kcexpress.example");
    const res = await page("kcexpress.example", cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("How do I add this at my provider?");
    // Finding the DNS host, and the managed-for-you path.
    expect(html).toContain("nameservers point to");
    expect(html).toContain("send them the Name and Value above");
    // Each provider, with the name format it expects and the record's value.
    for (const provider of ["Cloudflare", "Hetzner", "xneelo", "Afrihost", "Another provider"])
      expect(html).toContain(provider);
    expect(html).toContain("Name: _isitlegit (Cloudflare adds your domain to it)");
    expect(html).toContain("Host: _isitlegit (just that part, not the whole name)");
    expect(html).toContain("Record: _isitlegit.kcexpress.example (the whole name, not just _isitlegit)");
    // The claim's unique value, not an example: it changes with the claim.
    const row = await db
      .prepare("SELECT token FROM org_domains WHERE domain = 'kcexpress.example'")
      .first<{ token: string }>();
    expect(html).toContain(`isitlegit-verify=${row?.token}`);
    // TTL and troubleshooting in the steps.
    expect(html).toContain("TTL: leave Auto");
    expect(html).toContain("can take up to an hour");
    expect(html).toContain("_isitlegit.kcexpress.example.kcexpress.example");
    // xneelo's quoted destination.
    expect(html).toContain("in quotation marks, as xneelo asks for them");
  });
});
