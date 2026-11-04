import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { createCase } from "../../src/db/cases";
import { readModelTrace } from "../../src/db/model-trace";
import { whatItDid } from "../../src/web/components/model-trace";
import { signReportLink } from "../../src/web/report-link";
import { call, signIn } from "../auth/helpers";
import { putStoredVerdict } from "./stored-verdict";

// D07 T03 §5: the model trace on the report, read from what the pipeline stored (model_spend, walkthrough_actions,
// mail_sends), through /r/:caseId and the status poll, for a member only and pinned to the report's run.
const e = env as unknown as Env;
const db = e.DB;
const TITLE = "How Meta's models worked on this case";

async function member() {
  const orgId = `org-trace-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(orgId, "Trace Co", orgId, new Date().toISOString())
    .run();
  const email = `trace-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
    .run();
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return { orgId, cookie, id: made.value.id };
}
const page = (path: string, cookie?: string) =>
  call(path, { headers: { ...(cookie ? { cookie } : {}), accept: "text/html" } })
    .then((r) => r.text())
    .then((html) => html.replaceAll("&#39;", "'"));

type Spend = {
  step?: string | null;
  model?: string;
  at?: string;
  ms?: number | null;
  outcome?: "ok" | "error" | "refused" | null;
  errorClass?: string | null;
  cache?: "hit" | null;
  actual?: number | null;
  estimate?: number;
  certainty?: "measured" | "estimated" | null;
};
async function spend(caseId: string, s: Spend = {}) {
  const at = s.at ?? new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO model_spend (id, at, day, source, caller, model, case_id, attempt, estimate_usd, actual_usd, state, settled_at, owner, step, ms, outcome, error_class, cost_certainty, cache)
       VALUES (?, ?, ?, 'worker', 'trace-test', ?, ?, 1, ?, ?, ?, ?, 'case', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      at,
      at.slice(0, 10),
      s.model ?? "Muse Spark 1.3",
      caseId,
      s.estimate ?? 0.004,
      s.actual === undefined ? 0.004 : s.actual,
      s.actual === null ? "reserved" : "settled",
      s.actual === null ? null : at,
      s.step === undefined ? "verdict" : s.step,
      s.ms === undefined ? 2600 : s.ms,
      s.outcome === undefined ? "ok" : s.outcome,
      s.errorClass ?? null,
      s.certainty === undefined ? (s.actual === null ? null : "measured") : s.certainty,
      s.cache ?? null,
    )
    .run();
}
const finish = async (id: string) => {
  await putStoredVerdict(db, id, {
    verdict: "suspicious",
    headline: "A headline.",
    confidence: 0.6,
    reasons: ["A reason."],
    actions: ["An action."],
    source: "rules",
  });
  await db.prepare("UPDATE cases SET status = 'done', verdict = 'suspicious' WHERE id = ?").bind(id).run();
};
// A send as the pipeline stores it: a case's reply is keyed by its run (`reply:<run id>`, the case id for the first run),
// every other kind apart.
const sendRow = (
  caseId: string,
  status: string,
  hash: string,
  at = new Date().toISOString(),
  error: string | null = null,
  kind = "reply",
  run = caseId,
) =>
  db
    .prepare(
      "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      kind === "reply" ? `reply:${run}` : `${kind}:${crypto.randomUUID()}`,
      caseId,
      kind,
      hash,
      status,
      error,
      at,
      at,
    )
    .run();

