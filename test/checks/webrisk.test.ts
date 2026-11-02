import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { WEB_RISK_GLOBAL_DAILY, WEB_RISK_ORG_DAILY } from "../../src/checks/caps";
import { CACHE_MS } from "../../src/checks/lookup-io";
import {
  parseAnswer,
  stripUrl,
  WEB_RISK_URL,
  type WebRiskDeps,
  type WebRiskResult,
  webRiskSearch,
} from "../../src/checks/webrisk";
import { createCase } from "../../src/db/cases";

// D02 T06 §1: the Web Risk lookup (spec 4.3a), against a stubbed provider, the real D1 and KV, and a clock the test holds.
const db = env.DB;
// Each test starts with no count of the day, so one that fails midway cannot cap the next.
beforeEach(async () => {
  await db.prepare("DELETE FROM reputation_calls").run();
});
const KEY = "AIza-test-key-not-a-secret";
const T0 = new Date("2026-11-01T08:00:00Z");
// Written out, not imported: a constant changed by mistake must not change what the test expects.
const HOURS = 3_600_000;
const JSON_OK = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const listing = (expireTime: string, threatTypes: string[] = ["SOCIAL_ENGINEERING"]) =>
  JSON_OK({ threat: { threatTypes, expireTime } });

async function newCase(): Promise<{ caseId: string; orgId: string }> {
  const orgId = `org-${crypto.randomUUID()}`;
  const made = await createCase(db, { orgId, channel: "email", headersAvailable: true });
  if (!made.ok) throw new Error(made.error.message);
  return { caseId: made.value.id, orgId };
}

// A provider that answers with `answer` and keeps the requests it was sent.
function provider(answer: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
    return answer();
  }) as typeof fetch;
  return { fetcher, calls };
}

async function setup(answer: () => Response | Promise<Response>, over: Partial<WebRiskDeps> = {}) {
  const ids = await newCase();
  const p = provider(answer);
  let clock = T0.getTime();
  const deps: WebRiskDeps = {
    fetch: p.fetcher,
    cache: env.CACHE,
    db,
    key: KEY,
    now: () => new Date(clock),
    timeoutMs: 80,
    ...ids,
    ...over,
  };
  return {
    deps,
    calls: p.calls,
    ...ids,
    advance: (ms: number) => (clock += ms),
    set: (d: WebRiskDeps) => Object.assign(deps, d),
  };
}
const unique = () => `https://phish-${crypto.randomUUID().slice(0, 8)}.example/login`;
const count = async (scope: string, day = "2026-11-01") =>
  (
    await db
      .prepare("SELECT calls FROM reputation_calls WHERE day = ? AND scope = ?")
      .bind(day, scope)
      .first<{ calls: number }>()
  )?.calls ?? 0;
const events = async (caseId: string) =>
  (
    await db.prepare("SELECT step, status, ms, error FROM case_events WHERE case_id = ? ORDER BY id").bind(caseId).all<{
      step: string;
      status: string;
      ms: number | null;
      error: string | null;
    }>()
  ).results;
const state = (r: WebRiskResult) => (r.state === "not_checked" ? `not_checked:${r.reason}` : r.state);

