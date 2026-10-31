import { env, introspectWorkflowInstance } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { readCheckOutcomes, readEvidence, saveEvidence } from "../../src/checks/evidence";
import { CURRENT_RUN, completeStored, createCase, setStatus, setVerdict } from "../../src/db/cases";
import { putRaw, type Store } from "../../src/intake/store";
import { resendRequested } from "../../src/mail/resend";
import { SMTP2GO_URL } from "../../src/mail/smtp2go";
import { reply } from "../../src/pipeline/analysis-workflow";
import { recordEvent } from "../../src/pipeline/events";
import { retryCase, sweepRetries } from "../../src/pipeline/retry";
import { forwards } from "../fixtures/forward/load";

// D01 T01 §17: a failed check run again under a new Workflow instance, at a member's request.
const db = env.DB;
const store: Store = { bucket: env.ARTEFACTS, db };
const ORG = "org-retry";
const MEMBER = "member-retry";

// A case whose first run failed at parse, with evidence and outcomes from it.
async function failedCase(orgId = ORG) {
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: false });
  if (!made.ok) throw new Error(made.error.message);
  const id = made.value.id;
  await putRaw(store, id, forwards["attached-eml-file"]);
  for (const status of ["running", "partial"] as const) {
    const moved = await setStatus(db, orgId, id, status);
    if (!moved.ok) throw new Error(moved.error.message);
  }
  await recordEvent(db, id, "parse", "failed", { errorClass: "ParseError" });
  await saveEvidence(
    db,
    id,
    [{ check: "not_checked", severity: "info", summary: "old run", detail: {}, artefacts: [] }],
    undefined,
    undefined,
    [{ check: "auth.spf", outcome: "failed", reason: "Error", findings: 0 }],
  );
  return id;
}
const row = (id: string) =>
  db
    .prepare("SELECT status, verdict, run_id FROM cases WHERE id = ?")
    .bind(id)
    .first<{ status: string; verdict: string | null; run_id: string | null }>();
const events = async (id: string) =>
  (
    await db
      .prepare("SELECT step, status, actor, error FROM case_events WHERE case_id = ? ORDER BY id")
      .bind(id)
      .all<{ step: string; status: string; actor: string | null; error: string | null }>()
  ).results;
const currentFailures = async (id: string) =>
  (
    await db
      .prepare(
        `SELECT step FROM case_events WHERE case_id = ? AND status = 'failed' AND step != 'retry' AND ${CURRENT_RUN} ORDER BY id`,
      )
      .bind(id, id)
      .all<{ step: string }>()
  ).results.map((r) => r.step);

