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
