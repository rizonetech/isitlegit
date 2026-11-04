import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { d1Budget } from "../../src/meta/budget";
import { ModelOutputError, type StructuredContext, structured } from "../../src/meta/structured";

// The structured output helper (D03 T01 §5): the real client through a stubbed transport and the migrated D1, so the
// request Meta would receive and the record each attempt leaves are the real ones.
const db = (env as unknown as Env).DB;
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const MARKER = "HOSTILE-7f3a-ignore-previous";
const Verdict = z.strictObject({
  verdict: z.enum(["legit", "suspicious"]),
  reasons: z.array(z.string()),
  sender: z.string().nullable(),
});

beforeEach(async () => {
  await db.prepare("DELETE FROM model_spend").run();
});

type Part = { type: string; text?: string; refusal?: string };
const reply = (parts: Part[], status = "completed") =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      status,
      output: [{ type: "message", role: "assistant", content: parts }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );
const text = (body: string, status?: string) => reply([{ type: "output_text", text: body }], status);
const GOOD = JSON.stringify({ verdict: "legit", reasons: ["known sender"], sender: null });

function model(...script: (() => Response)[]) {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  const ctx: StructuredContext = {
    env: META,
    owner: { kind: "case", caseId: "01HZSTRUCTCASE000000000000", step: "verdict" },
    budget: d1Budget(db, { caller: "verdict" }),
    random: () => 0.5,
    sleep: async () => {},
    waitUntil: () => {},
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const next = script[Math.min(i++, script.length - 1)];
      if (!next) throw new Error("no answer");
      return next();
    }) as typeof fetch,
  };
  return { ctx, bodies };
}
const ask = (ctx: StructuredContext, schema: z.ZodType = Verdict, name = "verdict") =>
  structured(schema, { name, model: "muse-spark-1.3", input: "Is this legit?", max_output_tokens: 256 }, ctx);
const rows = async () =>
  (await db.prepare("SELECT outcome, error_class, actual_usd, cost_certainty FROM model_spend ORDER BY at").all())
    .results;
const failure = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e as ModelOutputError);

