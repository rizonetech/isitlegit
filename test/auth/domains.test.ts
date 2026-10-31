import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOH_URL, domainClaimView, findMemberBySender, normaliseClaimCode, registrable } from "../../src/auth/domains";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { addInviteCode } from "../fixtures/auth/members";
import { call, redeem, sessionCookie } from "./helpers";

// D07 T02 §5: domain and sending-address claims through the Worker's fetch, with DNS-over-HTTPS and SMTP2GO stubbed
// by one fetch stub (two spies on fetch would replace each other).
const db = (env as unknown as Env).DB;

type Doh = Response | Promise<Response> | "throw";
const world = {
  doh: (_name: string): Doh => Response.json({ Status: 3 }),
  smtp: "sent" as "sent" | "refused" | "silent",
  smtpDelayMs: 0,
  sends: [] as { to: string; text: string }[],
};
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  world.doh = () => Response.json({ Status: 3 });
  world.smtp = "sent";
  world.smtpDelayMs = 0;
  world.sends = [];
  const real = globalThis.fetch;
  spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(DOH_URL)) {
      const answer = world.doh(new URL(url).searchParams.get("name") ?? "");
      if (answer === "throw") throw new DOMException("timed out", "TimeoutError");
      return answer;
    }
    if (url === SMTP2GO_URL) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; text_body: string };
      if (world.smtpDelayMs) await new Promise((done) => setTimeout(done, world.smtpDelayMs));
      if (world.smtp === "silent") throw new DOMException("timed out", "TimeoutError");
      if (world.smtp === "refused")
        return Response.json({ data: { error_code: "E_ApiResponseCodes.API_EXCEPTION" } }, { status: 400 });
      world.sends.push({ to: body.to[0] ?? "", text: body.text_body });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${world.sends.length}` } });
    }
    return real(input, init);
  });
});
afterEach(() => spy.mockRestore());

const txtAnswer = (value: string) => Response.json({ Status: 0, Answer: [{ type: 16, data: `"${value}"` }] });
const json = (path: string, cookie: string, method: string, body?: unknown) =>
  call(`/api/org${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const lastCode = () => /\b(\d{6})\b/.exec(world.sends.at(-1)?.text ?? "")?.[1] ?? "";

// A real owner: invite-code signup, the first link redeemed (D07 T02 §4).
async function owner(email: string) {
  const code = `code-${crypto.randomUUID()}`;
  await addInviteCode(db, code);
  const signedUp = await call("/api/auth/sign-up/invite-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code, organizationName: `Org of ${email}`, consent: true }),
  });
  if (signedUp.status !== 201) throw new Error(`signup ${signedUp.status}`);
  const cookie = sessionCookie(await redeem(/https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? ""));
  const orgId = (
    await db.prepare("SELECT org_id FROM invite_redemptions WHERE email = ?").bind(email).first<{ org_id: string }>()
  )?.org_id as string;
  return { cookie, orgId };
}
// A member of an organisation with the given role, through Better Auth's invitation.
async function joiner(ownerCookie: string, email: string, role: "member" | "admin") {
  const invited = await call("/api/auth/organization/invite-member", {
    method: "POST",
    headers: { cookie: ownerCookie, "content-type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  const id = new URL(/https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? "http://x/").pathname
    .split("/")
    .at(-1);
  if (invited.status !== 200) throw new Error(`invite ${invited.status}`);
  await call("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const cookie = sessionCookie(await redeem(/https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? ""));
  await call("/api/auth/organization/accept-invitation", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ invitationId: id }),
  });
  // A new session starts in the organisation just joined (the earliest membership).
  await call("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return sessionCookie(await redeem(/https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? ""));
}
const stateOf = async (orgId: string, domain: string) =>
  (
    await db
      .prepare("SELECT state FROM org_domains WHERE org_id = ? AND domain = ?")
      .bind(orgId, domain)
      .first<{ state: string }>()
  )?.state ?? null;

// A pause on a request's own statements on a code: `pausing(pause)` is the database with each guess statement
// (`first` or `run`, not a batch) held after it ran until `release`; `reached` resolves once `count` are held.
function held(count: number) {
  let holding = 0;
  let reach: () => void = () => {};
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hold = async () => {
    holding += 1;
    if (holding === count) reach();
    await released;
  };
  return { reached, release, hold };
}
const GUESS_STATEMENT =
  /^(SELECT expires_at, locked_until FROM verification_codes|UPDATE verification_codes SET attempts)/;
function pausing(pause: { hold: () => Promise<void> }): D1Database {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!GUESS_STATEMENT.test(sql)) return statement;
          const bind = statement.bind.bind(statement);
          statement.bind = (...values: unknown[]) => {
            const bound = bind(...values);
            const first = bound.first.bind(bound) as () => Promise<unknown>;
            const run = bound.run.bind(bound);
            Object.assign(bound, {
              first: async () => {
                const result = await first();
                await pause.hold();
                return result;
              },
              run: async () => {
                const result = await run();
                await pause.hold();
                return result;
              },
            });
            return bound;
          };
          return statement;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
const near = (code: string, n: number) => String((Number(code) + n) % 1_000_000).padStart(6, "0");
const guess = (domain: string, cookie: string, code: string, DB: D1Database) =>
  call(
    `/api/org/domains/${domain}/verify`,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code }) },
    { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}`, DB },
  );
describe("claiming and verifying a domain", () => {
  it("lets an owner claim, verify by DNS, read back and remove a domain", async () => {
    const { cookie, orgId } = await owner("dnsowner@example.org");
    const claimed = await json("/domains", cookie, "POST", { domain: "Mail.Acme-Corp.co.za" });
    expect(claimed.status).toBe(201);
    const { domain, txt } = (await claimed.json()) as { domain: string; txt: { name: string; value: string } };
    expect(domain).toBe("acme-corp.co.za");
    expect(txt.name).toBe("_isitlegit.acme-corp.co.za");
    const listed = (await (await json("/domains", cookie, "GET")).json()) as {
      domains: { domain: string; state: string; txt?: unknown }[];
    };
    expect(listed.domains).toEqual([
      {
        domain,
        state: "pending",
        method: null,
        verified_at: null,
        txt,
        codeExpiresAt: null,
        lockedUntil: null,
        nextCodeAt: null,
      },
    ]);
    world.doh = (name) => (name === txt.name ? txtAnswer(txt.value) : Response.json({ Status: 3 }));
    expect(await (await json(`/domains/${domain}/check`, cookie, "POST")).json()).toEqual({ domain, verified: true });
    expect(await stateOf(orgId, domain)).toBe("verified");
    const after = (await (await json("/domains", cookie, "GET")).json()) as {
      domains: { state: string; method: string; txt?: unknown }[];
    };
    expect(after.domains[0]).toMatchObject({ state: "verified", method: "dns" });
    expect(after.domains[0]?.txt).toBeUndefined();
    expect(await findMemberBySender(db, "Accounts@Billing.Acme-Corp.co.za")).toBe(orgId);
    expect((await json(`/domains/${domain}`, cookie, "DELETE")).status).toBe(204);
    expect(((await (await json("/domains", cookie, "GET")).json()) as { domains: unknown[] }).domains).toEqual([]);
    expect(await findMemberBySender(db, "accounts@acme-corp.co.za")).toBeNull();
  });

  it("lets an admin claim too, refuses a member everywhere, and refuses what is not a claimable domain", async () => {
    const { cookie } = await owner("teamowner@example.org");
    const admin = await joiner(cookie, "teamadmin@example.org", "admin");
    expect((await json("/domains", admin, "POST", { domain: "admins.co.za" })).status).toBe(201);
    const member = await joiner(cookie, "teammember@example.org", "member");
    for (const [path, method, body] of [
      ["/domains", "GET", undefined],
      ["/domains", "POST", { domain: "x.co.za" }],
      ["/domains/admins.co.za/check", "POST", undefined],
      ["/domains/admins.co.za/code", "POST", { local: "admin" }],
      ["/domains/admins.co.za/verify", "POST", { code: "000000" }],
      ["/domains/admins.co.za", "DELETE", undefined],
      ["/addresses", "POST", { address: "a@gmail.com" }],
      ["/addresses/verify", "POST", { address: "a@gmail.com", code: "000000" }],
    ] as const)
      expect((await json(path, member, method, body)).status, `${method} ${path}`).toBe(403);
    for (const bad of ["co.za", "192.168.0.1", "not a domain", "", "x".repeat(300)])
      expect((await json("/domains", cookie, "POST", { domain: bad })).status, bad).toBe(400);
  });

  // The trust lane's finding (2026-10-31): the demo organisations' domains sit under demo.isitlegit.co.za, which the
  // public suffix list does not know, so each reduced to isitlegit.co.za and a demo organisation would have claimed
  // IsItLegit's own domain. demo.isitlegit.co.za is a private suffix here; isitlegit.co.za is never anyone's to claim.
  it("treats each demo domain as its own, and refuses a claim on IsItLegit's own domain", async () => {
    expect(registrable("fynbosfreight.demo.isitlegit.co.za")).toBe("fynbosfreight.demo.isitlegit.co.za");
    expect(registrable("Mail.FynbosFreight.demo.isitlegit.co.za.")).toBe("fynbosfreight.demo.isitlegit.co.za");
    expect(registrable("demo.isitlegit.co.za")).toBeNull();
    expect(registrable("app.isitlegit.co.za")).toBe("isitlegit.co.za");
    expect(registrable("mail.acme-corp.co.za")).toBe("acme-corp.co.za");
    const { cookie } = await owner("demoowner@example.org");
    const demo = await json("/domains", cookie, "POST", { domain: "mail.fynbosfreight.demo.isitlegit.co.za" });
    expect(demo.status).toBe(201);
    expect(((await demo.json()) as { domain: string }).domain).toBe("fynbosfreight.demo.isitlegit.co.za");
    for (const own of ["isitlegit.co.za", "app.isitlegit.co.za", "demo.isitlegit.co.za", "Mail.IsItLegit.co.za"]) {
      const refused = await json("/domains", cookie, "POST", { domain: own });
      expect(refused.status, own).toBe(400);
    }
    const listed = (await (await json("/domains", cookie, "GET")).json()) as { domains: { domain: string }[] };
    expect(listed.domains.map((d) => d.domain)).toEqual(["fynbosfreight.demo.isitlegit.co.za"]);
  });

  it("keeps another organisation out of a claim: 404 for each act, the claim unchanged, no mail", async () => {
    const first = await owner("firstorg@example.org");
    const second = await owner("secondorg@example.org");
    await json("/domains", first.cookie, "POST", { domain: "firsts.co.za" });
    const before = world.sends.length;
    for (const [path, method, body] of [
      ["/domains/firsts.co.za/check", "POST", undefined],
      ["/domains/firsts.co.za/code", "POST", { local: "admin" }],
      ["/domains/firsts.co.za/verify", "POST", { code: "000000" }],
      ["/domains/firsts.co.za", "DELETE", undefined],
    ] as const)
      expect((await json(path, second.cookie, method, body)).status, `${method} ${path}`).toBe(404);
    expect(((await (await json("/domains", second.cookie, "GET")).json()) as { domains: unknown[] }).domains).toEqual(
      [],
    );
    expect(await stateOf(first.orgId, "firsts.co.za")).toBe("pending");
    expect(world.sends.length).toBe(before);
  });

  it("verifies one of two organisations racing for the same domain, refusing the other", async () => {
    const a = await owner("racea@example.org");
    const b = await owner("raceb@example.org");
    const tokens: Record<string, string> = {};
    for (const o of [a, b]) {
      const claimed = (await (await json("/domains", o.cookie, "POST", { domain: "contested.co.za" })).json()) as {
        txt: { value: string };
      };
      tokens[o.orgId] = claimed.txt.value;
    }
    world.doh = () =>
      Response.json({ Status: 0, Answer: Object.values(tokens).map((v) => ({ type: 16, data: `"${v}"` })) });
    const answers = await Promise.all([a, b].map((o) => json("/domains/contested.co.za/check", o.cookie, "POST")));
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    const verified = await db
      .prepare("SELECT COUNT(*) AS n FROM org_domains WHERE domain = 'contested.co.za' AND state = 'verified'")
      .first<{ n: number }>();
    expect(verified?.n).toBe(1);
    // A third organisation cannot claim it now.
    const c = await owner("racec@example.org");
    expect((await json("/domains", c.cookie, "POST", { domain: "contested.co.za" })).status).toBe(409);
  });

  it("tells a DNS record not yet visible from a DNS provider failing, keeping the claim pending", async () => {
    const { cookie, orgId } = await owner("dnsstates@example.org");
    const { txt } = (await (await json("/domains", cookie, "POST", { domain: "slowdns.co.za" })).json()) as {
      txt: { value: string };
    };
    const notYet: Doh[] = [
      Response.json({ Status: 3 }),
      Response.json({ Status: 0 }),
      txtAnswer("isitlegit-verify=wrong"),
    ];
    for (const answer of notYet) {
      world.doh = () => answer;
      const r = await json("/domains/slowdns.co.za/check", cookie, "POST");
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ verified: false, message: expect.stringMatching(/not visible yet/) });
    }
    const failing: Doh[] = [
      Response.json({ Status: 2 }),
      new Response("oops", { status: 500 }),
      new Response("{not json", { status: 200 }),
      "throw",
    ];
    for (const answer of failing) {
      world.doh = () => answer;
      expect((await json("/domains/slowdns.co.za/check", cookie, "POST")).status).toBe(503);
    }
    expect(await stateOf(orgId, "slowdns.co.za")).toBe("pending");
    world.doh = () => txtAnswer(txt.value);
    expect((await (await json("/domains/slowdns.co.za/check", cookie, "POST")).json()) as object).toMatchObject({
      verified: true,
    });
  });
});

// D02 T02 §1: a verified domain's receiving systems, learned from its MX over the same DNS-over-HTTPS stub.
const mxAnswer = (...hosts: string[]) =>
  Response.json({ Status: 0, Answer: hosts.map((h, i) => ({ type: 15, data: `${(i + 1) * 10} ${h}.` })) });
const receiversOf = async (orgId: string) =>
  (
    await db
      .prepare("SELECT domain, kind, pattern FROM org_receivers WHERE org_id = ? ORDER BY domain, kind, pattern")
      .bind(orgId)
      .all<{ domain: string; kind: string; pattern: string }>()
  ).results;

describe("receiving systems learned at verification (D02 T02 §1)", () => {
  it("learns them when a domain is verified by DNS, and removes them with the domain; a re-added claim has none", async () => {
    const { cookie, orgId } = await owner("mxowner@example.org");
    const domain = "mx-dns.co.za";
    const added = (await (await json("/domains", cookie, "POST", { domain })).json()) as {
      txt: { name: string; value: string };
    };
    world.doh = (name) =>
      name === added.txt.name
        ? txtAnswer(added.txt.value)
        : name === domain
          ? mxAnswer("mx-dns-co-za.mail.protection.outlook.com")
          : Response.json({ Status: 3 });
    expect(await (await json(`/domains/${domain}/check`, cookie, "POST")).json()).toEqual({ domain, verified: true });
    await expect.poll(() => receiversOf(orgId)).toEqual([{ domain, kind: "microsoft", pattern: "*.outlook.com" }]);
    expect((await json(`/domains/${domain}`, cookie, "DELETE")).status).toBe(204);
    expect(await receiversOf(orgId)).toEqual([]);
    // Claimed again but not yet verified: nothing of the old claim is trusted.
    await json("/domains", cookie, "POST", { domain });
    expect(await receiversOf(orgId)).toEqual([]);
  });

  it("learns them when a domain is verified by a code", async () => {
    const { cookie, orgId } = await owner("mxcode@example.org");
    await json("/domains", cookie, "POST", { domain: "mx-code.co.za" });
    world.doh = (name) =>
      name === "mx-code.co.za"
        ? mxAnswer("aspmx.l.google.com", "alt1.aspmx.l.google.com")
        : Response.json({ Status: 3 });
    await json("/domains/mx-code.co.za/code", cookie, "POST", { local: "admin" });
    expect(
      await (await json("/domains/mx-code.co.za/verify", cookie, "POST", { code: lastCode() })).json(),
    ).toMatchObject({
      verified: true,
    });
    await expect
      .poll(() => receiversOf(orgId))
      .toEqual([{ domain: "mx-code.co.za", kind: "google", pattern: "*.google.com" }]);
  });

  it("answers verified without waiting for the MX lookup, which still learns the receivers after", async () => {
    const { cookie, orgId } = await owner("mxslow@example.org");
    const domain = "mx-slow.co.za";
    const added = (await (await json("/domains", cookie, "POST", { domain })).json()) as {
      txt: { name: string; value: string };
    };
    let release: () => void = () => {};
    const mx = new Promise<Response>((resolve) => {
      release = () =>
        resolve(
          Response.json({ Status: 0, Answer: [{ type: 15, data: "10 mx-slow-co-za.mail.protection.outlook.com." }] }),
        );
    });
    world.doh = (name) => (name === added.txt.name ? txtAnswer(added.txt.value) : mx);
    const answered = await Promise.race([
      json(`/domains/${domain}/check`, cookie, "POST").then((r) => r.json()),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 1000)),
    ]);
    expect(answered).toEqual({ domain, verified: true });
    expect(await receiversOf(orgId)).toEqual([]);
    release();
    await expect.poll(() => receiversOf(orgId)).toEqual([{ domain, kind: "microsoft", pattern: "*.outlook.com" }]);
  });

  it("verifies the domain all the same when the MX lookup fails, storing no receivers", async () => {
    const { cookie, orgId } = await owner("mxfail@example.org");
    const domain = "mx-fail.co.za";
    const added = (await (await json("/domains", cookie, "POST", { domain })).json()) as {
      txt: { name: string; value: string };
    };
    world.doh = (name) => (name === added.txt.name ? txtAnswer(added.txt.value) : "throw");
    expect(await (await json(`/domains/${domain}/check`, cookie, "POST")).json()).toEqual({ domain, verified: true });
    expect(await stateOf(orgId, domain)).toBe("verified");
    expect(await receiversOf(orgId)).toEqual([]);
  });
});

describe("codes by email", () => {
  it("verifies a domain by a code to admin@, refuses expired, replaced and wrong codes, and locks at three", async () => {
    const { cookie, orgId } = await owner("codeowner@example.org");
    await json("/domains", cookie, "POST", { domain: "coded.co.za" });
    expect((await json("/domains/coded.co.za/code", cookie, "POST", { local: "hostmaster" })).status).toBe(400);
    const sent = await json("/domains/coded.co.za/code", cookie, "POST", { local: "admin" });
    expect(sent.status).toBe(200);
    expect(world.sends.at(-1)?.to).toBe("admin@coded.co.za");
    const first = lastCode();
    // A new code replaces the first.
    await json("/domains/coded.co.za/code", cookie, "POST", { local: "postmaster" });
    expect(world.sends.at(-1)?.to).toBe("postmaster@coded.co.za");
    const second = lastCode();
    expect((await json("/domains/coded.co.za/verify", cookie, "POST", { code: first })).status).toBe(400);
    // Expired.
    await db
      .prepare("UPDATE verification_codes SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect(await (await json("/domains/coded.co.za/verify", cookie, "POST", { code: second })).json()).toMatchObject({
      error: expect.stringMatching(/expired/),
    });
    // A fresh code; three wrong guesses lock it, and the right one is then refused too.
    await json("/domains/coded.co.za/code", cookie, "POST", { local: "admin" });
    const right = lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    expect((await json("/domains/coded.co.za/verify", cookie, "POST", { code: wrong })).status).toBe(400);
    expect((await json("/domains/coded.co.za/verify", cookie, "POST", { code: wrong })).status).toBe(400);
    expect((await json("/domains/coded.co.za/verify", cookie, "POST", { code: wrong })).status).toBe(429);
    expect((await json("/domains/coded.co.za/verify", cookie, "POST", { code: right })).status).toBe(429);
    // No code is sent during the lock (it would expire before the lock ends), and none of the allowance is spent; a
    // reload shows the lock as the time the next code may be sent.
    const mailed = world.sends.length;
    const spent = await db.prepare("SELECT COUNT(*) AS n FROM verification_sends").first<{ n: number }>();
    const refused = await json("/domains/coded.co.za/code", cookie, "POST", { local: "admin" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/lock/) });
    expect(world.sends.length).toBe(mailed);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM verification_sends").first<{ n: number }>()).toEqual(spent);
    const during = (await (await json("/domains", cookie, "GET")).json()) as {
      domains: { lockedUntil: string | null; nextCodeAt: string | null }[];
    };
    expect(during.domains[0]?.lockedUntil).not.toBeNull();
    expect(during.domains[0]?.nextCodeAt).toBe(during.domains[0]?.lockedUntil);
    // The lock over, a new code is sent with a fresh three attempts, and it verifies and is consumed.
    await db
      .prepare("UPDATE verification_codes SET locked_until = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await json("/domains/coded.co.za/code", cookie, "POST", { local: "admin" })).status).toBe(200);
    const newest = lastCode();
    expect(newest).not.toBe(right);
    expect((await json("/domains/coded.co.za/verify", cookie, "POST", { code: right })).status).toBe(400);
    expect(await (await json("/domains/coded.co.za/verify", cookie, "POST", { code: newest })).json()).toMatchObject({
      verified: true,
    });
    expect(await stateOf(orgId, "coded.co.za")).toBe("verified");
    expect(await db.prepare("SELECT 1 FROM verification_codes").first()).toBeNull();
  });

  it("counts four concurrent wrong guesses as three and a lock", async () => {
    const { cookie } = await owner("guesser@example.org");
    await json("/domains", cookie, "POST", { domain: "guessed.co.za" });
    await json("/domains/guessed.co.za/code", cookie, "POST", { local: "admin" });
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    const answers = await Promise.all(
      [0, 1, 2, 3].map(() => json("/domains/guessed.co.za/verify", cookie, "POST", { code: wrong })),
    );
    expect(answers.filter((a) => a.status === 429).length).toBeGreaterThanOrEqual(2);
    const row = await db
      .prepare("SELECT attempts, locked_until FROM verification_codes")
      .first<{ attempts: number; locked_until: string | null }>();
    expect(row?.attempts).toBeLessThanOrEqual(3);
    expect(row?.locked_until).not.toBeNull();
  });

  it("weighs at most three of many guesses arriving together, whichever they are", async () => {
    const { cookie, orgId } = await owner("swarm@example.org");
    await json("/domains", cookie, "POST", { domain: "swarm.co.za" });
    await json("/domains/swarm.co.za/code", cookie, "POST", { local: "admin" });
    const right = lastCode();
    // Twenty guesses at once, the right code among them last.
    const guesses = Array.from({ length: 19 }, (_, i) => String((Number(right) + i + 1) % 1_000_000).padStart(6, "0"));
    guesses.push(right);
    const answers = await Promise.all(
      guesses.map((code) => json("/domains/swarm.co.za/verify", cookie, "POST", { code })),
    );
    const statuses = answers.map((a) => a.status);
    const wrongWeighed = statuses.filter((s) => s === 400).length;
    if (statuses.includes(200)) {
      // The right code got one of the three attempts: at most two wrong guesses were weighed before it.
      expect(wrongWeighed).toBeLessThanOrEqual(2);
      expect(await stateOf(orgId, "swarm.co.za")).toBe("verified");
    } else {
      // It did not: three attempts were taken, the code is locked, and everything else was refused unweighed.
      const row = await db
        .prepare("SELECT attempts, locked_until FROM verification_codes WHERE org_id = ?")
        .bind(orgId)
        .first<{ attempts: number; locked_until: string | null }>();
      expect(row?.attempts).toBe(3);
      expect(row?.locked_until).not.toBeNull();
      expect(wrongWeighed).toBe(2);
      expect(await stateOf(orgId, "swarm.co.za")).toBe("pending");
    }
  });

  it("weighs no guess beyond three, even the right one arriving while three wrong ones are under way", async () => {
    const { cookie, orgId } = await owner("barrier@example.org");
    await json("/domains", cookie, "POST", { domain: "barrier.co.za" });
    await json("/domains/barrier.co.za/code", cookie, "POST", { local: "admin" });
    const right = lastCode();
    // Three wrong guesses each pause after any statement of their own on the code (the point a check-then-count would
    // leave them uncounted) until the right guess has been answered; a guess taken in one transaction never pauses.
    const pause = held(3);
    const wrongs = [1, 2, 3].map((n) => guess("barrier.co.za", cookie, near(right, n), pausing(pause)));
    await Promise.race([pause.reached, Promise.all(wrongs)]);
    const late = await guess("barrier.co.za", cookie, right, db);
    pause.release();
    await Promise.all(wrongs);
    expect(late.status).toBe(429);
    expect(await stateOf(orgId, "barrier.co.za")).toBe("pending");
  });

  it("keeps the lock a third wrong guess sets, even with a resend under way beside it", async () => {
    const { cookie, orgId } = await owner("relockrace@example.org");
    await json("/domains", cookie, "POST", { domain: "relockrace.co.za" });
    await json("/domains/relockrace.co.za/code", cookie, "POST", { local: "admin" });
    const first = lastCode();
    for (const n of [1, 2]) await guess("relockrace.co.za", cookie, near(first, n), db);
    // The third wrong guess pauses after its first statement on the code while a new code is asked for.
    const pause = held(1);
    const third = guess("relockrace.co.za", cookie, near(first, 3), pausing(pause));
    await Promise.race([pause.reached, third]);
    await json("/domains/relockrace.co.za/code", cookie, "POST", { local: "admin" });
    pause.release();
    expect((await third).status).toBe(429);
    // Whatever code was mailed last, it is refused under the lock.
    expect((await guess("relockrace.co.za", cookie, lastCode(), db)).status).toBe(429);
    expect(await stateOf(orgId, "relockrace.co.za")).toBe("pending");
  });

  it("does not let a resend under way bring back a claim removed meanwhile", async () => {
    const { cookie, orgId } = await owner("resendrace@example.org");
    await json("/domains", cookie, "POST", { domain: "resendrace.co.za" });
    const claim = await db
      .prepare("SELECT id, org_id, domain, token, state FROM org_domains WHERE domain = 'resendrace.co.za'")
      .first<Record<string, unknown>>();
    expect((await json("/domains/resendrace.co.za", cookie, "DELETE")).status).toBe(204);
    // The resend read the claim before the removal: its lookup still sees it.
    const staleLookup = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) =>
            sql.startsWith("SELECT id, org_id, domain, token, state FROM org_domains")
              ? { bind: () => ({ first: async () => claim }) }
              : target.prepare(sql);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const before = world.sends.length;
    const resent = await call(
      "/api/org/domains/resendrace.co.za/code",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ local: "admin" }),
      },
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}`, DB: staleLookup },
    );
    expect(resent.status).toBe(404);
    expect(world.sends.length).toBe(before);
    expect(await db.prepare("SELECT 1 FROM verification_codes WHERE claim_id = ?").bind(claim?.id).first()).toBeNull();
    const charged = await db
      .prepare("SELECT COUNT(*) AS n FROM verification_sends WHERE org_id = ? AND target = 'domain:resendrace.co.za'")
      .bind(orgId)
      .first<{ n: number }>();
    expect(charged?.n).toBe(0);
  });

  it("answers each code send's outcome, and allows five codes an hour", async () => {
    const { cookie } = await owner("sender@example.org");
    await json("/domains", cookie, "POST", { domain: "outcomes.co.za" });
    world.smtp = "refused";
    expect((await json("/domains/outcomes.co.za/code", cookie, "POST", { local: "admin" })).status).toBe(502);
    world.smtp = "silent";
    const unknown = await json("/domains/outcomes.co.za/code", cookie, "POST", { local: "admin" });
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toMatchObject({ message: expect.stringMatching(/may have gone/) });
    world.smtp = "sent";
    for (let i = 0; i < 3; i++)
      expect((await json("/domains/outcomes.co.za/code", cookie, "POST", { local: "admin" })).status).toBe(200);
    const lastMailed = lastCode();
    expect((await json("/domains/outcomes.co.za/code", cookie, "POST", { local: "admin" })).status).toBe(429);
    // A code refused for the limit replaces nothing: the last one mailed still works.
    expect(
      await (await json("/domains/outcomes.co.za/verify", cookie, "POST", { code: lastMailed })).json(),
    ).toMatchObject({ verified: true });
  });

  // Twenty claims and their codes in sequence: past the 5-second default when the whole suite shares the machine.
  it("verifies a sending address by code, resends, refuses expired codes, and caps claims and codes", {
    timeout: 20_000,
  }, async () => {
    const { cookie, orgId } = await owner("addrowner@example.org");
    const claimed = await json("/addresses", cookie, "POST", { address: "Owner.Personal@gmail.com" });
    expect(claimed.status).toBe(200);
    expect(world.sends.at(-1)?.to).toBe("owner.personal@gmail.com");
    await db
      .prepare("UPDATE verification_codes SET expires_at = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect(
      (await json("/addresses/verify", cookie, "POST", { address: "owner.personal@gmail.com", code: lastCode() }))
        .status,
    ).toBe(400);
    expect((await json("/addresses/code", cookie, "POST", { address: "owner.personal@gmail.com" })).status).toBe(200);
    expect(
      await (
        await json("/addresses/verify", cookie, "POST", { address: "owner.personal@gmail.com", code: lastCode() })
      ).json(),
    ).toMatchObject({ verified: true });
    expect(await findMemberBySender(db, "Owner.Personal@Gmail.com")).toBe(orgId);
    expect(await findMemberBySender(db, "someone.else@gmail.com")).toBeNull();
    // Five codes an hour for an address, also across removing and re-adding it.
    await json("/addresses", cookie, "POST", { address: "busy@outlook.com" });
    for (let i = 0; i < 2; i++) await json("/addresses/code", cookie, "POST", { address: "busy@outlook.com" });
    expect((await json("/addresses/busy@outlook.com", cookie, "DELETE")).status).toBe(204);
    await json("/addresses", cookie, "POST", { address: "busy@outlook.com" });
    await json("/addresses/code", cookie, "POST", { address: "busy@outlook.com" });
    expect((await json("/addresses/code", cookie, "POST", { address: "busy@outlook.com" })).status).toBe(429);
    // At most 20 pending address claims.
    for (let i = 0; i < 19; i++) await json("/addresses", cookie, "POST", { address: `pending${i}@outlook.com` });
    expect((await json("/addresses", cookie, "POST", { address: "one-too-many@outlook.com" })).status).toBe(429);
  });
});

