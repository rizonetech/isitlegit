import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_EVENTS_RETENTION_DAYS, sweepAuthTables } from "../../src/auth/audit";
import { DOH_URL } from "../../src/auth/domains";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { addInviteCode } from "../fixtures/auth/members";
import { call, ORIGIN, redeem, sessionCookie } from "./helpers";
import { SoftAuthenticator } from "./webauthn";

// The auth audit trail (D07 T02 §6), each row driven through the route that makes it: the Worker's fetch, with
// SMTP2GO and DNS-over-HTTPS stubbed by one fetch stub.
const db = (env as unknown as Env).DB;
const IP = "203.0.113.77";

const world = {
  doh: (): Response | "throw" => Response.json({ Status: 3 }),
  sends: [] as { to: string; text: string }[],
};
let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  world.doh = () => Response.json({ Status: 3 });
  world.sends = [];
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
      world.sends.push({ to: body.to[0] ?? "", text: body.text_body });
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${world.sends.length}` } });
    }
    return real(input, init);
  });
});
afterEach(() => {
  spy.mockRestore();
  vi.restoreAllMocks();
});

const lastLink = () => /https?:\/\/\S+/.exec(world.sends.at(-1)?.text ?? "")?.[0] ?? "";
const api = (path: string, cookie: string, body?: unknown, method = "POST") =>
  call(path, {
    method,
    headers: { cookie, "content-type": "application/json", "cf-connecting-ip": IP },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const events = async (kind: string, where = "1 = 1", ...values: unknown[]) =>
  (
    await db
      .prepare(`SELECT * FROM auth_events WHERE kind = ? AND ${where} ORDER BY at`)
      .bind(kind, ...values)
      .all<Record<string, string | null>>()
  ).results;
const userIdOf = async (email: string) =>
  (await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>())?.id as string;

async function owner(email: string) {
  const code = `code-${crypto.randomUUID()}`;
  await addInviteCode(db, code);
  const signedUp = await call("/api/auth/sign-up/invite-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code, organizationName: `Org of ${email}`, consent: true }),
  });
  if (signedUp.status !== 201) throw new Error(`signup ${signedUp.status}`);
  const cookie = sessionCookie(await redeem(lastLink()));
  const orgId = (
    await db.prepare("SELECT org_id FROM invite_redemptions WHERE email = ?").bind(email).first<{ org_id: string }>()
  )?.org_id as string;
  return { cookie, orgId };
}
const signInAs = async (email: string) => {
  await call("/api/auth/sign-in/magic-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return sessionCookie(await redeem(lastLink()));
};
async function joiner(ownerCookie: string, email: string, role: "member" | "admin") {
  const invited = await api("/api/auth/organization/invite-member", ownerCookie, { email, role });
  if (invited.status !== 200) throw new Error(`invite ${invited.status}`);
  const id = new URL(lastLink()).pathname.split("/").at(-1);
  const cookie = await signInAs(email);
  await api("/api/auth/organization/accept-invitation", cookie, { invitationId: id });
  return { cookie: await signInAs(email), invitationId: id as string };
}
const unique = () => crypto.randomUUID().slice(0, 8);

describe("the auth audit trail", () => {
  it("records a sign-in by a magic link and by a passkey, each once, with its method", async () => {
    const email = `signin-${unique()}@example.org`;
    const { cookie } = await owner(email);
    const userId = await userIdOf(email);
    expect(
      (await events("sign-in", "user_id = ?", userId)).map((e) => JSON.parse(e.detail_json ?? "{}").method),
    ).toEqual(["magic-link"]);
    const authenticator = new SoftAuthenticator();
    const options = await call("/api/auth/passkey/generate-register-options", { headers: { cookie } });
    const challenge = options.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const created = await authenticator.create(await options.json(), ORIGIN);
    await api("/api/auth/passkey/verify-registration", `${cookie}; ${challenge}`, {
      response: created,
      name: "Laptop",
    });
    const auth = await call("/api/auth/passkey/generate-authenticate-options");
    const authCookie = auth.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const assertion = await authenticator.get(await auth.json(), ORIGIN);
    const passkey = await api("/api/auth/passkey/verify-authentication", authCookie, { response: assertion });
    expect(passkey.status).toBe(200);
    expect(
      (await events("sign-in", "user_id = ?", userId)).map((e) => JSON.parse(e.detail_json ?? "{}").method),
    ).toEqual(["magic-link", "passkey"]);
  });

  it("records each failed link with Better Auth's reason, and keeps no address, token or IP", async () => {
    const email = `failed-${unique()}@example.org`;
    await owner(email);
    await call("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const link = lastLink();
    const token = new URL(link).searchParams.get("token") ?? "";
    await redeem(link);
    const confirm = (t: string) =>
      call("/signin/confirm", {
        method: "POST",
        headers: { "cf-connecting-ip": IP },
        body: new URLSearchParams({ token: t, callbackURL: "/cases" }),
      });
    await confirm(token);
    await call("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const expiring = new URL(lastLink()).searchParams.get("token") ?? "";
    await db
      .prepare(`UPDATE verification SET "expiresAt" = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();
    await confirm(expiring);
    const failed = await events("sign-in-failed");
    expect(failed.map((e) => e.outcome)).toEqual(expect.arrayContaining(["invalid_token"]));
    expect(failed.length).toBeGreaterThanOrEqual(2);
    const all = JSON.stringify((await db.prepare("SELECT * FROM auth_events").all()).results);
    for (const secret of [email, token, expiring, IP]) expect(all).not.toContain(secret);
  });

  it("records an invitation, a role change, a revocation and a removal, attributable and kept after the member leaves", async () => {
    const ownerEmail = `team-${unique()}@example.org`;
    const { cookie, orgId } = await owner(ownerEmail);
    const ownerId = await userIdOf(ownerEmail);
    const memberEmail = `member-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    const memberId = await userIdOf(memberEmail);
    expect(
      (
        await api("/api/auth/organization/update-member-role", cookie, {
          memberId: (
            await db.prepare(`SELECT id FROM "member" WHERE "userId" = ?`).bind(memberId).first<{ id: string }>()
          )?.id,
          role: "admin",
        })
      ).status,
    ).toBe(200);
    const pending = await api("/api/auth/organization/invite-member", cookie, {
      email: `pending-${unique()}@example.org`,
      role: "member",
    });
    const pendingId = ((await pending.json()) as { id: string }).id;
    expect((await api("/api/auth/organization/cancel-invitation", cookie, { invitationId: pendingId })).status).toBe(
      200,
    );
    expect((await api("/api/auth/organization/remove-member", cookie, { memberIdOrEmail: memberEmail })).status).toBe(
      200,
    );
    const byOrg = (kind: string) => events(kind, "org_id = ?", orgId);
    expect((await byOrg("invite")).length).toBe(2);
    expect(await byOrg("update-member-role")).toEqual([
      expect.objectContaining({ actor_id: ownerId, target_id: memberId, outcome: "changed" }),
    ]);
    expect(await byOrg("cancel-invitation")).toEqual([
      expect.objectContaining({ actor_id: ownerId, target_id: pendingId, outcome: "revoked" }),
    ]);
    expect(await byOrg("remove-member")).toEqual([
      expect.objectContaining({ actor_id: ownerId, target_id: memberId, outcome: "removed" }),
    ]);
  });

  it("writes no success row for a refused change", async () => {
    const { cookie, orgId } = await owner(`refuse-${unique()}@example.org`);
    const { cookie: memberCookie } = await joiner(cookie, `plain-${unique()}@example.org`, "member");
    const refused = await api("/api/auth/organization/remove-member", memberCookie, {
      memberIdOrEmail: "nobody@example.org",
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await events("remove-member", "org_id = ?", orgId)).toEqual([]);
  });

  it("records each domain and address verification attempt with its outcome", async () => {
    const { cookie, orgId } = await owner(`verify-${unique()}@example.org`);
    const domain = `v${unique()}.co.za`;
    await api("/api/org/domains", cookie, { domain });
    await api(`/api/org/domains/${domain}/check`, cookie);
    world.doh = () => "throw";
    await api(`/api/org/domains/${domain}/check`, cookie);
    await api(`/api/org/domains/${domain}/code`, cookie, { local: "admin" });
    await api(`/api/org/domains/${domain}/verify`, cookie, { code: "000000" });
    const code = /\b(\d{6})\b/.exec(world.sends.at(-1)?.text ?? "")?.[1] ?? "";
    await api(`/api/org/domains/${domain}/verify`, cookie, { code });
    const outcomes = (await events("verify-domain", "org_id = ?", orgId)).map((e) => e.outcome);
    expect(outcomes).toEqual(["dns-not-visible", "dns-lookup-failed", "wrong", "verified-code"]);
    const address = `sender-${unique()}@gmail.com`;
    await api("/api/org/addresses", cookie, { address });
    await api("/api/org/addresses/verify", cookie, { address, code: "000000" });
    expect((await events("verify-address", "org_id = ?", orgId)).map((e) => e.outcome)).toEqual(["wrong"]);
    const all = JSON.stringify((await db.prepare("SELECT * FROM auth_events").all()).results);
    expect(all).not.toContain(code);
    expect(all).not.toContain(address);
  });
});

describe("the team history", () => {
  it("is read by the organisation's owner only, newest first and filtered", async () => {
    const { cookie, orgId } = await owner(`history-${unique()}@example.org`);
    const { cookie: adminCookie } = await joiner(cookie, `admin-${unique()}@example.org`, "admin");
    const { cookie: memberCookie } = await joiner(cookie, `m-${unique()}@example.org`, "member");
    const leaving = `leaving-${unique()}@example.org`;
    await joiner(cookie, leaving, "member");
    await api("/api/auth/organization/remove-member", cookie, { memberIdOrEmail: leaving });
    const read = (c: string, query = "") => call(`/api/team/history${query}`, { headers: { cookie: c } });
    const all = (await (await read(cookie)).json()) as { changes: { action: string; at: string }[] };
    expect(all.changes.map((c) => c.action)).toEqual(["remove-member"]);
    const filtered = (await (await read(cookie, "?action=update-member-role")).json()) as { changes: unknown[] };
    expect(filtered.changes).toEqual([]);
    expect((await read(cookie, "?from=yesterday")).status).toBe(400);
    expect((await read(adminCookie)).status).toBe(403);
    expect((await read(memberCookie)).status).toBe(403);
    const other = await owner(`other-${unique()}@example.org`);
    const theirs = (await (await read(other.cookie)).json()) as { changes: unknown[] };
    expect(theirs.changes).toEqual([]);
    expect(orgId).not.toBe(other.orgId);
  });
});

describe("a failing audit write", () => {
  it("still signs the member in and still persists a team change, each with one log line", async () => {
    const ownerEmail = `resilient-${unique()}@example.org`;
    const { cookie } = await owner(ownerEmail);
    const memberEmail = `kept-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(String(line)));
    await db.prepare("ALTER TABLE auth_events RENAME TO auth_events_away").run();
    try {
      const removed = await api("/api/auth/organization/remove-member", cookie, { memberIdOrEmail: memberEmail });
      expect(removed.status).toBe(200);
      expect(
        await db
          .prepare(`SELECT 1 FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
          .bind(memberEmail)
          .first(),
      ).toBeNull();
      const signedIn = await signInAs(ownerEmail);
      expect(signedIn).toContain("session_token");
    } finally {
      await db.prepare("ALTER TABLE auth_events_away RENAME TO auth_events").run();
    }
    expect(errors.filter((line) => line.includes('"auth-audit"') && line.includes('"remove-member"'))).toHaveLength(1);
    expect(
      errors.filter((line) => line.includes('"auth-audit"') && line.includes('"sign-in"')).length,
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("retention", () => {
  it("sweeps a row past its retention and keeps a recent one", async () => {
    const old = new Date(Date.now() - (AUTH_EVENTS_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    await db.batch([
      db
        .prepare("INSERT INTO auth_events (id, at, kind, outcome) VALUES ('old-row', ?, 'sign-in', 'signed-in')")
        .bind(old),
      db
        .prepare("INSERT INTO auth_events (id, at, kind, outcome) VALUES ('new-row', ?, 'sign-in', 'signed-in')")
        .bind(new Date().toISOString()),
    ]);
    await sweepAuthTables(db);
    const ids = (await db.prepare("SELECT id FROM auth_events WHERE id IN ('old-row', 'new-row')").all()).results;
    expect(ids).toEqual([{ id: "new-row" }]);
  });
});

describe("completion review (2026-10-29)", () => {
  it("attributes a resend to the admin who resent it, and records a role change's from and to", async () => {
    const ownerEmail = `resend-${unique()}@example.org`;
    const { cookie, orgId } = await owner(ownerEmail);
    const adminEmail = `resender-${unique()}@example.org`;
    const { cookie: adminCookie } = await joiner(cookie, adminEmail, "admin");
    const invitee = `invitee-${unique()}@example.org`;
    await api("/api/auth/organization/invite-member", cookie, { email: invitee, role: "member" });
    await api("/api/auth/organization/invite-member", adminCookie, { email: invitee, role: "member", resend: true });
    const invites = await events("invite", "org_id = ?", orgId);
    expect(invites.at(-1)).toMatchObject({ actor_id: await userIdOf(adminEmail), outcome: "resent" });
    const memberEmail = `roles-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    const memberRow = await db
      .prepare(`SELECT m.id FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
      .bind(memberEmail)
      .first<{ id: string }>();
    await api("/api/auth/organization/update-member-role", cookie, { memberId: memberRow?.id, role: "admin" });
    await api("/api/auth/organization/update-member-role", cookie, { memberId: memberRow?.id, role: "member" });
    await api("/api/auth/organization/remove-member", cookie, { memberIdOrEmail: memberEmail });
    const changes = (await events("update-member-role", "org_id = ?", orgId)).map((e) =>
      JSON.parse(e.detail_json ?? "{}"),
    );
    expect(changes).toEqual([
      { from: "member", to: "admin" },
      { from: "admin", to: "member" },
    ]);
  });

  it("pages the history by a stable cursor, newest first, and filters equivalent dates alike", async () => {
    const { cookie, orgId } = await owner(`pages-${unique()}@example.org`);
    const at = "2026-10-29T07:00:00.000Z";
    const insert = db.prepare(
      "INSERT INTO auth_events (id, at, kind, outcome, org_id) VALUES (?, ?, 'remove-member', 'removed', ?)",
    );
    await db.batch(
      Array.from({ length: 101 }, (_, i) =>
        insert.bind(
          crypto.randomUUID(),
          i < 3 ? at : `2026-10-29T06:${String(i % 60).padStart(2, "0")}:00.500Z`,
          orgId,
        ),
      ),
    );
    const read = (query: string) => call(`/api/team/history${query}`, { headers: { cookie } });
    const first = (await (await read("")).json()) as { changes: { at: string }[]; next: string | null };
    expect(first.changes).toHaveLength(100);
    expect(first.next).not.toBeNull();
    const ats = first.changes.map((c) => c.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    const second = (await (await read(`?after=${encodeURIComponent(first.next ?? "")}`)).json()) as {
      changes: unknown[];
      next: string | null;
    };
    expect(second.changes).toHaveLength(1);
    expect(second.next).toBeNull();
    const plain = (await (await read("?from=2026-10-29T07:00:00Z")).json()) as { changes: unknown[] };
    const millis = (await (await read("?from=2026-10-29T07:00:00.000Z")).json()) as { changes: unknown[] };
    const offset = (await (await read(`?from=${encodeURIComponent("2026-10-29T09:00:00+02:00")}`)).json()) as {
      changes: unknown[];
    };
    expect([plain.changes.length, millis.changes.length, offset.changes.length]).toEqual([3, 3, 3]);
  });

  it("records a verification by DNS, an expired and a locked code, and a verified address", async () => {
    const { cookie, orgId } = await owner(`more-${unique()}@example.org`);
    const domain = `d${unique()}.co.za`;
    const claimed = (await (await api("/api/org/domains", cookie, { domain })).json()) as { token?: string };
    const token =
      claimed.token ??
      (await db.prepare("SELECT token FROM org_domains WHERE domain = ?").bind(domain).first<{ token: string }>())
        ?.token;
    world.doh = () => Response.json({ Status: 0, Answer: [{ type: 16, data: `"isitlegit-verify=${token}"` }] });
    await api(`/api/org/domains/${domain}/check`, cookie);
    const other = `e${unique()}.co.za`;
    await api("/api/org/domains", cookie, { domain: other });
    await api(`/api/org/domains/${other}/code`, cookie, { local: "admin" });
    await db
      .prepare("UPDATE verification_codes SET expires_at = ?")
      .bind(new Date(Date.now() - 60_000).toISOString())
      .run();
    await api(`/api/org/domains/${other}/verify`, cookie, { code: "123456" });
    const third = `f${unique()}.co.za`;
    await api("/api/org/domains", cookie, { domain: third });
    await api(`/api/org/domains/${third}/code`, cookie, { local: "admin" });
    for (let i = 0; i < 6; i++) await api(`/api/org/domains/${third}/verify`, cookie, { code: "000000" });
    const outcomes = (await events("verify-domain", "org_id = ?", orgId)).map((e) => e.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(["verified-dns", "expired", "locked"]));
    const address = `ok-${unique()}@gmail.com`;
    await api("/api/org/addresses", cookie, { address });
    const code = /\b(\d{6})\b/.exec(world.sends.at(-1)?.text ?? "")?.[1] ?? "";
    await api("/api/org/addresses/verify", cookie, { address, code });
    expect((await events("verify-address", "org_id = ?", orgId)).map((e) => e.outcome)).toEqual(["verified-code"]);
  });

  it("records a link that finds no account to sign in to", async () => {
    const { cookie } = await owner(`noacct-${unique()}@example.org`);
    const invitee = `gone-${unique()}@example.org`;
    const invited = await api("/api/auth/organization/invite-member", cookie, { email: invitee, role: "member" });
    const invitationId = ((await invited.json()) as { id: string }).id;
    await call("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: invitee }),
    });
    const link = lastLink();
    await api("/api/auth/organization/cancel-invitation", cookie, { invitationId });
    const before = (await events("sign-in-failed")).length;
    await redeem(link);
    const failed = await events("sign-in-failed");
    expect(failed.length).toBe(before + 1);
    expect(failed.at(-1)?.outcome).not.toBe("invalid_token");
  });
});

describe("round 1 (2026-10-29)", () => {
  const memberRowOf = async (email: string) =>
    (await db
      .prepare(`SELECT m.id, m.role FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
      .bind(email)
      .first<{ id: string; role: string }>()) ?? { id: "", role: "" };

  it("lets one of two simultaneous role changes through, so each row names the role it really replaced", async () => {
    const { cookie, orgId } = await owner(`race-${unique()}@example.org`);
    const memberEmail = `raced-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    const { id } = await memberRowOf(memberEmail);
    const answers = await Promise.all(
      ["owner", "admin"].map((role) =>
        api("/api/auth/organization/update-member-role", cookie, { memberId: id, role }),
      ),
    );
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    const again = await api("/api/auth/organization/update-member-role", cookie, { memberId: id, role: "member" });
    expect(again.status).toBe(200);
    const chain = (await events("update-member-role", "org_id = ?", orgId)).map((e) =>
      JSON.parse(e.detail_json ?? "{}"),
    );
    expect(chain).toHaveLength(2);
    expect(chain[0]?.from).toBe("member");
    expect(chain[1]?.from).toBe(chain[0]?.to);
    expect((await memberRowOf(memberEmail)).role).toBe("member");
  });

  it("releases the member when a role change is refused, so the next one goes through at once", async () => {
    const { cookie } = await owner(`refused-${unique()}@example.org`);
    const memberEmail = `target-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    const { cookie: plainCookie } = await joiner(cookie, `plain-${unique()}@example.org`, "member");
    const { id } = await memberRowOf(memberEmail);
    const refused = await api("/api/auth/organization/update-member-role", plainCookie, {
      memberId: id,
      role: "admin",
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).not.toBe(409);
    expect(
      (await api("/api/auth/organization/update-member-role", cookie, { memberId: id, role: "admin" })).status,
    ).toBe(200);
  });

  it("records a member leaving as a departure in the team history", async () => {
    const { cookie, orgId } = await owner(`leave-${unique()}@example.org`);
    const leaverEmail = `leaver-${unique()}@example.org`;
    const { cookie: leaverCookie } = await joiner(cookie, leaverEmail, "member");
    expect((await api("/api/auth/organization/leave", leaverCookie, { organizationId: orgId })).status).toBe(200);
    const leaverId = await userIdOf(leaverEmail);
    expect(await events("leave-organization", "org_id = ?", orgId)).toEqual([
      expect.objectContaining({ actor_id: leaverId, target_id: leaverId, outcome: "left" }),
    ]);
    const history = (await (await call("/api/team/history", { headers: { cookie } })).json()) as {
      changes: { action: string }[];
    };
    expect(history.changes.map((c) => c.action)).toContain("leave-organization");
  });

  it("hashes an IPv6 client alike in its sign-in and in its rate-limit refusal", async () => {
    const v6 = "2001:db8:abcd:12::7";
    const email = `six-${unique()}@example.org`;
    await owner(email);
    await call("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const token = new URL(lastLink()).searchParams.get("token") ?? "";
    await call("/signin/confirm", {
      method: "POST",
      headers: { "cf-connecting-ip": v6 },
      body: new URLSearchParams({ token, callbackURL: "/cases" }),
    });
    const signedIn = (await events("sign-in", "user_id = ?", await userIdOf(email))).at(-1);
    for (let i = 0; i <= 20; i++)
      await call("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": v6 },
        body: JSON.stringify({ email: `x${i}-${unique()}@example.org` }),
      });
    const refused = (await events("rate-limited", "outcome = 'per-ip'")).at(-1);
    expect(signedIn?.ip_hash).toBeTruthy();
    expect(refused?.ip_hash).toBe(signedIn?.ip_hash);
  });
});

describe("round 2 (2026-10-29)", () => {
  it("never lets a caller without the right hold a member an owner is changing", async () => {
    const { cookie } = await owner(`hold-${unique()}@example.org`);
    const memberEmail = `held-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    const { cookie: plainCookie } = await joiner(cookie, `nosy-${unique()}@example.org`, "member");
    const outsider = await owner(`outsider-${unique()}@example.org`);
    const id =
      (
        await db
          .prepare(`SELECT m.id FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
          .bind(memberEmail)
          .first<{ id: string }>()
      )?.id ?? "";
    await db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS lock_log (member_id TEXT)"),
      db.prepare("DELETE FROM lock_log"),
      db.prepare(
        "CREATE TRIGGER IF NOT EXISTS lock_logged AFTER INSERT ON member_locks BEGIN INSERT INTO lock_log VALUES (NEW.member_id); END",
      ),
    ]);
    try {
      for (const c of [plainCookie, outsider.cookie])
        expect(
          (await api("/api/auth/organization/update-member-role", c, { memberId: id, role: "admin" })).status,
        ).toBeGreaterThanOrEqual(400);
      expect((await db.prepare("SELECT COUNT(*) AS n FROM lock_log").first<{ n: number }>())?.n).toBe(0);
      expect(
        (await api("/api/auth/organization/update-member-role", cookie, { memberId: id, role: "admin" })).status,
      ).toBe(200);
      expect((await db.prepare("SELECT COUNT(*) AS n FROM lock_log").first<{ n: number }>())?.n).toBe(1);
    } finally {
      await db.batch([db.prepare("DROP TRIGGER IF EXISTS lock_logged"), db.prepare("DROP TABLE IF EXISTS lock_log")]);
    }
  });
});

