// The admin organisation detail and feedback queue (D07 T08 §5): the triage state machine behind the New,
// Triaged and Closed tabs. A member edit after triage reopens the item, a stale operator POST is refused, and a
// withdrawn row leaves the queue; the counts follow the triage state while notices still follow notified_at.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { saveFeedback, withdrawFeedback } from "../../src/db/feedback";
import { listTriage, moveTriage, saveTriageNote, triageCounts } from "../../src/db/feedback-triage";
import { ulid } from "../../src/db/ulid";
import { authEnv, call, signIn } from "../auth/helpers";
import { makeOrg } from "../trust/helpers";

const db = env.DB;

// Every test starts from an empty queue: leftover rows would move the tabs and the pages.
const TABLES = [
  "feedback",
  "check_outcomes",
  "case_verdicts",
  "cases",
  "org_domains",
  "invitation",
  "org_limits",
  "organization",
];
beforeEach(async () => {
  for (const table of TABLES) {
    const quoted = table === "organization" ? `"${table}"` : table;
    await db.prepare(`DELETE FROM ${quoted}`).run();
  }
});
// The file shares one database across its tests, so every count asserts the move it made, not an absolute total.
const moveOf = async (work: () => Promise<unknown>) => {
  const before = await triageCounts(db);
  await work();
  const after = await triageCounts(db);
  return { new: after.new - before.new, triaged: after.triaged - before.triaged, closed: after.closed - before.closed };
};

const seedFeedback = async (orgId: string, userId: string, kind: "false_alarm" | "missed" = "false_alarm") => {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const saved = await saveFeedback(db, {
    caseId: made.value.id,
    userId,
    kind,
    note: "Should have been flagged",
    providers: [],
  });
  // `Feedback` carries no revision: the operator POST carries what the row holds.
  const revision = await db
    .prepare("SELECT updated_at AS updatedAt FROM feedback WHERE id = ?")
    .bind(saved.id)
    .first<{ updatedAt: string }>();
  return { ...saved, updatedAt: revision?.updatedAt ?? "" };
};

