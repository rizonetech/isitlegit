import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { caseCost, d1Budget } from "../../src/meta/budget";
import { cacheKey, MAX_CACHE_TTL_SECONDS, withCache } from "../../src/meta/cache";
import { type MetaContext, ModelError, metaResponses } from "../../src/meta/client";
import type { Budget, Owner } from "../../src/meta/guard";

// The result cache (D03 T01 §4): the real client through a stubbed transport, the real KV binding and the migrated D1,
// so a hit's record and the spend it leaves are the ones the trace and the caps read.
const db = (env as unknown as Env).DB;
const kv = (env as unknown as Env).CACHE;
const META = { META_API_KEY: "k", CF_AIG_TOKEN: "t", META_GATEWAY_URL: "https://gateway.test/v1" };
const CASE: Owner = { kind: "case", caseId: "01HZCACHECASE0000000000000", step: "checks" };
const IMAGE = "a".repeat(64);
const REFERENCE = "b".repeat(64);
const Verdict = z.strictObject({ verdict: z.enum(["legit", "suspicious"]) });

beforeEach(async () => {
  await db.prepare("DELETE FROM model_spend").run();
  for (const { name } of (await kv.list({ prefix: "meta:" })).keys) await kv.delete(name);
});

const answer = (text: string) =>
  new Response(
    JSON.stringify({
      id: "r",
      object: "response",
      output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
    { headers: { "content-type": "application/json", "cf-aig-log-id": "log-1", "x-request-id": "req-1" } },
  );

// A model behind the real client, counting what reaches the network.
function model(
  reply: () => Response = () => answer('{"verdict":"legit"}'),
  budget: Budget = d1Budget(db, { caller: "checks" }),
) {
  const sent: string[] = [];
  const ctx: MetaContext = {
    env: META,
    owner: CASE,
    budget,
    random: () => 0.5,
    sleep: async () => {},
    fetch: (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return reply();
    }) as typeof fetch,
  };
  const fn = async () => {
    const got = await metaResponses({ model: "muse-spark-1.3", input: "x", max_output_tokens: 32 }, ctx);
    const text = (got.data.output[0] as { content: { text: string }[] }).content[0]?.text ?? "";
    return { value: JSON.parse(text) as unknown };
  };
  return { sent, fn, budget };
}

const inputs = { task: "verdict", model: "muse-spark-1.3", promptVersion: "p1", schemaVersion: "s1" } as const;
const keyOf = (over: Partial<Parameters<typeof cacheKey>[0]> = {}) =>
  cacheKey({ ...inputs, artefacts: [IMAGE], params: { text: "Pay now" }, ...over });
const cacheCtx = (budget: Budget, extra: Partial<Parameters<typeof withCache>[0]> = {}) => ({
  kv,
  budget,
  owner: CASE,
  ...extra,
});
const rows = async () =>
  (await db.prepare("SELECT * FROM model_spend ORDER BY at").all<Record<string, unknown>>()).results;
const counted = async () =>
  (
    await db
      .prepare(
        "SELECT coalesce(sum(CASE WHEN state = 'settled' THEN actual_usd ELSE estimate_usd END), 0) AS usd FROM model_spend",
      )
      .first<{ usd: number }>()
  )?.usd ?? 0;

describe("the cache key", () => {
  it("is the same for the same inputs written in another order, and differs for every input that changes the answer", async () => {
    const base = await keyOf();
    expect(await cacheKey({ params: { text: "Pay now" }, artefacts: [IMAGE], ...inputs })).toBe(base);
    const others = await Promise.all([
      keyOf({ params: { text: "Pay later" } }),
      keyOf({ params: { text: "Pay now", concept: "logo" } }),
      keyOf({ params: { concept: "logo" } }),
      keyOf({ params: { concept: "signature" } }),
      keyOf({ artefacts: [IMAGE, REFERENCE] }),
      keyOf({ artefacts: [REFERENCE, IMAGE] }),
      keyOf({ artefacts: [IMAGE, "c".repeat(64)] }),
      keyOf({ promptVersion: "p2" }),
      keyOf({ schemaVersion: "s2" }),
      keyOf({ task: "logo-compare" }),
      keyOf({ model: "muse-wonder-1.0" }),
    ]);
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
    await expect(keyOf({ artefacts: ["not-a-hash"] })).rejects.toThrow(/SHA-256/);
  });
});

describe("withCache", () => {
  it("answers a second identical request from the cache: one paid call, then a hit costing nothing", async () => {
    const m = model();
    const key = await keyOf();
    const first = await withCache(cacheCtx(m.budget), key, "muse-spark-1.3", 3600, Verdict, m.fn);
    const spent = await counted();
    const second = await withCache(cacheCtx(m.budget), key, "muse-spark-1.3", 3600, Verdict, m.fn);
    expect([first, second]).toEqual([
      { value: { verdict: "legit" }, hit: false },
      { value: { verdict: "legit" }, hit: true },
    ]);
    expect(m.sent).toHaveLength(1);
    expect(await counted()).toBe(spent);
    const [paid, hit] = await rows();
    expect(paid).toMatchObject({ cache: null, outcome: "ok", cost_certainty: "measured", case_id: CASE.caseId });
    expect(hit).toMatchObject({
      cache: "hit",
      outcome: "ok",
      state: "settled",
      actual_usd: 0,
      cost_certainty: "none",
      case_id: CASE.caseId,
      step: "checks",
    });
    expect(hit?.call_id).not.toBe(paid?.call_id);
    const cost = await caseCost(db, { caseId: CASE.caseId });
    expect(cost.attempts).toBe(2);
    expect(cost.measuredUsd).toBeCloseTo(paid?.actual_usd as number);
  });

  it("keeps an entry for its time to live only: reused before, asked again after, written with expirationTtl", async () => {
    const m = model();
    const key = await keyOf();
    let clock = Date.parse("2026-11-01T08:00:00Z");
    const puts: unknown[] = [];
    const watched = new Proxy(kv, {
      get(target, name) {
        if (name === "put")
          return (k: string, v: string, options: unknown) => {
            puts.push(options);
            return target.put(k, v, options as KVNamespacePutOptions);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as KVNamespace;
    const ctx = cacheCtx(m.budget, { kv: watched, now: () => clock });
    await withCache(ctx, key, "muse-spark-1.3", 120, Verdict, m.fn);
    clock += 119_000;
    expect((await withCache(ctx, key, "muse-spark-1.3", 120, Verdict, m.fn)).hit).toBe(true);
    clock += 2_000;
    expect((await withCache(ctx, key, "muse-spark-1.3", 120, Verdict, m.fn)).hit).toBe(false);
    expect(m.sent).toHaveLength(2);
    expect(puts[0]).toEqual({ expirationTtl: 120 });
  });

  it("refuses a time to live KV cannot keep or the retention bound forbids, before any call", async () => {
    const m = model();
    const key = await keyOf();
    for (const ttl of [59, MAX_CACHE_TTL_SECONDS + 1, 1.5])
      await expect(withCache(cacheCtx(m.budget), key, "muse-spark-1.3", ttl, Verdict, m.fn)).rejects.toThrow(
        RangeError,
      );
    expect(m.sent).toEqual([]);
  });

  it("never keeps an error, a partial value or a schema-invalid answer", async () => {
    const key = await keyOf();
    const failing = model(() => new Response("{}", { status: 400 }));
    await expect(
      withCache(cacheCtx(failing.budget), key, "muse-spark-1.3", 3600, Verdict, failing.fn),
    ).rejects.toThrow();
    const m = model();
    expect((await withCache(cacheCtx(m.budget), key, "muse-spark-1.3", 3600, Verdict, m.fn)).hit).toBe(false);
    expect(m.sent).toHaveLength(1);

    const partialKey = await keyOf({ params: { text: "partial" } });
    const partial = async () => ({ ...(await m.fn()), partial: true });
    await withCache(cacheCtx(m.budget), partialKey, "muse-spark-1.3", 3600, Verdict, partial);
    expect((await withCache(cacheCtx(m.budget), partialKey, "muse-spark-1.3", 3600, Verdict, m.fn)).hit).toBe(false);

    const invalidKey = await keyOf({ params: { text: "invalid" } });
    const odd = model(() => answer('{"verdict":"maybe"}'));
    const thrown = await withCache(cacheCtx(odd.budget), invalidKey, "muse-spark-1.3", 3600, Verdict, odd.fn).catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(ModelError);
    expect((thrown as ModelError).kind).toBe("malformed");
    await withCache(cacheCtx(odd.budget), invalidKey, "muse-spark-1.3", 3600, Verdict, odd.fn).catch(() => null);
    expect(odd.sent).toHaveLength(2);
  });

  it("replaces an entry that fails its schema, and serves the replacement after", async () => {
    const m = model();
    const key = await keyOf();
    await kv.put(key, JSON.stringify({ expiresAt: Date.now() + 3_600_000, value: { verdict: "maybe" } }));
    expect((await withCache(cacheCtx(m.budget), key, "muse-spark-1.3", 3600, Verdict, m.fn)).hit).toBe(false);
    expect(await withCache(cacheCtx(m.budget), key, "muse-spark-1.3", 3600, Verdict, m.fn)).toEqual({
      value: { verdict: "legit" },
      hit: true,
    });
    expect(m.sent).toHaveLength(1);
  });

  it("times a hit, serves it with the day cap exhausted, and pays for each of two overlapping misses", async () => {
    const m = model();
    const key = await keyOf();
    await withCache(cacheCtx(m.budget), key, "muse-spark-1.3", 3600, Verdict, m.fn);
    const slow = new Proxy(kv, {
      get(target, name) {
        if (name === "get")
          return async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return (target.get as (...a: unknown[]) => unknown)(...args);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as KVNamespace;
    // The rest of the day's US$15 taken, so any paid call would be refused.
    await d1Budget(db, { caller: "earlier" }).reserve("muse-spark-1.3", 15 - (await counted()), 1);
    await expect(d1Budget(db, { caller: "probe" }).reserve("muse-spark-1.3", 0.01, 1)).rejects.toThrow(/day cap/);
    expect((await withCache(cacheCtx(m.budget, { kv: slow }), key, "muse-spark-1.3", 3600, Verdict, m.fn)).hit).toBe(
      true,
    );
    const hit = (await rows()).find((r) => r.cache === "hit");
    expect(hit?.ms as number).toBeGreaterThanOrEqual(35);

    await db.prepare("DELETE FROM model_spend").run();
    const both = model();
    const fresh = await keyOf({ params: { text: "overlap" } });
    await Promise.all([
      withCache(cacheCtx(both.budget), fresh, "muse-spark-1.3", 3600, Verdict, both.fn),
      withCache(cacheCtx(both.budget), fresh, "muse-spark-1.3", 3600, Verdict, both.fn),
    ]);
    expect(both.sent).toHaveLength(2);
    expect((await rows()).map((r) => [r.cache, r.cost_certainty])).toEqual([
      [null, "measured"],
      [null, "measured"],
    ]);
  });

  it("serves a hit whose record cannot be written, says so once, and sends nothing", async () => {
    const m = model();
    const key = await keyOf();
    await withCache(cacheCtx(m.budget), key, "muse-spark-1.3", 3600, Verdict, m.fn);
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(String(line)));
    try {
      const failing = { ...m.budget, cached: async () => Promise.reject(new Error("D1 down")) };
      expect(await withCache(cacheCtx(failing), key, "muse-spark-1.3", 3600, Verdict, m.fn)).toEqual({
        value: { verdict: "legit" },
        hit: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((line) => line.includes('"cache-hit-unrecorded"'))).toHaveLength(1);
    expect(m.sent).toHaveLength(1);
  });

  it("answers from the model when KV cannot be read or written", async () => {
    const m = model();
    const broken = {
      get: async () => Promise.reject(new Error("KV down")),
      put: async () => Promise.reject(new Error("KV down")),
    } as unknown as KVNamespace;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: string) => void errors.push(String(line)));
    try {
      const got = await withCache(
        cacheCtx(m.budget, { kv: broken }),
        await keyOf(),
        "muse-spark-1.3",
        3600,
        Verdict,
        m.fn,
      );
      expect(got).toEqual({ value: { verdict: "legit" }, hit: false });
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toMatch(/cache-read-failed[\s\S]*cache-write-failed/);
  });
});