describe("round 3 (2026-10-29)", () => {
  it("never lets an admin hold an owner, or a member it would make an owner, that Better Auth will not let it change", async () => {
    const { cookie } = await owner(`owners-${unique()}@example.org`);
    const secondOwner = `second-${unique()}@example.org`;
    await joiner(cookie, secondOwner, "member");
    const secondId =
      (
        await db
          .prepare(`SELECT m.id FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
          .bind(secondOwner)
          .first<{ id: string }>()
      )?.id ?? "";
    expect(
      (await api("/api/auth/organization/update-member-role", cookie, { memberId: secondId, role: "owner" })).status,
    ).toBe(200);
    const { cookie: adminCookie } = await joiner(cookie, `adm-${unique()}@example.org`, "admin");
    const plainEmail = `pl-${unique()}@example.org`;
    await joiner(cookie, plainEmail, "member");
    const plainId =
      (
        await db
          .prepare(`SELECT m.id FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
          .bind(plainEmail)
          .first<{ id: string }>()
      )?.id ?? "";
    await db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS lock_log (member_id TEXT)"),
      db.prepare("DELETE FROM lock_log"),
      db.prepare(
        "CREATE TRIGGER IF NOT EXISTS lock_logged AFTER INSERT ON member_locks BEGIN INSERT INTO lock_log VALUES (NEW.member_id); END",
      ),
    ]);
    try {
      expect(
        (await api("/api/auth/organization/update-member-role", adminCookie, { memberId: secondId, role: "member" }))
          .status,
      ).toBe(403);
      expect(
        (await api("/api/auth/organization/update-member-role", adminCookie, { memberId: plainId, role: "owner" }))
          .status,
      ).toBe(403);
      expect((await db.prepare("SELECT COUNT(*) AS n FROM lock_log").first<{ n: number }>())?.n).toBe(0);
      expect(
        (await api("/api/auth/organization/update-member-role", adminCookie, { memberId: plainId, role: "admin" }))
          .status,
      ).toBe(200);
      expect((await db.prepare("SELECT COUNT(*) AS n FROM lock_log").first<{ n: number }>())?.n).toBe(1);
    } finally {
      await db.batch([db.prepare("DROP TRIGGER IF EXISTS lock_logged"), db.prepare("DROP TABLE IF EXISTS lock_log")]);
    }
  });
});