describe("structured", () => {
  it("sends the schema as a strict json_schema text.format and returns the validated value", async () => {
    const m = model(() => text(GOOD));
    const got = await ask(m.ctx);
    expect(got.value).toEqual({ verdict: "legit", reasons: ["known sender"], sender: null });
    expect(got.callId).toEqual(expect.any(String));
    const format = (m.bodies[0] as { text: { format: Record<string, unknown> } }).text.format;
    expect(format).toMatchObject({ type: "json_schema", name: "verdict", strict: true });
    expect(format.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["verdict", "reasons", "sender"],
    });
    expect(format.schema).not.toHaveProperty("$schema");
    expect(await rows()).toEqual([
      { outcome: "ok", error_class: null, actual_usd: expect.any(Number), cost_certainty: "measured" },
    ]);
  });

  it("refuses a schema Meta would refuse, before anything is reserved or sent", async () => {
    const Tree: z.ZodType = z.strictObject({
      name: z.string(),
      get kids() {
        return z.array(Tree);
      },
    });
    let deep: z.ZodType = z.strictObject({ leaf: z.string() });
    for (let level = 0; level < 10; level++) deep = z.strictObject({ next: deep });
    const refused: [z.ZodType, string][] = [
      [Tree, "verdict"],
      [z.array(z.string()), "verdict"],
      [z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.string() })]), "verdict"],
      [z.strictObject({ a: z.string(), b: z.string().optional() }), "verdict"],
      [z.looseObject({ a: z.string() }), "verdict"],
      [deep, "verdict"],
      [Verdict, "has space"],
      [Verdict, "x".repeat(65)],
    ];
    for (const [schema, name] of refused) {
      const m = model(() => text(GOOD));
      const error = await failure(ask(m.ctx, schema, name));
      expect(error).toBeInstanceOf(ModelOutputError);
      expect((error as ModelOutputError).kind).toBe("schema");
      expect(m.bodies).toEqual([]);
    }
    expect(await rows()).toEqual([]);
    const nullable = model(() => text(GOOD));
    await expect(ask(nullable.ctx)).resolves.toBeTruthy();
  });

  it("retries once on each kind of invalid answer, with the problems said, then succeeds", async () => {
    for (const bad of [
      "{not json",
      JSON.stringify({ verdict: 7, reasons: [], sender: null }),
      JSON.stringify({ verdict: "legit", reasons: [], sender: null, extra: 1 }),
      JSON.stringify({ verdict: "legit", reasons: [""], sender: null }),
    ]) {
      const schema = Verdict.refine((v) => v.reasons.every((r) => r.length > 0), "reasons are words");
      const m = model(
        () => text(bad),
        () => text(GOOD),
      );
      expect(((await ask(m.ctx, schema)).value as { verdict: string }).verdict).toBe("legit");
      expect(m.bodies).toHaveLength(2);
      const retry = m.bodies[1]?.input as { role: string; content: string }[];
      expect(retry.at(-1)?.role).toBe("developer");
      expect(retry.at(-1)?.content).toMatch(/did not match the required schema/);
    }
  });

  it("throws invalid after one retry, and marks both paid answers on their records", async () => {
    const m = model(() => text(JSON.stringify({ verdict: "maybe", reasons: [], sender: null })));
    const error = await failure(ask(m.ctx));
    expect([error?.name, error?.kind]).toEqual(["ModelOutputError", "invalid"]);
    expect(m.bodies).toHaveLength(2);
    const got = await rows();
    expect(got.map((r) => [r.outcome, r.error_class, r.cost_certainty])).toEqual([
      ["error", "output-invalid", "measured"],
      ["error", "output-invalid", "measured"],
    ]);
    for (const row of got) expect(row.actual_usd as number).toBeGreaterThan(0);
  });

  it("records invalid-then-valid as an error row then an ok row", async () => {
    const m = model(
      () => text("{oops"),
      () => text(GOOD),
    );
    await ask(m.ctx);
    expect((await rows()).map((r) => [r.outcome, r.error_class])).toEqual([
      ["error", "output-invalid"],
      ["ok", null],
    ]);
  });

  it("ends a failed, incomplete or refused answer after one request, never repairing it", async () => {
    const cases: [() => Response, string][] = [
      [() => text("", "failed"), "failed"],
      [() => text('{"verdict":"le', "incomplete"), "incomplete"],
      [() => reply([{ type: "refusal", refusal: "no" }]), "refused"],
    ];
    for (const [answer, kind] of cases) {
      await db.prepare("DELETE FROM model_spend").run();
      const m = model(answer, () => text(GOOD));
      const error = await failure(ask(m.ctx));
      expect(error?.kind).toBe(kind);
      expect(m.bodies).toHaveLength(1);
      expect((await rows()).map((r) => r.error_class)).toEqual([`output-${kind}`]);
    }
  });

  it("never repeats the reply's own text, an unknown key or a parser's message", async () => {
    for (const bad of [
      `{"verdict": "${MARKER}`,
      JSON.stringify({ verdict: "legit", reasons: [], sender: null, [MARKER]: 1 }),
      JSON.stringify({ verdict: MARKER, reasons: [], sender: null }),
      JSON.stringify({ verdict: "legit", reasons: [MARKER, 3], sender: null }),
    ]) {
      const m = model(() => text(bad));
      const error = await failure(ask(m.ctx));
      const retry = m.bodies[1]?.input as { content: string }[];
      expect(retry.at(-1)?.content).not.toContain(MARKER);
      expect(error?.message).not.toContain(MARKER);
    }
  });
});