describe("feedback triage", () => {
  it("moves new to triaged to closed with the note kept, and counts each tab", async () => {
    const orgId = await makeOrg("Triage Org (fictional)");
    expect(
      await moveOf(async () => {
        await seedFeedback(orgId, "user-triage-1");
        await seedFeedback(orgId, "user-triage-2");
        await seedFeedback(orgId, "user-triage-3", "missed");
      }),
    ).toEqual({ new: 3, triaged: 0, closed: 0 });
    const first = (await listTriage(db, "new")).find((row) => row.userId === "user-triage-1");
    expect(first?.id).toBeDefined();
    if (!first) throw new Error("seeded feedback missing from the new tab");
    const noted = await saveTriageNote(db, { id: first.id, note: "Ledger was empty", knownUpdatedAt: first.updatedAt });
    expect(noted?.triage).toBe("triaged");
    expect(noted?.triageNote).toBe("Ledger was empty");
    const closed = await moveTriage(db, { id: first.id, to: "closed", knownUpdatedAt: noted?.updatedAt ?? "" });
    expect(closed?.triage).toBe("closed");
    expect(closed?.triageNote).toBe("Ledger was empty");
    // The tabs list their own rows, newest first.
    expect((await listTriage(db, "new")).map((row) => row.id)).not.toContain(first.id);
    expect((await listTriage(db, "closed")).map((row) => row.id)).toContain(first.id);
  });

  it("refuses a stale operator POST and keeps the row untouched", async () => {
    const orgId = await makeOrg("Stale Org (fictional)");
    const row = await seedFeedback(orgId, "user-stale-1");
    const moved = await moveTriage(db, { id: row.id, to: "closed", knownUpdatedAt: row.updatedAt });
    expect(moved?.triage).toBe("closed");
    const stale = await saveTriageNote(db, { id: row.id, note: "Too late", knownUpdatedAt: row.updatedAt });
    expect(stale).toBeNull();
    const kept = (await listTriage(db, "closed")).find((item) => item.id === row.id);
    expect(kept?.triageNote).toBeNull();
  });

  it("reopens a settled item when the member edits it, keeping the operator note", async () => {
    const orgId = await makeOrg("Reopen Org (fictional)");
    const row = await seedFeedback(orgId, "user-reopen-1");
    const noted = await saveTriageNote(db, { id: row.id, note: "Check the ledger", knownUpdatedAt: row.updatedAt });
    expect(
      await moveOf(async () => {
        await moveTriage(db, { id: row.id, to: "closed", knownUpdatedAt: noted?.updatedAt ?? "" });
      }),
    ).toEqual({ new: 0, triaged: -1, closed: 1 });
    // The member's words change: the item reads as new again with the operator's note kept.
    expect(
      await moveOf(async () => {
        await db
          .prepare("UPDATE feedback SET kind = ?, note = ?, updated_at = ? WHERE id = ?")
          .bind("missed", "Actually it should be safe", "2026-11-03T00:00:00.000Z", row.id)
          .run();
      }),
    ).toEqual({ new: 1, triaged: 0, closed: -1 });
    const reopened = (await listTriage(db, "new")).find((item) => item.id === row.id);
    expect(reopened?.triageNote).toBe("Check the ledger");
    // The member flow never clobbers triage columns it does not own.
    await saveFeedback(db, {
      caseId: row.caseId,
      userId: row.userId,
      kind: "missed",
      note: "Actually it should be safe",
      providers: [],
    });
    expect((await listTriage(db, "new")).find((item) => item.id === row.id)?.triageNote).toBe("Check the ledger");
  });

  it("saves a member-reopened complaint into triaged, not back into closed", async () => {
    const orgId = await makeOrg("Unclose Org (fictional)");
    const row = await seedFeedback(orgId, "user-unclose-1");
    const noted = await saveTriageNote(db, { id: row.id, note: "Verdict stands", knownUpdatedAt: row.updatedAt });
    const closed = await moveTriage(db, { id: row.id, to: "closed", knownUpdatedAt: noted?.updatedAt ?? "" });
    expect(closed?.triage).toBe("closed");
    // The member edits after closure: the item reads as new again before the operator saves.
    await db
      .prepare("UPDATE feedback SET note = ?, updated_at = ? WHERE id = ?")
      .bind("One more fact", "2026-11-03T00:00:00.000Z", row.id)
      .run();
    const listed = (await listTriage(db, "new")).find((item) => item.id === row.id);
    expect(listed?.triage).toBe("new");
    const saved = await saveTriageNote(db, {
      id: row.id,
      note: "Seen the edit now",
      knownUpdatedAt: listed?.updatedAt ?? "",
    });
    expect(saved?.triage).toBe("triaged");
    expect((await listTriage(db, "closed")).map((item) => item.id)).not.toContain(row.id);
    expect((await listTriage(db, "triaged")).map((item) => item.id)).toContain(row.id);
  });

  it("drops a withdrawn row from the queue and the counts", async () => {
    const orgId = await makeOrg("Withdraw Org (fictional)");
    const row = await seedFeedback(orgId, "user-withdraw-1");
    await saveTriageNote(db, { id: row.id, note: "Kept", knownUpdatedAt: row.updatedAt });
    expect(
      await moveOf(async () => {
        expect(await withdrawFeedback(db, row.caseId, row.userId)).toBe(true);
      }),
    ).toEqual({ new: 0, triaged: -1, closed: 0 });
    expect((await listTriage(db, "triaged")).find((item) => item.id === row.id)).toBeUndefined();
  });

  it("pages the queue fifty at a time with every record reachable", async () => {
    const orgId = await makeOrg("Paging Org (fictional)");
    const ids: string[] = [];
    for (let i = 0; i < 52; i += 1) ids.push((await seedFeedback(orgId, `user-page-${i}`)).id);
    const mine = (rows: { id: string }[]) => rows.filter((row) => ids.includes(row.id));
    const first = mine(await listTriage(db, "new", 0));
    const second = mine(await listTriage(db, "new", 1));
    expect(first).toHaveLength(50);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((row) => row.id))).toEqual(new Set(ids));
  });
});