describe("removal", () => {
  it("leaves nothing stale to restore a removed claim, needs fresh proof to re-add, and keeps the other route", async () => {
    const { cookie, orgId } = await owner("remover@example.org");
    const { txt } = (await (await json("/domains", cookie, "POST", { domain: "removed.co.za" })).json()) as {
      txt: { value: string };
    };
    await json("/domains/removed.co.za/code", cookie, "POST", { local: "admin" });
    const stale = lastCode();
    expect((await json("/domains/removed.co.za", cookie, "DELETE")).status).toBe(204);
    // Its code goes with it.
    expect(await db.prepare("SELECT 1 FROM verification_codes WHERE org_id = ?").bind(orgId).first()).toBeNull();
    world.doh = () => txtAnswer(txt.value);
    expect((await json("/domains/removed.co.za/check", cookie, "POST")).status).toBe(404);
    expect((await json("/domains/removed.co.za/verify", cookie, "POST", { code: stale })).status).toBe(404);
    // Re-added: a new token, and the old record no longer proves it.
    const again = (await (await json("/domains", cookie, "POST", { domain: "removed.co.za" })).json()) as {
      txt: { value: string };
    };
    expect(again.txt.value).not.toBe(txt.value);
    expect(await (await json("/domains/removed.co.za/check", cookie, "POST")).json()).toMatchObject({
      verified: false,
    });
    // A verified address in that domain survives the domain's removal.
    world.doh = () => txtAnswer(again.txt.value);
    await json("/domains/removed.co.za/check", cookie, "POST");
    await json("/addresses", cookie, "POST", { address: "ceo@removed.co.za" });
    await json("/addresses/verify", cookie, "POST", { address: "ceo@removed.co.za", code: lastCode() });
    await json("/domains/removed.co.za", cookie, "DELETE");
    expect(await findMemberBySender(db, "ceo@removed.co.za")).toBe(orgId);
    expect(await findMemberBySender(db, "cfo@removed.co.za")).toBeNull();
  });
});

