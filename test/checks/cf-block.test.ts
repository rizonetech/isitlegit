import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type CfDeps,
  type CfResult,
  CLOUDFLARE_DOH_URL,
  CLOUDFLARE_TERMS_CAVEAT,
  checkName,
  cloudflareBlocked,
  MAX_CF_BYTES,
  parseDns,
} from "../../src/checks/cf-block";
import { CACHE_MS } from "../../src/checks/lookup-io";
import { createCase } from "../../src/db/cases";

// D02 T06 §2: Cloudflare's 1.1.1.2 block check over DNS-over-HTTPS, against a stubbed resolver, the real D1 and KV, and a
// clock the test holds.
const db = env.DB;
const T0 = new Date("2026-11-01T08:00:00Z");
// Written out, not imported: a constant changed by mistake must not change what the test expects.
const HOURS = 3_600_000;
const dns = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const BLOCKED = { Status: 0, Answer: [{ name: "evil.example", type: 1, TTL: 60, data: "0.0.0.0" }] };
const RESOLVED = { Status: 0, Answer: [{ name: "fine.example", type: 1, TTL: 60, data: "93.184.216.34" }] };

async function setup(answer: () => Response | Promise<Response>, over: Partial<CfDeps> = {}) {
  const made = await createCase(db, { orgId: `org-${crypto.randomUUID()}`, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let clock = T0.getTime();
  const deps: CfDeps = {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
      return answer();
    }) as typeof fetch,
    cache: env.CACHE,
    db,
    caseId: made.value.id,
    now: () => new Date(clock),
    timeoutMs: 80,
    ...over,
  };
  return {
    deps,
    calls,
    caseId: made.value.id,
    advance: (ms: number) => (clock += ms),
    set: (d: CfDeps) => Object.assign(deps, d),
  };
}
const host = () => `site-${crypto.randomUUID().slice(0, 8)}.example`;
const state = (r: CfResult) => (r.state === "not_checked" ? `not_checked:${r.reason}` : r.state);
const hashOf = async (name: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

beforeEach(async () => {
  await db.prepare("DELETE FROM case_events WHERE step = 'reputation'").run();
});

describe("what is asked of Cloudflare", () => {
  it("is the host name alone, as DNS JSON, with nothing else", async () => {
    const s = await setup(() => dns(RESOLVED));
    await cloudflareBlocked("Fine.Example.", s.deps);
    const url = new URL(s.calls[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(CLOUDFLARE_DOH_URL);
    expect([...url.searchParams.entries()]).toEqual([
      ["name", "fine.example"],
      ["type", "A"],
    ]);
    expect(s.calls[0]?.headers.accept).toBe("application/dns-json");
  });

  it("is nothing for what is not a host name", async () => {
    const s = await setup(() => dns(RESOLVED));
    for (const bad of [
      "",
      "localhost",
      "192.0.2.7",
      "1.2.3.4",
      "bad_name.example",
      "-a.example",
      "a..example",
      `${"a".repeat(64)}.example`,
      "exa mple.com",
      "münchen.example",
      `${"a.".repeat(130)}com`,
    ])
      expect(await cloudflareBlocked(bad, s.deps), JSON.stringify(bad)).toEqual({
        state: "not_checked",
        reason: "invalid_name",
      });
    expect(s.calls).toHaveLength(0);
    expect(checkName("xn--mnchen-3ya.example")).toBe("xn--mnchen-3ya.example");
  });
});

describe("the answers", () => {
  it("reads a block, also behind a CNAME, and an address, no answer and a name that does not exist as clear", async () => {
    const blocked = await setup(() => dns(BLOCKED));
    expect(await cloudflareBlocked(host(), blocked.deps)).toEqual({
      state: "blocked",
      cached: false,
      caveat: CLOUDFLARE_TERMS_CAVEAT,
      obtainedAt: T0.toISOString(),
    });
    const behind = await setup(() =>
      dns({
        Status: 0,
        Answer: [
          { name: "a.example", type: 5, TTL: 60, data: "evil.example." },
          { name: "evil.example", type: 1, TTL: 60, data: "0.0.0.0" },
        ],
      }),
    );
    expect(state(await cloudflareBlocked(host(), behind.deps))).toBe("blocked");
    for (const body of [RESOLVED, { Status: 0 }, { Status: 0, Answer: [] }, { Status: 3 }]) {
      const clear = await setup(() => dns(body));
      expect(await cloudflareBlocked(host(), clear.deps), JSON.stringify(body)).toEqual({
        state: "clear",
        cached: false,
        caveat: CLOUDFLARE_TERMS_CAVEAT,
        obtainedAt: T0.toISOString(),
      });
    }
  });

  it("does not read a truncated answer as clear, caches none, and recovers on a complete one (completion review)", async () => {
    const s = await setup(() => dns({ Status: 0, TC: true, Answer: [] }));
    const name = host();
    expect(state(await cloudflareBlocked(name, s.deps))).toBe("not_checked:unavailable");
    s.set({
      ...s.deps,
      fetch: (async () => dns({ Status: 0, TC: true, Answer: [{ type: 5, data: "x.example." }] })) as typeof fetch,
    });
    expect(state(await cloudflareBlocked(name, s.deps))).toBe("not_checked:unavailable");
    s.set({ ...s.deps, fetch: (async () => dns({ Status: 0, TC: "yes" })) as typeof fetch });
    expect(state(await cloudflareBlocked(name, s.deps))).toBe("not_checked:malformed");
    s.set({ ...s.deps, fetch: (async () => dns({ ...BLOCKED, TC: false })) as typeof fetch });
    expect(await cloudflareBlocked(name, s.deps)).toMatchObject({ state: "blocked", cached: false });
  });

  it("is not checked for a resolver failure, whatever the HTTP says", async () => {
    for (const status of [2, 4, 5])
      expect(state(await cloudflareBlocked(host(), (await setup(() => dns({ Status: status }))).deps))).toBe(
        "not_checked:unavailable",
      );
    const cases: [string, () => Response | Promise<Response>][] = [
      ["not_checked:rate_limited", () => new Response("slow", { status: 429 })],
      ["not_checked:unavailable", () => new Response("down", { status: 503 })],
      ["not_checked:unavailable", () => Promise.reject(new TypeError("network"))],
      ["not_checked:rejected", () => new Response("no", { status: 403 })],
      ["not_checked:rejected", () => new Response("no", { status: 400 })],
      ["not_checked:timeout", () => new Promise<Response>(() => {})],
    ];
    for (const [expected, make] of cases)
      expect(state(await cloudflareBlocked(host(), (await setup(make)).deps))).toBe(expected);
  });

  it("does not read an answer that is not DNS JSON, caches none, and recovers on the next lookup", async () => {
    const s = await setup(() => dns(RESOLVED));
    const name = host();
    const bad: Array<() => Response> = [
      () => new Response("{nope", { status: 200 }),
      () => new Response("", { status: 200 }),
      () => dns([]),
      () => dns("blocked"),
      () => dns({}),
      () => dns({ Status: "0" }),
      () => dns({ Status: 0.5 }),
      () => dns({ Status: 0, Answer: "0.0.0.0" }),
      () => dns({ Status: 0, Answer: [null] }),
      () => dns({ Status: 0, Answer: [{ type: "A", data: "0.0.0.0" }] }),
      () => dns({ Status: 0, Answer: [{ type: 1, data: 0 }] }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"Stat'));
              controller.error(new Error("reset"));
            },
          }),
        ),
    ];
    for (const [n, make] of bad.entries()) {
      s.set({ ...s.deps, fetch: (async () => make()) as typeof fetch });
      expect(state(await cloudflareBlocked(name, s.deps)), String(n)).toBe("not_checked:malformed");
    }
    let calls = 0;
    s.set({
      ...s.deps,
      fetch: (async () => {
        calls++;
        return dns(RESOLVED);
      }) as typeof fetch,
    });
    expect(await cloudflareBlocked(name, s.deps)).toMatchObject({ state: "clear", cached: false });
    expect(calls).toBe(1);
  });

  it("ends a 200 whose body is too large, or stalls, as not checked, cancelled, uncached, and recovers", async () => {
    let cancelled = 0;
    const stalled = () =>
      new Response(
        new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel: () => {
            cancelled++;
          },
        }),
        { status: 200 },
      );
    const big = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_CF_BYTES + 1));
          },
          cancel: () => {
            cancelled++;
          },
        }),
        { status: 200 },
      );
    const s = await setup(stalled);
    const name = host();
    expect(state(await cloudflareBlocked(name, s.deps))).toBe("not_checked:timeout");
    s.set({ ...s.deps, fetch: (async () => big()) as typeof fetch });
    expect(state(await cloudflareBlocked(name, s.deps))).toBe("not_checked:malformed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(2);
    let calls = 0;
    s.set({
      ...s.deps,
      fetch: (async () => {
        calls++;
        return dns(BLOCKED);
      }) as typeof fetch,
    });
    expect(await cloudflareBlocked(name, s.deps)).toMatchObject({ state: "blocked", cached: false });
    expect(calls).toBe(1);
  });
});

