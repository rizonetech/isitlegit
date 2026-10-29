// The result cache by artefact hash (D03 T01 §4; the stack doc's "model results by artefact hash", eventual consistency
// accepted, and the design spec's risk table: cache by artefact hash against credit burn): the same screenshot, PDF or
// URL seen again is answered from KV (`CACHE`) once its answer is cached. A result is kept under a hash of every input
// that can change it, derived here from those inputs; only a whole answer that passes its schema is kept, and it passes
// the schema again when read (AGENTS.md: every model output is validated before use). A hit leaves the call's record
// costing nothing (D03 T01 §3), and is never reserved, so it is served when a cap is exhausted. The cache never fails a
// call: an unreadable entry is a miss, an unwritten one is logged.
import type { z } from "zod";
import { ModelError } from "./client.ts";
import type { Budget, Call, Owner } from "./guard.ts";
import type { ModelId } from "./models.ts";

// KV keeps an entry at least 60 seconds (its least `expirationTtl`); a cached reading can hold a message's extracted
// text, so no entry is kept longer than a week, and a deleted case's entries outlive it by at most that (D07 T02 §9's
// purge covers D1 and R2; this bound is the cache's).
export const MIN_CACHE_TTL_SECONDS = 60;
export const MAX_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

// Every input that can change the answer: the task, the model, the prompt's and the schema's versions, each artefact's
// SHA-256 in the order sent (a reference image is an artefact too; at least one), and the request's other inputs
// (visible text, a SAM concept, options) as plain JSON values.
export type CacheInputs = {
  task: string;
  model: ModelId;
  promptVersion: string;
  schemaVersion: string;
  artefacts: readonly string[];
  params?: Json;
};
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_DEPTH = 32;

// Canonical JSON: object keys sorted at every depth, so the same inputs written in another order hash the same. Only
// plain JSON is accepted (final review): a Date, Map, Set, BigInt, undefined, NaN, an infinity, a class instance or a
// cycle would otherwise hash as something else, or crash, and two different requests could share a key.
function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new TypeError("cache params nest too deep (or hold a cycle)");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cache params hold a number JSON cannot carry");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError("cache params hold a value that is not plain JSON");
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k], depth + 1)}`)
      .join(",")}}`;
  }
  throw new TypeError(`cache params hold a ${typeof value}, which is not JSON`);
}

export async function cacheKey(inputs: CacheInputs): Promise<string> {
  if (inputs.artefacts.length === 0) throw new TypeError("an artefact cache needs at least one artefact's SHA-256");
  for (const sha of inputs.artefacts)
    if (!SHA256.test(sha)) throw new TypeError("an artefact is named by its SHA-256, in lowercase hex");
  const text = canonical({
    v: 1,
    task: inputs.task,
    model: inputs.model,
    promptVersion: inputs.promptVersion,
    schemaVersion: inputs.schemaVersion,
    artefacts: [...inputs.artefacts],
    params: inputs.params ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `meta:v1:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type CacheContext = {
  kv: KVNamespace;
  budget: Budget;
  owner: Owner;
  // Keeps a write that outlives its wait alive: a Workflow step's or a request's own waitUntil. Required, so a late
  // write is never dropped when the invocation ends (final review).
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  // How long each storage wait (the KV read, the KV write, the hit's record) may hold the call (default STORAGE_WAIT_MS).
  storageWaitMs?: number;
};

// A storage wait is bounded (D03 T01 §4 completion review): a stalled KV or D1 never keeps the model's call from
// starting, nor an answer already in hand from its caller. A read past it is a miss; a write past it goes on, kept alive
// by `waitUntil`, and is logged.
export const STORAGE_WAIT_MS = 1_000;

async function bounded<T>(work: Promise<T>, ms: number, late: T, ctx: CacheContext): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  const settled = await Promise.race([work, expired]).finally(() => clearTimeout(timer));
  if (settled !== "late") return settled;
  ctx.waitUntil(work.catch(() => {}));
  return late;
}

// A store call that throws at once (a missing binding, a refused argument) is a failed call like any other.
const attempt = <T>(work: () => Promise<T>) => Promise.resolve().then(work);

// What `fn` returns: the model's output, validated here against the schema, and whether it is whole (a partial result
// is used but never kept).
export type Fresh = { value: unknown; partial?: boolean };

type Entry = { expiresAt: number; value: unknown };

export async function withCache<S extends z.ZodType>(
  ctx: CacheContext,
  inputs: CacheInputs,
  ttlSeconds: number,
  schema: S,
  fn: () => Promise<Fresh>,
): Promise<{ value: z.infer<S>; hit: boolean }> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_CACHE_TTL_SECONDS || ttlSeconds > MAX_CACHE_TTL_SECONDS)
    throw new RangeError(
      `a cache entry lives ${MIN_CACHE_TTL_SECONDS} to ${MAX_CACHE_TTL_SECONDS} whole seconds, not ${ttlSeconds}`,
    );
  // The key comes from the inputs, never from the caller: it is a hash, never content, and it names the model the
  // hit's record is written for.
  const key = await cacheKey(inputs);
  const now = ctx.now ?? Date.now;
  const started = performance.now();
  const wait = ctx.storageWaitMs ?? STORAGE_WAIT_MS;
  const stored = await bounded(
    attempt(() => ctx.kv.get<Entry>(key, "json")).catch(() => {
      log("cache-read-failed");
      return null;
    }),
    wait,
    undefined,
    ctx,
  );
  if (stored === undefined) log("cache-read-late");
  // Served only while it stays within its expiry through the hit's record wait, so it is never returned past it.
  if (stored && typeof stored.expiresAt === "number" && stored.expiresAt > now() + wait) {
    const parsed = schema.safeParse(stored.value);
    if (parsed.success) {
      const call: Call = { callId: crypto.randomUUID(), owner: ctx.owner };
      // Served whether or not its record is written: it cost nothing, and it never becomes a paid call.
      const recorded = attempt(() => ctx.budget.cached(inputs.model, call, performance.now() - started)).then(
        () => true,
        () => (log("cache-hit-unrecorded"), true),
      );
      if (!(await bounded(recorded, wait, false, ctx))) log("cache-hit-record-late");
      return { value: parsed.data, hit: true };
    }
  }
  const fresh = await fn();
  const parsed = schema.safeParse(fresh.value);
  // A model output that fails its schema is never used, nor kept.
  if (!parsed.success) throw new ModelError("malformed", "Meta's answer did not match its schema");
  if (!fresh.partial) {
    const entry: Entry = { expiresAt: now() + ttlSeconds * 1000, value: parsed.data };
    const written = attempt(() => ctx.kv.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds })).then(
      () => true,
      () => (log("cache-write-failed"), true),
    );
    if (!(await bounded(written, wait, false, ctx))) log("cache-write-late");
  }
  return { value: parsed.data, hit: false };
}

const log = (outcome: string) => console.error(JSON.stringify({ event: "meta-cache", outcome }));