describe("completion review cases", () => {
  it("lets an admin run a whole address and domain round trip, and refuses a member the address routes too", async () => {
    const { cookie } = await owner("rtowner@example.org");
    const admin = await joiner(cookie, "rtadmin@example.org", "admin");
    await json("/addresses", admin, "POST", { address: "rt@gmail.com" });
    expect(
      await (await json("/addresses/verify", admin, "POST", { address: "rt@gmail.com", code: lastCode() })).json(),
    ).toMatchObject({ verified: true });
    await json("/domains", admin, "POST", { domain: "rt.co.za" });
    await json("/domains/rt.co.za/code", admin, "POST", { local: "postmaster" });
    expect(await (await json("/domains/rt.co.za/verify", admin, "POST", { code: lastCode() })).json()).toMatchObject({
      verified: true,
    });
    const listed = (await (await json("/domains", admin, "GET")).json()) as {
      domains: { state: string }[];
      addresses: { state: string }[];
    };
    expect([listed.domains[0]?.state, listed.addresses[0]?.state]).toEqual(["verified", "verified"]);
    const member = await joiner(cookie, "rtmember@example.org", "member");
    for (const [path, method, body] of [
      ["/addresses/code", "POST", { address: "rt@gmail.com" }],
      ["/addresses/rt@gmail.com", "DELETE", undefined],
    ] as const)
      expect((await json(path, member, method, body)).status, `${method} ${path}`).toBe(403);
    expect((await json("/addresses/rt@gmail.com", admin, "DELETE")).status).toBe(204);
    expect((await json("/domains/rt.co.za", admin, "DELETE")).status).toBe(204);
  });

  it("keeps another organisation out of an address claim, and gives a contested address to one", async () => {
    const a = await owner("addra@example.org");
    const b = await owner("addrb@example.org");
    await json("/addresses", a.cookie, "POST", { address: "shared@gmail.com" });
    const codeA = lastCode();
    const before = world.sends.length;
    for (const [path, method, body] of [
      ["/addresses/code", "POST", { address: "shared@gmail.com" }],
      ["/addresses/verify", "POST", { address: "shared@gmail.com", code: codeA }],
      ["/addresses/shared@gmail.com", "DELETE", undefined],
    ] as const)
      expect((await json(path, b.cookie, method, body)).status, `${method} ${path}`).toBe(404);
    expect(world.sends.length).toBe(before);
    await json("/addresses", b.cookie, "POST", { address: "shared@gmail.com" });
    const codeB = lastCode();
    const answers = await Promise.all([
      json("/addresses/verify", a.cookie, "POST", { address: "shared@gmail.com", code: codeA }),
      json("/addresses/verify", b.cookie, "POST", { address: "shared@gmail.com", code: codeB }),
    ]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
    // The loser's code is still waiting: the refused verification rolled back with its consumption.
    const waiting = await db
      .prepare("SELECT COUNT(*) AS n FROM verification_codes WHERE org_id IN (?, ?)")
      .bind(a.orgId, b.orgId)
      .first<{ n: number }>();
    expect(waiting?.n).toBe(1);
  });

  it("holds each limit when requests arrive together at it", async () => {
    const { cookie } = await owner("limits@example.org");
    for (let i = 0; i < 9; i++) await json("/domains", cookie, "POST", { domain: `pending${i}.co.za` });
    const domains = await Promise.all(
      ["last-a.co.za", "last-b.co.za"].map((d) => json("/domains", cookie, "POST", { domain: d })),
    );
    expect(domains.map((r) => r.status).sort()).toEqual([201, 429]);
    for (let i = 0; i < 19; i++)
      await db
        .prepare(
          "INSERT INTO org_addresses (id, org_id, address, state, created_at) SELECT ?, org_id, ?, 'pending', ? FROM invite_redemptions WHERE email = 'limits@example.org'",
        )
        .bind(`pa-${i}`, `p${i}@outlook.com`, new Date().toISOString())
        .run();
    const addresses = await Promise.all(
      ["x1@outlook.com", "x2@outlook.com"].map((a) => json("/addresses", cookie, "POST", { address: a })),
    );
    expect(addresses.map((r) => r.status).sort()).toEqual([200, 429]);
    // One domain's five codes, shared by admin@ and postmaster@, and the last one taken by one of two at once.
    for (let i = 0; i < 3; i++) await json("/domains/pending0.co.za/code", cookie, "POST", { local: "admin" });
    await json("/domains/pending0.co.za/code", cookie, "POST", { local: "postmaster" });
    const codes = await Promise.all(
      ["admin", "postmaster"].map((local) => json("/domains/pending0.co.za/code", cookie, "POST", { local })),
    );
    expect(codes.map((r) => r.status).sort()).toEqual([200, 429]);
    // A reload sees when the next code may be sent.
    const listed = (await (await json("/domains", cookie, "GET")).json()) as {
      domains: { domain: string; nextCodeAt: string | null; codeExpiresAt: string | null }[];
    };
    const pending0 = listed.domains.find((d) => d.domain === "pending0.co.za");
    expect(pending0?.nextCodeAt).not.toBeNull();
    expect(pending0?.codeExpiresAt).not.toBeNull();
  });

  it("shows a locked claim's lock on a reload, without a trial guess", async () => {
    const { cookie } = await owner("relock@example.org");
    await json("/domains", cookie, "POST", { domain: "relock.co.za" });
    await json("/domains/relock.co.za/code", cookie, "POST", { local: "admin" });
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    for (let i = 0; i < 3; i++) await json("/domains/relock.co.za/verify", cookie, "POST", { code: wrong });
    const listed = (await (await json("/domains", cookie, "GET")).json()) as {
      domains: { lockedUntil: string | null }[];
    };
    expect(Date.parse(listed.domains[0]?.lockedUntil ?? "") - Date.now()).toBeGreaterThan(50 * 60_000);
  });

  it("answers a database failure 503, keeping the code, and verifies on the retry", async () => {
    const { cookie, orgId } = await owner("dbfail@example.org");
    await json("/addresses", cookie, "POST", { address: "dbfail@gmail.com" });
    const code = lastCode();
    // Two wrong guesses first, so the failed right one would have been the last attempt.
    for (const n of [1, 2])
      await json("/addresses/verify", cookie, "POST", { address: "dbfail@gmail.com", code: near(code, n) });
    const failingBatch = new Proxy(db, {
      get(target, key) {
        if (key === "batch") return async () => Promise.reject(new Error("D1_ERROR: Network connection lost."));
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failed = await call(
      "/api/org/addresses/verify",
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ address: "dbfail@gmail.com", code }),
      },
      { ...(env as unknown as Env), SMTP2GO_API_KEY: `api-${"k".repeat(32)}`, DB: failingBatch },
    );
    expect(failed.status).toBe(503);
    expect(await db.prepare("SELECT 1 FROM verification_codes").first()).not.toBeNull();
    expect(
      await (await json("/addresses/verify", cookie, "POST", { address: "dbfail@gmail.com", code })).json(),
    ).toMatchObject({ verified: true });
    expect(await findMemberBySender(db, "dbfail@gmail.com")).toBe(orgId);
  });

  it("refuses malformed requests with 400, changing nothing and sending nothing", async () => {
    const { cookie } = await owner("malformed@example.org");
    await json("/domains", cookie, "POST", { domain: "kept.co.za" });
    const before = world.sends.length;
    for (const bad of [
      "https://example.com/path",
      "person@example.com",
      "example.com/x",
      "exa mple.com",
      "-bad.co.za",
      "ex_ample.com",
    ])
      expect((await json("/domains", cookie, "POST", { domain: bad })).status, bad).toBe(400);
    for (const body of [null, [], "text", 5])
      for (const [path, method] of [
        ["/domains", "POST"],
        ["/domains/kept.co.za/code", "POST"],
        ["/domains/kept.co.za/verify", "POST"],
        ["/addresses", "POST"],
        ["/addresses/verify", "POST"],
      ] as const)
        expect((await json(path, cookie, method, body)).status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
    expect(world.sends.length).toBe(before);
    const listed = (await (await json("/domains", cookie, "GET")).json()) as {
      domains: unknown[];
      addresses: unknown[];
    };
    expect([listed.domains.length, listed.addresses.length]).toEqual([1, 0]);
  });

  it("does not let a DNS check already under way restore a claim removed meanwhile", async () => {
    const { cookie, orgId } = await owner("inflight@example.org");
    const { txt } = (await (await json("/domains", cookie, "POST", { domain: "inflight.co.za" })).json()) as {
      txt: { value: string };
    };
    // The claim is removed while the DNS answer is on its way back.
    world.doh = () => {
      void db.prepare("DELETE FROM org_domains WHERE domain = 'inflight.co.za'").run();
      return txtAnswer(txt.value);
    };
    const answered = await json("/domains/inflight.co.za/check", cookie, "POST");
    expect(answered.status).toBe(404);
    expect(await stateOf(orgId, "inflight.co.za")).toBeNull();
    // Removing an address keeps the domain's admission.
    world.doh = () => txtAnswer("isitlegit-verify=none");
    const again = (await (await json("/domains", cookie, "POST", { domain: "inflight.co.za" })).json()) as {
      txt: { value: string };
    };
    world.doh = () => txtAnswer(again.txt.value);
    await json("/domains/inflight.co.za/check", cookie, "POST");
    await json("/addresses", cookie, "POST", { address: "boss@inflight.co.za" });
    await json("/addresses/verify", cookie, "POST", { address: "boss@inflight.co.za", code: lastCode() });
    await json("/addresses/boss@inflight.co.za", cookie, "DELETE");
    expect(await findMemberBySender(db, "boss@inflight.co.za")).toBe(orgId);
  });

  it("gives up on a DNS provider that never answers after ten seconds", { timeout: 20_000 }, async () => {
    const { cookie, orgId } = await owner("deadline@example.org");
    await json("/domains", cookie, "POST", { domain: "deadline.co.za" });
    spy.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(DOH_URL)) throw new Error("unexpected fetch");
      // Never answers; only the request's own deadline ends it.
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    });
    const started = Date.now();
    const answered = await json("/domains/deadline.co.za/check", cookie, "POST");
    expect(answered.status).toBe(503);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
    expect(await stateOf(orgId, "deadline.co.za")).toBe("pending");
  });
});