const TEAM = "team.example.cloudflareaccess.com";
const AUD = "test-aud-tag";
const SIGNIN = "derick@rizonetech.com";
const OPERATOR = "hostmaster@rizonetech.com";
const makeQueueKey = async (kid: string) => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } as JsonWebKey };
};
const queueKey = await makeQueueKey("kid-queue");
const outerQueueFetch: typeof fetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith(`https://${TEAM}/cdn-cgi/access/certs`)) return Response.json({ keys: [queueKey.jwk] });
  return outerQueueFetch(input as Request, init);
}) as typeof fetch;

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
const jwt = async () => {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: queueKey.kid, typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ aud: AUD, iss: `https://${TEAM}`, exp: Math.floor(Date.now() / 1000) + 600, email: SIGNIN }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", queueKey.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
};
const ORIGIN = new URL(authEnv.APP_URL).origin;
const headers = async (extra: Record<string, string> = {}) => ({
  accept: "text/html",
  "cf-access-jwt-assertion": await jwt(),
  ...extra,
});
const get = async (path: string, authed = true) =>
  call(path, { headers: authed ? await headers() : { accept: "text/html" } }, workerEnv);
const post = async (path: string, fields: Record<string, string>, origin = ORIGIN) =>
  call(
    path,
    {
      method: "POST",
      headers: { ...(await headers()), origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    workerEnv,
  );

const words = (html: string) =>
  html
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

describe("the feedback queue page", () => {
  const seedCase = async (orgId: string) => {
    const id = ulid();
    const at = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, original_subject, original_from_name, original_from_address, created_at, updated_at)
         VALUES (?, ?, 'email', 'done', 'safe', 1, 'October statement', 'Thandi Nkosi', 'thandi@demo.isitlegit.co.za', ?, ?)`,
      )
      .bind(id, orgId, at, at)
      .run();
    await db
      .prepare(
        `INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at)
         VALUES (?, 'safe', 'h', 0.9, '["The statement is real but the account is not on file"]', '[]', 'Muse Spark verdict', ?)`,
      )
      .bind(id, at)
      .run();
    return id;
  };
  const seedQueue = async (kind: "false_alarm" | "missed" = "false_alarm", providers = '["Google Web Risk"]') => {
    const orgId = await makeOrg("Queue Org (fictional)");
    const caseId = await seedCase(orgId);
    const id = `qf-${crypto.randomUUID()}`;
    const at = new Date().toISOString();
    await db
      .prepare(
        `INSERT INTO feedback (id, case_id, user_id, kind, note, providers_json, created_at, updated_at)
         VALUES (?, ?, 'user-queue', ?, 'Should be at least suspicious', ?, ?, ?)`,
      )
      .bind(id, caseId, kind, providers, at, at)
      .run();
    return { id, caseId, orgId, updatedAt: at };
  };

  it("lists the queue with tabs, verdicts, attribution and times", async () => {
    await seedQueue();
    const response = await get("/admin/feedback");
    expect(response.status).toBe(200);
    const text = words(await response.text());
    expect(text).toContain("New 1");
    expect(text).toContain("October statement");
    expect(text).toContain("Queue Org");
    expect(text).toContain("Safe");
    expect(text).toContain("Google Web Risk");
  });

  it("selects a report with its quote, drivers and triage actions", async () => {
    const row = await seedQueue();
    const response = await get(`/admin/feedback?selected=${row.id}`);
    expect(response.status).toBe(200);
    const text = words(await response.text());
    expect(text).toContain("What drove our verdict");
    expect(text).toContain("Should be at least suspicious");
    expect(text).toContain("Triage note");
    expect(text).toContain("Close: verdict was right");
  });

  it("saves the note, refuses a stale one, closes and reopens", async () => {
    const row = await seedQueue();
    const noted = await post("/admin/feedback/action", {
      action: "note",
      id: row.id,
      note: "Ledger was empty",
      updatedAt: row.updatedAt,
    });
    expect(noted.status).toBe(200);
    expect(words(await noted.text())).toContain("Note saved.");
    const stale = await post("/admin/feedback/action", {
      action: "note",
      id: row.id,
      note: "Too late",
      updatedAt: row.updatedAt,
    });
    expect(stale.status).toBe(200);
    const staleText = words(await stale.text());
    expect(staleText).toContain("changed while you worked");
    expect(staleText).toContain("Too late");
    const fresh = await db
      .prepare("SELECT updated_at AS updatedAt FROM feedback WHERE id = ?")
      .bind(row.id)
      .first<{ updatedAt: string }>();
    // Closing carries the typed note with it: no words are lost on the way to Closed.
    const closed = await post("/admin/feedback/action", {
      action: "close",
      id: row.id,
      note: "Checked against the ledger",
      updatedAt: fresh?.updatedAt ?? "",
    });
    expect(words(await closed.text())).toContain("Closed: the verdict was right.");
    const kept = await db
      .prepare("SELECT triage_note AS note FROM feedback WHERE id = ?")
      .bind(row.id)
      .first<{ note: string | null }>();
    expect(kept?.note).toBe("Checked against the ledger");
    const closedPage = words(await (await get("/admin/feedback?triage=closed")).text());
    expect(closedPage).toContain("Closed 1");
    const reopened = await post("/admin/feedback/action", {
      action: "reopen",
      id: row.id,
      note: "Checked against the ledger",
      updatedAt:
        (
          await db
            .prepare("SELECT updated_at AS updatedAt FROM feedback WHERE id = ?")
            .bind(row.id)
            .first<{ updatedAt: string }>()
        )?.updatedAt ?? "",
    });
    expect(words(await reopened.text())).toContain("Reopened for another look.");
  });

  it("links the selected report to the signed case report", async () => {
    const row = await seedQueue();
    const response = await get(`/admin/feedback?selected=${row.id}`);
    expect(response.status).toBe(200);
    const text = words(await response.text());
    expect(text).toContain("Open the case report");
    expect(text).toMatch(/href="\/r\/[^"]+"/);
  });

  it("follows the signed link as a non-member operator and refuses a tampered one", async () => {
    const row = await seedQueue();
    const page = words(await (await get(`/admin/feedback?selected=${row.id}`)).text());
    const href = /href="(\/r\/[^"]+)"/.exec(page)?.[1];
    if (!href) throw new Error("the selected report carries no signed link");
    const opened = await get(href);
    expect(opened.status).toBe(200);
    const tampered = await get(`${href.slice(0, -2)}${href.slice(-2, -1) === "A" ? "B" : "A"}${href.slice(-1)}`);
    expect(tampered.status).toBe(404);
  });

  it("keeps the queue page in selection links and refusal renders", async () => {
    const row = await seedQueue();
    const page = words(await (await get(`/admin/feedback?page=0&selected=${row.id}`)).text());
    expect(page).toContain(`triage=new&page=0&selected=${row.id}`);
    const refused = await post("/admin/feedback/action", {
      action: "note",
      id: row.id,
      note: "Draft words",
      updatedAt: "1970-01-01T00:00:00.000Z",
      triage: "closed",
      page: "2",
    });
    const refusedText = words(await refused.text());
    expect(refusedText).toContain("changed while you worked");
    expect(refusedText).toContain("Draft words");
    expect(refusedText).toContain("No closed reports");
  });

  it("reads a withdrawn selection as withdrawn and drops it from the queue", async () => {
    const row = await seedQueue();
    await db.prepare("DELETE FROM feedback WHERE id = ?").bind(row.id).run();
    const response = await get(`/admin/feedback?selected=${row.id}`);
    expect(response.status).toBe(200);
    const text = words(await response.text());
    expect(text).toContain("Report withdrawn");
    expect(text).toContain("New 0");
  });

  it("refuses the queue and every mutation without Access or from another origin", async () => {
    const denied = await get("/admin/feedback", false);
    expect(denied.status).toBe(403);
    const row = await seedQueue();
    const forged = await post(
      "/admin/feedback/action",
      { action: "note", id: row.id, note: "x", updatedAt: row.updatedAt },
      "https://evil.example",
    );
    expect(forged.status).toBe(403);
    const kept = await db.prepare("SELECT triage FROM feedback WHERE id = ?").bind(row.id).first<{ triage: string }>();
    expect(kept?.triage).toBe("new");
  });

  it("moves the open count with triage and never with notice delivery", async () => {
    const row = await seedQueue();
    const open = words(await (await get("/admin/feedback")).text());
    expect(open).toContain("New 1");
    // The operator notice going out is delivery, not triage: the count stays.
    await db.prepare("UPDATE feedback SET notified_at = ? WHERE id = ?").bind(new Date().toISOString(), row.id).run();
    const afterNotice = words(await (await get("/admin/feedback")).text());
    expect(afterNotice).toContain("New 1");
    const fresh = await db
      .prepare("SELECT updated_at AS updatedAt FROM feedback WHERE id = ?")
      .bind(row.id)
      .first<{ updatedAt: string }>();
    await post("/admin/feedback/action", { action: "close", id: row.id, note: "", updatedAt: fresh?.updatedAt ?? "" });
    const afterClose = words(await (await get("/admin/feedback")).text());
    expect(afterClose).toContain("New 0");
    expect(afterClose).toContain("Closed 1");
  });

  it("refuses a close carrying a note past the transport bound and changes nothing", async () => {
    const row = await seedQueue();
    const noted = await saveTriageNote(db, { id: row.id, note: "Keep me", knownUpdatedAt: row.updatedAt });
    const huge = "n".repeat(2001);
    const response = await post("/admin/feedback/action", {
      action: "close",
      id: row.id,
      note: huge,
      updatedAt: noted?.updatedAt ?? "",
    });
    expect(response.status).toBe(200);
    expect(words(await response.text())).toContain("too long");
    const kept = await db
      .prepare("SELECT triage, triage_note FROM feedback WHERE id = ?")
      .bind(row.id)
      .first<{ triage: string; triage_note: string | null }>();
    expect(kept?.triage).toBe("triaged");
    expect(kept?.triage_note).toBe("Keep me");
  });

  it("keeps the typed note when the note is too long and stores nothing", async () => {
    const row = await seedQueue();
    const long = "n".repeat(1001);
    const response = await post("/admin/feedback/action", {
      action: "note",
      id: row.id,
      note: long,
      updatedAt: row.updatedAt,
    });
    expect(response.status).toBe(200);
    const text = words(await response.text());
    expect(text).toContain("too long");
    const kept = await db
      .prepare("SELECT triage, triage_note FROM feedback WHERE id = ?")
      .bind(row.id)
      .first<{ triage: string; triage_note: string | null }>();
    expect(kept?.triage).toBe("new");
    expect(kept?.triage_note).toBeNull();
  });
});

describe("the organisation detail page", () => {
  const seedOrg = async (name = "Detail Org (fictional)") => {
    const orgId = await makeOrg(name);
    await db
      .prepare(
        `INSERT INTO org_domains (id, org_id, domain, token, state, method, verified_at, created_at) VALUES (?, ?, 'detail.example', 't12345678901234567890123456789012', 'verified', 'dns', ?, ?)`,
      )
      .bind(`d-${crypto.randomUUID()}`, orgId, new Date().toISOString(), new Date().toISOString())
      .run();
    const { cookie } = await signIn(`owner-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`);
    const user = await db.prepare(`SELECT id FROM "user" ORDER BY rowid DESC LIMIT 1`).bind().first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, 'owner', ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, new Date().toISOString())
      .run();
    await db
      .prepare(
        `INSERT INTO "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") VALUES (?, ?, 'pending@demo.isitlegit.co.za', 'member', 'pending', ?, ?, ?)`,
      )
      .bind(
        `i-${crypto.randomUUID()}`,
        orgId,
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date().toISOString(),
        user?.id,
      )
      .run();
    void cookie;
    return { orgId, userId: user?.id ?? "" };
  };
  const seedOrgCase = async (orgId: string, createdAt: string, verdict: "safe" | "suspicious" = "safe") => {
    const id = ulid();
    await db
      .prepare(
        `INSERT INTO cases (id, org_id, channel, status, verdict, headers_available, original_subject, created_at, updated_at) VALUES (?, ?, 'email', 'done', ?, 1, 'Statement', ?, ?)`,
      )
      .bind(id, orgId, verdict, createdAt, createdAt)
      .run();
    await db
      .prepare(
        `INSERT INTO case_verdicts (case_id, verdict, headline, confidence, reasons, actions, source, created_at) VALUES (?, ?, 'h', 0.9, '[]', '[]', 'stub', ?)`,
      )
      .bind(id, verdict, createdAt)
      .run();
    return id;
  };

  it("draws the header, onboarding, domains, members, weeks, threats, feedback and plan", async () => {
    const { orgId } = await seedOrg();
    const at = new Date();
    await seedOrgCase(orgId, at.toISOString(), "suspicious");
    await db
      .prepare(
        `INSERT INTO check_outcomes (case_id, run_id, check_name, seq, outcome, findings, revision) VALUES ((SELECT id FROM cases WHERE org_id = ? LIMIT 1), 'r1', 'link.credential_form', 1, 'ran', 2, 'test')`,
      )
      .bind(orgId)
      .run();
    const feedbackId = `fq-${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO feedback (id, case_id, user_id, kind, note, providers_json, created_at, updated_at) VALUES (?, (SELECT id FROM cases WHERE org_id = ? LIMIT 1), 'u-x', 'missed', 'Nope', '[]', ?, ?)`,
      )
      .bind(feedbackId, orgId, at.toISOString(), at.toISOString())
      .run();
    const response = await get(`/admin/orgs/${orgId}`);
    expect(response.status).toBe(200);
    const text = words(await response.text());
    expect(text).toContain("Detail Org");
    expect(text).toContain("Trial,");
    expect(text).toContain("Verify your domain");
    expect(text).toContain("detail.example");
    expect(text).toContain("Invited");
    expect(text).toContain("Cases by week");
    expect(text).toContain("Top threats, 30 days");
    expect(text).toContain("A page that collects what you type");
    expect(text).toContain("Feedback from this organisation");
    expect(text).toContain("Open queue");
    expect(text).toContain("Plan");
    expect(text).toContain("Protected identity: not set up");
  });

  it("answers 404 for an unknown organisation", async () => {
    expect((await get("/admin/orgs/no-such-org")).status).toBe(404);
  });

  it("sets and clears the daily cap with the value kept on refusal", async () => {
    const { orgId } = await seedOrg();
    const set = await post(`/admin/orgs/${orgId}/cap`, { action: "set", cap: "30" });
    expect(set.status).toBe(303);
    const stored = await db
      .prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
      .bind(orgId)
      .first<{ cap: number }>();
    expect(stored?.cap).toBe(30);
    const page = words(await (await get(`/admin/orgs/${orgId}`)).text());
    expect(page).toContain("Today 0 of 30 cases");
    const bad = await post(`/admin/orgs/${orgId}/cap`, { action: "set", cap: "abc" });
    expect(bad.status).toBe(200);
    expect(words(await bad.text())).toContain("whole number from 0 to 50");
    const cleared = await post(`/admin/orgs/${orgId}/cap`, { action: "clear" });
    expect(cleared.status).toBe(303);
    const gone = await db
      .prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
      .bind(orgId)
      .first<{ cap: number | null }>();
    expect(gone?.cap).toBeNull();
  });

  it("extends the trial to a future day and refuses bad dates and paid plans", async () => {
    const { orgId } = await seedOrg();
    const future = new Date(Date.now() + 30 * 86_400_000);
    const day = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, "0")}-${String(future.getUTCDate()).padStart(2, "0")}`;
    const extended = await post(`/admin/orgs/${orgId}/trial`, { until: day });
    expect(extended.status).toBe(303);
    const past = await post(`/admin/orgs/${orgId}/trial`, { until: "2001-01-01" });
    expect(words(await past.text())).toContain("still to come");
    const shapeless = await post(`/admin/orgs/${orgId}/trial`, { until: "soon" });
    expect(words(await shapeless.text())).toContain("YYYY-MM-DD");
    await db
      .prepare(
        "INSERT INTO org_limits (org_id, plan) VALUES (?, 'protect') ON CONFLICT (org_id) DO UPDATE SET plan = 'protect'",
      )
      .bind(orgId)
      .run();
    const paid = await post(`/admin/orgs/${orgId}/trial`, { until: day });
    expect(words(await paid.text())).toContain("A paid plan has no trial to extend.");
  });

  it("puts a lapsed trial back on trial from the page", async () => {
    const { orgId } = await seedOrg();
    const lapsed = new Date(Date.now() - 30 * 86_400_000);
    await db.prepare(`UPDATE "organization" SET "createdAt" = ? WHERE id = ?`).bind(lapsed.toISOString(), orgId).run();
    const before = words(await (await get(`/admin/orgs/${orgId}`)).text());
    expect(before).toContain("Free");
    const future = new Date(Date.now() + 20 * 86_400_000);
    const day = `${future.getUTCFullYear()}-${String(future.getUTCMonth() + 1).padStart(2, "0")}-${String(future.getUTCDate()).padStart(2, "0")}`;
    const extended = await post(`/admin/orgs/${orgId}/trial`, { until: day });
    expect(extended.status).toBe(303);
    const after = words(await (await get(`/admin/orgs/${orgId}`)).text());
    expect(after).toContain("Trial,");
  });

  it("refuses an impossible calendar day and keeps the typed day", async () => {
    const { orgId } = await seedOrg();
    const response = await post(`/admin/orgs/${orgId}/trial`, { until: "2027-02-30" });
    expect(response.status).toBe(200);
    const text = words(await response.text());
    expect(text).toContain("real YYYY-MM-DD day");
    expect(text).toContain('value="2027-02-30"');
  });

  it("changes the plan and back with the cap override surviving", async () => {
    const { orgId } = await seedOrg();
    await post(`/admin/orgs/${orgId}/cap`, { action: "set", cap: "30" });
    const moved = await post(`/admin/orgs/${orgId}/plan`, { plan: "protect" });
    expect(moved.status).toBe(303);
    const page = words(await (await get(`/admin/orgs/${orgId}`)).text());
    expect(page).toContain("Protect");
    expect(page).toContain("Today 0 of 30 cases");
    const stored = await db
      .prepare("SELECT daily_cases_override AS cap FROM org_limits WHERE org_id = ?")
      .bind(orgId)
      .first<{ cap: number | null }>();
    expect(stored?.cap).toBe(30);
    const back = await post(`/admin/orgs/${orgId}/plan`, { plan: "free" });
    expect(back.status).toBe(303);
    const backPage = words(await (await get(`/admin/orgs/${orgId}`)).text());
    expect(backPage).toContain("Free");
    const bogus = await post(`/admin/orgs/${orgId}/plan`, { plan: "gold" });
    expect(bogus.status).toBe(200);
    expect(words(await bogus.text())).toContain("Pick the plan");
  });
});
