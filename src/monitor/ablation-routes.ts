// Mounted only with the real experimental Workflow binding at the coordinator-approved integration boundary.
import { Hono } from "hono";
import { z } from "zod";
import { requireSession } from "../auth/gate";
import { type OrgEnv, requireOrg } from "../auth/org";
import { spentStatement } from "../meta/budget-sql";
import { DAY_CAP_USD, totalLimitFor } from "../meta/caps";
import { sastDay } from "../meta/day";
import { missingConfig } from "../vision/glimmer-wake";
import {
  approvedManifests,
  Deployment,
  ExperimentId,
  loadManifest,
  parseStrictJson,
  preflightCaptures,
  Trigger,
} from "./ablation-manifest";
import { readExperimentReport } from "./ablation-readback";
import { MonitorReconciliationRefused, ReconcileRequest, reconcileExperimentAttempt } from "./ablation-reconcile";
import { admitExperiment, MonitorIdentityConflict, readExperiment, type StoredExperiment } from "./ablation-store";

export type ExperimentPayload = { orgId: string; experimentRunId: string };
export type ExperimentWorkflow = {
  create(options: { id: string; params: ExperimentPayload }): Promise<unknown>;
  get(id: string): Promise<{ status(): Promise<{ status: string }>; restart(): Promise<void> }>;
};
class Refused extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 503) {
    super("monitor request unavailable");
  }
}
const identity = (run: StoredExperiment) => ({
  experimentId: run.experimentId,
  arm: run.arm,
  manifestDigest: run.manifestDigest,
  deployment: run.deployment,
  replayRunId: run.replayRunId,
  monitorRunId: run.monitorRunId,
  status: run.status,
});
async function body(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new Refused(400);
  const reader = request.body?.getReader();
  if (!reader) throw new Refused(400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 2048) {
        await reader.cancel();
        throw new Refused(400);
      }
      chunks.push(part.value);
    }
    const joined = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      joined.set(chunk, at);
      at += chunk.length;
    }
    return parseStrictJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(joined), 2048);
  } catch {
    throw new Refused(400);
  }
}
async function parsedBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  try {
    return schema.parse(await body(request));
  } catch {
    throw new Refused(400);
  }
}
function routeId(value: string) {
  const id = ExperimentId.safeParse(value);
  if (!id.success) throw new Refused(400);
  return id.data;
}
function enabled(env: Env, orgId: string) {
  if (!env.EVAL_ORG_ID) throw new Refused(503);
  if (orgId !== env.EVAL_ORG_ID) throw new Refused(403);
  if (
    !Deployment.safeParse(env.COMMIT_SHA).success ||
    !env.META_API_KEY ||
    !env.CF_AIG_TOKEN ||
    !env.META_GATEWAY_URL ||
    missingConfig(env).length > 0
  )
    throw new Refused(503);
}
async function schemaReady(db: D1Database) {
  const results = await db.batch([
    db.prepare("SELECT manifest_digest,deployment FROM monitor_experiments LIMIT 0"),
    db.prepare("SELECT capture_digest,label_digest FROM monitor_experiment_pages LIMIT 0"),
    db.prepare("SELECT spark_deadline,resume_state,resume_token FROM monitor_experiment_arms LIMIT 0"),
    db.prepare(
      "SELECT page_operation_id,result_json,screen_nonce,second_nonce FROM monitor_experiment_results LIMIT 0",
    ),
    db.prepare("SELECT attempt_id,status,metadata_json FROM monitor_experiment_attempts LIMIT 0"),
  ]);
  if (results.length !== 5 || results.some((result) => !result.success)) throw new Refused(503);
}
async function headroom(db: D1Database) {
  const day = sastDay(new Date());
  const statement = spentStatement(day);
  const row = await db
    .prepare(statement.sql)
    .bind(...statement.params)
    .first<{ day_usd: number; total_usd: number }>();
  if (
    !row ||
    !Number.isFinite(row.day_usd) ||
    !Number.isFinite(row.total_usd) ||
    row.day_usd >= DAY_CAP_USD ||
    row.total_usd >= totalLimitFor(day)
  )
    throw new Refused(503);
  // Admission is only a read. Each actual request still atomically reserves its full owning estimate before transport.
}
export function monitorAblationRoutes(workflow: (env: Env) => ExperimentWorkflow) {
  const app = new Hono<OrgEnv>();
  app.use("*", requireSession, requireOrg);
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(c.env.APP_URL).origin) return c.json({ error: "Forbidden" }, 403);
    }
    return next();
  });
  app.onError((error, c) =>
    c.json(
      { error: "Monitor request unavailable" },
      error instanceof Refused
        ? error.status
        : error instanceof MonitorReconciliationRefused
          ? 403
          : error instanceof MonitorIdentityConflict
            ? 409
            : 503,
    ),
  );
  app.get("/ablation-capabilities", async (c) => {
    enabled(c.env, c.get("org").id);
    workflow(c.env);
    await schemaReady(c.env.DB);
    await approvedManifests(c.env.ARTEFACTS, c.env.COMMIT_SHA);
    return c.json({
      version: 1,
      kind: "monitor-screening",
      commit: c.env.COMMIT_SHA,
      durableContext: true,
      arms: ["full", "no-screening"],
      maxPages: 15,
      immutableCaptures: true,
    });
  });
  app.post("/ablation-runs", async (c) => {
    const org = c.get("org").id;
    enabled(c.env, org);
    const request = await parsedBody(c.req.raw, Trigger);
    if (request.deployment !== c.env.COMMIT_SHA) throw new Refused(409);
    await schemaReady(c.env.DB);
    const existing = await c.env.DB.prepare(
      "SELECT monitor_run_id FROM monitor_experiment_arms WHERE org_id=? AND experiment_id=? AND arm=?",
    )
      .bind(org, request.experimentId, request.arm)
      .first<{ monitor_run_id: string }>();
    if (existing) {
      const prior = await readExperiment(c.env.DB, org, existing.monitor_run_id);
      if (
        !prior ||
        prior.manifestDigest !== request.manifestDigest ||
        prior.deployment !== request.deployment ||
        prior.replayRunId !== request.replayRunId
      )
        throw new MonitorIdentityConflict();
      // Returning an existing non-pending identity neither admits nor resumes work. It needs no new spending headroom.
      if (prior.status !== "pending") return c.json(identity(prior), 202);
      let instanceStatus: string | null = null;
      try {
        instanceStatus = (await (await workflow(c.env).get(prior.monitorRunId)).status()).status;
      } catch {
        // A pending admission without a readable instance still needs all gates before idempotent creation below.
      }
      if (instanceStatus !== null) {
        if (instanceStatus === "unknown") throw new Refused(503);
        return c.json(identity(prior), 202);
      }
    }
    const manifest = await loadManifest(c.env.ARTEFACTS, request.manifestDigest, request.deployment);
    await preflightCaptures(c.env.ARTEFACTS, manifest);
    await headroom(c.env.DB);
    const run = await admitExperiment(c.env.DB, org, request, manifest);
    if (run.status === "pending") {
      const binding = workflow(c.env);
      try {
        await binding.create({ id: run.monitorRunId, params: { orgId: org, experimentRunId: run.monitorRunId } });
      } catch {
        // A duplicate is accepted only if the same real instance is readable. An outage never becomes successful admission.
        const status = await (await binding.get(run.monitorRunId)).status();
        if (status.status === "unknown") throw new Refused(503);
      }
    }
    return c.json(identity(run), 202);
  });
  app.get("/ablation-runs/:id", async (c) => {
    const id = routeId(c.req.param("id"));
    const run = await readExperimentReport(c.env.DB, c.get("org").id, id);
    if (!run) throw new Refused(404);
    return c.json(run);
  });
  app.post("/ablation-runs/:id/reconcile", async (c) => {
    const id = routeId(c.req.param("id"));
    const org = c.get("org");
    const request = await parsedBody(c.req.raw, ReconcileRequest);
    const result = await reconcileExperimentAttempt(
      c.env.DB,
      { orgId: org.id, userId: c.get("signedIn").user.id, role: org.role },
      id,
      request,
    );
    return c.json({ attemptId: request.attemptId, status: "failed", reconciliation: result });
  });
  app.post("/ablation-runs/:id/resume", async (c) => {
    await parsedBody(c.req.raw, z.strictObject({ action: z.literal("resume") }));
    const id = routeId(c.req.param("id"));
    const org = c.get("org");
    if (org.role !== "owner" && org.role !== "admin") throw new Refused(403);
    const run = await readExperiment(c.env.DB, org.id, id);
    if (!run) throw new Refused(404);
    enabled(c.env, org.id);
    if (run.deployment !== c.env.COMMIT_SHA || Date.now() >= run.sparkDeadline || run.status === "complete")
      throw new Refused(409);
    const manifest = await loadManifest(c.env.ARTEFACTS, run.manifestDigest, run.deployment);
    await preflightCaptures(c.env.ARTEFACTS, manifest);
    await headroom(c.env.DB);
    const token = crypto.randomUUID();
    const claimed = await c.env.DB.prepare(
      "UPDATE monitor_experiment_arms SET resume_state='calling',resume_token=? WHERE org_id=? AND monitor_run_id=? AND resume_state='idle' AND NOT EXISTS(SELECT 1 FROM monitor_experiment_attempts t WHERE t.monitor_run_id=monitor_experiment_arms.monitor_run_id AND t.status IN ('running','unknown'))",
    )
      .bind(token, org.id, id)
      .run();
    if (claimed.meta.changes !== 1) throw new Refused(409);
    let sent = false;
    try {
      const instance = await workflow(c.env).get(id);
      const status = await instance.status();
      if (!["errored", "terminated", "complete"].includes(status.status))
        throw new Refused(status.status === "unknown" ? 503 : 409);
      await c.env.DB.prepare(
        "UPDATE monitor_experiment_arms SET status='waiting' WHERE org_id=? AND monitor_run_id=? AND resume_token=?",
      )
        .bind(org.id, id, token)
        .run();
      sent = true;
      await instance.restart();
      await c.env.DB.prepare(
        "UPDATE monitor_experiment_arms SET resume_state='idle',resume_token=NULL WHERE org_id=? AND monitor_run_id=? AND resume_token=?",
      )
        .bind(org.id, id, token)
        .run();
    } catch (error) {
      await c.env.DB.prepare(
        "UPDATE monitor_experiment_arms SET resume_state=?,resume_token=CASE WHEN ?='idle' THEN NULL ELSE resume_token END WHERE org_id=? AND monitor_run_id=? AND resume_token=?",
      )
        .bind(sent ? "unknown" : "idle", sent ? "unknown" : "idle", org.id, id, token)
        .run();
      throw error;
    }
    const resumed = await readExperiment(c.env.DB, org.id, id);
    if (!resumed) throw new Refused(503);
    return c.json(identity(resumed), 202);
  });
  return app;
}
