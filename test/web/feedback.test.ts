import { env } from "cloudflare:test";
import { jsx } from "hono/jsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { CheckRegistry } from "../../src/checks/registry";
import { createCase } from "../../src/db/cases";
import { feedbackWaiting, readFeedback, saveFeedback, waitingNotices, withdrawFeedback } from "../../src/db/feedback";
import worker from "../../src/index";
import { buildReply } from "../../src/mail/reply";
import { citedProviders, sendFeedbackNotice, sendPendingFeedbackNotices } from "../../src/web/pages/feedback";
import { FeedbackControl } from "../../src/web/pages/feedback-control";
import { feedbackNotice } from "../../src/web/pages/feedback-notice";
import { signReportLink } from "../../src/web/report-link";
import { authEnv, call, ORIGIN, signIn, stubSmtp2go } from "../auth/helpers";
import { putStoredVerdict } from "./stored-verdict";

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
// `verdict`: true for a finished check with a verdict, false for a failed one (partial, no verdict), "running" for a
// check still running, "partial" for a partial check with its verdict.
async function finished(
  orgId: string,
  reasons: (string | { text: string; evidenceIds: string[] })[] = [],
  verdict: boolean | "running" | "partial" = true,
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
  if (verdict === "running") {
    await db.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(id).run();
    return id;
  }
  if (verdict) {
    await putStoredVerdict(db, id, {
      verdict: "malicious",
      headline: "A headline.",
      confidence: 0.9,
      reasons,
      actions: ["Do not click."],
      source: "rules",
    });
    await db
      .prepare("UPDATE cases SET status = ?, verdict = 'malicious' WHERE id = ?")
      .bind(verdict === "partial" ? "partial" : "done", id)
      .run();
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
    expect(await first.text()).toContain("Sent: you said this looks safe.");
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

  // D07 T09 §3: the reply mail's signed dispute link, followed from the mailbox to the stored dispute.
  it("stores a dispute sent from the reply mail's dispute link, once, with one operator notice", async () => {
    const orgId = await org("Mailbox Co");
    const mine = await member(orgId);
    const id = await finished(orgId);
    const mail = stubSmtp2go();
    // The address the generated reply mail itself carries: built by the mail builder from the signed report
    // link, and taken out of its plain part, as a reader (or a scanner) meets it.
    const signed = await signReportLink(SECRET, id, orgId);
    const reply = buildReply({
      parentSubject: "Fwd: Invoice 77",
      headersAvailable: true,
      otherOriginals: 0,
      reportUrl: `https://isitlegit.test${signed}`,
      report: {
        status: "ready",
        view: {
          verdict: "malicious",
          headline: "A headline.",
          confidence: 0.9,
          reasons: [{ text: "A reason.", evidenceIds: ["E1"] }],
          actions: ["Do not click."],
          meaning: null,
          source: "rules",
          floorApplied: null,
        },
      },
      design: { appUrl: "https://isitlegit.test", organisation: "Mailbox Co" },
    });
    const dispute = /Tell us on the report page: (\S+)\./.exec(reply.text)?.[1] as string;
    expect(dispute).toContain("dispute=1");
    const path = new URL(dispute).pathname + new URL(dispute).search;
    // Opening it, signed out or signed in, saves nothing: a mail scanner following the link disputes nothing.
    await call(path);
    await call(path, { headers: { cookie: mine.cookie } });
    expect(await rows(id)).toEqual([]);
    // Signed in, the report opens with the dispute line the board draws for a member who came from the email.
    const page = await (await call(`/r/${id}?dispute=1`, { headers: { cookie: mine.cookie } })).text();
    expect(page).toContain("You came here from the email to say this verdict is wrong.");
    // The one press, with the member's own session: stored once, and the operator is told once.
    expect((await post(id, { kind: "false_alarm" }, mine.cookie)).status).toBe(200);
    await sendPendingFeedbackNotices(authEnv as Env);
    await sendPendingFeedbackNotices(authEnv as Env);
    expect(await rows(id)).toHaveLength(1);
    const told = mail.sends.filter((s) => s.text.includes("Organisation: Mailbox Co"));
    expect(told).toHaveLength(1);
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
    const res = await post(id, { kind: "missed", note: "Kept through the outage." }, cookie);
    expect(res.status).toBe(503);
    const html = await res.text();
    expect(html).toContain("Nothing was saved");
    expect(html).toContain("Kept through the outage.");
    vi.restoreAllMocks();
    expect(await rows(id)).toEqual([]);
  });

  it("refuses an overlong note anywhere in the accepted body, never saving it as no note", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie, userId } = await member(orgId);
    const id = await finished(orgId);
    await post(id, { kind: "missed", note: "The first note." }, cookie);
    for (const length of [1001, 4001, 12_000]) {
      const res = await post(id, { kind: "false_alarm", note: "n".repeat(length) }, cookie);
      expect(res.status, String(length)).toBe(400);
    }
    expect(await readFeedback(db, id, userId)).toMatchObject({ kind: "missed", note: "The first note." });
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

// "Withdraw" (D07 T03 §21): a member takes their own feedback back in one press.
const withdraw = (id: string, cookie?: string, origin = ORIGIN) =>
  call(`/r/${id}/feedback/withdraw`, {
    method: "POST",
    headers: { origin, ...(cookie ? { cookie } : {}) },
  });
const page = async (id: string, cookie: string) =>
  (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();

describe("withdrawing feedback", () => {
  it("removes the member's own feedback from the waiting notices, the queue count and the providers, leaving others", async () => {
    const orgId = await org();
    const a = await member(orgId);
    const b = await member(orgId);
    const id = await finished(orgId, [{ text: "Listed.", evidenceIds: ["E1"] }]);
    const mine = await saveFeedback(db, {
      caseId: id,
      userId: a.userId,
      kind: "false_alarm",
      note: null,
      providers: ["google-web-risk"],
    });
    await saveFeedback(db, { caseId: id, userId: b.userId, kind: "missed", note: null, providers: [] });
    const before = await feedbackWaiting(db);
    expect((await waitingNotices(db, 500)).map((r) => r.id)).toContain(mine.id);
    expect(await withdrawFeedback(db, id, a.userId)).toBe(true);
    expect(await readFeedback(db, id, a.userId)).toBeNull();
    expect((await waitingNotices(db, 500)).map((r) => r.id)).not.toContain(mine.id);
    expect(await feedbackWaiting(db)).toBe(before - 1);
    expect(
      (await db.prepare("SELECT providers_json FROM feedback WHERE case_id = ?").bind(id).all()).results.map(
        (r) => r.providers_json,
      ),
    ).toEqual(["[]"]);
    expect(await readFeedback(db, id, b.userId)).not.toBeNull();
    // A second withdrawal changes nothing.
    expect(await withdrawFeedback(db, id, a.userId)).toBe(false);
  });

  it("withdraws through the route for a member only, says so once, and holds across a reload with new feedback possible", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie } = await member(orgId);
    const stranger = await member(await org("Elsewhere"));
    const id = await finished(orgId);
    expect((await post(id, { kind: "false_alarm" }, cookie)).status).toBe(200);
    expect(await page(id, cookie)).toContain("Withdraw");
    // Not a stranger, a signed-out reader or another site.
    expect((await withdraw(id, stranger.cookie)).status).toBe(404);
    expect((await withdraw(id)).status).toBe(404);
    expect((await withdraw(id, cookie, "https://elsewhere.example")).status).toBe(403);
    expect(await rows(id)).toHaveLength(1);
    const done = await withdraw(id, cookie);
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain("You took your feedback back.");
    expect(html).toContain("data-withdrawn");
    expect(html).toContain("Was this verdict wrong?");
    expect(html).not.toContain("Sent: you said");
    expect(await rows(id)).toEqual([]);
    // A second press is the closed control alone, saying nothing.
    const again = await (await withdraw(id, cookie)).text();
    expect(again).not.toContain("You took your feedback back.");
    expect(again).toContain("Was this verdict wrong?");
    // After a reload it stays withdrawn, and the member can say it again.
    const reloaded = await page(id, cookie);
    expect(reloaded).not.toContain("Sent: you said");
    expect(reloaded).toContain("Was this verdict wrong?");
    expect((await post(id, { kind: "missed" }, cookie)).status).toBe(200);
    expect(await rows(id)).toHaveLength(1);
  });

  it("does not let a send that began before a withdrawal recreate the feedback (D07 T03 §22)", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie, userId } = await member(orgId);
    const id = await finished(orgId);
    await post(id, { kind: "false_alarm" }, cookie);
    const saved = await readFeedback(db, id, userId);
    await withdraw(id, cookie);
    expect(await rows(id)).toEqual([]);
    // The delayed note send, carrying the state it began from, is refused as withdrawn and stores nothing.
    const stale = await post(id, { kind: "false_alarm", note: "Late note.", base: saved?.updatedAt ?? "" }, cookie);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("You took your feedback back.");
    expect(await rows(id)).toEqual([]);
    // A fresh press, with no base, disputes again.
    expect((await post(id, { kind: "missed" }, cookie)).status).toBe(200);
    expect(await rows(id)).toHaveLength(1);
  });

  it("leaves the feedback and says so when the delete does not go through, never a 500", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie } = await member(orgId);
    const id = await finished(orgId);
    await post(id, { kind: "false_alarm" }, cookie);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/DELETE FROM feedback/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    const res = await withdraw(id, cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-feedback")).toBe("1");
    const html = await res.text();
    expect(html).toContain("That did not go through. Your feedback is still there: try again in a moment.");
    expect(html).toContain("Sent: you said this looks safe.");
    expect(html).toContain("Withdraw");
    vi.restoreAllMocks();
    expect(await rows(id)).toHaveLength(1);
  });

  // Completion review: the delete landed but the answer to it failed. The member is told it is withdrawn, not that it remains.
  it("answers a delete that committed though its answer failed as withdrawn, not as still there", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie } = await member(orgId);
    const id = await finished(orgId);
    await post(id, { kind: "false_alarm" }, cookie);
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      const real = prepare(sql);
      if (!/DELETE FROM feedback/.test(sql)) return real;
      // The statement runs, then its answer is lost.
      return new Proxy(real, {
        get(target, key) {
          if (key === "bind")
            return (...args: unknown[]) => {
              const bound = (target.bind as (...a: unknown[]) => D1PreparedStatement)(...args);
              return new Proxy(bound, {
                get(inner, k) {
                  if (k === "run")
                    return async () => {
                      await inner.run();
                      throw new Error("D1_ERROR: Network connection lost.");
                    };
                  const v = Reflect.get(inner, k);
                  return typeof v === "function" ? v.bind(inner) : v;
                },
              });
            };
          const v = Reflect.get(target, key);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    });
    const res = await withdraw(id, cookie);
    vi.restoreAllMocks();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You took your feedback back.");
    expect(html).not.toContain("Your feedback is still there");
    expect(await rows(id)).toEqual([]);
  });

  // The cron holds a batch of waiting notices in memory: one withdrawn since is not announced.
  it("sends no notice for a feedback withdrawn after the cron selected its batch, and still sends the others", async () => {
    const orgId = await org("Withdraw Co");
    const a = await member(orgId);
    const b = await member(orgId);
    const id = await finished(orgId);
    const mail = stubSmtp2go();
    const kept = await saveFeedback(db, {
      caseId: id,
      userId: a.userId,
      kind: "false_alarm",
      note: null,
      providers: [],
    });
    const taken = await saveFeedback(db, { caseId: id, userId: b.userId, kind: "missed", note: null, providers: [] });
    const batch = (await waitingNotices(db, 500)).filter((r) => r.caseId === id);
    expect(batch.map((r) => r.id).sort()).toEqual([kept.id, taken.id].sort());
    // Withdrawn between the batch's selection and its dispatch.
    expect(await withdrawFeedback(db, id, b.userId)).toBe(true);
    const results = [];
    for (const row of batch)
      results.push([row.id, await sendFeedbackNotice(authEnv as Env, row as never).catch(() => false)]);
    expect(Object.fromEntries(results)[kept.id]).toBe(true);
    expect(Object.fromEntries(results)[taken.id]).toBe(false);
    const mine = mail.sends.filter((s) => s.text.includes("Organisation: Withdraw Co"));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toContain("It is safe (false alarm)");
    expect(mine[0]?.text).not.toContain("a scam");
  });
});

