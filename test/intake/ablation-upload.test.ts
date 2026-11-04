import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sweepIntake } from "../../src/intake/admit";
import { readCaseExperiment } from "../../src/pipeline/case-experiments";
import { call, signIn, stubSmtp2go } from "../auth/helpers";
import { addInviteCode } from "../fixtures/auth/members";

const db = env.DB;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const context = (arm = "full", experimentId = "experiment-one") => ({
  experimentId,
  arm,
  manifestDigest: "a".repeat(64),
  deployment: COMMIT,
});
async function member() {
  const email = `ablation-${crypto.randomUUID()}@demo.isitlegit.co.za`;
  const code = `code-${crypto.randomUUID()}`;
  await addInviteCode(db, code);
  const smtp = stubSmtp2go();
  try {
    const made = await call("/api/auth/sign-up/invite-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, organizationName: "Ablation fixtures", consent: true }),
    });
    expect(made.status).toBe(201);
  } finally {
    smtp.restore();
  }
  const { cookie } = await signIn(email);
  const row = await db
    .prepare('SELECT m."organizationId" AS id FROM "member" m JOIN "user" u ON u.id=m."userId" WHERE u.email=?')
    .bind(email)
    .first<{ id: string }>();
  if (!row) throw new Error("no test organisation");
  const starts: string[] = [];
  const running = new Set<string>();
  const workerEnv = {
    ...env,
    EVAL_ORG_ID: row.id,
    COMMIT_SHA: COMMIT,
    ANALYSIS: {
      create: async ({ id }: { id: string }) => {
        starts.push(id);
        running.add(id);
        return { id };
      },
      get: async (id: string) => {
        if (!running.has(id)) throw new Error("instance.not_found");
        return { id };
      },
    },
  } as unknown as Env;
  return { cookie, orgId: row.id, starts, workerEnv };
}
function upload(cookie: string, workerEnv: Env, metadata: unknown = context(), replay = "arm-full") {
  const form = new FormData();
  form.set("file", new Blob(["%PDF-1.4\n% synthetic invoice\n%%EOF\n"], { type: "application/pdf" }), "invoice.pdf");
  form.set("replayRunId", replay);
  if (metadata !== null) form.set("ablate", JSON.stringify(metadata));
  return call(
    "/api/upload",
    { method: "POST", headers: { cookie, accept: "application/json" }, body: form },
    workerEnv,
  );
}

