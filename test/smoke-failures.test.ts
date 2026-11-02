import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type SmokeResult, smoke } from "../src/smoke";

// The smoke route's failure paths (D00 T01 §5 completion review): one failed binding makes the run 503 while the
// others keep their results, a check that outlasts its limit is reported and still cleaned up after the answer, a
// failed cleanup fails its check, and a Workflow instance that never finishes is terminated. The browser is a stand-in
// that refuses at once, so these runs stay short.
const TOKEN = { authorization: "Bearer test-smoke-token" };
const request = () => new Request("https://example.com/internal/smoke", { headers: TOKEN });
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(overrides: Partial<Env>, limitMs = 1_000) {
  const ctx = createExecutionContext();
  const response = await smoke({ ...env, BROWSER: {} as Env["BROWSER"], ...overrides } as Env, request(), ctx, limitMs);
  const body = (await response.json()) as SmokeResult;
  await waitOnExecutionContext(ctx);
  return { status: response.status, body };
}

describe("smoke route failures", () => {
  it("one failed binding makes the run 503 and keeps the others' results", async () => {
    const DB = { prepare: () => ({ first: () => Promise.reject(new Error("D1 is down")) }) } as unknown as Env["DB"];
    const { status, body } = await run({ DB });
    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.DB).toBe("D1 is down");
    expect(body.checks.CACHE).toBe("ok");
    expect(body.checks.ARTEFACTS).toBe("ok");
  });

  it("reports a write past its limit, and still deletes it once it lands", async () => {
    const calls: string[] = [];
    const ARTEFACTS = {
      put: async (key: string, value: string) => {
        await later(1_500);
        calls.push(`put ${key}`);
        return env.ARTEFACTS.put(key, value);
      },
      get: (key: string) => env.ARTEFACTS.get(key),
      delete: async (key: string) => {
        calls.push(`delete ${key}`);
        return env.ARTEFACTS.delete(key);
      },
    } as unknown as Env["ARTEFACTS"];
    const { body } = await run({ ARTEFACTS }, 500);
    expect(body.checks.ARTEFACTS).toBe("ARTEFACTS did not finish within 0.5 s");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^put smoke\//);
    expect(calls[1]).toBe(calls[0]?.replace("put", "delete"));
    expect(await env.ARTEFACTS.get(calls[0]?.slice(4) as string)).toBeNull();
  });

  it("fails a check whose cleanup fails, naming it", async () => {
    const ARTEFACTS = {
      put: (key: string, value: string) => env.ARTEFACTS.put(key, value),
      get: (key: string) => env.ARTEFACTS.get(key),
      delete: () => Promise.reject(new Error("delete refused")),
    } as unknown as Env["ARTEFACTS"];
    const { status, body } = await run({ ARTEFACTS });
    expect(status).toBe(503);
    expect(body.checks.ARTEFACTS).toBe("cleanup failed: delete refused");
  });

  it("terminates a Workflow instance that does not complete within the limit", async () => {
    let terminated = false;
    const ANALYSIS = {
      create: async () => ({
        status: async () => ({ status: "running" }),
        terminate: async () => {
          terminated = true;
        },
      }),
    } as unknown as Env["ANALYSIS"];
    const { body } = await run({ ANALYSIS }, 1_500);
    expect(body.checks.ANALYSIS).toBe("instance did not complete within 0.5 s");
    expect(terminated).toBe(true);
  });

  it("terminates an instance whose creation answers only after the limit", async () => {
    let terminated = false;
    const ANALYSIS = {
      create: async () => {
        await later(1_500);
        return {
          status: async () => ({ status: "running" }),
          terminate: async () => {
            terminated = true;
          },
        };
      },
    } as unknown as Env["ANALYSIS"];
    const { body } = await run({ ANALYSIS }, 1_000);
    expect(body.checks.ANALYSIS).toBe("ANALYSIS did not finish within 1 s");
    expect(terminated).toBe(true);
  });

  it("terminates an instance whose status cannot be read, and reports a termination that fails", async () => {
    let terminations = 0;
    const failing = (terminate: () => Promise<void>) =>
      ({
        create: async () => ({ status: () => Promise.reject(new Error("status unavailable")), terminate }),
      }) as unknown as Env["ANALYSIS"];
    const unread = await run({ ANALYSIS: failing(async () => void terminations++) }, 2_000);
    expect(unread.body.checks.ANALYSIS).toBe("status unavailable");
    expect(terminations).toBe(1);
    const refused = await run({ ANALYSIS: failing(() => Promise.reject(new Error("terminate refused"))) }, 2_000);
    expect(refused.body.checks.ANALYSIS).toBe("status unavailable; cleanup failed: terminate refused");
  });

  it("runs the SCREEN probe only when asked, and fails the run when Worker screening is broken (§36)", async () => {
    const asked = new Request("https://example.com/internal/smoke?screen=1", { headers: TOKEN });
    const ctx = createExecutionContext();
    const good = await smoke({ ...env, BROWSER: {} as Env["BROWSER"] } as Env, asked, ctx, 1_000, async () => ({
      screener: "glimmer",
      version: "1.0",
    }));
    expect(((await good.json()) as SmokeResult).checks.SCREEN).toBe("ok glimmer 1.0");
    const ctx2 = createExecutionContext();
    const broken = await smoke({ ...env, BROWSER: {} as Env["BROWSER"] } as Env, asked, ctx2, 1_000, async () => {
      throw new Error("screening failed: error/model-x");
    });
    expect(broken.status).toBe(503);
    expect(((await broken.json()) as SmokeResult).checks.SCREEN).toContain("screening failed");
    // A plain smoke run never asks for screening, so it pays no screening spend.
    const plain = await run({});
    expect(plain.body.checks.SCREEN).toBeUndefined();
  });

  it("reports the Worker's version and commit with every run", async () => {
    const { body } = await run({});
    expect(body.version).toBe(env.CF_VERSION_METADATA.id);
    expect(body.version).not.toBe("");
    expect(body.commit).toBe(env.COMMIT_SHA);
  });
});