describe("the cache", () => {
  it("answers a second lookup without a call", async () => {
    const s = await setup(() => dns(BLOCKED));
    const name = host();
    await cloudflareBlocked(name, s.deps);
    expect(await cloudflareBlocked(name.toUpperCase(), s.deps)).toEqual({
      state: "blocked",
      cached: true,
      caveat: CLOUDFLARE_TERMS_CAVEAT,
      obtainedAt: T0.toISOString(),
    });
    expect(s.calls).toHaveLength(1);
  });

  it("reads a legacy cache entry without a fetched time as obtained when read", async () => {
    const s = await setup(() => dns(BLOCKED));
    const name = host();
    await env.CACHE.put(
      `cfblock:${await hashOf(name)}`,
      JSON.stringify({ v: 1, blocked: true, expiresAt: "2099-01-01T00:00:00Z" }),
    );
    s.advance(60_000);
    expect(await cloudflareBlocked(name, s.deps)).toEqual({
      state: "blocked",
      cached: true,
      caveat: CLOUDFLARE_TERMS_CAVEAT,
      obtainedAt: new Date(T0.getTime() + 60_000).toISOString(),
    });
    expect(s.calls).toHaveLength(0);
  });

  it("ignores an entry whose fetched time is not a time", async () => {
    const s = await setup(() => dns(BLOCKED));
    const name = host();
    await env.CACHE.put(
      `cfblock:${await hashOf(name)}`,
      JSON.stringify({ v: 1, blocked: true, expiresAt: "2099-01-01T00:00:00Z", fetchedAt: "invalid" }),
    );
    expect(await cloudflareBlocked(name, s.deps)).toMatchObject({ state: "blocked", cached: false });
    expect(s.calls).toHaveLength(1);
  });

  it("keeps a block 24 hours and a clear answer six, to the second, with the writer's expiry stored", async () => {
    for (const [body, ttl, expected] of [
      [BLOCKED, 24 * HOURS, "blocked"],
      [RESOLVED, 6 * HOURS, "clear"],
    ] as const) {
      const s = await setup(() => dns(body));
      const name = host();
      await cloudflareBlocked(name, s.deps);
      const stored = (await env.CACHE.get(`cfblock:${await hashOf(name)}`, "json")) as {
        blocked: boolean;
        expiresAt: string;
        fetchedAt: string;
      };
      expect(stored.expiresAt).toBe(new Date(T0.getTime() + ttl).toISOString());
      expect(stored.fetchedAt).toBe(T0.toISOString());
      expect(stored.blocked).toBe(expected === "blocked");
      s.advance(ttl - 1_000);
      expect(await cloudflareBlocked(name, s.deps), expected).toMatchObject({ state: expected, cached: true });
      s.advance(2_000);
      expect(await cloudflareBlocked(name, s.deps), expected).toMatchObject({ state: expected, cached: false });
      expect(s.calls).toHaveLength(2);
    }
  });

  it("is bounded: a read that stalls or fails reaches Cloudflare, a write that stalls or fails keeps the answer", async () => {
    const kv = (over: Partial<KVNamespace>) =>
      new Proxy(env.CACHE, {
        get: (t, k) => {
          if (k in over) return (over as never)[k];
          const value = Reflect.get(t, k, t);
          return typeof value === "function" ? value.bind(t) : value;
        },
      }) as KVNamespace;
    const stall = () => new Promise<never>(() => {});
    const reject = () => Promise.reject(new Error("kv down"));
    for (const [name, cache] of [
      ["read stalls", kv({ get: stall as never })],
      ["read rejects", kv({ get: reject as never })],
      ["write stalls", kv({ put: stall as never })],
      ["write rejects", kv({ put: reject as never })],
    ] as const) {
      const s = await setup(() => dns(RESOLVED), { cache });
      const began = Date.now();
      expect(await cloudflareBlocked(host(), s.deps), name).toMatchObject({ state: "clear", cached: false });
      expect(s.calls, name).toHaveLength(1);
      expect(Date.now() - began, name).toBeLessThan(CACHE_MS * 3);
    }
  });
});

