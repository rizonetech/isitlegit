// The result cache by artefact hash (D03 T01 §4; spec section 8, budget): the same screenshot, PDF or URL seen twice
// does not cost twice. A result is kept in KV (`CACHE`) under a hash of every input that can change it; only a whole
// answer that passes its schema is kept, and it passes the schema again when read (AGENTS.md: every model output is
// validated before use). A hit leaves the call's record costing nothing (D03 T01 §3), and is never reserved, so it is
// served when a cap is exhausted. The cache never fails a call: an unreadable entry is a miss, an unwritten one is logged.
import type { z } from "zod";
import { ModelError } from "./client";
import type { Budget, Call, Owner } from "./guard";
import type { ModelId } from "./models";

// KV keeps an entry at least 60 seconds (its least `expirationTtl`); a cached reading can hold a message's extracted
// text, so no entry is kept longer than a week, and a deleted case's entries outlive it by at most that (D07 T02 §9's
// purge covers D1 and R2; this bound is the cache's).
export const MIN_CACHE_TTL_SECONDS = 60;
export const MAX_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Every input that can change the answer: the task, the model, the prompt's and the schema's versions, each artefact's
// SHA-256 in the order sent (a reference image is an artefact too), and the request's other inputs (visible text, a SAM
// concept, options).
export type CacheInputs = {
  task: string;
  model: ModelId;
  promptVersion: string;
  schemaVersion: string;
  artefacts: readonly string[];
  params?: unknown;
};

const SHA256 = /^[0-9a-f]{64}$/;

// Canonical JSON: object keys sorted at every depth, so the same inputs written in another order hash the same.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export async function cacheKey(inputs: CacheInputs): Promise<string> {
  for (const sha of inputs.artefacts)
    if (!SHA256.test(sha)) throw new Error("an artefact is named by its SHA-256, in lowercase hex");
  const text = canonical({ v: 1, ...inputs, params: inputs.params ?? null });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `meta:v1:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type CacheContext = {
  kv: KVNamespace;
  budget: Budget;
  owner: Owner;
  now?: () => number;
};

// What `fn` returns: the model's output, validated here against the schema, and whether it is whole (a partial result
// is used but never kept).
export type Fresh = { value: unknown; partial?: boolean };

type Entry = { expiresAt: number; value: unknown };

export async function withCache<S extends z.ZodType>(
  ctx: CacheContext,
  key: string,
  model: ModelId,
  ttlSeconds: number,
  schema: S,
  fn: () => Promise<Fresh>,
): Promise<{ value: z.infer<S>; hit: boolean }> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_CACHE_TTL_SECONDS || ttlSeconds > MAX_CACHE_TTL_SECONDS)
    throw new RangeError(
      `a cache entry lives ${MIN_CACHE_TTL_SECONDS} to ${MAX_CACHE_TTL_SECONDS} whole seconds, not ${ttlSeconds}`,
    );
  const now = ctx.now ?? Date.now;
  const started = performance.now();
  const stored = await ctx.kv.get<Entry>(key, "json").catch(() => {
    log("cache-read-failed");
    return null;
  });
  if (stored && typeof stored.expiresAt === "number" && stored.expiresAt > now()) {
    const parsed = schema.safeParse(stored.value);
    if (parsed.success) {
      const call: Call = { callId: crypto.randomUUID(), owner: ctx.owner };
      // Served whether or not its record is written: it cost nothing, and it never becomes a paid call.
      await ctx.budget.cached(model, call, performance.now() - started).catch(() => log("cache-hit-unrecorded"));
      return { value: parsed.data, hit: true };
    }
  }
  const fresh = await fn();
  const parsed = schema.safeParse(fresh.value);
  // A model output that fails its schema is never used, nor kept.
  if (!parsed.success) throw new ModelError("malformed", "Meta's answer did not match its schema");
  if (!fresh.partial) {
    const entry: Entry = { expiresAt: now() + ttlSeconds * 1000, value: parsed.data };
    await ctx.kv.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds }).catch(() => log("cache-write-failed"));
  }
  return { value: parsed.data, hit: false };
}

const log = (outcome: string) => console.error(JSON.stringify({ event: "meta-cache", outcome }));