describe("the domain page's needs (D07 T02 §15)", () => {
  it("reads a code as people type it, keeping leading zeroes, and nothing else as a code", () => {
    expect(normaliseClaimCode("482107")).toBe("482107");
    expect(normaliseClaimCode(" 48 21 07 ")).toBe("482107");
    expect(normaliseClaimCode("482-107")).toBe("482107");
    expect(normaliseClaimCode("007 001")).toBe("007001");
    for (const bad of ["48210", "4821077", "48a107", "48  2107", "48--2107", "", "-482107"])
      expect(normaliseClaimCode(bad), bad).toBeNull();
  });

  it("verifies a grouped code, and refuses a malformed one without spending an attempt", async () => {
    const { cookie, orgId } = await owner("grouped@example.org");
    await json("/domains", cookie, "POST", { domain: "grouped.co.za" });
    await json("/domains/grouped.co.za/code", cookie, "POST", { local: "admin" });
    const code = lastCode();
    const bad = await json("/domains/grouped.co.za/verify", cookie, "POST", { code: "48a107" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "send the 6 digits you were mailed" });
    expect((await domainClaimView(db, orgId, "grouped.co.za"))?.code.attempts).toBe(0);
    const grouped = `${code.slice(0, 2)} ${code.slice(2, 4)} ${code.slice(4)}`;
    expect((await json("/domains/grouped.co.za/verify", cookie, "POST", { code: grouped })).status).toBe(200);
    expect((await domainClaimView(db, orgId, "grouped.co.za"))?.state).toBe("verified");
  });

  it("names a different verification record a check finds, and keeps the check for the page", async () => {
    const { cookie, orgId } = await owner("different@example.org");
    await json("/domains", cookie, "POST", { domain: "different.co.za" });
    world.doh = () => txtAnswer("isitlegit-verify=0b19aaaabbbbccccddddeeeeffff0000");
    expect((await json("/domains/different.co.za/check", cookie, "POST")).status).toBe(200);
    const view = await domainClaimView(db, orgId, "different.co.za");
    expect(view).toMatchObject({ state: "pending", lastCheck: { outcome: "dns-different" } });
    world.doh = () => Response.json({ Status: 3 });
    await json("/domains/different.co.za/check", cookie, "POST");
    expect((await domainClaimView(db, orgId, "different.co.za"))?.lastCheck?.outcome).toBe("dns-not-visible");
    expect(await domainClaimView(db, orgId, "never-claimed.co.za")).toBeNull();
  });
});