describe("the strict-object contract and the trusted words", () => {
  it("refuses an unknown property even under a plain z.object, which would strip it", async () => {
    const Plain = z.object({ verdict: z.enum(["legit", "suspicious"]) });
    const m = model(
      () => text(JSON.stringify({ verdict: "legit", smuggled: "x" })),
      () => text(JSON.stringify({ verdict: "suspicious" })),
    );
    expect((await ask(m.ctx, Plain)).value).toEqual({ verdict: "suspicious" });
    expect(m.bodies).toHaveLength(2);
    const retry = m.bodies[1]?.input as { content: string }[];
    expect(retry.at(-1)?.content).toContain("the answer has a property the schema does not name");
  });

  it("says each problem as a schema path and a fixed phrase", async () => {
    const m = model(
      () => text(JSON.stringify({ verdict: 7, reasons: ["a", 3], sender: null })),
      () => text(GOOD),
    );
    await ask(m.ctx);
    const retry = m.bodies[1]?.input as { content: string }[];
    expect(retry.at(-1)?.content).toBe(
      "Your previous answer did not match the required schema: verdict is not one of the allowed values; reasons.1 has the wrong type. Answer again, matching it exactly.",
    );
  });
});

describe("completion review (2026-10-29)", () => {
  // A schema `levels` containers deep, objects and arrays alternating, the root an object (level 1).
  const nested = (levels: number): z.ZodType => {
    let inner: z.ZodType = z.string();
    for (let level = levels; level >= 2; level--)
      inner = level % 2 === 0 ? z.array(inner) : z.strictObject({ v: inner });
    return z.strictObject({ v: inner });
  };

  it("counts arrays toward the nesting limit: ten levels go, eleven are refused before any request", async () => {
    const ok = model(() => text(JSON.stringify({ v: "x" })));
    await failure(ask(ok.ctx, nested(10)));
    expect(ok.bodies).toHaveLength(2);
    const deep = model(() => text(GOOD));
    expect((await failure(ask(deep.ctx, nested(11))))?.kind).toBe("schema");
    expect(deep.bodies).toEqual([]);
  });

  it("refuses allOf and oneOf before any request, with no record", async () => {
    await db.prepare("DELETE FROM model_spend").run();
    const withAllOf = z.strictObject({ x: z.string().meta({ allOf: [{ type: "string" }] }) });
    const withOneOf = z.strictObject({
      x: z.discriminatedUnion("k", [z.strictObject({ k: z.literal("a") }), z.strictObject({ k: z.literal("b") })]),
    });
    for (const schema of [withAllOf, withOneOf]) {
      const m = model(() => text(GOOD));
      expect((await failure(ask(m.ctx, schema)))?.kind).toBe("schema");
      expect(m.bodies).toEqual([]);
    }
    expect(await rows()).toEqual([]);
  });

  it("finds an unknown property in a nullable object, a nullable array, a tuple, and an inherited name", async () => {
    const Shape = z.strictObject({
      who: z.strictObject({ name: z.string() }).nullable(),
      list: z.array(z.strictObject({ n: z.number() })).nullable(),
      pair: z.tuple([z.string(), z.strictObject({ ok: z.boolean() })]),
    });
    const clean = { who: { name: "a" }, list: [{ n: 1 }], pair: ["x", { ok: true }] };
    for (const dirty of [
      { ...clean, who: { name: "a", extra: 1 } },
      { ...clean, list: [{ n: 1, extra: 1 }] },
      { ...clean, pair: ["x", { ok: true, extra: 1 }] },
      { ...clean, toString: "x" },
    ]) {
      const m = model(
        () => text(JSON.stringify(dirty)),
        () => text(JSON.stringify(clean)),
      );
      expect((await ask(m.ctx, Shape)).value).toEqual(clean);
      expect(m.bodies).toHaveLength(2);
    }
  });

  it("never waits past its grace on a failure record that stalls, and keeps it alive", async () => {
    const never = new Promise<never>(() => {});
    const kept: Promise<unknown>[] = [];
    for (const answer of [() => text("{bad"), () => text('{"verdict":"le', "incomplete")]) {
      const m = model(answer);
      const ctx = {
        ...m.ctx,
        budget: { ...m.ctx.budget, outputFailed: () => never },
        waitUntil: (p: Promise<unknown>) => void kept.push(p),
      };
      const started = Date.now();
      const error = await failure(ask(ctx));
      expect(error).toBeInstanceOf(ModelOutputError);
      expect(Date.now() - started).toBeLessThan(3_500);
    }
    expect(kept.length).toBeGreaterThanOrEqual(2);
  });

  it("bounds the answer and its repair by one deadline", async () => {
    const slow = (body: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return text(body);
    };
    let i = 0;
    const answers = [slow("{bad"), slow(GOOD)];
    const m = model(() => text(GOOD));
    const ctx = {
      ...m.ctx,
      deadlineMs: 400,
      fetch: (async () => (answers[Math.min(i++, 1)] as () => Promise<Response>)()) as typeof fetch,
    };
    const started = Date.now();
    const error = await ask(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(400 + 1_500);
  });

  it("carries each paid attempt's call and gateway ids on the error", async () => {
    const m = model(() => text(JSON.stringify({ verdict: "maybe", reasons: [], sender: null })));
    const error = await failure(ask(m.ctx));
    expect(error?.calls).toEqual([
      { callId: expect.any(String), logId: "log-1" },
      { callId: expect.any(String), logId: "log-1" },
    ]);
    expect(error?.calls[0]?.callId).not.toBe(error?.calls[1]?.callId);
  });
});

describe("round 1 (2026-10-29)", () => {
  it("never returns a value zod's union parse stripped of what the reply said", async () => {
    const Union = z.strictObject({
      result: z.union([
        z.object({ verdict: z.literal("suspicious") }),
        z.object({ verdict: z.literal("suspicious"), evidenceIds: z.array(z.string()) }),
      ]),
    });
    const whole = { result: { verdict: "suspicious", evidenceIds: ["E1"] } };
    const m = model(() => text(JSON.stringify(whole)));
    const error = await failure(ask(m.ctx, Union));
    expect(error?.kind).toBe("invalid");
    expect(m.bodies).toHaveLength(2);
    expect((await rows()).map((r) => r.error_class)).toEqual(["output-invalid", "output-invalid"]);
  });
});

describe("final review (2026-10-29)", () => {
  it("inlines a shared named sub-schema and sends it, refusing only a reference cycle", async () => {
    const Evidence = z.strictObject({ id: z.string() }).meta({ id: "Evidence" });
    const Shared = z.strictObject({ a: Evidence, b: Evidence });
    const m = model(() => text(JSON.stringify({ a: { id: "1" }, b: { id: "2" } })));
    expect((await ask(m.ctx, Shared)).value).toEqual({ a: { id: "1" }, b: { id: "2" } });
    const sent = (m.bodies[0] as { text: { format: { schema: Record<string, unknown> } } }).text.format.schema;
    expect(JSON.stringify(sent)).not.toContain("$ref");
    expect(sent).not.toHaveProperty("$defs");
    const Node: z.ZodType = z
      .strictObject({
        id: z.string(),
        get next() {
          return z.array(Node);
        },
      })
      .meta({ id: "Node" });
    const cyclic = model(() => text(GOOD));
    expect((await failure(ask(cyclic.ctx, z.strictObject({ root: Node }))))?.kind).toBe("schema");
    expect(cyclic.bodies).toEqual([]);
  });

  it("refuses a schema past each of Meta's limits before any request, and accepts one at them", async () => {
    const values = (n: number, width = 1) => Array.from({ length: n }, (_, i) => `v${i}`.padEnd(width, "x"));
    const props = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, z.string()]));
    const Leaf = z.strictObject(props(40)).meta({ id: "Leaf" });
    const Mid = z
      .strictObject(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`m${i}`, Leaf])))
      .meta({ id: "Mid" });
    const over: z.ZodType[] = [
      z.strictObject({ code: z.enum(values(1_001) as [string, ...string[]]) }),
      z.strictObject(props(5_001)),
      z.strictObject({ code: z.enum(values(251, 70) as [string, ...string[]]) }),
      z.strictObject({
        a: z.enum(values(500, 130) as [string, ...string[]]),
        b: z.enum(values(500, 130).map((v) => `b${v}`) as [string, ...string[]]),
      }),
      z.strictObject(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`r${i}`, z.array(Mid)]))),
    ];
    for (const schema of over) {
      const m = model(() => text(GOOD));
      expect((await failure(ask(m.ctx, schema)))?.kind).toBe("schema");
      expect(m.bodies).toEqual([]);
    }
    const atLimit = model(() => text("{}"));
    await failure(ask(atLimit.ctx, z.strictObject({ code: z.enum(values(1_000) as [string, ...string[]]) })));
    expect(atLimit.bodies).toHaveLength(2);
  });
});