describe("the control", () => {
  it("is drawn for a partial check with a verdict, and not for one still running", async () => {
    const orgId = await org();
    const { cookie } = await member(orgId);
    const partial = await finished(orgId, [], "partial");
    expect(await (await call(`/r/${partial}`, { headers: { cookie, accept: "text/html" } })).text()).toContain(
      "Was this verdict wrong?",
    );
    const running = await finished(orgId, [], "running");
    expect(await (await call(`/r/${running}`, { headers: { cookie, accept: "text/html" } })).text()).not.toContain(
      "Was this verdict wrong?",
    );
    expect((await post(running, { kind: "missed" }, cookie)).status).toBe(409);
  });

  it("is drawn for a member on a finished report, with their saved feedback and Change after a reload, and never for a link holder", async () => {
    stubSmtp2go();
    const orgId = await org();
    const { cookie } = await member(orgId);
    const id = await finished(orgId);
    let html = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
    expect(html).toContain("Was this verdict wrong?");
    await post(id, { kind: "false_alarm", note: "Our supplier." }, cookie);
    html = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
    expect(html).toContain("Sent: you said this looks safe.");
    const change = await (await call(`/r/${id}/feedback`, { headers: { cookie } })).text();
    expect(change).toMatch(/value="false_alarm"[^>]*checked/);
    expect(change).toContain("Our supplier.");
    const link = await signReportLink(SECRET, id, orgId);
    expect(await (await call(link, { headers: { accept: "text/html" } })).text()).not.toContain(
      "Was this verdict wrong?",
    );
  });

  it("puts first the choice that disputes the verdict, and draws none without a verdict", async () => {
    const form = { kind: "", note: "", errors: {} };
    const malicious = String(
      jsx(FeedbackControl, { caseId: "C", verdict: "malicious", saved: null, open: true, form }),
    );
    expect(malicious.indexOf('value="false_alarm"')).toBeLessThan(malicious.indexOf('value="missed"'));
    const safe = String(jsx(FeedbackControl, { caseId: "C", verdict: "safe", saved: null, open: true, form }));
    expect(safe.indexOf('value="missed"')).toBeLessThan(safe.indexOf('value="false_alarm"'));
    // The closed control is one press naming the opposite verdict (D07 T03 §22).
    const closed = String(jsx(FeedbackControl, { caseId: "C", verdict: "safe", saved: null }));
    expect(closed).toContain("Was this verdict wrong?");
    expect(closed).toContain("I think this is a scam");
    expect(closed).toContain('value="missed"');
    expect(closed).toContain("One press sends it. You can add a note after.");
    const intent = String(jsx(FeedbackControl, { caseId: "C", verdict: "malicious", saved: null, dispute: true }));
    expect(intent).toContain("You came here from the email to say this verdict is wrong.");
    expect(intent).toContain("data-focus-on-load");
    expect(intent).toContain("I think this is safe");
    const orgId = await org();
    const { cookie } = await member(orgId);
    const running = await finished(orgId, [], false);
    expect(await (await call(`/r/${running}`, { headers: { cookie, accept: "text/html" } })).text()).not.toContain(
      "This verdict is wrong",
    );
  });
});

