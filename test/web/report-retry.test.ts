import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { saveEvidence } from "../../src/checks/evidence";
import { readCaseEvents } from "../../src/db/case-progress";
import { createCase, setStatus } from "../../src/db/cases";
import { recordEvent } from "../../src/pipeline/events";
import { RETRY_SETTLE_MS, sweepRetries } from "../../src/pipeline/retry";
import { retryRoutes } from "../../src/web/pages/report-retry";
import { CONFIRMING, RETRY_WORDS } from "../../src/web/pages/retry-words";
import { signReportLink } from "../../src/web/report-link";
import { call, signIn } from "../auth/helpers";

// D07 T03 §20: a member presses "Retry the check" on a failed report. The route is called with a Workflow double in its
// env (its `create` and `get`, as test/pipeline/retry.test.ts does); the report itself is read through the Worker.
const e = env as unknown as Env;
const db = e.DB;
const ORIGIN = new URL(e.APP_URL).origin;

async function member() {
  const orgId = `org-retry-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(`INSERT INTO "organization" (id, name, slug, "createdAt") VALUES (?, ?, ?, ?)`)
    .bind(orgId, "Retry Co", orgId, new Date().toISOString())
    .run();
  const email = `retry-${crypto.randomUUID().slice(0, 8)}@demo.isitlegit.co.za`;
  const { cookie } = await signIn(email);
  const user = await db.prepare(`SELECT id FROM "user" WHERE lower(email) = ?`).bind(email).first<{ id: string }>();
  await db
    .prepare(`INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES (?, ?, ?, ?, ?)`)
    .bind(`m-${crypto.randomUUID()}`, orgId, user?.id, "member", new Date().toISOString())
    .run();
  return { orgId, cookie, userId: user?.id as string };
}

// A case whose first run failed at parse, with that run's outcomes, its reply step done and that reply's failed send.
async function failedCase(orgId: string) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  for (const status of ["running", "partial"] as const) {
    const moved = await setStatus(db, orgId, id, status);
    if (!moved.ok) throw new Error(moved.error.message);
  }
  await recordEvent(db, id, "admit", "done");
  await recordEvent(db, id, "parse", "failed", { errorClass: "ParseError" });
  // Its failure's own answer has been tried, so the report is settled rather than still live.
  await recordEvent(db, id, "reply", "done");
  await saveEvidence(db, id, [], undefined, undefined, [
    { check: "auth.spf", outcome: "failed", reason: "Error", findings: 0 },
  ]);
  await db
    .prepare(
      "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'reply', ?, 'failed', 1, ?, ?)",
    )
    .bind(crypto.randomUUID(), `reply:${id}`, id, "a".repeat(64), new Date().toISOString(), new Date().toISOString())
    .run();
  return id;
}

// A Workflow binding double: `create` as given (accepting by default); `get` answering each id's status, absent
// unless named, or an unknown answer.
function withWorkflow(parts: { create?: () => Promise<unknown>; states?: Record<string, string> }) {
  const states = parts.states ?? {};
  return {
    ...e,
    ANALYSIS: {
      create: parts.create ?? (async () => {}),
      get: async (id: string) => {
        const state = states[id];
        if (state === "unknown") throw new Error("internal error");
        if (!state) throw new Error("instance.not_found");
        return { status: async () => ({ status: state }) };
      },
    },
  } as unknown as Env;
}

const press = (id: string, headers: Record<string, string>, workflow = withWorkflow({}), origin = ORIGIN) =>
  retryRoutes.fetch(
    new Request(`${ORIGIN}/r/${id}/retry`, { method: "POST", headers: { origin, ...headers } }),
    workflow,
  );
const page = (path: string, cookie?: string) =>
  call(path, { headers: { ...(cookie ? { cookie } : {}), accept: "text/html" } }).then((r) => r.text());
const caseRow = (id: string) =>
  db
    .prepare("SELECT status, run_id AS runId FROM cases WHERE id = ?")
    .bind(id)
    .first<{ status: string; runId: string | null }>();

describe("Retry the check", () => {
  it("runs a failed case again once for a member, the report then showing the new run alone", async () => {
    const { orgId, cookie, userId } = await member();
    const id = await failedCase(orgId);
    const before = await page(`/r/${id}`, cookie);
    expect(before).toContain('action="/r/' + id + '/retry"');
    expect(before).toContain("The message could not be opened");
    const answer = await press(id, { cookie });
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe(`/r/${id}`);
    const row = await caseRow(id);
    expect(row?.status).toBe("received");
    expect(row?.runId).toMatch(new RegExp(`^${id}R`));
    const retry = await db
      .prepare("SELECT actor, run_id AS runId FROM case_events WHERE case_id = ? AND step = 'retry'")
      .bind(id)
      .first<{ actor: string; runId: string }>();
    expect(retry).toEqual({ actor: userId, runId: row?.runId });
    // The new run alone: its own steps, no earlier failure, no earlier reply, polling.
    for (const html of [await page(`/r/${id}`, cookie), await page(`/r/${id}/status`, cookie)]) {
      expect(html).toContain("We are investigating this message.");
      expect(html).toContain('hx-trigger="every 2s"');
      expect(html).not.toContain("The message could not be opened");
      expect(html).not.toContain("We could not email this answer");
    }
    await recordEvent(db, id, "admit", "started");
    expect(await page(`/r/${id}/status`, cookie)).toContain("Step 1 of");
    // A second press while it runs changes nothing and says nothing: the page shows the check running.
    const again = await press(id, { cookie });
    expect(again.headers.get("location")).toBe(`/r/${id}`);
    expect((await caseRow(id))?.runId).toBe(row?.runId);
  });

  it("shows a retried run's own failure, never the first run's", async () => {
    const { orgId, cookie } = await member();
    const id = await failedCase(orgId);
    await press(id, { cookie });
    await recordEvent(db, id, "admit", "done");
    await recordEvent(db, id, "checks", "failed", { errorClass: "Timeout" });
    await recordEvent(db, id, "reply", "done");
    const moved = await setStatus(db, orgId, id, "running");
    if (moved.ok) await setStatus(db, orgId, id, "partial");
    const html = await page(`/r/${id}`, cookie);
    expect(html).toContain("We could not finish checking this message.");
    expect(html).toContain("A step ran out of time.");
    expect(html).not.toContain("The message could not be opened");
  });

  it("refuses a foreign origin, a stranger, a signed-out reader and a link holder, changing nothing", async () => {
    const { orgId } = await member();
    const id = await failedCase(orgId);
    const stranger = (await member()).cookie;
    const link = new URL(await signReportLink(e.REPORT_LINK_SECRET, id, orgId), ORIGIN);
    const { cookie } = await member();
    expect((await press(id, { cookie }, undefined, "https://elsewhere.example")).status).toBe(403);
    expect((await press(id, { cookie: stranger })).status).toBe(404);
    expect((await press(id, {})).status).toBe(404);
    expect(
      (
        await retryRoutes.fetch(
          new Request(`${ORIGIN}/r/${id}/retry${link.search}`, { method: "POST", headers: { origin: ORIGIN } }),
          withWorkflow({}),
        )
      ).status,
    ).toBe(404);
    expect(await caseRow(id)).toEqual({ status: "partial", runId: null });
    // A link holder reads the failed report without the form or its line.
    const shown = await page(`/r/${id}${link.search}`);
    expect(shown).toContain("We could not finish checking this message.");
    expect(shown).not.toContain("/retry");
    expect(shown).not.toContain("Retry runs the check once more");
  });

  it("says a refusal on the failed report, only when its signature holds and it is recent", async () => {
    const { orgId, cookie } = await member();
    const id = await failedCase(orgId);
    // The failed run is still writing.
    const answer = await press(id, { cookie }, withWorkflow({ states: { [id]: "running" } }));
    const location = answer.headers.get("location") ?? "";
    expect(location).toMatch(new RegExp(`^/r/${id}\\?retry=not_finished&rt=\\d+&rs=`));
    expect(await page(location, cookie)).toContain(RETRY_WORDS.not_finished);
    const url = new URL(location, ORIGIN);
    const forged = new URL(url);
    forged.searchParams.set("retry", "not_started");
    expect(await page(`${forged.pathname}${forged.search}`, cookie)).not.toContain(RETRY_WORDS.not_started);
    const stale = new URL(url);
    stale.searchParams.set("rt", String(Date.now() - 11 * 60_000));
    expect(await page(`${stale.pathname}${stale.search}`, cookie)).not.toContain(RETRY_WORDS.not_finished);
    // A start that failed outright is put back and said.
    const failed = await press(id, { cookie }, withWorkflow({ create: async () => Promise.reject(new Error("down")) }));
    const back = failed.headers.get("location") ?? "";
    expect(back).toContain("retry=not_started");
    expect(await caseRow(id)).toMatchObject({ status: "partial" });
    const html = await page(back, cookie);
    expect(html).toContain(RETRY_WORDS.not_started);
    // The first run's failure is current again.
    expect(html).toContain("The message could not be opened");
  });

  // The confirming words follow the case's stored state: a retry's run id on a `received` case that has recorded no step.
  it("says a start being confirmed while it is unresolved, clears it the moment the run records a step, and rolls back", async () => {
    const { orgId, cookie } = await member();
    const id = await failedCase(orgId);
    const unknown = withWorkflow({
      create: async () => Promise.reject(new Error("lost")),
      states: new Proxy({} as Record<string, string>, { get: (_t, key) => (key === id ? "complete" : "unknown") }),
    });
    const answer = await press(id, { cookie }, unknown);
    // The answer is the plain report: the state carries the words, not an address.
    expect(answer.headers.get("location")).toBe(`/r/${id}`);
    const runId = (await caseRow(id))?.runId ?? "";
    expect(runId).not.toBe("");
    for (const html of [await page(`/r/${id}`, cookie), await page(`/r/${id}/status`, cookie)]) {
      expect(html).toContain("We are investigating this message.");
      expect(html).toContain(CONFIRMING);
      expect(html).toContain('hx-trigger="every 2s"');
    }
    // The run is found and advances: the words clear on the next poll, the polling carries on.
    await recordEvent(db, id, "admit", "started");
    const advanced = await page(`/r/${id}/status`, cookie);
    expect(advanced).not.toContain(CONFIRMING);
    expect(advanced).toContain("Step 1 of");
    expect(advanced).toContain('hx-trigger="every 2s"');
    expect(await page(`/r/${id}`, cookie)).not.toContain(CONFIRMING);
  });

  it("settles an unconfirmed start by rolling it back: the failed report again, the words gone", async () => {
    const { orgId, cookie } = await member();
    const id = await failedCase(orgId);
    const unknown = withWorkflow({
      create: async () => Promise.reject(new Error("lost")),
      states: new Proxy({} as Record<string, string>, { get: (_t, key) => (key === id ? "complete" : "unknown") }),
    });
    await press(id, { cookie }, unknown);
    expect(await page(`/r/${id}`, cookie)).toContain(CONFIRMING);
    await sweepRetries(db, withWorkflow({}), () => new Date(Date.now() + RETRY_SETTLE_MS + 60_000));
    expect(await caseRow(id)).toMatchObject({ status: "partial" });
    const settled = await page(`/r/${id}/status`, cookie);
    expect(settled).toContain("We could not finish checking this message.");
    expect(settled).not.toContain(CONFIRMING);
    expect(settled).toContain("The message could not be opened");
  });

  // Completion review: progress is pinned to the run the response captured, so a retry landing between the reads cannot
  // join run A's lifecycle to run B's steps.
  it("reads one run's steps whichever run is current, and a retried run's steps apart from the first's", async () => {
    const { orgId, cookie } = await member();
    const id = await failedCase(orgId);
    await press(id, { cookie });
    const second = (await caseRow(id))?.runId ?? "";
    await recordEvent(db, id, "admit", "started");
    await recordEvent(db, id, "parse", "done");
    const steps = async (run: string) => (await readCaseEvents(db, id, run)).map((e) => `${e.step}:${e.status}`);
    // Run A (the first, named by the case id) is still read as A's after B began; B reads B's.
    expect(await steps(id)).toEqual(["admit:done", "parse:failed", "reply:done"]);
    expect(await steps(second)).toEqual(["admit:started", "parse:done"]);
    // A third run lands: B's steps stop at C's start, A's stay A's.
    await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
    await recordEvent(db, id, "reply", "done");
    await press(id, { cookie });
    const third = (await caseRow(id))?.runId ?? "";
    await recordEvent(db, id, "admit", "started");
    expect(await steps(second)).toEqual(["admit:started", "parse:done", "reply:done"]);
    expect(await steps(third)).toEqual(["admit:started"]);
    expect(await steps(id)).toEqual(["admit:done", "parse:failed", "reply:done"]);
  });

  it("answers an outage before anything was written with the report, never a 500", async () => {
    const { orgId, cookie } = await member();
    const id = await failedCase(orgId);
    const broken = {
      ...withWorkflow({}),
      DB: {
        prepare: () => {
          throw new Error("D1_ERROR: Network connection lost.");
        },
      },
    } as unknown as Env;
    const answer = await press(id, { cookie }, broken);
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toContain("retry=database");
    expect(await page(answer.headers.get("location") ?? "", cookie)).toContain(RETRY_WORDS.database);
  });
});