describe("bounded verdict validation diagnostics", () => {
  it("records JSON and hostile-property rejection without copying content and keeps the two-answer ceiling", async () => {
    const m = model(
      () => text("SECRET not JSON"),
      () => text(JSON.stringify({ ...JSON.parse(GOOD), "SECRET-password": "private" })),
    );
    const diagnostics: unknown[] = [];
    const got = await failure(
      ask({
        ...m.ctx,
        onValidationDiagnostic: async (d) => {
          diagnostics.push(d);
        },
      }),
    );
    expect(got?.kind).toBe("invalid");
    expect(diagnostics).toEqual([
      {
        phase: "structured",
        callId: expect.any(String),
        attempt: 1,
        remaining: 1,
        issues: [{ category: "json_invalid", path: [] }],
      },
      {
        phase: "structured",
        callId: expect.any(String),
        attempt: 2,
        remaining: 0,
        issues: [{ category: "unknown_property", path: [] }],
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/SECRET|private|password/);
    expect(m.bodies).toHaveLength(2);
    expect((await rows()).every((r) => r.error_class === "output-invalid")).toBe(true);
  });
  it("records a trusted static schema path and preserves a normal repaired answer", async () => {
    const schema = z.strictObject({ confidence: z.number(), recommended_actions: z.array(z.string()) });
    const m = model(
      () => text('{"confidence":"PRIVATE","recommended_actions":[]}'),
      () => text('{"confidence":0.5,"recommended_actions":[]}'),
    );
    const diagnostics: unknown[] = [];
    const got = await ask(
      {
        ...m.ctx,
        onValidationDiagnostic: async (d) => {
          diagnostics.push(d);
        },
      },
      schema,
    );
    expect(got.value).toEqual({ confidence: 0.5, recommended_actions: [] });
    expect(diagnostics).toEqual([
      {
        phase: "structured",
        callId: expect.any(String),
        attempt: 1,
        remaining: 1,
        issues: [{ category: "schema_invalid", path: ["confidence"] }],
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE");
  });
  it("does not let a rejected diagnostic callback change repair or accounting", async () => {
    const m = model(
      () => text("invalid"),
      () => text(GOOD),
    );
    const got = await ask({
      ...m.ctx,
      onValidationDiagnostic: async () => {
        throw new Error("PRIVATE");
      },
    });
    expect(got.value).toEqual(JSON.parse(GOOD));
    expect(got.attempts).toBe(2);
    expect((await rows()).filter((r) => r.error_class === "output-invalid")).toHaveLength(1);
  });
});

it("bounds nested hostile properties and array paths to static schema segments", async () => {
  const nested = z.strictObject({ recommended_actions: z.array(z.strictObject({ meaning: z.string() })) });
  const m = model(
    () => text('{"recommended_actions":[{"meaning":"x","PRIVATE-KEY":"secret"}]}'),
    () => text('{"recommended_actions":[{"meaning":12}]}'),
  );
  const diagnostics: unknown[] = [];
  await failure(
    ask(
      {
        ...m.ctx,
        onValidationDiagnostic: async (d) => {
          diagnostics.push(d);
        },
      },
      nested,
    ),
  );
  expect(diagnostics).toEqual([
    {
      phase: "structured",
      callId: expect.any(String),
      attempt: 1,
      remaining: 1,
      issues: [{ category: "unknown_property", path: [] }],
    },
    {
      phase: "structured",
      callId: expect.any(String),
      attempt: 2,
      remaining: 0,
      issues: [{ category: "schema_invalid", path: ["recommended_actions", "*", "meaning"] }],
    },
  ]);
  expect(JSON.stringify(diagnostics)).not.toMatch(/PRIVATE|secret/);
});