describe("the operator notice", () => {
  it("draws N9's summary in both parts, with the listings the verdict leaned on and the queue, never a note", () => {
    const notice = feedbackNotice({
      appUrl: "https://app.isitlegit.co.za",
      at: new Date(Date.UTC(2026, 9, 27, 13, 40)),
      organisation: "Karoo Couriers <Pty>",
      verdict: "malicious",
      confidence: 0.92,
      kind: "false_alarm",
      listings: [{ provider: "google-web-risk", id: "E9" }],
      waiting: 3,
    });
    for (const part of [notice.text, notice.html]) {
      expect(part).toContain("Verdict given");
      expect(part).toContain("Malicious, high confidence");
      expect(part).toContain("It is safe (false alarm)");
      expect(part).toContain("Google Web Risk listing (E9)");
      expect(part).toContain("3 waiting");
      expect(part).toContain("https://app.isitlegit.co.za/admin/feedback");
    }
    expect(notice.html).toContain("Feedback · 15:40 SAST");
    expect(notice.html).toContain("Karoo Couriers &lt;Pty&gt;");
    expect(notice.html).toMatch(
      /<a href="https:\/\/app\.isitlegit\.co\.za\/admin\/feedback"[^>]*>Open the feedback queue<\/a>/,
    );
    expect(notice.html).toContain("https://app.isitlegit.co.za/static/brand/logo.");
  });

  it("never lets notices stuck uncertain keep later ones from their turn", async () => {
    const orgId = await org();
    const id = await finished(orgId);
    for (let i = 0; i < 22; i++) {
      const { userId } = await member(orgId);
      await saveFeedback(db, { caseId: id, userId, kind: "missed", note: null, providers: [] });
    }
    // Every send times out, so each stays waiting; the next cron run takes the ones not yet tried first.
    stubSmtp2go(() => "silent");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await sendPendingFeedbackNotices(authEnv as Env);
    await sendPendingFeedbackNotices(authEnv as Env);
    const tried = await db
      .prepare("SELECT COUNT(*) AS n FROM feedback WHERE case_id = ? AND notice_tried_at IS NOT NULL")
      .bind(id)
      .first<{ n: number }>();
    expect(tried?.n).toBe(22);
    // These stay waiting by design; they are cleared so the next test's cron run is not queued behind them.
    await db.prepare("DELETE FROM feedback WHERE case_id = ?").bind(id).run();
  });

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
    // The designed HTML part goes too (N9), with the queue as its button and no note.
    expect(sent[0]?.html).toMatch(/<a href="[^"]*\/admin\/feedback"[^>]*>Open the feedback queue<\/a>/);
    expect(sent[0]?.html).not.toContain("A private note");
    // The cron again, and a replaced choice: nothing more.
    await sendPendingFeedbackNotices(authEnv as Env);
    await post(id, { kind: "missed" }, cookie);
    await sendPendingFeedbackNotices(authEnv as Env);
    expect(mine()).toHaveLength(1);
  });

  it("leaves a notice waiting when the verdict cannot be read, never sending it without one", async () => {
    const orgId = await org();
    const { userId } = await member(orgId);
    const id = await finished(orgId);
    const row = await saveFeedback(db, { caseId: id, userId, kind: "missed", note: null, providers: [] });
    const mail = stubSmtp2go();
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM case_verdicts/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    await expect(sendFeedbackNotice(authEnv as Env, row)).rejects.toThrow();
    vi.restoreAllMocks();
    expect(mail.sends.filter((s) => s.text.includes(`${id}`) || s.subject.startsWith("Feedback"))).toHaveLength(0);
    expect((await readFeedback(db, id, userId))?.notifiedAt).toBeNull();
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
