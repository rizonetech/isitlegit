// The admin console (D07 T05 §2): the overview draws every organisation with its exact aggregates, spend bars and
// incidents, the CSV exports the filtered table with escaping, invite codes are made through the form and read back
// with their uses, a revoked code is refused at signup while its earlier signups stand, and every failure keeps what
// was typed and stores nothing.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { readTeamHistory, recordAuthEvent } from "../../src/auth/audit";
import { hashInviteCode, newInviteCode } from "../../src/auth/invite-codes";
import { codeHash } from "../../src/auth/signup";
import { admitCase } from "../../src/db/cases";
import { authEnv, call, signIn, stubSmtp2go } from "../auth/helpers";
import { addDomain, makeOrg } from "../trust/helpers";

const db = env.DB;

// The admin guard's test tokens (D07 T05 §1): real RS256 JWTs through the stubbed team certs endpoint.
const TEAM = "team.example.cloudflareaccess.com";
const AUD = "test-aud-tag";
const OPERATOR = "hostmaster@rizonetech.com";
const SIGNIN = "derick@rizonetech.com";
const workerEnv = {
  ...authEnv,
  CF_ACCESS_AUD: AUD,
  CF_ACCESS_TEAM_DOMAIN: TEAM,
  CF_ACCESS_EMAIL: SIGNIN,
  OPERATOR_EMAIL: OPERATOR,
} as unknown as Env;

const b64url = (bytes: Uint8Array | string) => {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};
async function makeKey(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey };
}
const key = await makeKey("kid-1");
// A plain wrapper, not a spy: the sign-in helper stubs and restores `fetch` around every member it makes, and a
// `mockRestore` puts back whatever held `fetch` when its stub went on, so the certificates keep answering through
// every stub cycle of the file.
const outerFetch: typeof fetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(`https://${TEAM}/cdn-cgi/access/certs`)) return Response.json({ keys: [key.jwk] });
  return outerFetch(input, init);
}) as typeof fetch;
async function jwt(): Promise<string> {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: SIGNIN }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

