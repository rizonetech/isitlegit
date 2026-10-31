import { env } from "cloudflare:test";
import { jsx } from "hono/jsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { saveVerdict } from "../../src/db/verdicts";
import { type Coverage, ReportLive } from "../../src/web/pages/report-live";
import { progressOf, type StepEvent } from "../../src/web/pages/report-progress";
import { signReportLink } from "../../src/web/report-link";
import { call, signIn } from "../auth/helpers";

// The report's live status, partial and failed states (D07 T03 §4): step attempts reduced per step, the poll answering
// the live region while a case runs and the finished report once with no trigger, coverage read from the stored check
// outcomes apart from the lifecycle, a reply failure its own notice, the failed state with its step and reference.
const db = (env as unknown as Env).DB;
const SECRET = (env as unknown as Env).REPORT_LINK_SECRET;
afterEach(() => vi.restoreAllMocks());

const at = (s: number) => new Date(Date.UTC(2026, 9, 31, 8, 0, s)).toISOString();
const ev = (step: string, status: StepEvent["status"], s: number, error: string | null = null): StepEvent => ({
  step,
  status,
  startedAt: at(s),
  ms: status === "started" ? null : 500,
  error,
});

describe("progress from step events", () => {
  it("reduces a retried step that recovers to done, and exhausted retries to failed", () => {
    const recovered = progressOf([
      ev("admit", "started", 0),
      ev("admit", "done", 0),
      ev("parse", "started", 1),
      ev("parse", "error", 1, "Error"),
      ev("parse", "started", 3),
      ev("parse", "done", 3),
    ]);
    expect(recovered.steps.find((s) => s.step === "parse")?.state).toBe("done");
    expect(recovered.failed).toBeNull();
    const exhausted = progressOf([
      ev("admit", "done", 0),
      ev("parse", "error", 1, "ParseError"),
      ev("parse", "failed", 1, "ParseError"),
    ]);
    expect(exhausted.failed?.step).toBe("parse");
    expect(exhausted.failed?.error).toBe("ParseError");
  });

  it("shows a step between attempts as trying again, and a running one as running", () => {
    const p = progressOf([ev("admit", "done", 0), ev("parse", "started", 1), ev("parse", "error", 1, "Error")]);
    expect(p.steps.find((s) => s.step === "parse")?.state).toBe("retrying");
    expect(p.current).toBe(2);
    const q = progressOf([ev("admit", "done", 0), ev("parse", "done", 1), ev("checks", "started", 2)]);
    expect(q.steps.find((s) => s.step === "checks")?.state).toBe("running");
    expect(q.current).toBe(3);
    expect(q.startedAt).toBe(at(0));
  });

  it("names the first failed step when a check failure is followed by a reply failure", () => {
    const p = progressOf([ev("checks", "failed", 1, "Timeout"), ev("reply", "failed", 2, "Error")]);
    expect(p.failed?.step).toBe("checks");
  });

  it("keeps a step it does not know, in its recorded order after the known ones", () => {
    const p = progressOf([ev("admit", "done", 0), ev("glimmer", "done", 1)]);
    expect(p.steps.map((s) => s.step).at(-1)).toBe("glimmer");
    expect(p.steps.at(-1)?.words).toBe("Another step");
  });
});

const VERDICT = {
  verdict: "suspicious" as const,
  headline: "A stored headline.",
  confidence: 0.6,
  reasons: ["A reason."],
  actions: ["An action."],
};
const live = (props: Partial<Parameters<typeof ReportLive>[0]>) =>
  String(
    jsx(ReportLive, {
      caseId: "01JCASE0000000000000000000",
      status: "done",
      verdict: VERDICT,
      sourceKind: "mail",
      channel: "email",
      delivery: "sent",
      evidence: [],
      progress: progressOf([]),
      coverage: [],
      view: "member",
      now: new Date(at(30)),
      ...props,
    }),
  );
const outcome = (check: string, o: NonNullable<Coverage>[number]["outcome"], reason: string | null = null) => ({
  check,
  outcome: o,
  reason,
  findings: 0,
});

