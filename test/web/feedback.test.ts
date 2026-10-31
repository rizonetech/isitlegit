import { env } from "cloudflare:test";
import { jsx } from "hono/jsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import { createCase } from "../../src/db/cases";
import { readFeedback, saveFeedback } from "../../src/db/feedback";
import { saveVerdict } from "../../src/db/verdicts";
import worker from "../../src/index";
import { citedProviders, sendFeedbackNotice, sendPendingFeedbackNotices } from "../../src/web/pages/feedback";
import { FeedbackControl } from "../../src/web/pages/feedback-control";
import { signReportLink } from "../../src/web/report-link";
import { authEnv, call, ORIGIN, signIn, stubSmtp2go } from "../auth/helpers";

// "This verdict is wrong" (D07 T03 §6): a member of the case's organisation disputes its verdict; the case and its
// evidence never change; the cited reputation providers are recorded; the operator is told once per feedback, never
// with the note, and a notice that could not go is sent by the cron.
const db = (env as unknown as Env).DB;
const SECRET = (env as unknown as Env).REPORT_LINK_SECRET;
afterEach(() => vi.restoreAllMocks());

async function org(name = "Karoo Couriers") {
  const id = `org-fb-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(id, name, id, new Date().toISOString())
    .run();
  return id;
}
async function member(orgId: string) {
  const email = `fb-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
    .run();
  return { cookie, userId: user?.id as string, email };
}
// The reputation producer (D02 T06) is not built yet: these stand-ins register the names its items carry, so the
// items it will store can be stored here.
const REGISTRY = new CheckRegistry();
for (const name of ["reputation.listing", "reputation.counter_signal", "sender.first_time"])
  REGISTRY.register({ name, needs: [], timeoutMs: 1000, run: () => [] });
const LISTING = (provider: string) => ({
  check: "reputation.listing",
  severity: "high" as const,
  summary: `Listed by ${provider}`,
  detail: { provider },
  artefacts: [],
});
async function finished(
  orgId: string,
  reasons: (string | { text: string; evidenceIds: string[] })[] = [],
  verdict = true,
) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  // E1 Google Web Risk, E2 Cloudflare (never cited), E3 Google again, E4 not reputation, E5 a counter-signal.
  await saveEvidence(
    db,
    id,
    [
      LISTING("google-web-risk"),
      LISTING("cloudflare-security-dns"),
      LISTING("google-web-risk"),
      {
        check: "sender.first_time",
        severity: "low",
        summary: "First time",
        detail: { history: "first", from: "x@y.example", headers: [] },
        artefacts: [],
      },
      {
        check: "reputation.counter_signal",
        severity: "info",
        summary: "An aligned DMARC pass",
        detail: { provider: "dmarc-aligned" },
        artefacts: [],
      },
    ],
    REGISTRY,
  );
  if (verdict) {
    await saveVerdict(db, id, {
      verdict: "malicious",
      headline: "A headline.",
      confidence: 0.9,
      reasons: reasons as string[],
      actions: ["Do not click."],
      source: "rules",
    });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'malicious' WHERE id = ?").bind(id).run();
  } else await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
  return id;
}
const post = (id: string, fields: Record<string, string>, cookie?: string, origin = ORIGIN) =>
  call(`/r/${id}/feedback`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields),
  });
const snapshot = async (id: string) => ({
  verdict: await db
    .prepare("SELECT verdict, headline, confidence, reasons, actions FROM case_verdicts WHERE case_id = ?")
    .bind(id)
    .first(),
  evidence: (
    await db.prepare("SELECT id, summary, detail_json FROM evidence WHERE case_id = ? ORDER BY seq").bind(id).all()
  ).results,
  status: await db.prepare("SELECT status, verdict FROM cases WHERE id = ?").bind(id).first(),
});
const rows = async (id: string) =>
  (await db.prepare("SELECT user_id, kind, note FROM feedback WHERE case_id = ?").bind(id).all()).results;