const ORIGIN = new URL(authEnv.APP_URL).origin;
const HTML = { accept: "text/html" };
const headers = async (extra: Record<string, string> = {}) => ({
  ...HTML,
  "cf-access-jwt-assertion": await jwt(),
  ...extra,
});
const get = async (path: string) => call(path, { headers: await headers() }, workerEnv);
const post = async (path: string, fields: Record<string, string>) =>
  call(
    path,
    {
      method: "POST",
      headers: { ...(await headers()), origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    workerEnv,
  );
// HTML entities decoded, so assertions read the words a person reads.
const words = (html: string) =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// Every test starts from an empty console: the file's tests share one in-memory D1, so leftover rows would move the
// tiles and the CSV.
const TABLES = [
  "invite_redemptions",
  "case_events",
  "check_outcomes",
  "case_verdicts",
  "feedback",
  "cases",
  "org_domains",
  "member",
  "org_limits",
  "invite_codes",
  "organization",
  "auth_events",
  "model_spend",
  "glimmer_runtime",
];
beforeEach(async () => {
  for (const table of TABLES) {
    const quoted = ["organization", "member", "user"].includes(table) ? `"${table}"` : table;
    await db.prepare(`DELETE FROM ${quoted}`).run();
  }
});
// The certificate wrapper above holds `fetch` for the file. `signIn` restores its own SMTP stub.

let n = 0;
const tag = () => `${++n}-${crypto.randomUUID().slice(0, 6)}`;
async function memberOf(orgId: string, role = "owner"): Promise<void> {
  const email = `op-${tag()}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const user = await db.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, role, new Date().toISOString())
    .run();
  void cookie;
}
// A decided case with the given seconds from arrival to verdict.
async function decidedCase(orgId: string, seconds: number, verdict: "safe" | "suspicious" | "malicious" = "safe") {
  const arrived = new Date();
  const id = `c-${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, created_at, updated_at) VALUES (?, ?, 'email', 'done', ?, 0, ?, ?)`,
    )
    .bind(id, orgId, verdict, arrived.toISOString(), arrived.toISOString())
    .run();
  await db
    .prepare(
      `INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, ?, 'h', 0.9, '[]', '[]', 'stub', ?)`,
    )
    .bind(id, verdict, new Date(arrived.getTime() + seconds * 1000).toISOString())
    .run();
  return id;
}
async function problemCheck(caseId: string, check: string, findings = 1) {
  await db
    .prepare(
      `INSERT INTO check_outcomes (case_id, run_id, check_name, seq, outcome, findings, revision) VALUES (?, ?, ?, 1, 'ran', ?, 'test')`,
    )
    .bind(caseId, `r-${caseId}`, check, findings)
    .run();
}
async function openFeedback(caseId: string) {
  await db
    .prepare(
      `INSERT INTO feedback (id, case_id, user_id, kind, providers_json, created_at, updated_at) VALUES (?, ?, 'u-x', 'false_alarm', '[]', ?, ?)`,
    )
    .bind(`f-${crypto.randomUUID()}`, caseId, new Date().toISOString(), new Date().toISOString())
    .run();
}
async function settledSpend(day: string, usd: number) {
  await db
    .prepare(
      `INSERT INTO model_spend (id, at, day, source, caller, model, attempt, estimate_usd, actual_usd, state, settled_at) VALUES (?, ?, ?, 'worker', 'probe', 'meta-probe', 1, ?, ?, 'settled', ?)`,
    )
    .bind(`s-${crypto.randomUUID()}`, `${day}T10:00:00.000Z`, day, usd, usd, `${day}T10:00:01.000Z`)
    .run();
}
async function glimmerMinutes(day: string, minutes: number) {
  await db
    .prepare(
      `INSERT INTO glimmer_runtime (id, reservation_id, day, source, caller, purpose, wake_at, reserved_minutes, used_minutes, reconciled) VALUES (?, ?, ?, 'worker', 'probe', 'probe', ?, ?, ?, 1)`,
    )
    .bind(`g-${crypto.randomUUID()}`, `r-${crypto.randomUUID()}`, day, `${day}T10:00:00.000Z`, minutes, minutes)
    .run();
}

const CODE_PATTERN = /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/;
const createdCodeOf = (page: string) => /data-copy-source[^>]*>([^<]+)</.exec(page)?.[1]?.trim() ?? "";
const codeCount = async () =>
  (await db.prepare("SELECT COUNT(*) AS n FROM invite_codes").first<{ n: number }>())?.n ?? 0;

describe("the invite-code hashing", () => {
  it("hashes the same bytes signup and the script store, and makes shaped codes", async () => {
    expect(await hashInviteCode("ABCD-EFGH-JKLM-NPQR")).toBe(await codeHash("ABCD-EFGH-JKLM-NPQR"));
    expect(await hashInviteCode("  ABCD-EFGH-JKLM-NPQR  ")).toBe(await codeHash("ABCD-EFGH-JKLM-NPQR"));
    expect(newInviteCode(() => new Uint8Array(16).fill(0))).toBe("AAAA-AAAA-AAAA-AAAA");
    expect(newInviteCode()).toMatch(CODE_PATTERN);
  });
});

describe("the admin overview", () => {
  it("draws every organisation with its exact aggregates, tiles, spend bars and incidents", async () => {
    const karoo = await makeOrg("Karoo Couriers (fictional)");
    const fynbos = await makeOrg("Fynbos Freight (fictional)");
    await addDomain(karoo, "karoo.example");
    await memberOf(karoo);
    await memberOf(karoo, "admin");
    await memberOf(fynbos);
    // Karoo: three suspicious cases this week, domain.lookalike the most frequent problem check.
    const k1 = await decidedCase(karoo, 10, "suspicious");
    const k2 = await decidedCase(karoo, 20, "suspicious");
    const k3 = await decidedCase(karoo, 300, "malicious");
    await problemCheck(k1, "domain.lookalike");
    await problemCheck(k2, "domain.lookalike");
    await problemCheck(k2, "auth.results");
    await problemCheck(k3, "domain.lookalike");
    await problemCheck(k3, "auth.results", 0);
    await openFeedback(k1);
    // Fynbos: one safe case, no problem checks, no feedback.
    const f1 = await decidedCase(fynbos, 40, "safe");
    await problemCheck(f1, "auth.results", 0);
    await settledSpend(new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10), 6.4);
    await glimmerMinutes(new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10), 30);
    await recordAuthEvent(db, "test-secret", {
      kind: "sign-in-failed",
      outcome: "refused",
      detail: { method: "code" },
    });
    await recordAuthEvent(db, "test-secret", {
      kind: "rate-limited",
      outcome: "refused",
      orgId: karoo,
      detail: { path: "/upload" },
    });

    const res = await get("/admin");
    expect(res.status).toBe(200);
    const page = words(await res.text());
    // The rows with their exact values.
    expect(page).toContain("Karoo Couriers (fictional)");
    expect(page).toContain("Trial, 14 days");
    expect(page).toContain("1 verified");
    expect(page).toContain("Lookalike domains");
    expect(page).toContain("Fynbos Freight (fictional)");
    expect(page).toContain("None yet");
    // The tiles: two organisations with one verified domain, cases today and in total, the median and p95 of the
    // four verdicts (10, 20, 40 and 300 seconds), one open feedback.
    expect(page).toContain("1 with a verified domain");
    expect(page).toContain("4 in total");
    expect(page).toContain("30 s");
    expect(page).toContain("p95 5 min");
    // The spend bars name both providers' amounts and caps.
    expect(page).toContain("Meta Model API today");
    expect(page).toContain("US$6.40 of 15.00");
    expect(page).toContain("Meta Model API total");
    expect(page).toContain("Fireworks today");
    expect(page).toContain("US$4.00 of 5.00");
    expect(page).toContain("Fireworks total");
    // The incident panel reads the refused sign-in with no organisation and the rate limit with its own.
    expect(page).toContain("Sign-in refused");
    expect(page).toContain("No organisation");
    expect(page).toContain("Rate limited");
    expect(page).toContain("Karoo Couriers (fictional)");
  });

  it("exports the table as filtered, with every column, escaping and formula guards", async () => {
    const plain = await makeOrg("Plain Org (fictional)");
    await makeOrg('Tricky, "Quoted" Org (fictional)');
    await makeOrg("=cmd|'/c calc'!A0 (fictional)");
    await addDomain(plain, "plain.example");
    await memberOf(plain);

    const all = await get("/admin/organisations.csv");
    expect(all.status).toBe(200);
    expect(all.headers.get("content-type")).toContain("text/csv");
    const body = await all.text();
    const lines = body.trim().split("\r\n");
    expect(lines[0]).toBe("Organisation,Plan,Domains verified,Members,Cases this week,Top threat,Feedback,Daily cap");
    expect(lines).toHaveLength(4);
    expect(body).toContain("Plain Org (fictional),");
    expect(body).toContain('"Tricky, ""Quoted"" Org (fictional)",');
    // A cell a spreadsheet would run as a formula exports as text.
    expect(body).toContain("'=cmd|'/c calc'!A0 (fictional),\"Trial, 14 days\"");

    const filteredBody = await (await get("/admin/organisations.csv?q=Plain")).text();
    expect(filteredBody.trim().split("\r\n")).toHaveLength(2);
    expect(filteredBody).toContain("Plain Org (fictional)");
    expect(filteredBody).not.toContain("Tricky");
  });

  it("searches by name, says when nothing matches, and names the empty service", async () => {
    await makeOrg("Karoo Couriers (fictional)");
    const found = words(await (await get("/admin?q=Karoo")).text());
    expect(found).toContain("Karoo Couriers (fictional)");
    // The navigation's Organisations entry lands on the table.
    expect(found).toContain('id="organisations"');
    const missed = words(await (await get("/admin?q=Nope")).text());
    expect(missed).toContain("No organisations match");
    expect(missed).toContain("Clear search");
  });
});

describe("invite codes", () => {
  it("makes a code through the form, shows it once with Copy, and counts its use after a reload", async () => {
    const made = await post("/admin/invites", { label: "Karoo pilot", uses: "2", expires: "" });
    expect(made.status).toBe(200);
    const created = words(await made.text());
    expect(created).toContain("Code created for Karoo pilot");
    const code = createdCodeOf(created);
    expect(code).toMatch(CODE_PATTERN);
    expect(created).toContain("Copy");
    expect(created).toContain("No later visit can show it again");
    // The list reads the hash's tag, the uses and the Active status, with no code to copy.
    const listed = words(await (await get("/admin/invites")).text());
    expect(listed).toContain("0 of 2");
    expect(listed).toContain("Active");
    expect(listed).not.toContain(code);
    expect(createdCodeOf(listed)).toBe("");
    // Signing up with the copied code works, and the use is counted after a reload.
    const smtp = stubSmtp2go();
    try {
      const answer = await call(
        "/api/auth/sign-up/invite-code",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "founder@example.org", code, organizationName: "Karoo", consent: true }),
        },
        authEnv,
      );
      expect(answer.status).toBe(201);
    } finally {
      smtp.restore();
    }
    expect(words(await (await get("/admin/invites")).text())).toContain("1 of 2");
  });

  it("tells Active, Used up, Expired and Revoked apart, with Copy and Revoke only where they can act", async () => {
    await db
      .prepare(
        "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES ('active-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Active code', 3, 1, '2999-01-01T00:00:00.000Z', '2026-10-27T00:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES ('spent-1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Spent code', 1, 1, '2999-01-01T00:00:00.000Z', '2026-10-27T00:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, created_at) VALUES ('old-1', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'Old code', 5, 0, '2020-01-01T00:00:00.000Z', '2026-10-27T00:00:00.000Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO invite_codes (id, code_hash, label, max_uses, uses, expires_at, revoked_at, created_at) VALUES ('dead-1', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'Dead code', 5, 0, '2999-01-01T00:00:00.000Z', '2026-10-28T00:00:00.000Z', '2026-10-27T00:00:00.000Z')",
      )
      .run();
    const page = words(await (await get("/admin/invites")).text());
    for (const status of ["Active", "Used up", "Expired", "Revoked"]) expect(page).toContain(status);
    // Revoke only on the active row: one Revoke control per rendering (the table and the phone list).
    expect(page.match(/Revoke the code for Active code/g)).toHaveLength(2);
    expect(await (await post("/admin/invites/revoke", { id: "active-1" })).status).toBe(303);
    const again = words(await (await get("/admin/invites")).text());
    expect(again.match(/Revoked/g)?.length).toBeGreaterThanOrEqual(2);
    expect(again).not.toContain("Revoke the code for");
  });

  it("refuses a revoked code at signup while its earlier signups stand, and tells it from an expired one", async () => {
    const made = await post("/admin/invites", { label: "One org", uses: "2", expires: "" });
    const code = createdCodeOf(words(await made.text()));
    expect(code).toMatch(CODE_PATTERN);
    const smtp = stubSmtp2go();
    const signUp = (email: string) =>
      call(
        "/api/auth/sign-up/invite-code",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code, organizationName: "First", consent: true }),
        },
        authEnv,
      );
    try {
      expect((await signUp("first@example.org")).status).toBe(201);
    } finally {
      smtp.restore();
    }
    const row = await db.prepare("SELECT id FROM invite_codes WHERE label = 'One org'").first<{ id: string }>();
    expect(await (await post("/admin/invites/revoke", { id: row?.id ?? "" })).status).toBe(303);
    // The earlier signup stands: its owner membership is untouched.
    const kept = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM "member" m JOIN "user" u ON u.id = m."userId" WHERE u.email = 'first@example.org' AND m.role = 'owner'`,
      )
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
    const smtp2 = stubSmtp2go();
    try {
      const refused = await signUp("second@example.org");
      expect(refused.status).toBe(400);
      expect(await refused.text()).toContain("that invite code is not valid");
    } finally {
      smtp2.restore();
    }
    // No second use was taken and no second redemption stands.
    const after = await db
      .prepare("SELECT uses FROM invite_codes WHERE id = ?")
      .bind(row?.id)
      .first<{ uses: number }>();
    expect(after?.uses).toBe(1);
  });

  it("refuses invalid invite fields under the field with the typed values kept and nothing stored", async () => {
    const before = await codeCount();
    const bad = await post("/admin/invites", { label: "", uses: "7", expires: "2020-01-01" });
    expect(bad.status).toBe(200);
    const page = words(await bad.text());
    expect(page).toContain("a label is 1 to 200 letters");
    expect(page).toContain("expires is a date like 2026-11-13 after today, or empty for never");
    expect(page).toContain('value="7"');
    expect(await codeCount()).toBe(before);
    const badUses = words(await (await post("/admin/invites", { label: "Ok", uses: "many", expires: "" })).text());
    expect(badUses).toContain("organisations is a whole number from 1 to 10000");
    expect(await codeCount()).toBe(before);
    const badFormat = await post("/admin/invites", { label: "Ok format", uses: "1", expires: "13/11/2026" });
    expect(badFormat.status).toBe(200);
    const badFormatPage = words(await badFormat.text());
    expect(badFormatPage).toContain("like 2026-11-13");
    expect(badFormatPage).toContain('value="Ok format"');
    expect(await codeCount()).toBe(before);
  });

  it("says when no codes exist yet, and refuses posts from another origin", async () => {
    expect(words(await (await get("/admin/invites")).text())).toContain("No invite codes yet");
    const forged = await call(
      "/admin/invites",
      {
        method: "POST",
        headers: {
          ...(await headers()),
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ label: "Evil", uses: "1", expires: "" }).toString(),
      },
      workerEnv,
    );
    expect(forged.status).toBe(403);
    expect(await codeCount()).toBe(0);
  });
});