describe("the log", () => {
  it("records each lookup by the name's hash under step reputation, never the name", async () => {
    const s = await setup(() => dns(BLOCKED));
    await cloudflareBlocked("secret-brand.example", s.deps);
    s.set({ ...s.deps, fetch: (async () => dns(RESOLVED)) as typeof fetch });
    await cloudflareBlocked("other-brand.example", s.deps);
    s.set({ ...s.deps, fetch: (async () => new Response("down", { status: 503 })) as typeof fetch });
    await cloudflareBlocked("third-brand.example", s.deps);
    const rows = (
      await db
        .prepare("SELECT status, ms, error FROM case_events WHERE case_id = ? AND step = 'reputation' ORDER BY id")
        .bind(s.caseId)
        .all<{ status: string; ms: number | null; error: string | null }>()
    ).results;
    expect(rows.map((e) => [e.status, e.error?.replace(/:[0-9a-f]{12}$/, ":HASH")])).toEqual([
      ["done", "cloudflare:blocked:HASH"],
      ["done", "cloudflare:clear:HASH"],
      ["error", "cloudflare:not_checked:HASH"],
    ]);
    expect(rows[0]?.error?.endsWith((await hashOf("secret-brand.example")).slice(0, 12))).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/brand|secret|example/);
  });

  it("throws when the audit write fails, after the answer is cached, so the retry costs no lookup", async () => {
    const failing = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (/INSERT INTO case_events/.test(sql)) throw new Error("D1 down");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const s = await setup(() => dns(RESOLVED));
    const name = host();
    await expect(cloudflareBlocked(name, { ...s.deps, db: failing })).rejects.toThrow("recording reputation: database");
    expect(s.calls).toHaveLength(1);
    expect(await cloudflareBlocked(name, s.deps)).toMatchObject({ state: "clear", cached: true });
    expect(s.calls).toHaveLength(1);
  });
});

describe("parseDns", () => {
  it("accepts only DNS JSON", () => {
    expect(parseDns(JSON.stringify(BLOCKED))).toBe("blocked");
    expect(parseDns('{"Status":0,"Answer":[{"type":1,"data":"0.0.0.1"}]}')).toBe("clear");
    expect(parseDns('{"Status":3}')).toBe("clear");
    expect(parseDns('{"Status":2}')).toBe("unavailable");
    for (const text of ["", "null", "[]", "{}", '{"Status":"0"}']) expect(parseDns(text), text).toBeNull();
  });
});