describe("the feedback table", () => {
  it("refuses a third kind and a note over 1000 characters", async () => {
    const id = await finished(await org());
    const insert = (kind: string, note: string | null) =>
      db
        .prepare(
          "INSERT INTO feedback (id, case_id, user_id, kind, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), id, crypto.randomUUID(), kind, note, "t", "t")
        .run();
    await expect(insert("unsure", null)).rejects.toThrow();
    await expect(insert("missed", "x".repeat(1001))).rejects.toThrow();
    await expect(insert("missed", "x".repeat(1000))).resolves.toBeTruthy();
  });
});

describe("posting feedback", () => {
  it("saves both kinds, replaces a member's own, keeps another member's apart, and changes nothing of the case", async () => {
    stubSmtp2go();
    const orgId = await org();
    const a = await member(orgId);
    const b = await member(orgId);
    const id = await finished(orgId);
    const before = await snapshot(id);
    const first = await post(id, { kind: "false_alarm", note: "This is our own supplier." }, a.cookie);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("You said this verdict is wrong: It is safe.");
    expect((await post(id, { kind: "missed" }, a.cookie)).status).toBe(200);
    expect((await post(id, { kind: "false_alarm" }, b.cookie)).status).toBe(200);
    const stored = await rows(id);
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.user_id === a.userId)).toMatchObject({ kind: "missed", note: null });
    expect(stored.find((r) => r.user_id === b.userId)).toMatchObject({ kind: "false_alarm" });
    expect(await snapshot(id)).toEqual(before);
  });

  it("refuses each bad field with the error on it and what was typed kept, writing nothing", async () => {
    const orgId = await org();
    const { cookie } = await member(orgId);
    const id = await finished(orgId);
    for (const [fields, words] of [
      [{ note: "Typed note." }, "Choose whether it is safe or a scam."],
      [{ kind: "unsure", note: "Typed note." }, "Choose whether it is safe or a scam."],
      [{ kind: "missed", note: "y".repeat(1001) }, "The note is longer than 1000 characters."],
    ] as const) {
      const res = await post(id, fields, cookie);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain(words);
      expect(html).toContain(fields.note);
      expect(html).toContain('role="alert"');
    }
    expect(await rows(id)).toEqual([]);
  });

  it("refuses another organisation's member, a removed member, a link holder, a case with no verdict, another origin and an oversized body", async () => {
    const orgId = await org();
    const mine = await member(orgId);
    const id = await finished(orgId);
    const stranger = await member(await org("Other Co"));
    expect((await post(id, { kind: "missed" }, stranger.cookie)).status).toBe(404);
    const removed = await member(orgId);
    await db.prepare(`DELETE FROM "member" WHERE "userId" = ?`).bind(removed.userId).run();
    expect((await post(id, { kind: "missed" }, removed.cookie)).status).toBe(404);
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost");
    expect(
      (
        await call(`/r/${id}/feedback${link.search}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
          body: "kind=missed",
        })
      ).status,
    ).toBe(404);
    const running = await finished(orgId, [], false);
    expect((await post(running, { kind: "missed" }, mine.cookie)).status).toBe(409);
    expect((await post(id, { kind: "missed" }, mine.cookie, "https://evil.example")).status).toBe(403);
    expect((await post(id, { kind: "missed", note: "z".repeat(20_000) }, mine.cookie)).status).toBe(413);
    expect(await rows(id)).toEqual([]);
  });

  it("answers a membership read that fails with 503, writing nothing", async () => {
    const orgId = await org();
    const { cookie } = await member(orgId);
    const id = await finished(orgId);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/JOIN "member" m ON/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    expect((await post(id, { kind: "missed" }, cookie)).status).toBe(503);
    vi.restoreAllMocks();
    expect(await rows(id)).toEqual([]);
  });

  it("records the providers of the cited reputation items exactly, each once", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie, userId } = await member(orgId);
    // The stored verdict takes plain reasons until the checks lane's structured ones land (D04 T01 §2; the route's
    // read-back of them is D07 T03 §10), so the citation rule is read on its own here.
    const cited = await finished(orgId);
    expect(
      await citedProviders(db, cited, [
        { text: "Listed.", evidenceIds: ["E1", "E4"] },
        { text: "Listed again.", evidenceIds: ["E3"] },
        { text: "An aligned DMARC pass argues the other way.", evidenceIds: ["E5"] },
      ]),
    ).toEqual(["google-web-risk"]);
    expect(
      await citedProviders(db, cited, [{ text: "Only the uncited one is elsewhere.", evidenceIds: ["E4"] }]),
    ).toEqual([]);
    const legacy = await finished(orgId, ["A plain reason with no citation."]);
    await post(legacy, { kind: "false_alarm" }, cookie);
    expect((await readFeedback(db, legacy, userId))?.providers).toEqual([]);
  });
});

describe("the control", () => {
  it("is drawn for a member on a finished report, with their saved feedback and Change after a reload, and never for a link holder", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie } = await member(orgId);
    const id = await finished(orgId);
    let html = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
    expect(html).toContain(">This verdict is wrong</summary>");
    await post(id, { kind: "false_alarm", note: "Our supplier." }, cookie);
    html = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
    expect(html).toContain("You said this verdict is wrong: It is safe.");
    const change = await (await call(`/r/${id}/feedback`, { headers: { cookie } })).text();
    expect(change).toMatch(/value="false_alarm"[^>]*checked/);
    expect(change).toContain("Our supplier.");
    const link = await signReportLink(SECRET, id, orgId);
    expect(await (await call(link, { headers: { accept: "text/html" } })).text()).not.toContain(
      "This verdict is wrong</summary>",
    );
  });

  it("puts first the choice that disputes the verdict, and draws none without a verdict", async () => {
    const malicious = String(jsx(FeedbackControl, { caseId: "C", verdict: "malicious", saved: null }));
    expect(malicious.indexOf('value="false_alarm"')).toBeLessThan(malicious.indexOf('value="missed"'));
    const safe = String(jsx(FeedbackControl, { caseId: "C", verdict: "safe", saved: null }));
    expect(safe.indexOf('value="missed"')).toBeLessThan(safe.indexOf('value="false_alarm"'));
    const orgId = await org();
    const { cookie } = await member(orgId);
    const running = await finished(orgId, [], false);
    expect(await (await call(`/r/${running}`, { headers: { cookie, accept: "text/html" } })).text()).not.toContain(
      "This verdict is wrong",
    );
  });
});

describe("the operator notice", () => {
  const notices = async () =>
    (
      await db
        .prepare("SELECT send_key, status FROM mail_sends WHERE kind = 'notice' AND send_key LIKE 'feedback:%'")
        .all()
    ).results;

  it("sends one notice for a feedback whose first send failed, from the cron, with no note in it", async () => {
    const orgId = await org("Fynbos Freight");
    const { cookie, userId } = await member(orgId);
    const id = await finished(orgId);
    let down = true;
    const mail = stubSmtp2go(() => (down ? "refused" : "sent"));
    // Saved through the store, so no background send of the post's races the two below.
    const row = await saveFeedback(db, {
      caseId: id,
      userId,
      kind: "false_alarm",
      note: "A private note about our supplier.",
      providers: [],
    });
    await sendFeedbackNotice(authEnv as Env, row as never);
    expect((await readFeedback(db, id, userId))?.notifiedAt).toBeNull();
    down = false;
    expect(await sendPendingFeedbackNotices(authEnv as Env)).toBeGreaterThanOrEqual(1);
    expect((await readFeedback(db, id, userId))?.notifiedAt).not.toBeNull();
    // The cron also sends what other tests' feedback left waiting: this case's notices are the ones naming its organisation.
    const mine = () => mail.sends.filter((s) => s.text.includes("Organisation: Fynbos Freight"));
    const sent = mine();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Organisation: Fynbos Freight");
    expect(sent[0]?.text).toContain("Member says: It is safe (false alarm)");
    expect(sent[0]?.text).toContain("Open the feedback queue: ");
    expect(sent[0]?.text).not.toContain("A private note");
    // The cron again, and a replaced choice: nothing more.
    await sendPendingFeedbackNotices(authEnv as Env);
    await post(id, { kind: "missed" }, cookie);
    await sendPendingFeedbackNotices(authEnv as Env);
    expect(mine()).toHaveLength(1);
  });

  it("sends one notice for two racing sends of the same feedback, and none with no operator address", async () => {
    const orgId = await org();
    const { cookie, userId } = await member(orgId);
    const id = await finished(orgId);
    const mail = stubSmtp2go();
    await post(id, { kind: "missed" }, cookie);
    const row = await readFeedback(db, id, userId);
    await Promise.all([
      sendFeedbackNotice(authEnv as Env, row as never),
      sendFeedbackNotice(authEnv as Env, row as never),
    ]);
    expect(
      mail.sends.filter((s) => s.subject === "Feedback: a member marked a verdict wrong").length,
    ).toBeLessThanOrEqual(1);
    expect((await notices()).filter((n) => n.send_key === `feedback:${row?.id}`)).toHaveLength(1);
    const quiet = { ...(authEnv as Env), OPERATOR_EMAIL: "" };
    expect(await sendFeedbackNotice(quiet, row as never)).toBe(false);
  });
});

void worker;