describe("immutable per-case ablation admission", () => {
  it("admits explicit full with persisted attribution and returns the same case on retry", async () => {
    const m = await member();
    const first = await upload(m.cookie, m.workerEnv);
    expect(first.status).toBe(201);
    const one = (await first.json()) as { caseId: string; experiment: unknown };
    expect(one.experiment).toEqual({ ...context(), replayRunId: "arm-full" });
    const repeat = await upload(m.cookie, m.workerEnv);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ...one, repeat: true });
    expect(m.starts).toEqual([one.caseId]);
    expect(
      await db.prepare("SELECT arm, replay_run_id FROM case_experiments WHERE case_id=?").bind(one.caseId).first(),
    ).toEqual({ arm: "full", replay_run_id: "arm-full" });
  });
  it("keeps sample identity after claim expiry and sweep", async () => {
    const m = await member();
    const one = (await (await upload(m.cookie, m.workerEnv)).json()) as { caseId: string };
    await db
      .prepare("UPDATE intake_messages SET claimed_at='2020-01-01T00:00:00.000Z' WHERE org_id=?")
      .bind(m.orgId)
      .run();
    await sweepIntake(m.workerEnv);
    const retry = await upload(m.cookie, m.workerEnv);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { caseId: string }).caseId).toBe(one.caseId);
    expect(m.starts).toEqual([one.caseId]);
  });
  it("binds each arm to a fresh case and refuses identity changes", async () => {
    const m = await member();
    const ids = new Set<string>();
    for (const arm of ["full", "no-agent-reasoning", "no-walkthrough", "no-sam", "no-transcribe", "no-screening"]) {
      const response = await upload(m.cookie, m.workerEnv, context(arm), `run-${arm}`);
      expect(response.status).toBe(201);
      const body = (await response.json()) as { caseId: string; experiment: unknown };
      expect(body.experiment).toEqual({ ...context(arm), replayRunId: `run-${arm}` });
      ids.add(body.caseId);
    }
    expect(ids.size).toBe(6);
    for (const metadata of [
      context("no-sam"),
      context("full", "other"),
      { ...context(), manifestDigest: "b".repeat(64) },
      { ...context(), deployment: "b".repeat(40) },
    ]) {
      expect((await upload(m.cookie, m.workerEnv, metadata, "run-full")).status).toBe(409);
    }
    expect((await upload(m.cookie, m.workerEnv, null, "run-full")).status).toBe(409);
    expect(m.starts).toHaveLength(6);
  });
  it("refuses malformed and forged metadata without starting work", async () => {
    const m = await member();
    for (const metadata of [
      "not an object",
      {},
      { ...context(), extra: true },
      { ...context(), arm: "unknown" },
      { ...context(), experimentId: "bad id" },
    ])
      expect((await upload(m.cookie, m.workerEnv, metadata)).status).toBe(400);
    expect((await upload(m.cookie, { ...m.workerEnv, EVAL_ORG_ID: "another-org" })).status).toBe(403);
    expect((await upload(m.cookie, m.workerEnv, context(), "")).status).toBe(400);
    expect(m.starts).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM cases WHERE org_id=?").bind(m.orgId).first()).toEqual({ n: 0 });
  });
  it("advertises only installed consumers and disables experimental admission without disabling ordinary uploads", async () => {
    const m = await member();
    const capability = await call("/api/upload/ablation-capabilities", { headers: { cookie: m.cookie } }, m.workerEnv);
    expect(capability.status).toBe(200);
    expect(await capability.json()).toEqual({
      version: 1,
      commit: COMMIT,
      durableContext: true,
      uploadArms: ["full", "no-agent-reasoning", "no-walkthrough", "no-sam", "no-transcribe"],
      screening: false,
    });
    const one = (await (await upload(m.cookie, m.workerEnv)).json()) as { caseId: string };
    const disabled = { ...m.workerEnv, EVAL_ORG_ID: "" };
    expect((await upload(m.cookie, disabled)).status).toBe(503);
    expect((await call("/api/upload/ablation-capabilities", { headers: { cookie: m.cookie } }, disabled)).status).toBe(
      503,
    );
    expect((await upload(m.cookie, disabled, null)).status).toBe(201);
    expect(await readCaseExperiment(db, one.caseId, m.orgId)).toEqual({ ...context(), replayRunId: "arm-full" });
    expect(await readCaseExperiment(db, one.caseId, "other-org")).toBeNull();
  });
  it("retains failed attribution but frees only the active binding after definitive RawMissing", async () => {
    const m = await member();
    const bucket = new Proxy(m.workerEnv.ARTEFACTS, {
      get(target, key) {
        if (key === "put")
          return async () => {
            throw new Error("synthetic R2 failure");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect((await upload(m.cookie, { ...m.workerEnv, ARTEFACTS: bucket })).status).toBe(503);
    const failed = await db
      .prepare("SELECT case_id,active_upload_key FROM case_experiments WHERE org_id=?")
      .bind(m.orgId)
      .first<{ case_id: string; active_upload_key: null }>();
    if (!failed) throw new Error("missing failed attribution");
    expect(failed.active_upload_key).toBeNull();
    await sweepIntake(m.workerEnv);
    const retry = await upload(m.cookie, m.workerEnv);
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { caseId: string }).caseId).not.toBe(failed?.case_id);
    expect(await readCaseExperiment(db, failed.case_id, m.orgId)).toEqual({ ...context(), replayRunId: "arm-full" });
    await expect(
      db.prepare("UPDATE case_experiments SET arm='no-sam' WHERE case_id=?").bind(failed.case_id).run(),
    ).rejects.toThrow();
    expect(m.starts).toHaveLength(1);
  });
  it("recovers a stored case through the sweep with its original attribution", async () => {
    const m = await member();
    const stopped = {
      ...m.workerEnv,
      ANALYSIS: {
        ...m.workerEnv.ANALYSIS,
        create: async () => {
          throw new Error("synthetic create failure");
        },
        get: async () => {
          throw new Error("instance.not_found");
        },
      },
    } as unknown as Env;
    expect((await upload(m.cookie, stopped)).status).toBe(503);
    const row = await db
      .prepare("SELECT case_id FROM case_experiments WHERE org_id=?")
      .bind(m.orgId)
      .first<{ case_id: string }>();
    expect((await upload(m.cookie, m.workerEnv)).status).toBe(503);
    await db
      .prepare("UPDATE intake_messages SET claimed_at='2020-01-01T00:00:00.000Z' WHERE org_id=?")
      .bind(m.orgId)
      .run();
    expect((await sweepIntake(m.workerEnv)).completed).toBe(1);
    const retry = await upload(m.cookie, m.workerEnv);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { caseId: string }).caseId).toBe(row?.case_id);
    expect(m.starts).toEqual([row?.case_id]);
  });
  it("preserves the cap and refuses reuse of an ordinary replay identity", async () => {
    const m = await member();
    expect((await upload(m.cookie, m.workerEnv, null)).status).toBe(201);
    expect((await upload(m.cookie, m.workerEnv)).status).toBe(409);
    await db
      .prepare(
        "INSERT INTO org_limits (org_id,daily_cases_override) VALUES (?,0) ON CONFLICT(org_id) DO UPDATE SET daily_cases_override=0",
      )
      .bind(m.orgId)
      .run();
    expect((await upload(m.cookie, m.workerEnv, context(), "new-run")).status).toBe(429);
    expect(m.starts).toHaveLength(1);
  });
  it("rejects duplicate, binary, missing-replay and invalid JSON fields before admission", async () => {
    const m = await member();
    for (const mode of ["duplicate", "binary", "missing-replay", "json"]) {
      const form = new FormData();
      form.set("file", new Blob(["%PDF-1.4\n%%EOF\n"], { type: "application/pdf" }), "invoice.pdf");
      if (mode !== "missing-replay") form.set("replayRunId", "run");
      form.set("ablate", mode === "binary" ? new Blob(["bad"]) : mode === "json" ? "{" : JSON.stringify(context()));
      if (mode === "duplicate") form.append("ablate", JSON.stringify(context()));
      const response = await call(
        "/api/upload",
        { method: "POST", headers: { cookie: m.cookie }, body: form },
        m.workerEnv,
      );
      expect(response.status).toBe(400);
    }
    expect(m.starts).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM intake_messages WHERE org_id=?").bind(m.orgId).first()).toEqual({
      n: 0,
    });
  });
  it("fails closed before storage when case attribution persistence is unavailable", async () => {
    const m = await member();
    let puts = 0;
    const database = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("INSERT INTO case_experiments")) throw new Error("synthetic attribution outage");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(m.workerEnv.ARTEFACTS, {
      get(target, key) {
        if (key === "put")
          return async () => {
            puts++;
            throw new Error("unexpected raw write");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect((await upload(m.cookie, { ...m.workerEnv, DB: database, ARTEFACTS: bucket })).status).toBe(503);
    expect(puts).toBe(0);
    expect(m.starts).toHaveLength(0);
    expect((await upload(m.cookie, m.workerEnv)).status).toBe(201);
  });
  it("refuses capability and experiment admission on missing schema", async () => {
    const m = await member();
    const database = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("eval_experiment")) throw new Error("synthetic missing schema");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const unavailable = { ...m.workerEnv, DB: database };
    expect(
      (await call("/api/upload/ablation-capabilities", { headers: { cookie: m.cookie } }, unavailable)).status,
    ).toBe(503);
    expect((await upload(m.cookie, unavailable)).status).toBe(503);
    expect(m.starts).toHaveLength(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM cases WHERE org_id=?").bind(m.orgId).first()).toEqual({ n: 0 });
  });
  it("recovers an R2 object whose artefact row failed without replacing the experimental case", async () => {
    const m = await member();
    const database = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("INSERT INTO artefacts")) throw new Error("synthetic artefact insert outage");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect((await upload(m.cookie, { ...m.workerEnv, DB: database })).status).toBe(503);
    const row = await db
      .prepare("SELECT case_id,active_upload_key FROM case_experiments WHERE org_id=?")
      .bind(m.orgId)
      .first<{ case_id: string; active_upload_key: string | null }>();
    if (!row) throw new Error("missing experiment case");
    expect(row.active_upload_key).not.toBeNull();
    const objects = await m.workerEnv.ARTEFACTS.list({ prefix: `raw/${row.case_id}/` });
    expect(objects.objects).toHaveLength(1);
    await db
      .prepare("UPDATE intake_messages SET claimed_at='2020-01-01T00:00:00.000Z' WHERE org_id=?")
      .bind(m.orgId)
      .run();
    expect((await sweepIntake(m.workerEnv)).completed).toBe(1);
    const retry = await upload(m.cookie, m.workerEnv);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { caseId: string }).caseId).toBe(row.case_id);
    expect(m.starts).toEqual([row.case_id]);
    expect(await readCaseExperiment(db, row.case_id, m.orgId)).toEqual({ ...context(), replayRunId: "arm-full" });
  });
});
