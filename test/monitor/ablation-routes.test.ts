import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import worker from "../../src/index";
import { monitorAblationRoutes } from "../../src/monitor/ablation-routes";
import { call, signIn, stubSmtp2go } from "../auth/helpers";
import { addInviteCode } from "../fixtures/auth/members";
import { monitorFixture } from "./ablation-fixture";

afterEach(async () => {
  await env.DB.prepare("DELETE FROM model_spend WHERE id IN ('headroom-route','repeat-headroom')").run();
});

async function world(mounted = false) {
  const email = `monitor-${crypto.randomUUID()}@demo.isitlegit.co.za`,
    code = `code-${crypto.randomUUID()}`;
  await addInviteCode(env.DB, code);
  const smtp = stubSmtp2go();
  try {
    expect(
      (
        await call("/api/auth/sign-up/invite-code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, code, organizationName: "Monitor test", consent: true }),
        })
      ).status,
    ).toBe(201);
  } finally {
    smtp.restore();
  }
  const { cookie } = await signIn(email);
  const member = await env.DB.prepare(
    'SELECT m."organizationId" AS orgId,m.id FROM member m JOIN user u ON u.id=m."userId" WHERE u.email=?',
  )
    .bind(email)
    .first<{ orgId: string; id: string }>();
  if (!member) throw new Error("missing member");
  const fixture = await monitorFixture(false, member.orgId);
  const instances = new Map<string, string>();
  const starts: string[] = [];
  const restarts: string[] = [];
  let unknownRestart = false;
  const binding = {
    create: async ({ id }: { id: string; params: { orgId: string; experimentRunId: string } }) => {
      if (instances.has(id)) throw new Error("exists");
      starts.push(id);
      instances.set(id, "queued");
      return { id };
    },
    get: async (id: string) => {
      if (!instances.has(id)) throw new Error("missing");
      return {
        status: async () => ({ status: instances.get(id) ?? "unknown" }),
        restart: async () => {
          restarts.push(id);
          if (unknownRestart) throw new Error("lost restart response");
          instances.set(id, "running");
        },
      };
    },
  };
  const routes = monitorAblationRoutes(() => binding);
  const request = {
    experimentId: "route",
    arm: "no-screening",
    manifestDigest: fixture.manifestDigest,
    deployment: fixture.deployment,
    replayRunId: "no-screening",
  };
  const fetch = (path: string, value?: unknown, runtime = fixture.runtime, customCookie = cookie) =>
    (mounted ? worker.fetch : routes.fetch)(
      new Request(`http://localhost${mounted ? "/api/monitor" : ""}${path}`, {
        method: value === undefined ? "GET" : "POST",
        headers: { cookie: customCookie, accept: "application/json", "content-type": "application/json" },
        ...(value !== undefined ? { body: typeof value === "string" ? value : JSON.stringify(value) } : {}),
      }),
      mounted ? { ...runtime, MONITOR: binding as unknown as Env["MONITOR"] } : runtime,
      createExecutionContext(),
    );
  return {
    ...fixture,
    cookie,
    member,
    request,
    fetch,
    instances,
    starts,
    restarts,
    loseRestart: () => {
      unknownRestart = true;
    },
  };
}
it("requires real authentication, advertises exact capability and idempotently starts one immutable instance", async () => {
  const w = await world();
  expect((await w.fetch("/ablation-capabilities", undefined, w.runtime, "")).status).toBe(401);
  const capability = await w.fetch("/ablation-capabilities");
  expect(capability.status).toBe(200);
  expect(await capability.json()).toEqual({
    version: 1,
    kind: "monitor-screening",
    commit: w.deployment,
    durableContext: true,
    arms: ["full", "no-screening"],
    maxPages: 15,
    immutableCaptures: true,
  });
  const first = await w.fetch("/ablation-runs", w.request);
  expect(first.status).toBe(202);
  const one = (await first.json()) as { monitorRunId: string };
  const repeat = await w.fetch("/ablation-runs", w.request);
  expect(repeat.status).toBe(202);
  expect(await repeat.json()).toEqual(one);
  expect(w.starts).toEqual([one.monitorRunId]);
  const disabled = { ...w.runtime, EVAL_ORG_ID: "" };
  expect((await w.fetch(`/ablation-runs/${one.monitorRunId}`, undefined, disabled)).status).toBe(200);
  expect((await w.fetch("/ablation-capabilities", undefined, disabled)).status).toBe(503);
  expect((await w.fetch("/ablation-runs", w.request, disabled)).status).toBe(503);
  expect((await w.fetch(`/ablation-runs/${one.monitorRunId}/resume`, { action: "resume" }, disabled)).status).toBe(503);
});
it("rejects duplicate/extra keys and deployment drift before any Workflow, and fails closed on corrupt registry", async () => {
  const w = await world();
  for (const input of [
    JSON.stringify(w.request).replace('"arm":"no-screening"', '"arm":"no-screening","arm":"full"'),
    { ...w.request, orgId: w.org },
    { ...w.request, url: "https://caller.example" },
  ])
    expect((await w.fetch("/ablation-runs", input)).status).toBe(400);
  expect((await w.fetch("/ablation-runs", { ...w.request, deployment: "b".repeat(40) })).status).toBe(409);
  expect(w.starts).toHaveLength(0);
  await env.ARTEFACTS.put(
    "eval/monitor-registry.json",
    JSON.stringify({ version: 1, deployment: w.deployment, manifests: [], private: "bad" }),
  );
  expect((await w.fetch("/ablation-capabilities")).status).toBe(503);
});
it("resumes only a stopped original instance, serializes concurrent requests and holds an unknown restart", async () => {
  const w = await world();
  const admitted = await w.fetch("/ablation-runs", w.request);
  const run = (await admitted.json()) as { monitorRunId: string };
  const path = `/ablation-runs/${run.monitorRunId}/resume`;
  expect((await w.fetch(path, { action: "resume" })).status).toBe(409);
  w.instances.set(run.monitorRunId, "errored");
  const responses = await Promise.all([w.fetch(path, { action: "resume" }), w.fetch(path, { action: "resume" })]);
  expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
  expect(w.restarts).toEqual([run.monitorRunId]);
  w.instances.set(run.monitorRunId, "errored");
  w.loseRestart();
  expect((await w.fetch(path, { action: "resume" })).status).toBe(503);
  expect((await w.fetch(path, { action: "resume" })).status).toBe(409);
  expect(w.restarts).toEqual([run.monitorRunId, run.monitorRunId]);
  expect(
    await env.DB.prepare("SELECT resume_state FROM monitor_experiment_arms WHERE monitor_run_id=?")
      .bind(run.monitorRunId)
      .first(),
  ).toEqual({ resume_state: "unknown" });
});
it("denies ordinary members recovery while keeping historical reads scoped to their organization", async () => {
  const w = await world();
  const run = await w.admitted("no-screening");
  await env.DB.prepare("UPDATE member SET role='member' WHERE id=?").bind(w.member.id).run();
  expect((await w.fetch(`/ablation-runs/${run.monitorRunId}`)).status).toBe(200);
  expect(
    (
      await w.fetch(`/ablation-runs/${run.monitorRunId}/reconcile`, {
        attemptId: "unknown",
        reservationIds: ["unknown"],
      })
    ).status,
  ).toBe(403);
  expect((await w.fetch(`/ablation-runs/${run.monitorRunId}/resume`, { action: "resume" })).status).toBe(403);
  const foreign = await world();
  expect((await foreign.fetch(`/ablation-runs/${run.monitorRunId}`)).status).toBe(404);
  expect((await foreign.fetch(`/ablation-runs/${run.monitorRunId}/resume`, { action: "resume" })).status).toBe(404);
});
it("refuses zero shared headroom before starting a Workflow", async () => {
  const w = await world();
  const day = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO model_spend(id,at,day,source,caller,model,estimate_usd,state) VALUES('headroom-route',?,?,'worker','test','model',15,'uncertain')",
  )
    .bind(new Date().toISOString(), day)
    .run();
  expect((await w.fetch("/ablation-runs", w.request)).status).toBe(503);
  expect(w.starts).toHaveLength(0);
});
it("returns an already completed immutable arm at zero remaining headroom without starting work", async () => {
  const w = await world();
  const first = await w.fetch("/ablation-runs", w.request);
  expect(first.status).toBe(202);
  const run = (await first.json()) as { monitorRunId: string };
  await env.DB.prepare("UPDATE monitor_experiment_arms SET status='complete' WHERE monitor_run_id=?")
    .bind(run.monitorRunId)
    .run();
  const day = new Date(Date.now() + 2 * 3600000).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO model_spend(id,at,day,source,caller,model,estimate_usd,state) VALUES('repeat-headroom',?,?,'worker','test','model',15,'uncertain')",
  )
    .bind(new Date().toISOString(), day)
    .run();
  const repeated = await w.fetch("/ablation-runs", w.request);
  expect(repeated.status).toBe(202);
  expect(await repeated.json()).toMatchObject({ monitorRunId: run.monitorRunId, status: "complete" });
  expect(w.starts).toEqual([run.monitorRunId]);
  await env.DB.prepare("UPDATE monitor_experiment_arms SET status='pending' WHERE monitor_run_id=?")
    .bind(run.monitorRunId)
    .run();
  expect((await w.fetch("/ablation-runs", w.request)).status).toBe(202);
  expect(w.starts).toEqual([run.monitorRunId]);
  expect((await w.fetch("/ablation-runs", { ...w.request, replayRunId: "replacement" })).status).toBe(409);
});

it("mounts monitor capability and immutable admission behind actual Worker authentication", async () => {
  const w = await world(true);
  expect((await w.fetch("/ablation-capabilities", undefined, w.runtime, "")).status).toBe(401);
  expect((await w.fetch("/ablation-capabilities")).status).toBe(200);
  const response = await w.fetch("/ablation-runs", w.request);
  expect(response.status).toBe(202);
  const run = (await response.json()) as { monitorRunId: string };
  expect(w.starts).toEqual([run.monitorRunId]);
  expect((await w.fetch(`/ablation-runs/${run.monitorRunId}`)).status).toBe(200);
});