describe("the daily cap control", () => {
  it("lowers a cap, reads it back as an override, refuses admission at it, and returns to the plan", async () => {
    const org = await makeOrg("Capped Org (fictional)");
    // The plan's cap shows, then lowering it reads back marked as an override.
    expect(words(await (await get("/admin")).text())).toContain("Plan's cap (50)");
    expect(await (await post("/admin/orgs/cap", { orgId: org, action: "set", cap: "0" })).status).toBe(303);
    const lowered = words(await (await get("/admin")).text());
    expect(lowered).toContain("Override (0)");
    // The next admission for the organisation is refused at the new limit.
    const refused = await admitCase(db, { orgId: org, channel: "email", headersAvailable: false });
    expect(refused.ok).toBe(false);
    // "Use plan limit" clears the override: the plan's cap reads back and admission follows it.
    expect(await (await post("/admin/orgs/cap", { orgId: org, action: "clear", cap: "" })).status).toBe(303);
    const cleared = words(await (await get("/admin")).text());
    expect(cleared).toContain("Plan's cap (50)");
    expect(cleared).not.toContain("Override (0)");
    const admitted = await admitCase(db, { orgId: org, channel: "email", headersAvailable: false });
    expect(admitted.ok).toBe(true);
  });

  it("refuses a cap outside 0 to 50 under the field with the stored cap unchanged", async () => {
    const org = await makeOrg("Careful Org (fictional)");
    const bad = await post("/admin/orgs/cap", { orgId: org, action: "set", cap: "51" });
    expect(bad.status).toBe(200);
    const page = words(await bad.text());
    expect(page).toContain("a daily cap is a whole number from 0 to 50");
    expect(page).toContain('value="51"');
    const stored = await db
      .prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
      .bind(org)
      .first<{ cap: number | null }>();
    expect(stored).toBeNull();
  });

  it("refuses a blank cap without saving zero, and keeps the search it came from", async () => {
    const org = await makeOrg("Kept Search Org (fictional)");
    const blank = await post("/admin/orgs/cap", { orgId: org, action: "set", cap: "", q: "Kept" });
    expect(blank.status).toBe(200);
    const page = words(await blank.text());
    expect(page).toContain("a daily cap is a whole number from 0 to 50");
    expect(page).toContain("Kept Search Org (fictional)");
    const stored = await db
      .prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
      .bind(org)
      .first<{ cap: number | null }>();
    expect(stored).toBeNull();
    // A successful set returns to the same filtered table.
    const set = await post("/admin/orgs/cap", { orgId: org, action: "set", cap: "7", q: "Kept" });
    expect(set.status).toBe(303);
    expect(set.headers.get("location")).toBe("/admin?q=Kept");
    const kept = words(await (await get("/admin?q=Kept")).text());
    expect(kept).toContain("Override (7)");
  });

  it("reads an unreadable plan as Unknown, never a fabricated cap", async () => {
    const org = await makeOrg("Broken Plan Org (fictional)");
    await db
      .prepare("INSERT INTO org_limits (org_id, plan, trial_ends_at) VALUES (?, NULL, 'not-a-date')")
      .bind(org)
      .run();
    const page = words(await (await get("/admin")).text());
    expect(page).toContain("Unknown");
    expect(page).not.toContain("Plan's cap (50)");
    // An explicit override still works: it does not need the plan to read.
    expect((await post("/admin/orgs/cap", { orgId: org, action: "set", cap: "5" })).status).toBe(303);
    expect(words(await (await get("/admin")).text())).toContain("Override (5)");
  });
});