describe("coverage apart from the lifecycle", () => {
  it("says a failed check on a done case, partly checked", () => {
    const html = live({ coverage: [outcome("auth.spf", "ran"), outcome("domain.age", "failed", "Timeout")] });
    expect(html).toContain("One check did not run, so this verdict rests on the one that did.");
    expect(html).toContain("How old the domain is:");
    expect(html).toContain("it ran out of time.");
    expect(html).toContain("Suspicious · medium confidence · partial check");
  });

  it("names grouped missing inputs and a partial read, counting ran and partial as run", () => {
    const html = live({
      coverage: [
        outcome("auth.spf", "skipped", "the original's headers were not available"),
        outcome("auth.dkim", "skipped", "the original's headers were not available"),
        outcome("content.hidden_text", "partial", "a cut body part"),
        outcome("sender.first_time", "ran"),
      ],
    });
    // Two did not run; the partial read ran, so it is named apart and counted with the one that ran in full.
    expect(html).toContain("Two checks did not run, so this verdict rests on the two that did.");
    expect(html).toContain("The sending server check (SPF):");
    expect(html).toContain("it had nothing to check (the original&#39;s headers were not available).");
    expect(html).toContain("Read only part of what they were given:");
    expect(html).toContain("<strong>Hidden text:</strong> a cut body part.");
  });

  it("says checks that only read part of their input without calling them not run", () => {
    const html = live({
      coverage: [outcome("content.hidden_text", "partial", "a cut body part"), outcome("auth.spf", "ran")],
    });
    expect(html).toContain("One check read only part of what it was given, so this verdict rests on what they read.");
    expect(html).not.toContain("did not run");
  });

  it("calls a partial case whose only gap is the reply checked, with the delivery said apart", () => {
    const html = live({
      status: "partial",
      coverage: [outcome("auth.spf", "ran")],
      delivery: "failed",
      progress: progressOf([ev("admit", "done", 0), ev("reply", "failed", 5, "Error")]),
    });
    expect(html).toContain("We could not email this answer. It is here, and it is complete.");
    expect(html).toContain("Suspicious · medium confidence</p>");
    expect(html).not.toContain("did not run");
  });

  it("says coverage was not recorded for a case with no stored outcomes, never complete", () => {
    expect(live({ coverage: null })).toContain("Coverage not recorded for this check");
  });
});