describe("what is asked of Web Risk", () => {
  it("is the URL's scheme, host, port and path only, with the key in a header", async () => {
    const s = await setup(() => JSON_OK({}));
    await webRiskSearch("https://user:hunter2@Bank.example:8443/pay/now?acct=12345&token=abc#section", s.deps);
    const request = s.calls[0];
    const url = new URL(request?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(WEB_RISK_URL);
    expect(url.searchParams.get("uri")).toBe("https://bank.example:8443/pay/now");
    expect(url.searchParams.getAll("threatTypes")).toEqual(["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]);
    expect(request?.url).not.toMatch(/hunter2|acct|token|abc|section|AIza|key=/);
    expect(request?.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("is nothing for what is not an http or https URL, or is too long, or has no key", async () => {
    const s = await setup(() => JSON_OK({}));
    for (const bad of [
      "mailto:a@b.example",
      "javascript:alert(1)",
      "not a url",
      "ftp://x.example/a",
      `https://x.example/${"a".repeat(2_100)}`,
    ])
      expect(await webRiskSearch(bad, s.deps), bad).toEqual({ state: "not_checked", reason: "invalid_url" });
    expect(stripUrl("https://x.example")).toBe("https://x.example/");
    const keyless = await setup(() => JSON_OK({}), { key: null });
    expect(await webRiskSearch(unique(), keyless.deps)).toEqual({ state: "not_checked", reason: "no_key" });
    expect(s.calls).toHaveLength(0);
    expect(keyless.calls).toHaveLength(0);
  });
});

describe("the answers", () => {
  it("reads a listing with its threat types, and no listing", async () => {
    const hour = new Date(T0.getTime() + 3_600_000).toISOString();
    const s = await setup(() => listing(hour, ["MALWARE", "SOCIAL_ENGINEERING", "MALWARE"]));
    expect(await webRiskSearch(unique(), s.deps)).toEqual({
      state: "listed",
      threatTypes: ["MALWARE", "SOCIAL_ENGINEERING"],
      expiresAt: hour,
      cached: false,
      obtainedAt: T0.toISOString(),
    });
    const clean = await setup(() => JSON_OK({}));
    expect(await webRiskSearch(unique(), clean.deps)).toEqual({
      state: "not_listed",
      cached: false,
      obtainedAt: T0.toISOString(),
    });
  });

  it("does not read an answer it cannot validate as not listed, caches none, and recovers on the next lookup", async () => {
    const s = await setup(() => JSON_OK({}));
    const url = unique();
    const hour = new Date(T0.getTime() + 3_600_000).toISOString();
    const bad: Array<() => Response> = [
      () => new Response("{not json", { status: 200 }),
      () => new Response("", { status: 200 }),
      () => JSON_OK([]),
      () => JSON_OK("listed"),
      () => JSON_OK({ threat: "yes" }),
      () => JSON_OK({ threat: {} }),
      () => JSON_OK({ threat: { threatTypes: [], expireTime: hour } }),
      () => JSON_OK({ threat: { threatTypes: ["BORING"], expireTime: hour } }),
      () => JSON_OK({ threat: { threatTypes: ["MALWARE"] } }),
      () => JSON_OK({ threat: { threatTypes: ["MALWARE"], expireTime: "tomorrow" } }),
      () => JSON_OK({ something: "else" }),
      () => new Response("x".repeat(70_000), { status: 200 }),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"thre'));
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 200 },
        ),
    ];
    for (const [n, make] of bad.entries()) {
      s.set({ ...s.deps, fetch: provider(make).fetcher });
      expect(state(await webRiskSearch(url, s.deps)), String(n)).toBe("not_checked:malformed");
    }
    // None was cached: a good answer is asked for, then recovers.
    const good = provider(() => JSON_OK({}));
    s.set({ ...s.deps, fetch: good.fetcher });
    expect(await webRiskSearch(url, s.deps)).toEqual({
      state: "not_listed",
      cached: false,
      obtainedAt: T0.toISOString(),
    });
    expect(good.calls).toHaveLength(1);
  });

  it("is never not listed for an outage, a rate limit, a rejection or a stall", async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ["not_checked:unavailable", () => new Response("down", { status: 503 })],
      ["not_checked:unavailable", () => new Response("down", { status: 500 })],
      ["not_checked:unavailable", () => Promise.reject(new TypeError("network"))],
      ["not_checked:rate_limited", () => new Response("slow down", { status: 429 })],
      ["not_checked:rejected", () => new Response("bad key", { status: 403 })],
      ["not_checked:rejected", () => new Response("bad request", { status: 400 })],
      ["not_checked:timeout", () => new Promise<Response>(() => {})],
    ];
    for (const [expected, make] of cases) {
      const s = await setup(make);
      expect(state(await webRiskSearch(unique(), s.deps))).toBe(expected);
    }
  });
});

describe("an error answer", () => {
  it("is let go of, not left open: its body is cancelled and the request aborted when the lookup ends (round 1)", async () => {
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled = true;
      },
    });
    const s = await setup(() => new Response(body, { status: 503 }));
    s.set({
      ...s.deps,
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Response(body, { status: 503 });
      }) as typeof fetch,
    });
    expect(state(await webRiskSearch(unique(), s.deps))).toBe("not_checked:unavailable");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});