describe("a code still being mailed (D07 T02 §15)", () => {
  it("lets one of two presses at once through and refuses the other, the mailer slow", async () => {
    const { cookie } = await owner("racing@example.org");
    await json("/domains", cookie, "POST", { domain: "racing.co.za" });
    const mailed = world.sends.length;
    world.smtpDelayMs = 300;
    const answers = await Promise.all([
      json("/domains/racing.co.za/code", cookie, "POST", { local: "admin" }),
      json("/domains/racing.co.za/code", cookie, "POST", { local: "postmaster" }),
    ]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 429]);
    expect(world.sends.length).toBe(mailed + 1);
  });

  it("issues no new code while the last one's mail is unfinished, and does once it finished or is old", async () => {
    const { cookie, orgId } = await owner("sending@example.org");
    await json("/domains", cookie, "POST", { domain: "sending.co.za" });
    const claimId = (
      await db
        .prepare("SELECT id FROM org_domains WHERE org_id = ? AND domain = ?")
        .bind(orgId, "sending.co.za")
        .first<{ id: string }>()
    )?.id;
    expect((await json("/domains/sending.co.za/code", cookie, "POST", { local: "admin" })).status).toBe(200);
    // Its send still pending (the mailer retrying): no new code, no mail.
    const unfinished = (status: string) =>
      db.prepare("UPDATE mail_sends SET status = ? WHERE send_key LIKE ?").bind(status, `claim:${claimId}:%`).run();
    await unfinished("pending");
    const mailed = world.sends.length;
    const refused = await json("/domains/sending.co.za/code", cookie, "POST", { local: "admin" });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/still being sent/) });
    expect(world.sends.length).toBe(mailed);
    // Issued long enough ago (its Worker gone): the claim is free again.
    await db
      .prepare("UPDATE verification_codes SET expires_at = ? WHERE claim_id = ?")
      .bind(new Date(Date.now() + 25 * 60_000).toISOString(), claimId)
      .run();
    expect((await json("/domains/sending.co.za/code", cookie, "POST", { local: "admin" })).status).toBe(200);
    // Finished (sent): a resend goes as before.
    expect((await json("/domains/sending.co.za/code", cookie, "POST", { local: "admin" })).status).toBe(200);
  });
});

