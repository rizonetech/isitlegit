import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOH_URL, findMemberBySender } from "../../src/auth/domains";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { addInviteCode } from "../fixtures/auth/members";
import { call, pathOf, sessionCookie } from "./helpers";

// D07 T02 §5: domain and sending-address claims through the Worker's fetch, with DNS-over-HTTPS and SMTP2GO stubbed
// by one fetch stub (two spies on fetch would replace each other).
const db = (env as unknown as Env).DB;

type Doh = Response | "throw";
const world = {
  doh: (_name: string): Doh => Response.json({ Status: 3 }),
  smtp: "sent" as "sent" | "refused" | "silent",
  sends: [] as { to: string; text: string }[],
};
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  world.doh = () => Response.json({ Status: 3 });
  world.smtp = "sent";
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
  const cookie = sessionCookie(await call(pathOf(/https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? "")));
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
  const cookie = sessionCookie(await call(pathOf(/https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? "")));
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
  return sessionCookie(await call(pathOf(/https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? "")));
}
const stateOf = async (orgId: string, domain: string) =>
  (
    await db
      .prepare("SELECT state FROM org_domains WHERE org_id = ? AND domain = ?")
      .bind(orgId, domain)
      .first<{ state: string }>()
  )?.state ?? null;

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
    // A resend during the lock leaves it.
    await json("/domains/coded.co.za/code", cookie, "POST", { local: "admin" });
    expect((await json("/domains/coded.co.za/verify", cookie, "POST", { code: lastCode() })).status).toBe(429);
    // The lock over, the newest code verifies and is consumed.
    await db
      .prepare("UPDATE verification_codes SET locked_until = ?")
      .bind(new Date(Date.now() - 1000).toISOString())
      .run();
    const newest = lastCode();
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

  it("verifies a sending address by code, resends, refuses expired codes, and caps claims and codes", async () => {
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