describe("the cache", () => {
  it("answers a second lookup without a call", async () => {
    const hour = new Date(T0.getTime() + 3_600_000).toISOString();
    const s = await setup(() => listing(hour));
    const url = unique();
    await webRiskSearch(url, s.deps);
    const second = await webRiskSearch(`${url}?another=query#fragment`, s.deps);
    expect(second).toMatchObject({ state: "listed", cached: true });
    expect(s.calls).toHaveLength(1);
  });

  it("keeps a listing until the earlier of Google's expiry and 24 hours, and looks it up again past that", async () => {
    // Google says it expires in an hour: asked again after an hour, not kept a day.
    const soon = await setup(() => listing(new Date(T0.getTime() + 3_600_000).toISOString()));
    const url = unique();
    await webRiskSearch(url, soon.deps);
    soon.advance(3_599_000);
    expect(await webRiskSearch(url, soon.deps)).toMatchObject({ cached: true });
    soon.advance(2_000);
    expect(await webRiskSearch(url, soon.deps)).toMatchObject({ cached: false });
    expect(soon.calls).toHaveLength(2);
    // Google says three days: kept 24 hours.
    const far = await setup(() => listing(new Date(T0.getTime() + 3 * 86_400_000).toISOString()));
    const longUrl = unique();
    const first = await webRiskSearch(longUrl, far.deps);
    expect(first).toMatchObject({ state: "listed", expiresAt: new Date(T0.getTime() + 24 * HOURS).toISOString() });
    far.advance(24 * HOURS - 1_000);
    expect(await webRiskSearch(longUrl, far.deps)).toMatchObject({ cached: true });
    far.advance(2_000);
    expect(await webRiskSearch(longUrl, far.deps)).toMatchObject({ cached: false });
  });

  it("keeps no listing at all that expires within the minute KV cannot keep", async () => {
    const s = await setup(() => listing(new Date(T0.getTime() + 30_000).toISOString()));
    const url = unique();
    await webRiskSearch(url, s.deps);
    await webRiskSearch(url, s.deps);
    expect(s.calls).toHaveLength(2);
  });

  it("keeps a not-listed answer six hours, to the second", async () => {
    const s = await setup(() => JSON_OK({}));
    const url = unique();
    await webRiskSearch(url, s.deps);
    s.advance(6 * HOURS - 1_000);
    expect(await webRiskSearch(url, s.deps)).toEqual({
      state: "not_listed",
      cached: true,
      obtainedAt: T0.toISOString(),
    });
    s.advance(2_000);
    expect(await webRiskSearch(url, s.deps)).toEqual({
      state: "not_listed",
      cached: false,
      obtainedAt: new Date(T0.getTime() + 6 * HOURS + 1_000).toISOString(),
    });
    expect(s.calls).toHaveLength(2);
  });

  it("reads a legacy cache entry without a fetched time as obtained when read", async () => {
    const s = await setup(() => JSON_OK({}));
    const url = unique();
    const stripped = stripUrl(url) as string;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stripped));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.CACHE.put(
      `webrisk:${hash}`,
      JSON.stringify({ v: 1, listed: false, threatTypes: [], expiresAt: "2099-01-01T00:00:00Z" }),
    );
    s.advance(60_000);
    expect(await webRiskSearch(url, s.deps)).toEqual({
      state: "not_listed",
      cached: true,
      obtainedAt: new Date(T0.getTime() + 60_000).toISOString(),
    });
    expect(s.calls).toHaveLength(0);
  });

  it("ignores an entry it does not understand", async () => {
    const s = await setup(() => JSON_OK({}));
    const url = unique();
    const stripped = stripUrl(url) as string;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stripped));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await env.CACHE.put(
      `webrisk:${hash}`,
      JSON.stringify({ v: 1, listed: true, threatTypes: [], expiresAt: "2099-01-01T00:00:00Z" }),
    );
    expect(await webRiskSearch(url, s.deps)).toEqual({
      state: "not_listed",
      cached: false,
      obtainedAt: T0.toISOString(),
    });
  });

  it("is bounded: a read that stalls or fails reaches the provider, a write that stalls or fails keeps the answer", async () => {
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
      const s = await setup(() => JSON_OK({}), { cache });
      const began = Date.now();
      const result = await webRiskSearch(unique(), s.deps);
      expect(result, name).toEqual({ state: "not_listed", cached: false, obtainedAt: T0.toISOString() });
      expect(s.calls, name).toHaveLength(1);
      expect(Date.now() - began, name).toBeLessThan(CACHE_MS * 3);
    }
  });
});