describe("the model trace", () => {
  it("lists a run's calls in order with its totals, marking a cached, a failed, a refused and an estimated call", async () => {
    const { cookie, id } = await member();
    const t = (n: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString();
    await spend(id, { at: t(1), step: "walkthrough", model: "Muse Wonder 2.0", ms: 31000, actual: 0.006 });
    await spend(id, { at: t(2), step: "verdict", ms: 2600, actual: 0.004 });
    await spend(id, { at: t(3), step: "verdict", ms: 800, cache: "hit", actual: 0 });
    await spend(id, { at: t(4), step: "verdict", ms: 500, outcome: "error", errorClass: "Timeout", actual: 0.001 });
    await spend(id, { at: t(5), step: "walkthrough", outcome: "refused", errorClass: "budget:day", actual: 0, ms: 0 });
    await spend(id, { at: t(6), step: "verdict", ms: 1200, actual: null, estimate: 0.003, outcome: "ok" });
    await finish(id);
    const trace = await readModelTrace(db, id, id);
    expect(trace.calls.map((c) => [c.step, c.model, c.ms, c.outcome, c.cached, c.certainty])).toEqual([
      ["walkthrough", "Muse Wonder 2.0", 31000, "ok", false, "measured"],
      ["verdict", "Muse Spark 1.3", 2600, "ok", false, "measured"],
      ["verdict", "Muse Spark 1.3", 800, "ok", true, "measured"],
      ["verdict", "Muse Spark 1.3", 500, "error", false, "measured"],
      ["walkthrough", "Muse Spark 1.3", 0, "refused", false, "measured"],
      ["verdict", "Muse Spark 1.3", 1200, "ok", false, "estimated"],
    ]);
    expect(trace.total.measuredUsd).toBeCloseTo(0.011, 6);
    expect(trace.total.estimatedUsd).toBeCloseTo(0.003, 6);
    expect(trace.total.estimatedCalls).toBe(1);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).toContain(TITLE);
    expect(html).toContain("Total 36.1 s · US$0.011 · US$0.003 estimated for 1 call");
    expect(html).toContain("cached");
    expect(html).toContain("Did not finish: the model did not answer in time");
    expect(html).toContain("Refused: today's model limit was reached");
    expect(html).not.toContain("budget:day");
    expect(html).toContain("US$0.003 (estimated)");
    // In the order they were made.
    expect(html.indexOf("Muse Wonder 2.0")).toBeLessThan(html.indexOf("Did not finish"));
  });

  it("derives what the verdict did from the stored verdict, and says when a result is not stored", async () => {
    const { cookie, id } = await member();
    await saveEvidence(db, id, [
      { check: "sender.first_time", severity: "low", summary: "A", detail: {}, artefacts: [] },
      { check: "domain.age", severity: "medium", summary: "B", detail: {}, artefacts: [] },
      { check: "not_checked", severity: "info", summary: "C", detail: {}, artefacts: [] },
    ]);
    await spend(id, { step: "verdict" });
    await finish(id);
    expect(await page(`/r/${id}?trace=1`, cookie)).toContain("Rule-based verdict used");
    // Another rules verdict also cannot confer model authorship.
    const other = await member();
    await saveEvidence(db, other.id, [
      { check: "sender.first_time", severity: "low", summary: "A", detail: {}, artefacts: [] },
    ]);
    await spend(other.id, { step: "verdict" });
    await finish(other.id);
    const html = await page(`/r/${other.id}?trace=1`, other.cookie);
    expect(html).toContain("Rule-based verdict used");
    expect(html).not.toContain("wrote the verdict");
    // No walk stored: the walkthrough step says so, and claims nothing.
    const none = await member();
    await spend(none.id, { step: "walkthrough" });
    await finish(none.id);
    expect(await page(`/r/${none.id}?trace=1`, none.cookie)).toContain("Result not stored");
  });

  // A stored verdict keeps its reasons as text, so the evidence they cite is not stored yet and the panel says only how many
  // findings were weighed; the wording that names the cited ids is the pure function's, for when a verdict stores them.
  it("names the cited evidence when a verdict stores it, and nothing it does not", () => {
    const call = { step: "verdict", outcome: "ok" } as Parameters<typeof whatItDid>[0];
    expect(whatItDid(call, { findings: 3, cited: ["E1", "E2", "E3"], verdictSource: "agent" }, 0)).toBe(
      "Weighed 3 findings, cited E1, E2, E3",
    );
    expect(whatItDid(call, { findings: 3, cited: [], verdictSource: "agent" }, 0)).toBe("Weighed 3 findings");
    expect(whatItDid(call, { findings: 0, cited: null, verdictSource: "agent" }, 0)).toBe("Result not stored");
  });

  it("lists the agent's actions in order, a refused one said refused, with no typed text", async () => {
    const { cookie, id } = await member();
    const now = new Date().toISOString();
    const walk = "walk-1";
    const action = (seq: number, kind: string, json: unknown, outcome: string) =>
      db
        .prepare(
          "INSERT INTO walkthrough_actions (case_id, walk_id, seq, kind, action_json, outcome, ms, at) VALUES (?, ?, ?, ?, ?, ?, 100, ?)",
        )
        .bind(id, walk, seq, kind, JSON.stringify(json), outcome, now)
        .run();
    await action(1, "action", { tool: "click", x: 10, y: 20 }, "done");
    await action(2, "action", { tool: "type", text: "SECRET-TYPED" }, "refused");
    // The call precedes the actions it chose.
    await spend(id, { at: new Date(Date.now() - 5000).toISOString(), step: "walkthrough" });
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).toContain("Chose 2 actions");
    expect(html.indexOf("Clicked: done")).toBeLessThan(
      html.indexOf("Typed into a field (the text is never kept): refused"),
    );
    expect(html).not.toContain("SECRET-TYPED");
  });

  // Completion review: the work a call led to is attributed to that call, never repeated as a run-wide total.
  it("attributes each walkthrough call only the actions that followed it, across several calls and two walks", async () => {
    const { cookie, id } = await member();
    const t = (n: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString();
    const act = (
      walk: string,
      seq: number,
      at: string,
      json: unknown,
      outcome = "done",
      reason: string | null = null,
    ) =>
      db
        .prepare(
          "INSERT INTO walkthrough_actions (case_id, walk_id, seq, kind, action_json, outcome, reason, ms, at) VALUES (?, ?, ?, 'action', ?, ?, ?, 1, ?)",
        )
        .bind(id, walk, seq, JSON.stringify(json), outcome, reason, at)
        .run();
    // Walk one: a call chooses two actions, a second chooses one, a third only concludes. Walk two: one call, one action.
    await spend(id, { at: t(1), step: "walkthrough" });
    await act("w1", 1, t(2), { tool: "click", x: 1, y: 1 });
    await act("w1", 2, t(3), { tool: "scroll", direction: "down", amount: 1 });
    await spend(id, { at: t(4), step: "walkthrough" });
    await act("w1", 3, t(5), { tool: "wait", ms: 100 });
    await spend(id, { at: t(6), step: "walkthrough" });
    await spend(id, { at: t(20), step: "walkthrough" });
    await act("w2", 1, t(21), { tool: "screenshot" });
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    const described = [...html.matchAll(/(Chose \d+ actions?|Concluded the walk)/g)].map((m) => m[1]);
    expect(described).toEqual(["Chose 2 actions", "Chose 1 action", "Concluded the walk", "Chose 1 action"]);
    expect(html).not.toContain("Chose 4 actions");
    expect(html).not.toContain("Walked the link: 4");
  });

  it("explains a refused, limited or failed action by the reason the walk stored, never its raw text", async () => {
    const { cookie, id } = await member();
    const now = new Date().toISOString();
    const act = (seq: number, outcome: string, reason: string) =>
      db
        .prepare(
          'INSERT INTO walkthrough_actions (case_id, walk_id, seq, kind, action_json, outcome, reason, ms, at) VALUES (?, \'w\', ?, \'action\', \'{"tool":"click","x":1,"y":1}\', ?, ?, 1, ?)',
        )
        .bind(id, seq, outcome, reason, now)
        .run();
    await act(1, "limit", "steps");
    await act(2, "limit", "time");
    await act(3, "refused", "<script>alert(1)</script> internal containment detail");
    await act(4, "error", "ECONNRESET at 10.0.0.1");
    await spend(id, { step: "walkthrough" });
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).toContain("(the step limit was reached)");
    expect(html).toContain("(the time limit was reached)");
    expect(html).toContain("(stopped by the walkthrough&#39;s safety rules)".replace("&#39;", "'"));
    expect(html).toContain("(the walk met an error)");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("internal containment detail");
    expect(html).not.toContain("ECONNRESET");
  });

  // Completion review: a send that settles after the report stops polling is refreshed in its own section, which swaps
  // only itself and stops once every send has settled.
  it("refreshes an unsettled send in the mail section alone, until it settles, for a member only", async () => {
    const { orgId, cookie, id } = await member();
    await sendRow(id, "uncertain", "f".repeat(64));
    await finish(id);
    const open = await page(`/r/${id}?trace=1`, cookie);
    expect(open).toContain(`hx-get="/r/${id}/trace-mail?run=${id}"`);
    expect(open).toContain('hx-trigger="every 15s"');
    expect(open).toContain("Reply: may have been sent");
    // The refresh answers the section alone, and says the send settled once it has, without the polling attributes.
    const again = await page(`/r/${id}/trace-mail?run=${id}`, cookie);
    expect(again).toMatch(/^<section id="trace-mail"/);
    expect(again).toContain("hx-trigger");
    await db.prepare("UPDATE mail_sends SET status = 'sent' WHERE case_id = ?").bind(id).run();
    const settled = await page(`/r/${id}/trace-mail?run=${id}`, cookie);
    expect(settled).toContain("Reply: sent");
    expect(settled).not.toContain("hx-trigger");
    expect(await page(`/r/${id}?trace=1`, cookie)).not.toContain(`hx-get="/r/${id}/trace-mail?run=${id}"`);
    // Nothing for a link holder, a stranger, a signed-out reader or a running report.
    const link = new URL(await signReportLink(e.REPORT_LINK_SECRET, id, orgId), "http://localhost").search;
    for (const res of [
      await call(`/r/${id}/trace-mail${link}`),
      await call(`/r/${id}/trace-mail?run=${id}`),
      await call(`/r/${id}/trace-mail?run=${id}`, {
        headers: { cookie: (await signIn(`other-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`)).cookie },
      }),
    ]) {
      expect(await res.text()).not.toContain("Reply:");
    }
    await db.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(id).run();
    expect(await page(`/r/${id}/trace-mail?run=${id}`, cookie)).not.toContain("Reply:");
  });

  // Review round 1: the refresh answers only for the run it was drawn for, so a retry in another tab never puts the new
  // run's mail beside the old run's calls.
  it("refuses a mail refresh drawn for another run, and asks for the run it is on", async () => {
    const { cookie, id } = await member();
    await sendRow(id, "uncertain", "1".repeat(64), "2026-10-31T10:00:00.000Z");
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).toContain(`/r/${id}/trace-mail?run=${id}`);
    // A retry elsewhere: the case is on a new run, whose mail this tab's refresh must not draw.
    const second = `${id}RSECOND`;
    await db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, actor, run_id) VALUES (?, 'retry', 'started', ?, 'member', ?)",
      )
      .bind(id, "2026-10-31T11:00:00.000Z", second)
      .run();
    await db.prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(second, id).run();
    await sendRow(id, "sent", "2".repeat(64), "2026-10-31T11:05:00.000Z", null, "reply", second);
    const stale = await page(`/r/${id}/trace-mail?run=${id}`, cookie);
    expect(stale).not.toContain("Reply:");
    expect(await page(`/r/${id}/trace-mail`, cookie)).not.toContain("Reply:");
    expect(await page(`/r/${id}/trace-mail?run=${second}`, cookie)).toContain("Reply: sent");
  });

  // Review round 1: a failed report whose reply has not started has no send row yet, which is not "no mail expected": it
  // keeps asking, says so, and stops when the reply step ends or the case has gone quiet.
  it("keeps asking for a reply that has not started, then stops once the reply step ends or the case goes quiet", async () => {
    const { cookie, id } = await member();
    const recent = new Date().toISOString();
    const step = (name: string, status: string, at: string) =>
      db
        .prepare("INSERT INTO case_events (case_id, step, status, started_at, ms) VALUES (?, ?, ?, ?, 100)")
        .bind(id, name, status, at)
        .run();
    await step("admit", "done", recent);
    await step("reply", "started", recent);
    await finish(id);
    // A finished case has done its reply, whatever its events say; only a failed one can still be awaiting it.
    expect(await page(`/r/${id}?trace=1`, cookie)).toContain("No mail was sent for this case.");
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
    const waiting = await page(`/r/${id}?trace=1`, cookie);
    expect(waiting).toContain("The reply has not been sent yet.");
    expect(waiting).toContain(`hx-get="/r/${id}/trace-mail?run=${id}"`);
    // Its send appears and the reply step ends: settled, no more asking.
    await sendRow(id, "sent", "3".repeat(64));
    await step("reply", "done", new Date().toISOString());
    const done = await page(`/r/${id}/trace-mail?run=${id}`, cookie);
    expect(done).toContain("Reply: sent");
    expect(done).not.toContain("hx-trigger");
    // A case that has gone quiet (nothing in ten minutes) is not awaited for ever.
    const quiet = await member();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await db
      .prepare("INSERT INTO case_events (case_id, step, status, started_at, ms) VALUES (?, 'reply', 'started', ?, 100)")
      .bind(quiet.id, old)
      .run();
    await finish(quiet.id);
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(quiet.id).run();
    const stopped = await page(`/r/${quiet.id}?trace=1`, quiet.cookie);
    expect(stopped).toContain("No mail was sent for this case.");
    expect(stopped).not.toContain("hx-trigger");
  });

  it("says plainly when no model was used, and shows an unsettled call's time and outcome as not recorded", async () => {
    const empty = await member();
    await finish(empty.id);
    expect(await page(`/r/${empty.id}?trace=1`, empty.cookie)).toContain("No model was used for this case.");
    const { cookie, id } = await member();
    await spend(id, { step: "verdict", ms: null, outcome: null, actual: null, estimate: 0.002 });
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).toContain("not recorded");
    expect(html).toContain("Outcome not recorded");
    expect(html).not.toContain("0.0 s");
    expect(html).toContain("Total time not recorded");
  });

  it("is collapsed for a member, open with ?trace=1, and never shown to a link holder or while the report runs", async () => {
    const { orgId, cookie, id } = await member();
    await db.prepare("UPDATE cases SET status = 'running' WHERE id = ?").bind(id).run();
    await spend(id, { step: "verdict" });
    expect(await page(`/r/${id}/status`, cookie)).not.toContain(TITLE);
    await finish(id);
    // The poll that finishes it carries the trace, closed, or open when the page asked for it.
    const closed = await page(`/r/${id}/status`, cookie);
    expect(closed).toContain(TITLE);
    expect(closed).toMatch(/<details id="model-trace"(?! open)/);
    expect(await page(`/r/${id}/status?trace=1`, cookie)).toMatch(/<details id="model-trace" open=""/);
    expect(await page(`/r/${id}`, cookie)).toMatch(/<details id="model-trace"(?! open)/);
    expect(await page(`/r/${id}?trace=1`, cookie)).toMatch(/<details id="model-trace" open=""/);
    const link = new URL(await signReportLink(e.REPORT_LINK_SECRET, id, orgId), "http://localhost").search;
    expect(await page(`/r/${id}${link}`)).not.toContain(TITLE);
    expect(await page(`/r/${id}/status${link}`)).not.toContain(TITLE);
  });

  it("lists the case's mail with no address, and says when there is none", async () => {
    const { cookie, id } = await member();
    const hashes = ["a", "b", "c"].map((c) => c.repeat(64));
    await sendRow(id, "sent", hashes[0] as string, "2026-10-31T10:00:00.000Z");
    await sendRow(id, "uncertain", hashes[1] as string, "2026-10-31T10:01:00.000Z", null, "alert");
    await sendRow(id, "failed", hashes[2] as string, "2026-10-31T10:02:00.000Z", "SmtpRefused", "notice");
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).toContain("Reply: sent · 2 attempts");
    expect(html).toContain("Alert: may have been sent");
    expect(html).toContain("Notice: failed · 2 attempts · SmtpRefused");
    for (const hash of hashes) expect(html).not.toContain(hash);
    const none = await member();
    await finish(none.id);
    expect(await page(`/r/${none.id}?trace=1`, none.cookie)).toContain("No mail was sent for this case.");
  });

  it("reads a retried report's current run alone, each run's own calls, walks and mail", async () => {
    const { cookie, id } = await member();
    const t = (n: number) => new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString();
    // The first run's calls, a walk and a send; then a retry; then the second run's.
    await spend(id, { at: t(1), step: "verdict", model: "First Run Model" });
    await db
      .prepare(
        "INSERT INTO walkthrough_actions (case_id, walk_id, seq, kind, action_json, outcome, ms, at) VALUES (?, 'walk-a', 1, 'action', '{\"tool\":\"click\",\"x\":1,\"y\":1}', 'done', 1, ?)",
      )
      .bind(id, t(2))
      .run();
    await sendRow(id, "failed", "d".repeat(64), t(3), "FirstRunSend");
    await db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, actor, run_id) VALUES (?, 'retry', 'started', ?, 'member', ?)",
      )
      .bind(id, t(10), `${id}RSECOND`)
      .run();
    await db.prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(`${id}RSECOND`, id).run();
    await spend(id, { at: t(11), step: "verdict", model: "Second Run Model" });
    await db
      .prepare(
        'INSERT INTO walkthrough_actions (case_id, walk_id, seq, kind, action_json, outcome, ms, at) VALUES (?, \'walk-b\', 1, \'action\', \'{"tool":"scroll","direction":"down","amount":1}\', \'done\', 1, ?)',
      )
      .bind(id, t(12))
      .run();
    await sendRow(id, "sent", "e".repeat(64), t(13), null, "reply", `${id}RSECOND`);
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).toContain("Second Run Model");
    expect(html).not.toContain("First Run Model");
    expect(html).toContain("Scrolled: done");
    expect(html).not.toContain("Clicked: done");
    expect(html).not.toContain("FirstRunSend");
    expect(html).toContain("Reply: sent");
    // The earlier run's own trace is still readable by its run id, apart.
    const first = await readModelTrace(db, id, id);
    expect(first.calls.map((c) => c.model)).toEqual(["First Run Model"]);
    expect(first.actions.map((a) => a.tool)).toEqual(["click"]);
    expect(first.sends.map((m) => m.error)).toEqual(["FirstRunSend"]);
  });

  it("draws a hostile model or step name as text", async () => {
    const { cookie, id } = await member();
    await spend(id, { step: "<img src=x onerror=alert(1)>", model: '<script>alert("x")</script>' });
    await finish(id);
    const html = await page(`/r/${id}?trace=1`, cookie);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });
});