describe("delivery apart from coverage", () => {
  it("says each reply outcome that did not plainly go, and nothing for one that went or an upload", () => {
    const cases: [Parameters<typeof live>[0], string | null][] = [
      [{ delivery: "refused" }, "We could not email this answer. It is here, and it is complete."],
      [{ delivery: "failed" }, "We could not email this answer."],
      [{ delivery: "uncertain" }, "We may not have emailed this answer: the mail service did not confirm it."],
      [{ delivery: "pending" }, "This answer is still being emailed."],
      [
        { delivery: null, progress: progressOf([ev("reply", "started", 1), ev("reply", "done", 1)]) },
        "This answer was not emailed: we had no address to send it to.",
      ],
      [{ delivery: "sent" }, null],
      [{ delivery: null, channel: "upload" }, null],
    ];
    for (const [props, words] of cases) {
      const html = live(props);
      if (words) expect(html, JSON.stringify(props)).toContain(words);
      else expect(html, JSON.stringify(props)).not.toContain('role="note" class="px-16');
    }
  });

  it("never calls an answer complete when its checks were not", () => {
    const html = live({ delivery: "failed", coverage: [outcome("domain.age", "failed", "Timeout")] });
    expect(html).toContain("We could not email this answer. It is here.");
    expect(html).not.toContain("it is complete");
    expect(live({ delivery: "failed", coverage: null })).not.toContain("it is complete");
  });

  it("promises an upload no email while it runs", () => {
    const upload = live({
      status: "running",
      verdict: null,
      channel: "upload",
      progress: progressOf([ev("admit", "started", 0)]),
    });
    expect(upload).toContain("You can leave this page and come back: the answer stays on this report.");
    expect(upload).not.toContain("email");
    const mail = live({ status: "running", verdict: null, progress: progressOf([ev("admit", "started", 0)]) });
    expect(mail).toContain("we also email you the verdict");
  });

  it("keeps a failed check live while its reply is still being sent, then stops", () => {
    const failed = [ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")];
    const settling = live({
      status: "partial",
      verdict: null,
      delivery: null,
      progress: progressOf([...failed, ev("reply", "started", 2)]),
    });
    expect(settling).toContain('hx-trigger="every 2s"');
    const settled = live({
      status: "partial",
      verdict: null,
      delivery: "sent",
      progress: progressOf([...failed, ev("reply", "started", 2), ev("reply", "done", 2)]),
    });
    expect(settled).not.toContain("hx-trigger");
    expect(
      live({
        status: "partial",
        verdict: null,
        delivery: "refused",
        progress: progressOf([...failed, ev("reply", "failed", 2)]),
      }),
    ).toContain("We could not email this answer. It is here.");
  });

  it("keeps a failed check live before its reply starts, for a while, and only for an email", () => {
    const failed = [ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")];
    expect(live({ status: "partial", verdict: null, delivery: null, progress: progressOf(failed) })).toContain(
      'hx-trigger="every 2s"',
    );
    const later = live({
      status: "partial",
      verdict: null,
      delivery: null,
      progress: progressOf(failed),
      now: new Date(Date.parse(at(1)) + 11 * 60 * 1000),
    });
    expect(later).not.toContain("hx-trigger");
    expect(
      live({ status: "partial", verdict: null, delivery: null, channel: "upload", progress: progressOf(failed) }),
    ).not.toContain("hx-trigger");
  });

  it("keeps polling through a failed send while the reply step is still trying", () => {
    const failed = [ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")];
    for (const delivery of ["failed", "refused", "pending"] as const) {
      const html = live({
        status: "partial",
        verdict: null,
        delivery,
        progress: progressOf([...failed, ev("reply", "started", 2), ev("reply", "error", 2, "ReplyNotSent")]),
      });
      expect(html, delivery).toContain('hx-trigger="every 2s"');
    }
  });

  it("takes the stored send over an earlier failed reply step, as after a resend", () => {
    const html = live({
      delivery: "sent",
      progress: progressOf([ev("reply", "failed", 1, "Error"), ev("finish", "done", 5)]),
    });
    expect(html).not.toContain("We could not email this answer");
  });

  it("says a step being tried again as such", () => {
    const html = live({
      status: "running",
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("parse", "started", 1), ev("parse", "error", 1, "Error")]),
    });
    expect(html).toContain('data-announce="Step 2 of 7: Opened the message and its attachments (trying again)"');
  });
});

describe("the failed state", () => {
  it("names the failed step in words, with the reference and Upload it instead", () => {
    const html = live({
      status: "partial",
      verdict: null,
      progress: progressOf([ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")]),
    });
    expect(html).toContain("Check failed · no verdict");
    expect(html).toContain("The message could not be opened: its file is damaged or not a message.");
    expect(html).toContain("Reference 01JCASE0000000000000000000 · failed at step 2 of 7 · 10:00 SAST");
    // Read again a day later: the failure keeps its own time.
    const later = live({
      status: "partial",
      verdict: null,
      now: new Date(Date.UTC(2026, 10, 1, 15, 0)),
      progress: progressOf([ev("admit", "done", 0), ev("parse", "failed", 1, "ParseError")]),
    });
    expect(later).toContain("failed at step 2 of 7 · 10:00 SAST");
    expect(html).toMatch(/<a[^>]*href="\/upload"[^>]*>Upload it instead<\/a>/);
    expect(html).not.toContain("hx-trigger");
  });

  it("says a check that did not finish, naming no step, when no step recorded its failure", () => {
    const html = live({ status: "partial", verdict: null, progress: progressOf([ev("admit", "done", 0)]) });
    expect(html).toContain("The check did not finish.");
    expect(html).not.toContain("failed at step");
  });
});

describe("the status poll", () => {
  async function setup() {
    const orgId = `org-status-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Status Co", orgId, new Date().toISOString())
      .run();
    const email = `status-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
      .run();
    const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await db.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(id).run();
    return { orgId, cookie, id };
  }
  const event = (id: string, step: string, status: string) =>
    db
      .prepare("INSERT INTO case_events (case_id, step, status, started_at, ms) VALUES (?, ?, ?, ?, ?)")
      .bind(id, step, status, new Date().toISOString(), status === "started" ? null : 400)
      .run();
  const poll = (id: string, cookie?: string, search = "") =>
    call(`/r/${id}/status${search}`, { headers: cookie ? { cookie } : {} });

  it("answers the live region while running, the steps advancing and findings appearing, then the finished report once", async () => {
    const { cookie, id } = await setup();
    await event(id, "admit", "started");
    let html = await (await poll(id, cookie)).text();
    expect(html).toMatch(/^<div id="report-live"/);
    expect(html).toContain('hx-trigger="every 2s"');
    expect(html).toContain("Step 1 of 7");
    expect(html).toContain("Nothing found yet.");
    await event(id, "admit", "done");
    await event(id, "parse", "done");
    await event(id, "checks", "started");
    await saveEvidence(db, id, [
      {
        check: "sender.first_time",
        severity: "low",
        summary: "A first-time sender",
        detail: { history: "first", from: "x@y.example", headers: [] },
        artefacts: [],
      },
    ]);
    html = await (await poll(id, cookie)).text();
    expect(html).toContain("Step 3 of 7");
    expect(html).toContain("Found so far");
    expect(html.match(/id="e1"/g)?.length).toBe(1);
    await saveVerdict(db, id, { ...VERDICT, source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'suspicious' WHERE id = ?").bind(id).run();
    html = await (await poll(id, cookie)).text();
    expect(html).toMatch(/^<div id="report-live"/);
    expect(html).not.toContain("hx-trigger");
    expect(html).toContain("A stored headline.");
    expect(html).toContain('data-announce="Checked: Suspicious"');
  });

  // D07 T03 §18: the count line and the safe board's clean list are inside the polled region, so a report a reader
  // watched while it ran finishes with both, through the status route alone, for a member and a link holder.
  it("finishes a watched report with its count line and its clean checks, for a member and a link holder", async () => {
    const { orgId, cookie, id } = await setup();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost").search;
    await event(id, "admit", "started");
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).not.toContain("checks ran");
      expect(html).not.toContain("Checks that found nothing");
    }
    await saveEvidence(
      db,
      id,
      [
        {
          check: "sender.first_time",
          severity: "info",
          summary: "A sender who has written before",
          detail: { history: "known", from: "x@y.example", headers: [] },
          artefacts: [],
        },
      ],
      undefined,
      undefined,
      [
        { check: "sender.first_time", outcome: "ran", reason: null, findings: 1 },
        { check: "domain.lookalike", outcome: "ran", reason: null, findings: 0 },
        { check: "content.hidden_text", outcome: "ran", reason: null, findings: 0 },
      ],
    );
    await saveVerdict(db, id, { ...VERDICT, verdict: "safe", source: "rules" });
    await db.prepare("UPDATE cases SET status = 'done', verdict = 'safe' WHERE id = ?").bind(id).run();
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).toMatch(/^<div id="report-live"/);
      expect(html).toContain("1 finding · 3 checks ran · nothing skipped");
      expect(html).toContain("Checks that found nothing");
      expect(html).toContain("Lookalike domains: nothing found");
      expect(html).toContain("Hidden text: nothing found");
      expect(html).not.toContain("Whether this sender has written before: nothing found");
    }
  });

  // D07 T03 §40: a case whose admission failed before its file was stored ends partial with `admit` failed (RawMissing);
  // the report words it by how the case came and offers that channel's own next step, never a retry that cannot succeed.
  async function failedAdmission(
    opts: { channel: "email" | "upload"; sourceKind: "mail" | "document" | "image" | "audio"; uploadName?: string },
    error = "RawMissing",
  ) {
    const orgId = `org-gone-${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
      .bind(orgId, "Gone Co", orgId, new Date().toISOString())
      .run();
    const email = `gone-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
    const { cookie } = await signIn(email);
    const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
    await db
      .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
      .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
      .run();
    const made = await createCase(db, {
      orgId,
      channel: opts.channel,
      headersAvailable: false,
      sourceKind: opts.sourceKind,
      ...(opts.channel === "upload" ? { uploadedBy: user?.id as string } : {}),
      ...(opts.uploadName ? { uploadName: opts.uploadName } : {}),
    });
    if (!made.ok) throw new Error(made.error.message);
    const id = made.value.id;
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
    await event(id, "admit", "started");
    await db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, ms, error) VALUES (?, 'admit', 'failed', ?, 400, ?)",
      )
      .bind(id, new Date().toISOString(), error)
      .run();
    await event(id, "reply", "done");
    return { id, cookie, orgId };
  }

  it("words a file that never arrived by how it came, through the page and the poll", async () => {
    const hostile = '<script>alert("x")</script>.pdf';
    const cases = [
      { channel: "upload", sourceKind: "document", uploadName: "invoice-2026.pdf" },
      { channel: "upload", sourceKind: "image", uploadName: hostile },
      { channel: "upload", sourceKind: "audio", uploadName: "voicenote.mp3" },
      { channel: "upload", sourceKind: "document" },
      { channel: "email", sourceKind: "mail" },
    ] as const;
    for (const c of cases) {
      const { id, cookie } = await failedAdmission(c);
      const page = await (await call(`/r/${id}`, { headers: { cookie, accept: "text/html" } })).text();
      const polled = await (await poll(id, cookie)).text();
      for (const html of [page, polled]) {
        if (c.channel === "upload") {
          const named = "uploadName" in c ? c.uploadName : null;
          expect(html).toContain(
            named
              ? `The file &quot;${named.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")}&quot; did not arrive in full`
              : "The file did not arrive in full",
          );
          expect(html).not.toContain("<script>alert");
          expect(html).toContain(">Upload again<");
          expect(html).not.toContain("Upload it instead");
          expect(html).not.toContain("Forward it again");
        } else {
          expect(html).toContain("The message did not arrive in full, so it could not be checked.");
          expect(html).toContain("Forward it again.");
          expect(html).toContain(">Upload it instead<");
          expect(html).not.toContain(">Upload again<");
        }
        // The original is gone: no retry that could not succeed, and none of the old storage words.
        expect(html).not.toContain("/retry");
        expect(html).not.toContain("not found in storage");
      }
    }
  });

  it("keeps the retry and the other failures' words for a failure a second run can mend", async () => {
    const { id, cookie } = await failedAdmission({ channel: "email", sourceKind: "mail" }, "ParseError");
    const html = await (await poll(id, cookie)).text();
    expect(html).toContain("The message could not be opened");
    expect(html).toContain(`action="/r/${id}/retry"`);
    expect(html).toContain(">Upload it instead<");
    expect(html).not.toContain("Upload again");
  });

  // §18's completion review: a check that stops after its outcomes were stored still says how much ran.
  it("keeps the count line on a report whose check failed after its outcomes were stored, for both readers", async () => {
    const { orgId, cookie, id } = await setup();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost").search;
    await saveEvidence(db, id, [], undefined, undefined, [
      { check: "domain.lookalike", outcome: "ran", reason: null, findings: 0 },
      { check: "domain.age", outcome: "failed", reason: "Timeout", findings: 0 },
    ]);
    // A failed check is a case left partial with no verdict.
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
    for (const html of [await (await poll(id, cookie)).text(), await (await poll(id, undefined, link)).text()]) {
      expect(html).toContain("We could not finish checking this message.");
      expect(html).toContain("0 findings · 1 check ran · 1 failed");
      expect(html).toContain("Nothing was found before the check stopped.");
      expect(html).not.toContain("Checks that found nothing");
    }
  });

  it("serves a link holder, keeping the link on the next poll", async () => {
    const { orgId, id } = await setup();
    const link = new URL(await signReportLink(SECRET, id, orgId), "http://localhost");
    const html = await (await poll(id, undefined, link.search)).text();
    expect(html).toContain(`hx-get="/r/${id}/status${link.search.replaceAll("&", "&amp;")}"`);
  });

  it("sends a poll with no access to the full report, and answers an outage with 503 to poll through", async () => {
    const { id, cookie } = await setup();
    const stranger = (await signIn(`other-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`)).cookie;
    for (const res of [await poll(id, stranger), await poll(id)]) {
      expect(res.status).toBe(204);
      expect(res.headers.get("hx-redirect")).toBe(`/r/${id}`);
    }
    // A link past its expiry, or with another case's signature, sends the page to the full report too.
    const { orgId: other } = await setup();
    const expired = new URL(
      await signReportLink(SECRET, id, other, Date.now() - 8 * 24 * 3600 * 1000),
      "http://localhost",
    );
    const forged = new URL(await signReportLink(SECRET, id, other), "http://localhost");
    for (const search of [expired.search, forged.search]) {
      const res = await poll(id, undefined, search);
      expect(res.status, search).toBe(204);
      expect(res.headers.get("hx-redirect"), search).toBe(`/r/${id}${search}`);
    }
    const prepare = db.prepare.bind(db);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (/FROM case_events/.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    });
    expect((await poll(id, cookie)).status).toBe(503);
  });
});