describe("the caps", () => {
  it("refuses the organisation's 501st lookup of the day, and a new day starts at zero", async () => {
    const s = await setup(() => JSON_OK({}));
    await db
      .prepare("INSERT INTO reputation_calls (day, scope, calls) VALUES ('2026-11-01', ?, ?)")
      .bind(`webrisk:${s.orgId}`, WEB_RISK_ORG_DAILY - 1)
      .run();
    expect(await webRiskSearch(unique(), s.deps)).toMatchObject({ state: "not_listed" });
    expect(await webRiskSearch(unique(), s.deps)).toEqual({ state: "capped", scope: "organisation" });
    expect(s.calls).toHaveLength(1);
    expect(await count(`webrisk:${s.orgId}`)).toBe(WEB_RISK_ORG_DAILY);
    s.advance(86_400_000);
    expect(await webRiskSearch(unique(), s.deps)).toMatchObject({ state: "not_listed" });
    expect(await count(`webrisk:${s.orgId}`, "2026-11-02")).toBe(1);
  });

  it("refuses past the global cap for any organisation, and gives the organisation's place back", async () => {
    const s = await setup(() => JSON_OK({}));
    await db
      .prepare("INSERT OR REPLACE INTO reputation_calls (day, scope, calls) VALUES ('2026-11-01', 'webrisk:*', ?)")
      .bind(WEB_RISK_GLOBAL_DAILY)
      .run();
    expect(await webRiskSearch(unique(), s.deps)).toEqual({ state: "capped", scope: "global" });
    expect(s.calls).toHaveLength(0);
    expect(await count(`webrisk:${s.orgId}`)).toBe(0);
    expect(await count("webrisk:*")).toBe(WEB_RISK_GLOBAL_DAILY);
    await db.prepare("DELETE FROM reputation_calls WHERE day = '2026-11-01' AND scope = 'webrisk:*'").run();
  });

  it("lets only one of several lookups racing for the last place of a cap take it", async () => {
    const s = await setup(() => JSON_OK({}));
    await db
      .prepare("INSERT INTO reputation_calls (day, scope, calls) VALUES ('2026-11-01', ?, ?)")
      .bind(`webrisk:${s.orgId}`, WEB_RISK_ORG_DAILY - 1)
      .run();
    const results = await Promise.all([unique(), unique(), unique(), unique()].map((u) => webRiskSearch(u, s.deps)));
    expect(results.filter((r) => r.state === "not_listed")).toHaveLength(1);
    expect(results.filter((r) => r.state === "capped")).toHaveLength(3);
    expect(s.calls).toHaveLength(1);
    expect(await count(`webrisk:${s.orgId}`)).toBe(WEB_RISK_ORG_DAILY);
  });

  it("costs a cached answer nothing", async () => {
    const s = await setup(() => JSON_OK({}));
    const url = unique();
    await webRiskSearch(url, s.deps);
    await webRiskSearch(url, s.deps);
    expect(await count(`webrisk:${s.orgId}`)).toBe(1);
  });
});