describe("the incident panel and the owner read", () => {
  it("shows refused sign-ins and rate limits including rows with no organisation, which owners never see", async () => {
    const org = await makeOrg("Watched Org (fictional)");
    await recordAuthEvent(db, "test-secret", {
      kind: "sign-in-failed",
      outcome: "refused",
      detail: { method: "code" },
    });
    await recordAuthEvent(db, "test-secret", {
      kind: "rate-limited",
      outcome: "refused",
      orgId: org,
      detail: { path: "/cases" },
    });
    await recordAuthEvent(db, "test-secret", {
      kind: "update-member-role",
      outcome: "changed",
      orgId: org,
      detail: { role: "admin" },
    });
    const page = words(await (await get("/admin")).text());
    expect(page).toContain("Sign-in refused");
    expect(page).toContain("No organisation");
    expect(page).toContain("Rate limited");
    // An organisation owner's history reads only its own organisation's rows.
    const history = await readTeamHistory(db, org, {});
    expect(history.changes).toHaveLength(1);
    expect(history.changes[0]?.kind).toBe("update-member-role");
    const orgLess = await db
      .prepare("SELECT COUNT(*) AS n FROM auth_events WHERE org_id IS NULL")
      .first<{ n: number }>();
    expect(orgLess?.n).toBe(1);
  });
});
