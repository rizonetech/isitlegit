import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { d1Budget } from "../../src/meta/budget";
import { structured } from "../../src/meta/structured";
import { manifestDigest, modelVersions, settingsDigest } from "../../src/monitor/ablation-manifest";
import { admitExperiment } from "../../src/monitor/ablation-store";
import { structuredContinuation } from "../../src/monitor/ablation-structured";
import { makeOrg } from "../trust/helpers";

const Schema = z.strictObject({ ok: z.boolean() });
const request = { name: "test", model: "muse-spark-1.3", input: "Fictional page", max_output_tokens: 64 };
const good = () =>
  new Response(
    JSON.stringify({
      id: "response-1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"ok":true}' }] }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { headers: { "content-type": "application/json" } },
  );
const bad = () =>
  new Response(
    JSON.stringify({
      id: "response-1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"private-arbitrary-property":"secret","ok":7}' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
    { headers: { "content-type": "application/json" } },
  );
async function context(fetcher: typeof fetch) {
  const org = await makeOrg();
  const deployment = "a".repeat(40);
  const m = {
    version: 1,
    kind: "monitor-screening",
    seed: "continuation",
    deployment,
    modelVersions: modelVersions(),
    settingsDigest: await settingsDigest(deployment),
    pages: [{ experimentCaseId: "e1", pageId: "p1", captureDigest: "1".repeat(64), labelDigest: "2".repeat(64) }],
  };
  const run = await admitExperiment(
    env.DB,
    org,
    {
      experimentId: "continuation",
      arm: "full",
      manifestDigest: await manifestDigest(m),
      deployment,
      replayRunId: "full",
    },
    m,
  );
  const operationId = run.pages[0]?.pageOperationId;
  if (!operationId) throw new Error("missing fixture operation");
  const binding = {
    db: env.DB,
    monitorRunId: run.monitorRunId,
    operationId,
    phase: "second-look" as const,
    deployment,
    deadline: Date.now() + 3600000,
  };
  return {
    env: { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" },
    budget: d1Budget(env.DB, { caller: "monitor" }),
    owner: { kind: "monitor" as const, run: operationId, host: "candidate.example", step: "second-look" },
    waitUntil: () => {},
    fetch: fetcher,
    transportAttempts: 1,
    binding,
    continuation: structuredContinuation(binding),
  };
}

describe("owning structured answer continuation", () => {
  it("blocks an unknown paid response on restart instead of sending another answer", async () => {
    let sends = 0;
    const ctx = await context((async () => {
      sends++;
      return sends === 1 ? new Response("unavailable", { status: 503 }) : good();
    }) as typeof fetch);
    await expect(structured(Schema, request, ctx)).rejects.toThrow();
    await expect(structured(Schema, request, ctx)).rejects.toThrow();
    expect(sends).toBe(1);
  });
  it("refuses deployment drift before a paid call", async () => {
    let sends = 0;
    const ctx = await context((async () => {
      sends++;
      return good();
    }) as typeof fetch);
    ctx.continuation = structuredContinuation({ ...ctx.binding, deployment: "b".repeat(40) });
    await expect(structured(Schema, request, ctx)).rejects.toThrow();
    expect(sends).toBe(0);
  });
  it("resumes only repair after interruption between first invalid answer and repair claim", async () => {
    let sends = 0;
    const ctx = await context((async () => {
      sends++;
      return sends === 1 ? bad() : good();
    }) as typeof fetch);
    let interrupted = false;
    ctx.binding.db = new Proxy(env.DB, {
      get(target, key) {
        if (key !== "prepare") {
          const v = Reflect.get(target, key);
          return typeof v === "function" ? v.bind(target) : v;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(s, k) {
              if (k !== "bind") {
                const v = Reflect.get(s, k);
                return typeof v === "function" ? v.bind(s) : v;
              }
              return (...args: unknown[]) => {
                if (!interrupted && sql.startsWith("SELECT attempt_id") && args[3] === 2) {
                  interrupted = true;
                  throw new Error("test interrupted before repair claim");
                }
                return s.bind(...args);
              };
            },
          });
        };
      },
    });
    ctx.continuation = structuredContinuation(ctx.binding);
    await expect(structured(Schema, request, ctx)).rejects.toThrow();
    expect(sends).toBe(1);
    ctx.continuation = structuredContinuation({ ...ctx.binding, db: env.DB });
    expect((await structured(Schema, request, ctx)).value).toEqual({ ok: true });
    expect(sends).toBe(2);
    const rows = await env.DB.prepare("SELECT metadata_json FROM monitor_experiment_attempts WHERE monitor_run_id=?")
      .bind(ctx.binding.monitorRunId)
      .all();
    expect(JSON.stringify(rows.results)).not.toContain("private-arbitrary-property");
    expect(JSON.stringify(rows.results)).not.toContain("secret");
  });
  it("reuses only validated completion and refuses request drift", async () => {
    let sends = 0;
    const ctx = await context((async () => {
      sends++;
      return good();
    }) as typeof fetch);
    expect((await structured(Schema, request, ctx)).value).toEqual({ ok: true });
    expect((await structured(Schema, request, ctx)).value).toEqual({ ok: true });
    expect(sends).toBe(1);
    await expect(structured(Schema, { ...request, input: "changed" }, ctx)).rejects.toThrow();
    expect(sends).toBe(1);
  });
});

it("retains an unknown second send without replaying either answer", async () => {
  let sends = 0;
  const ctx = await context((async () => {
    sends++;
    return sends === 1 ? bad() : new Response("unavailable", { status: 503 });
  }) as typeof fetch);
  await expect(structured(Schema, request, ctx)).rejects.toThrow();
  expect(sends).toBe(2);
  await expect(structured(Schema, request, ctx)).rejects.toThrow();
  expect(sends).toBe(2);
});
it("rejects corrupt cached phase metadata without another transport", async () => {
  let sends = 0;
  const ctx = await context((async () => {
    sends++;
    return good();
  }) as typeof fetch);
  await structured(Schema, request, ctx);
  await env.DB.prepare("UPDATE monitor_experiment_attempts SET metadata_json=? WHERE monitor_run_id=?")
    .bind(
      JSON.stringify({
        value: {
          kind: "valid",
          value: { ok: "forged" },
          call: { callId: crypto.randomUUID(), logId: null, reservationId: "missing" },
        },
      }),
      ctx.binding.monitorRunId,
    )
    .run();
  await expect(structured(Schema, request, ctx)).rejects.toThrow();
  expect(sends).toBe(1);
});

it("does not accept a continuation adapter substituting a schema-valid answer", async () => {
  const ctx = await context((async () => good()) as typeof fetch);
  const real = ctx.continuation.execute;
  ctx.continuation.execute = (async (...args: Parameters<typeof real>) => {
    const actual = await real(...args);
    return { ...(actual as Record<string, unknown>), value: { ok: false } };
  }) as typeof real;
  await expect(structured(Schema, request, ctx)).rejects.toThrow();
});