describe("D1 failing", () => {
  const failing = (match: RegExp) =>
    new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (match.test(sql)) throw new Error("D1 down");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;

  it("makes no request when a place cannot be taken, and counts nothing", async () => {
    const s = await setup(() => JSON_OK({}));
    expect(await webRiskSearch(unique(), { ...s.deps, db: failing(/INSERT INTO reputation_calls/) })).toEqual({
      state: "not_checked",
      reason: "counting",
    });
    expect(s.calls).toHaveLength(0);
  });

  it("leaves a place it could not give back counted", async () => {
    const s = await setup(() => JSON_OK({}));
    await db
      .prepare("INSERT OR REPLACE INTO reputation_calls (day, scope, calls) VALUES ('2026-11-01', 'webrisk:*', ?)")
      .bind(WEB_RISK_GLOBAL_DAILY)
      .run();
    const deps = { ...s.deps, db: failing(/UPDATE reputation_calls/) };
    expect(await webRiskSearch(unique(), deps)).toEqual({ state: "capped", scope: "global" });
    expect(await count(`webrisk:${s.orgId}`)).toBe(1);
    await db.prepare("DELETE FROM reputation_calls WHERE day = '2026-11-01' AND scope = 'webrisk:*'").run();
  });

  it("throws when the audit write fails, after the answer is cached, so the retry costs no lookup", async () => {
    const s = await setup(() => JSON_OK({}));
    const url = unique();
    await expect(webRiskSearch(url, { ...s.deps, db: failing(/INSERT INTO case_events/) })).rejects.toThrow(
      "recording reputation: database",
    );
    expect(s.calls).toHaveLength(1);
    expect(await webRiskSearch(url, s.deps)).toEqual({
      state: "not_listed",
      cached: true,
      obtainedAt: T0.toISOString(),
    });
    expect(s.calls).toHaveLength(1);
  });
});

describe("the log", () => {
  it("records each lookup under step reputation by the stripped URL's hash, never the URL or the key", async () => {
    const s = await setup(() => JSON_OK({}));
    const hour = new Date(T0.getTime() + 3_600_000).toISOString();
    const url = "https://secret-host.example/private/path?token=abc";
    await webRiskSearch(url, s.deps);
    s.set({ ...s.deps, fetch: provider(() => listing(hour)).fetcher });
    await webRiskSearch("https://other-host.example/a", s.deps);
    s.set({ ...s.deps, fetch: provider(() => new Response("down", { status: 503 })).fetcher });
    await webRiskSearch("https://third-host.example/c", s.deps);
    await db
      .prepare("INSERT OR REPLACE INTO reputation_calls (day, scope, calls) VALUES ('2026-11-01', ?, ?)")
      .bind(`webrisk:${s.orgId}`, WEB_RISK_ORG_DAILY)
      .run();
    await webRiskSearch("https://fourth-host.example/d", s.deps);
    const rows = (await events(s.caseId)).filter((e) => e.step === "reputation");
    expect(rows.map((e) => [e.status, e.error?.replace(/:[0-9a-f]{12}$/, ":HASH")])).toEqual([
      ["done", "webrisk:not_listed:HASH"],
      ["done", "webrisk:listed:HASH"],
      ["error", "webrisk:not_checked:HASH"],
      ["done", "webrisk:capped:HASH"],
    ]);
    expect(rows.every((e) => typeof e.ms === "number")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/secret-host|private|token|other-host|AIza/);
  });
});

describe("the log's identity", () => {
  it("is kept only in its own shape: a URL or a longer hash is recorded as a plain Error", async () => {
    const { recordEvent } = await import("../../src/pipeline/events");
    const { caseId } = await newCase();
    for (const bad of [
      "webrisk:listed:https://bank.example/pay",
      "webrisk:listed:0123456789abcdef",
      "webrisk:maybe:0123456789ab",
    ]) {
      const recorded = await recordEvent(db, caseId, "reputation", "done", { errorClass: bad });
      expect(recorded.ok && recorded.value.error, bad).toBe("Error");
    }
    const good = await recordEvent(db, caseId, "reputation", "done", { errorClass: "webrisk:listed:0123456789ab" });
    expect(good.ok && good.value.error).toBe("webrisk:listed:0123456789ab");
  });
});

describe("parseAnswer", () => {
  it("accepts only the shapes Google documents", () => {
    expect(parseAnswer("{}")).toEqual({ listed: false });
    expect(parseAnswer('{"threat":{"threatTypes":["MALWARE"],"expireTime":"2026-11-02T00:00:00Z"}}')).toEqual({
      listed: true,
      threatTypes: ["MALWARE"],
      expireTime: Date.parse("2026-11-02T00:00:00Z"),
    });
    for (const text of ["", "null", "[]", '{"threat":null}', '{"threat":[]}', '{"x":1}'])
      expect(parseAnswer(text), text).toBeNull();
  });
});