describe("final review cases", () => {
  it("locks an address after three wrong codes, sends nothing under the lock, and lets a new code verify after it", async () => {
    const { cookie, orgId } = await owner("addrlock@example.org");
    await json("/addresses", cookie, "POST", { address: "locked@gmail.com" });
    const right = lastCode();
    for (const n of [1, 2])
      await json("/addresses/verify", cookie, "POST", { address: "locked@gmail.com", code: near(right, n) });
    expect(
      (await json("/addresses/verify", cookie, "POST", { address: "locked@gmail.com", code: near(right, 3) })).status,
    ).toBe(429);
    expect((await json("/addresses/verify", cookie, "POST", { address: "locked@gmail.com", code: right })).status).toBe(
      429,
    );
    const mailed = world.sends.length;
    expect((await json("/addresses/code", cookie, "POST", { address: "locked@gmail.com" })).status).toBe(429);
    expect(world.sends.length).toBe(mailed);
    await db
      .prepare("UPDATE verification_codes SET locked_until = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    expect((await json("/addresses/code", cookie, "POST", { address: "locked@gmail.com" })).status).toBe(200);
    expect(
      await (await json("/addresses/verify", cookie, "POST", { address: "locked@gmail.com", code: lastCode() })).json(),
    ).toMatchObject({ verified: true });
    expect(await findMemberBySender(db, "locked@gmail.com")).toBe(orgId);
  });

  it("bounds an organisation's claim mail across claims removed and made again", async () => {
    const { cookie, orgId } = await owner("budget@example.org");
    // Claiming, removing and claiming another address spends the organisation's hourly twenty.
    for (let i = 0; i < 20; i++) {
      expect((await json("/addresses", cookie, "POST", { address: `target${i}@outlook.com` })).status).toBe(200);
      expect((await json(`/addresses/target${i}@outlook.com`, cookie, "DELETE")).status).toBe(204);
    }
    const mailed = world.sends.length;
    const over = await json("/addresses", cookie, "POST", { address: "target20@outlook.com" });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: expect.stringMatching(/organisation/) });
    expect(world.sends.length).toBe(mailed);
    // The claim waits, and a reload says when a code may be sent: an hour after the first of the twenty.
    const listed = (await (await json("/domains", cookie, "GET")).json()) as {
      addresses: { address: string; nextCodeAt: string | null }[];
    };
    const first = await db
      .prepare("SELECT MIN(sent_at) AS at FROM verification_sends WHERE org_id = ?")
      .bind(orgId)
      .first<{ at: string }>();
    expect(listed.addresses.find((a) => a.address === "target20@outlook.com")?.nextCodeAt).toBe(
      new Date(Date.parse(first?.at ?? "") + 60 * 60_000).toISOString(),
    );
  });

  it("bounds an organisation's claim mail to fifty a day", async () => {
    const { cookie, orgId } = await owner("daily@example.org");
    // Fifty sends over the past day, none in the last hour.
    const old = Date.now() - 2 * 60 * 60_000;
    for (let i = 0; i < 50; i++)
      await db
        .prepare("INSERT INTO verification_sends (id, org_id, target, sent_at) VALUES (?, ?, ?, ?)")
        .bind(`day-${i}`, orgId, `address:old${i}@outlook.com`, new Date(old - i * 60_000).toISOString())
        .run();
    const over = await json("/addresses", cookie, "POST", { address: "fresh@outlook.com" });
    expect(over.status).toBe(429);
    const listed = (await (await json("/domains", cookie, "GET")).json()) as {
      addresses: { nextCodeAt: string | null }[];
    };
    // The oldest of the fifty ages out of the day first.
    expect(listed.addresses[0]?.nextCodeAt).toBe(new Date(old - 49 * 60_000 + 24 * 60 * 60_000).toISOString());
  });

  it("answers a resend for a verified address 409, as for a domain", async () => {
    const { cookie } = await owner("verifiedresend@example.org");
    await json("/addresses", cookie, "POST", { address: "done@gmail.com" });
    await json("/addresses/verify", cookie, "POST", { address: "done@gmail.com", code: lastCode() });
    const mailed = world.sends.length;
    expect((await json("/addresses/code", cookie, "POST", { address: "done@gmail.com" })).status).toBe(409);
    expect(world.sends.length).toBe(mailed);
  });

  it("answers a DNS check verified when the emailed code verified the domain while DNS was answering", async () => {
    const { cookie, orgId } = await owner("bothways@example.org");
    const { txt } = (await (await json("/domains", cookie, "POST", { domain: "bothways.co.za" })).json()) as {
      txt: { value: string };
    };
    await json("/domains/bothways.co.za/code", cookie, "POST", { local: "admin" });
    const code = lastCode();
    // The check reads the claim, then the code verifies it before the DNS answer arrives.
    const pause = held(1);
    let answered: () => void = () => {};
    const dnsArrives = new Promise<void>((resolve) => {
      answered = resolve;
    });
    spy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(DOH_URL)) throw new Error("unexpected fetch");
      pause.hold();
      await dnsArrives;
      return txtAnswer(txt.value);
    });
    const check = json("/domains/bothways.co.za/check", cookie, "POST");
    await pause.reached;
    pause.release();
    spy.mockRestore();
    expect(await (await json("/domains/bothways.co.za/verify", cookie, "POST", { code })).json()).toMatchObject({
      verified: true,
    });
    answered();
    const result = await check;
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ verified: true });
    expect(await stateOf(orgId, "bothways.co.za")).toBe("verified");
  });

  it("finds an organisation for an address only", async () => {
    const { cookie, orgId } = await owner("onlyaddr@example.org");
    const { txt } = (await (await json("/domains", cookie, "POST", { domain: "onlyaddr.co.za" })).json()) as {
      txt: { value: string };
    };
    world.doh = () => txtAnswer(txt.value);
    await json("/domains/onlyaddr.co.za/check", cookie, "POST");
    expect(await findMemberBySender(db, "boss@onlyaddr.co.za")).toBe(orgId);
    for (const sender of ["onlyaddr.co.za", "@onlyaddr.co.za", "boss@", "a@b@onlyaddr.co.za", ""])
      expect(await findMemberBySender(db, sender), sender).toBeNull();
  });
});
