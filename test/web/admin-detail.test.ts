// The admin organisation detail and feedback queue (D07 T08 §5): the triage state machine behind the New,
// Triaged and Closed tabs. A member edit after triage reopens the item, a stale operator POST is refused, and a
// withdrawn row leaves the queue; the counts follow the triage state while notices still follow notified_at.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createCase } from "../../src/db/cases";
import { saveFeedback, withdrawFeedback } from "../../src/db/feedback";
import { listTriage, moveTriage, saveTriageNote, triageCounts } from "../../src/db/feedback-triage";
import { ulid } from "../../src/db/ulid";
import { authEnv, call } from "../auth/helpers";
import { makeOrg } from "../trust/helpers";

const db = env.DB;

// Every test starts from an empty queue: leftover rows would move the tabs and the pages.
const TABLES = ["feedback", "check_outcomes", "case_verdicts", "cases", "organization"];
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

describe("the feedback queue page", () => {
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
    const noted = await post("/admin/feedback/note", {
      id: row.id,
      note: "Ledger was empty",
      updatedAt: row.updatedAt,
    });
    expect(noted.status).toBe(200);
    expect(words(await noted.text())).toContain("Note saved.");
    const stale = await post("/admin/feedback/note", { id: row.id, note: "Too late", updatedAt: row.updatedAt });
    expect(stale.status).toBe(200);
    const staleText = words(await stale.text());
    expect(staleText).toContain("changed while you worked");
    expect(staleText).toContain("Too late");
    const fresh = await db
      .prepare("SELECT updated_at AS updatedAt FROM feedback WHERE id = ?")
      .bind(row.id)
      .first<{ updatedAt: string }>();
    const closed = await post("/admin/feedback/close", { id: row.id, updatedAt: fresh?.updatedAt ?? "" });
    expect(words(await closed.text())).toContain("Closed: the verdict was right.");
    const closedPage = words(await (await get("/admin/feedback?triage=closed")).text());
    expect(closedPage).toContain("Closed 1");
    const reopened = await post("/admin/feedback/reopen", {
      id: row.id,
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
      "/admin/feedback/note",
      { id: row.id, note: "x", updatedAt: row.updatedAt },
      "https://evil.example",
    );
    expect(forged.status).toBe(403);
    const kept = await db.prepare("SELECT triage FROM feedback WHERE id = ?").bind(row.id).first<{ triage: string }>();
    expect(kept?.triage).toBe("new");
  });

  it("keeps the typed note when the note is too long and stores nothing", async () => {
    const row = await seedQueue();
    const long = "n".repeat(1001);
    const response = await post("/admin/feedback/note", { id: row.id, note: long, updatedAt: row.updatedAt });
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