// A Workflow binding double: `create` as given (accepting by default), `get` answering each id's status, absent unless
// named, or failing as an unknown answer.
function fakeEnv(parts: {
  create?: (options: { id: string }) => Promise<unknown>;
  states?: Record<string, string | "unknown">;
}) {
  const states = parts.states ?? {};
  return {
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

describe("retryCase", () => {
  it("runs a failed case again under a new instance, recording the member and clearing the failed run's results", async () => {
    const id = await failedCase();
    const runId = `${id}R1`;
    const instance = await introspectWorkflowInstance(env.ANALYSIS, runId);
    try {
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
        await m.disableSleeps();
      });
      const result = await retryCase(db, env, ORG, id, MEMBER, undefined, () => runId);
      expect(result).toEqual({ ok: true, runId });
      expect((await row(id))?.run_id).toBe(runId);
      expect((await events(id)).find((e) => e.step === "retry")).toMatchObject({ status: "started", actor: MEMBER });
      // The failed run's failure is not the current run's.
      expect(await currentFailures(id)).toEqual([]);
      await instance.waitForStatus("complete");
    } finally {
      await instance.dispose();
    }
    expect(await row(id)).toMatchObject({ status: "done", verdict: "suspicious", run_id: runId });
    expect((await readEvidence(db, id)).some((e) => e.summary === "old run")).toBe(false);
    expect((await readCheckOutcomes(db, id))?.some((o) => o.check === "auth.spf" && o.reason === "Error")).toBe(false);
  });

  it("refuses a case with a verdict, one not failed, one in another organisation, and the second of two at once", async () => {
    const judged = await failedCase();
    await db.prepare("UPDATE cases SET verdict = 'safe' WHERE id = ?").bind(judged).run();
    expect(await retryCase(db, env, ORG, judged, MEMBER)).toMatchObject({ ok: false, error: { code: "has_verdict" } });
    const made = await createCase(db, { orgId: ORG, channel: "email", headersAvailable: false });
    if (!made.ok) throw new Error(made.error.message);
    await setStatus(db, ORG, made.value.id, "running");
    expect(await retryCase(db, env, ORG, made.value.id, MEMBER)).toMatchObject({
      ok: false,
      error: { code: "not_failed" },
    });
    const elsewhere = await failedCase("org-other");
    expect(await retryCase(db, env, ORG, elsewhere, MEMBER)).toMatchObject({ ok: false, error: { code: "not_found" } });
    // Two at once: one starts a run, the other changes nothing.
    const id = await failedCase();
    const started: string[] = [];
    const counting = fakeEnv({ create: async ({ id: runId }: { id: string }) => void started.push(runId) });
    const [a, b] = await Promise.all([
      retryCase(db, counting, ORG, id, MEMBER, undefined, () => `${id}Ra`),
      retryCase(db, counting, ORG, id, MEMBER, undefined, () => `${id}Rb`),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(started).toHaveLength(1);
    expect((await events(id)).filter((e) => e.step === "retry")).toHaveLength(1);
    expect((await row(id))?.run_id).toBe(started[0]);
  });

  it("puts the case back when the Workflow cannot start, the earlier failure its cause again", async () => {
    const id = await failedCase();
    const failing = fakeEnv({ create: async () => Promise.reject(new Error("unavailable")) });
    expect(await retryCase(db, failing, ORG, id, MEMBER)).toMatchObject({ ok: false, error: { code: "not_started" } });
    expect((await row(id))?.status).toBe("partial");
    expect((await events(id)).filter((e) => e.step === "retry").map((e) => [e.status, e.actor])).toEqual([
      ["started", MEMBER],
      ["failed", MEMBER],
    ]);
    expect(await currentFailures(id)).toEqual(["parse"]);
    // And it can be retried again.
    const again = fakeEnv({});
    expect((await retryCase(db, again, ORG, id, MEMBER)).ok).toBe(true);
  });

  it("lets a retried run record its own failure and finish after a verdict, whatever the failed run left", async () => {
    const id = await failedCase();
    const quiet = fakeEnv({});
    expect((await retryCase(db, quiet, ORG, id, MEMBER)).ok).toBe(true);
    // The failed run's results are gone before the new run writes any.
    expect(await readEvidence(db, id)).toEqual([]);
    expect(await readCheckOutcomes(db, id)).toBeNull();
    // The new run fails at parse too: recorded once in its own run, though the old run has the same failure.
    await recordEvent(db, id, "parse", "failed", { errorClass: "ParseError", once: true });
    expect(await currentFailures(id)).toEqual(["parse"]);
    // A later run that reaches a verdict and fails only at its reply finishes, the old failures not holding it back.
    expect((await retryCase(db, quiet, ORG, id, MEMBER)).ok).toBe(false);
    await db
      .prepare(
        "DELETE FROM case_events WHERE case_id = ? AND step = 'parse' AND id > (SELECT MAX(id) FROM case_events WHERE case_id = ? AND step = 'retry')",
      )
      .bind(id, id)
      .run();
    await setStatus(db, ORG, id, "running");
    await setVerdict(db, ORG, id, "safe");
    await setStatus(db, ORG, id, "partial");
    await recordEvent(db, id, "reply", "failed", { errorClass: "SendFailed" });
    expect((await completeStored(db, ORG, id)).ok).toBe(true);
  });

  it("waits for the failed run to finish, and settles a start whose answer was lost or not known (plan review)", async () => {
    const going = await failedCase();
    expect(await retryCase(db, fakeEnv({ states: { [going]: "running" } }), ORG, going, MEMBER)).toMatchObject({
      ok: false,
      error: { code: "not_finished" },
    });
    // The create failed but the instance exists: the retry stands.
    const lost = await failedCase();
    const lostEnv = fakeEnv({
      create: async () => Promise.reject(new Error("timeout")),
      states: { [`${lost}R1`]: "queued" },
    });
    expect(await retryCase(db, lostEnv, ORG, lost, MEMBER, undefined, () => `${lost}R1`)).toEqual({
      ok: true,
      runId: `${lost}R1`,
    });
    expect((await row(lost))?.status).toBe("received");
    // Not known: left received, then the sweep settles it once the run is known absent.
    const unsure = await failedCase();
    const unsureEnv = fakeEnv({
      create: async () => Promise.reject(new Error("timeout")),
      states: { [`${unsure}R1`]: "unknown" },
    });
    expect(await retryCase(db, unsureEnv, ORG, unsure, MEMBER, undefined, () => `${unsure}R1`)).toMatchObject({
      ok: false,
      error: { code: "start_unknown" },
    });
    expect((await row(unsure))?.status).toBe("received");
    const later = () => new Date(Date.now() + 10 * 60 * 1000);
    await sweepRetries(db, fakeEnv({ states: { [`${lost}R1`]: "running" } }), later);
    expect((await row(unsure))?.status).toBe("partial");
    expect((await row(lost))?.status).toBe("received");
    expect(await currentFailures(unsure)).toEqual(["parse"]);
  });

  it("settles a retry interrupted between its batch and its start", async () => {
    const id = await failedCase();
    // The batch committed, the start never ran: as a crash after the batch would leave it.
    await db
      .prepare("UPDATE cases SET status = 'received', run_id = ?, updated_at = ? WHERE id = ?")
      .bind(`${id}R9`, new Date(Date.now() - 6 * 60 * 1000).toISOString(), id)
      .run();
    await db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, actor, run_id) VALUES (?, 'retry', 'started', ?, ?, ?)",
      )
      .bind(id, new Date().toISOString(), MEMBER, `${id}R9`)
      .run();
    expect((await sweepRetries(db, fakeEnv({}))).settled).toBeGreaterThanOrEqual(1);
    expect((await row(id))?.status).toBe("partial");
    expect((await retryCase(db, fakeEnv({}), ORG, id, MEMBER)).ok).toBe(true);
  });

  it("keeps a started retry's failure current when a later retry fails to start", async () => {
    const id = await failedCase();
    expect((await retryCase(db, fakeEnv({}), ORG, id, MEMBER, undefined, () => `${id}RA`)).ok).toBe(true);
    await setStatus(db, ORG, id, "running");
    await recordEvent(db, id, "checks", "failed", { errorClass: "Timeout" });
    await setStatus(db, ORG, id, "partial");
    const failing = fakeEnv({ create: async () => Promise.reject(new Error("unavailable")) });
    expect(await retryCase(db, failing, ORG, id, MEMBER, undefined, () => `${id}RB`)).toMatchObject({
      ok: false,
      error: { code: "not_started" },
    });
    expect(await currentFailures(id)).toEqual(["checks"]);
  });

  it("sends each run its own reply, once, so a retry's verdict is not taken for the first run's notice", async () => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      sent.push(String(init?.body ?? ""));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
    });
    try {
      const made = await createCase(db, {
        orgId: ORG,
        channel: "email",
        headersAvailable: false,
        forwardedBy: "member@demo.isitlegit.co.za",
        messageId: "<retry-77@fictional-recipient.example>",
      });
      if (!made.ok) throw new Error(made.error.message);
      const id = made.value.id;
      await putRaw(store, id, forwards["attached-eml-file"]);
      const partial = { status: "partial", failedStep: "parse", errorClass: "ParseError" } as const;
      await reply(env, id, partial);
      await db.prepare("UPDATE cases SET run_id = ? WHERE id = ?").bind(`${id}R1`, id).run();
      await reply(env, id, partial);
      await reply(env, id, partial);
      const keys = (
        await db
          .prepare("SELECT send_key FROM mail_sends WHERE case_id = ? ORDER BY send_key")
          .bind(id)
          .all<{ send_key: string }>()
      ).results.map((r) => r.send_key);
      expect(keys).toEqual([`reply:${id}`, `reply:${id}R1`].sort());
      expect(sent).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("fences a retry to the run whose finish it checked, so a delayed request cannot start a second run (completion review)", async () => {
    const id = await failedCase();
    const started: string[] = [];
    const create = async ({ id: runId }: { id: string }) => void started.push(runId);
    // While A waits on the first run's status, B retries and its run fails back to partial.
    const slow = {
      ANALYSIS: {
        create,
        get: async (instance: string) => ({
          status: async () => {
            if (instance === id) {
              expect((await retryCase(db, fakeEnv({ create }), ORG, id, MEMBER, undefined, () => `${id}RB`)).ok).toBe(
                true,
              );
              await db.prepare("UPDATE cases SET status = 'partial' WHERE id = ?").bind(id).run();
            }
            return { status: "complete" };
          },
        }),
      },
    } as unknown as Env;
    expect(await retryCase(db, slow, ORG, id, MEMBER, undefined, () => `${id}RA`)).toMatchObject({
      ok: false,
      error: { code: "not_failed" },
    });
    expect(started).toEqual([`${id}RB`]);
    expect((await row(id))?.run_id).toBe(`${id}RB`);
  });

  it("settles a retry whose run ended without moving its case, and reaches every case across sweeps", async () => {
    const ended = await failedCase();
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await db
      .prepare("UPDATE cases SET status = 'received', run_id = ?, updated_at = ? WHERE id = ?")
      .bind(`${ended}RE`, old, ended)
      .run();
    const later = () => new Date(Date.now() + 60 * 60 * 1000);
    await sweepRetries(db, fakeEnv({ states: { [`${ended}RE`]: "errored" } }), later);
    expect((await row(ended))?.status).toBe("partial");
    expect((await events(ended)).find((e) => e.step === "retry" && e.status === "failed")?.error).toBe("WorkflowEnded");
    // Fifty-one unresolved retries: the second sweep reaches the one the first could not.
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) {
      const made = await createCase(db, { orgId: "org-sweep", channel: "email", headersAvailable: false });
      if (!made.ok) throw new Error(made.error.message);
      ids.push(made.value.id);
      await db
        .prepare("UPDATE cases SET status = 'received', run_id = ?, updated_at = ? WHERE id = ?")
        .bind(`${made.value.id}RX`, new Date(Date.now() - (7 * 60 + 51 - i) * 1000).toISOString(), made.value.id)
        .run();
    }
    const asked = new Set<string>();
    const unknownAll = {
      ANALYSIS: {
        get: async (instance: string) => {
          asked.add(instance);
          throw new Error("internal error");
        },
      },
    } as unknown as Env;
    await sweepRetries(db, unknownAll, later);
    await sweepRetries(db, unknownAll, () => new Date(Date.now() + 2 * 60 * 60 * 1000));
    for (const caseId of ids) expect(asked.has(`${caseId}RX`), caseId).toBe(true);
  });

  it("leaves a retry whose rollback failed for the sweep, and keeps sweeping past a row that fails", async () => {
    const id = await failedCase();
    const failingDb = new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) =>
            statements.length === 2 ? Promise.reject(new Error("D1 unavailable")) : target.batch(statements);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = fakeEnv({ create: async () => Promise.reject(new Error("unavailable")) });
    expect(await retryCase(failingDb, failing, ORG, id, MEMBER, undefined, () => `${id}RF`)).toMatchObject({
      ok: false,
      error: { code: "start_unknown" },
    });
    expect((await row(id))?.status).toBe("received");
    // The sweep: this row's settling fails once, another row settles in the same sweep, then this one settles.
    const other = await failedCase();
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await db
      .prepare("UPDATE cases SET status = 'received', run_id = ?, updated_at = ? WHERE id IN (?, ?)")
      .bind(`${other}RO`, old, other, other)
      .run();
    await db.prepare("UPDATE cases SET updated_at = ? WHERE id = ?").bind(old, id).run();
    const later = () => new Date(Date.now() + 3 * 60 * 60 * 1000);
    const first = await sweepRetries(failingDb, fakeEnv({}), later);
    expect(first.errors).toBeGreaterThanOrEqual(1);
    expect((await row(other))?.status).toBe("received");
    // Earlier tests' unsettled rows were looked at before these, so they are reached first; a few sweeps reach all.
    for (let hour = 4; hour < 8; hour++)
      await sweepRetries(db, fakeEnv({}), () => new Date(Date.now() + hour * 60 * 60 * 1000));
    expect((await row(id))?.status).toBe("partial");
    expect((await row(other))?.status).toBe("partial");
  });

  it("does not resend an earlier run's reply after a retry: the retried run replies under its own key", async () => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      sent.push(String(init?.body ?? ""));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
    });
    try {
      const id = await failedCase();
      await db
        .prepare("UPDATE cases SET forwarded_by = 'member@demo.isitlegit.co.za', run_id = ? WHERE id = ?")
        .bind(`${id}R1`, id)
        .run();
      const at = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at, claimed_at, resend_state, resend_runs, resend_at) VALUES (?, ?, ?, 'reply', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'failed', 1, ?, ?, ?, 'requested', 0, ?)",
        )
        .bind(crypto.randomUUID(), `reply:${id}`, id, at, at, at, at)
        .run();
      await resendRequested(env);
      expect(sent).toEqual([]);
      const state = await db
        .prepare("SELECT resend_state, resend_outcome FROM mail_sends WHERE send_key = ?")
        .bind(`reply:${id}`)
        .first<{ resend_state: string; resend_outcome: string }>();
      expect(state?.resend_state).toBe("done");
      expect(state?.resend_outcome).toContain("superseded");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("leaves a run that started alone when a stale sweep raced it, its own failure current (round 1)", async () => {
    const id = await failedCase();
    const old = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await db
      .prepare("UPDATE cases SET status = 'received', run_id = ?, updated_at = ? WHERE id = ?")
      .bind(`${id}RS`, old, id)
      .run();
    await db
      .prepare(
        "INSERT INTO case_events (case_id, step, status, started_at, actor, run_id) VALUES (?, 'retry', 'started', ?, ?, ?)",
      )
      .bind(id, old, MEMBER, `${id}RS`)
      .run();
    // The run starts and fails at checks while the sweep waits on its lookup.
    const racing = {
      ANALYSIS: {
        get: async (instance: string) => ({
          status: async () => {
            if (instance === `${id}RS`) {
              await setStatus(db, ORG, id, "running");
              await recordEvent(db, id, "checks", "failed", { errorClass: "CheckError" });
              await setStatus(db, ORG, id, "partial");
            }
            return { status: "complete" };
          },
        }),
      },
    } as unknown as Env;
    for (let hour = 10; hour < 14; hour++)
      await sweepRetries(db, racing, () => new Date(Date.now() + hour * 60 * 60 * 1000));
    expect((await events(id)).filter((e) => e.step === "retry" && e.status === "failed")).toEqual([]);
    expect(await currentFailures(id)).toEqual(["checks"]);
    expect((await row(id))?.run_id).toBe(`${id}RS`);
  });

  it("gives the case its earlier run back when a retry is rolled back, so that run's reply can still be resent (round 1)", async () => {
    const sent: string[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== SMTP2GO_URL) return real(input, init);
      sent.push(String(init?.body ?? ""));
      return Response.json({ data: { succeeded: 1, failed: 0, email_id: `email-${sent.length}` } });
    });
    try {
      const id = await failedCase();
      await db
        .prepare(
          "UPDATE cases SET forwarded_by = 'member@demo.isitlegit.co.za', message_id = '<rb-1@fictional-recipient.example>' WHERE id = ?",
        )
        .bind(id)
        .run();
      const at = new Date().toISOString();
      await db
        .prepare(
          "INSERT INTO mail_sends (id, send_key, case_id, kind, to_hash, status, attempts, created_at, updated_at, claimed_at, resend_state, resend_runs, resend_at) VALUES (?, ?, ?, 'reply', ?, 'failed', 1, ?, ?, ?, 'requested', 0, ?)",
        )
        .bind(crypto.randomUUID(), `reply:${id}`, id, "c".repeat(64), at, at, at, at)
        .run();
      const failing = fakeEnv({ create: async () => Promise.reject(new Error("unavailable")) });
      expect(await retryCase(db, failing, ORG, id, MEMBER)).toMatchObject({
        ok: false,
        error: { code: "not_started" },
      });
      expect((await row(id))?.run_id).toBeNull();
      await resendRequested(env);
      expect(sent).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