describe("final review (2026-10-29)", () => {
  it("releases a role change's hold when the change fails with an error Better Auth rethrows", async () => {
    const { cookie } = await owner(`fail-${unique()}@example.org`);
    const memberEmail = `failing-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    const id =
      (
        await db
          .prepare(`SELECT m.id FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = ?`)
          .bind(memberEmail)
          .first<{ id: string }>()
      )?.id ?? "";
    await db.prepare(`CREATE TRIGGER fail_role BEFORE UPDATE ON "member" BEGIN SELECT RAISE(ABORT, 'disk'); END`).run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await api("/api/auth/organization/update-member-role", cookie, { memberId: id, role: "admin" });
      expect(failed.status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.prepare("DROP TRIGGER fail_role").run();
    }
    expect(await db.prepare("SELECT 1 FROM member_locks WHERE member_id = ?").bind(id).first()).toBeNull();
    expect(
      (await api("/api/auth/organization/update-member-role", cookie, { memberId: id, role: "admin" })).status,
    ).toBe(200);
  });

  it("ends a removed member's sessions before recording it, and says so when they could not be ended", async () => {
    const { cookie, orgId } = await owner(`sessions-${unique()}@example.org`);
    const memberEmail = `sess-${unique()}@example.org`;
    await joiner(cookie, memberEmail, "member");
    await db
      .prepare(`CREATE TRIGGER keep_sessions BEFORE DELETE ON "session" BEGIN SELECT RAISE(ABORT, 'disk'); END`)
      .run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await api("/api/auth/organization/remove-member", cookie, { memberIdOrEmail: memberEmail })).status).toBe(
        200,
      );
    } finally {
      await db.prepare("DROP TRIGGER keep_sessions").run();
    }
    const [row] = await events("remove-member", "org_id = ?", orgId);
    expect(JSON.parse(row?.detail_json ?? "{}")).toEqual({ sessionsEnded: false });
  });

  it("keeps rows of one millisecond in the order they happened", async () => {
    const { cookie, orgId } = await owner(`order-${unique()}@example.org`);
    const at = "2026-10-29T08:00:00.000Z";
    for (const id of ["ffffffff-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"])
      await db
        .prepare("INSERT INTO auth_events (id, at, kind, outcome, org_id) VALUES (?, ?, 'remove-member', 'removed', ?)")
        .bind(id, at, orgId)
        .run();
    const read = (await (await call("/api/team/history", { headers: { cookie } })).json()) as {
      changes: { at: string }[];
    };
    expect(read.changes).toHaveLength(2);
    const { readTeamHistory } = await import("../../src/auth/audit");
    const { changes } = await readTeamHistory(db, orgId);
    // The later insert first, although its id sorts first: insertion order, not the random id.
    expect(changes.map((c) => c.id)).toEqual([
      "00000000-0000-4000-8000-000000000002",
      "ffffffff-0000-4000-8000-000000000001",
    ]);
  });

  it("normalises a mapped IPv4 address alike in dotted and hex form", async () => {
    const { normalizeIp } = await import("../../src/auth/audit");
    expect(normalizeIp("::ffff:c000:0201")).toBe("192.0.2.1");
    expect(normalizeIp("::FFFF:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeIp("2001:db8:abcd:12::7")).toBe("2001:0db8:abcd:0012:0000:0000:0000:0000");
  });
});


describe("team history actor and target parameters (D07 T04 §24)", () => {
  it("filters the endpoint by actor and by target", async () => {
    const { cookie, orgId } = await owner(`hist24-${unique()}@example.org`);
    await joiner(cookie, `hist24-m-${unique()}@example.org`, "member");
    const ownerId = await db
      .prepare(`SELECT "userId" AS id FROM "member" WHERE "organizationId" = ? AND role = 'owner'`)
      .bind(orgId)
      .first<{ id: string }>()
      .then((r) => r?.id as string);
    const memberUserId = await db
      .prepare(`SELECT "userId" AS id FROM "member" WHERE "organizationId" = ? AND role = 'member'`)
      .bind(orgId)
      .first<{ id: string }>()
      .then((r) => r?.id as string);
    const ev = (actor: string, target: string, at: string) =>
      db
        .prepare(
          `INSERT INTO auth_events (id, at, kind, outcome, org_id, user_id, actor_id, target_id, ip_hash, detail_json)
           VALUES (?, ?, 'update-member-role', 'changed', ?, ?, ?, ?, 'x', '{}')`,
        )
        .bind(crypto.randomUUID(), at, orgId, actor, actor, target)
        .run();
    await ev(memberUserId, ownerId, "2026-10-27T08:00:00.000Z");
    await ev(ownerId, memberUserId, "2026-10-26T08:00:00.000Z");
    const read = (query: string) =>
      call(`/api/team/history${query}`, { headers: { cookie } }).then((r) => r.json()) as Promise<{
        changes: { actor: string; target: string }[];
      }>;
    const byActor = await read(`?actor=${memberUserId}`);
    expect(byActor.changes).toHaveLength(1);
    expect(byActor.changes[0]?.actor).toBe(memberUserId);
    const byTarget = await read(`?target=${memberUserId}`);
    expect(byTarget.changes).toHaveLength(1);
    expect(byTarget.changes[0]?.target).toBe(memberUserId);
  });
});
