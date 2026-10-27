import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_ID,
  interrupted,
  newProgress,
  type Options,
  parseConfigArgs,
  restore,
  Snapshot,
  type SnapshotData,
  snapshot,
} from "../../scripts/gateway-config.ts";

// scripts/gateway-config.ts (D00 T01 §11) against a stand-in for Cloudflare's AI Gateway API that keeps state and
// records every request: snapshot writes the account whole or leaves the old file, and restore puts it back without
// ever deleting, says what it would do without doing it, names what a failure left behind, and checks the result.
const DIR = join(import.meta.dirname, `../../build/test-gateway-config-${process.pid}`);
const FILE = join(DIR, "ai-gateway.json");
const TOKEN = `cf-${"t".repeat(37)}`;
const STAND_IN = "https://stand-in.test/client/v4";
const BASE = `${STAND_IN}/accounts/${ACCOUNT_ID}/ai-gateway`;
beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

type Raw = Record<string, unknown>;
// The account as Cloudflare answered on 2026-10-27, trimmed: a pricing rule's token_pricing comes back as a string.
const gateway = (): Raw => ({
  id: "isitlegit",
  created_at: "2026-10-27 08:15:32",
  modified_at: "2026-10-27 14:02:10",
  authentication: true,
  cache_invalidate_on_update: false,
  cache_ttl: 0,
  collect_logs: false,
  log_management: 10_000_000,
  log_management_strategy: "DELETE_OLDEST",
  logpush: false,
  logpush_public_key: null,
  rate_limiting_interval: 0,
  rate_limiting_limit: 0,
  rate_limiting_technique: "fixed",
  retry_backoff: null,
  store_id: "",
  wholesale: true,
  zdr: false,
});
const provider = (id = "prov-1"): Raw => ({
  id,
  account_tag: ACCOUNT_ID,
  name: "Meta Model API",
  slug: "meta",
  position: 0,
  enable: true,
  logo: "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
  description: "IsItLegit (D00 T01 §6)",
  link: "https://dev.meta.ai/docs/overview",
  curl_example: null,
  js_example: null,
  beta: false,
  created_at: 1793088934143,
  base_url: "https://api.meta.ai",
  headers: null,
});
const rule = (
  id: string,
  model: string,
  input: number,
  cached: number,
  output: number,
  providerId = "prov-1",
): Raw => ({
  id,
  enable: true,
  account_provider_id: providerId,
  model_rule: "equals",
  model,
  cost_type: "tokens",
  cost_in: input / 1e6,
  cost_out: output / 1e6,
  token_pricing: JSON.stringify({ input_tokens: input, output_tokens: output, input_cached_tokens: cached }),
});
const rules = () => [
  rule("r-spark", "muse-spark-1.3", 1.25, 0.15, 4.25),
  rule("r-wonder", "muse-wonder-1.0", 4, 0.2, 20),
];

type Request = { method: string; path: string; body: Raw | undefined };
// A fault decides one request's fate before the stand-in acts: an answer of its own, or "lost" (the change lands and
// the answer never arrives).
type Fault = (request: Request) => Response | "lost" | undefined;
function cloudflare(state: { gateway: Raw | null; providers: Raw[]; costs: Raw[] }, fault: Fault = () => undefined) {
  const requests: Request[] = [];
  let next = 0;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const list = (items: Raw[], query: URLSearchParams) => {
    const page = Number(query.get("page") ?? 1);
    const per = Number(query.get("per_page") ?? 50);
    return json({ result: items.slice((page - 1) * per, page * per), result_info: { total_count: items.length } });
  };
  const act = (request: Request, query: URLSearchParams): Response => {
    const { method, path, body } = request;
    if (path === "/gateways/isitlegit" && method === "GET")
      return state.gateway ? json({ result: state.gateway }) : json({ errors: [{ code: 7002 }] }, 404);
    if (path === "/gateways" && method === "POST") {
      state.gateway = { ...body, created_at: "now" };
      return json({ result: state.gateway });
    }
    if (path === "/gateways/isitlegit" && method === "PUT") {
      state.gateway = { ...state.gateway, ...body };
      return json({ result: state.gateway });
    }
    if (path === "/custom-providers" && method === "GET") return list(state.providers, query);
    if (path === "/custom-providers" && method === "POST") {
      const created = { ...body, id: `prov-new-${++next}`, logo: null, headers: null };
      state.providers.push(created);
      return json({ result: created });
    }
    if (path.startsWith("/custom-providers/costs")) {
      if (method === "GET") return list(state.costs, query);
      // As Cloudflare answered a live check on 2026-10-27: token_pricing (per million tokens) is required, and the
      // per-token cost_in and cost_out are derived from it; a cost_in written directly is taken per million.
      const priced = (tp: { input_tokens: number; output_tokens: number }) => ({
        token_pricing: JSON.stringify(tp),
        cost_in: tp.input_tokens / 1e6,
        cost_out: tp.output_tokens / 1e6,
      });
      if (method === "POST") {
        if (!body?.token_pricing || typeof body.token_pricing !== "object")
          return json({ errors: [{ code: 7001, message: "token_pricing object must be provided" }] }, 400);
        const created = { ...body, id: `r-new-${++next}`, ...priced(body.token_pricing as never) };
        state.costs.push(created);
        return json({ result: created });
      }
      const found = state.costs.find((c) => c.id === path.split("/").at(-1));
      if (!found) return json({ errors: [{ code: 7002 }] }, 404);
      if (method === "PATCH") {
        Object.assign(
          found,
          body,
          typeof body?.cost_in === "number" ? { cost_in: body.cost_in / 1e6 } : {},
          typeof body?.cost_out === "number" ? { cost_out: body.cost_out / 1e6 } : {},
          body?.token_pricing ? priced(body.token_pricing as never) : {},
        );
        return json({ result: found });
      }
      if (method === "DELETE") {
        state.costs = state.costs.filter((c) => c !== found);
        return json({ result: { id: found.id } });
      }
    }
    if (path.startsWith("/custom-providers/") && method === "PATCH") {
      const found = state.providers.find((p) => p.id === path.split("/").at(-1));
      if (!found) return json({ errors: [{ code: 7002 }] }, 404);
      Object.assign(found, body);
      return json({ result: found });
    }
    return json({ errors: [{ code: 1, message: `no route ${method} ${path}` }] }, 400);
  };
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Request = {
      method: init?.method ?? "GET",
      path: url.pathname.slice(new URL(BASE).pathname.length),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    requests.push(request);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(init?.redirect).toBe("manual");
    const decided = fault(request);
    if (decided === "lost") {
      act(request, url.searchParams);
      throw new TypeError("fetch failed");
    }
    return decided ?? act(request, url.searchParams);
  }) as typeof fetch;
  const writes = () => requests.filter((r) => r.method !== "GET");
  return { fetchStub, requests, writes, state };
}
const live = () => ({ gateway: gateway(), providers: [provider()], costs: rules() });
const options = (fetchStub: typeof fetch, extra: Partial<Options> = {}): Options => ({
  token: TOKEN,
  file: FILE,
  fetch: fetchStub,
  api: STAND_IN,
  allowEndpoint: true,
  timeoutMs: 2_000,
  ...extra,
});
const read = () => JSON.parse(readFileSync(FILE, "utf-8")) as SnapshotData;
async function take() {
  const world = cloudflare(live());
  expect((await snapshot(options(world.fetchStub))).code).toBe(0);
  return read();
}
const failed = (lines: string[]) => lines.join("\n");

describe("scripts/gateway-config.ts snapshot", () => {
  it("writes the gateway, the provider and its rules, read back from disk, with no ids and no token", async () => {
    const world = cloudflare({ ...live(), costs: [...rules(), rule("r-other", "x-1", 1, 0, 1, "prov-other")] });
    const outcome = await snapshot(options(world.fetchStub));
    expect(outcome.code).toBe(0);
    const text = readFileSync(FILE, "utf-8");
    const data = Snapshot.parse(JSON.parse(text));
    expect(data.gateway).toMatchObject({ id: "isitlegit", authentication: true, collect_logs: false, cache_ttl: 0 });
    expect(data.gateway).not.toHaveProperty("created_at");
    expect(data.gateway).not.toHaveProperty("wholesale");
    expect(data.provider).toMatchObject({ slug: "meta", base_url: "https://api.meta.ai" });
    expect(data.provider).not.toHaveProperty("id");
    expect(data.provider).not.toHaveProperty("headers");
    // Only the meta provider's rules, sorted by model, with token_pricing as an object.
    expect(data.rules.map((r) => r.model)).toEqual(["muse-spark-1.3", "muse-wonder-1.0"]);
    expect(data.rules[1]?.token_pricing).toEqual({ input_tokens: 4, output_tokens: 20, input_cached_tokens: 0.2 });
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/"id": "(prov|r)-/);
    expect(world.writes()).toEqual([]);
  });

  it("leaves the previous file as it was after a failed read, a refused provider and a failed write", async () => {
    writeFileSync(FILE, "the previous snapshot\n");
    const failing = cloudflare(live(), (r) =>
      r.path === "/custom-providers" ? new Response("{}", { status: 500 }) : undefined,
    );
    const broken = await snapshot(options(failing.fetchStub));
    expect(broken.code).toBe(2);
    expect(failed(broken.lines)).toMatch(
      /GET \/custom-providers\?page=1&per_page=50 answered HTTP 500; .* is unchanged/,
    );
    const keyed = cloudflare({ ...live(), providers: [{ ...provider(), headers: '{"x-api-key":"sk-live-123"}' }] });
    const refused = await snapshot(options(keyed.fetchStub));
    expect(refused.code).toBe(2);
    expect(failed(refused.lines)).toMatch(/the provider's headers is set, and can hold a credential/);
    expect(failed(refused.lines)).not.toContain("sk-live-123");
    const otel = cloudflare({ ...live(), gateway: { ...gateway(), otel: [{ authorization: "Bearer x" }] } });
    expect(failed((await snapshot(options(otel.fetchStub))).lines)).toMatch(/the gateway's otel is set/);
    chmodSync(DIR, 0o500);
    try {
      const unwritable = await snapshot(options(cloudflare(live()).fetchStub));
      expect(unwritable.code).toBe(1);
      expect(failed(unwritable.lines)).toMatch(/could not be written \(EACCES\); the previous file is unchanged/);
    } finally {
      chmodSync(DIR, 0o700);
    }
    expect(readFileSync(FILE, "utf-8")).toBe("the previous snapshot\n");
    expect(existsSync(`${FILE}.${process.pid}.tmp`)).toBe(false);
  });

  it("names the permission a refused read needs", async () => {
    const world = cloudflare(live(), (r) =>
      r.method === "GET"
        ? new Response(JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 })
        : undefined,
    );
    const outcome = await snapshot(options(world.fetchStub));
    expect(outcome.code).toBe(2);
    expect(failed(outcome.lines)).toMatch(
      /GET \/gateways\/isitlegit was refused \(HTTP 403 \(10000: Authentication error\)\); the token needs "AI Gateway Read"/,
    );
  });
});

describe("scripts/gateway-config.ts restore", () => {
  it("creates a missing gateway and provider (with its logo), restores a changed price, keeps an extra rule, and never deletes", async () => {
    const want = await take();
    const world = cloudflare({
      gateway: null,
      providers: [],
      costs: [rule("r-extra", "muse-image-1", 1, 0, 1, "prov-new-1")],
    });
    // The extra rule belongs to the provider the restore will create; its model is not in the file.
    const outcome = await restore(options(world.fetchStub));
    expect(outcome.code, failed(outcome.lines)).toBe(0);
    expect(world.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /gateways",
      "POST /custom-providers",
      "PATCH /custom-providers/prov-new-1",
      "POST /custom-providers/costs",
      "POST /custom-providers/costs",
    ]);
    expect(world.state.providers[0]?.logo).toBe(want.provider.logo);
    expect(world.state.costs.map((c) => c.model)).toContain("muse-image-1");
    expect(world.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(failed(outcome.lines)).toMatch(/restore: 5 change\(s\) made; the account matches/);

    const changed = cloudflare({
      ...live(),
      costs: [{ ...rules()[0], cost_out: 9e-6 }, rules()[1] as Raw, rule("r-x", "muse-image-1", 1, 0, 1)],
    });
    const priced = await restore(options(changed.fetchStub));
    expect(priced.code, failed(priced.lines)).toBe(0);
    expect(changed.writes()).toEqual([
      {
        method: "PATCH",
        path: "/custom-providers/costs/r-spark",
        body: { token_pricing: { input_tokens: 1.25, output_tokens: 4.25, input_cached_tokens: 0.15 } },
      },
    ]);
    expect(failed(priced.lines)).toMatch(/the live pricing rule muse-image-1 is not in .*; it is kept/);
    expect(changed.state.costs).toHaveLength(3);
  });

  it("--dry prints every change and sends no write", async () => {
    await take();
    const world = cloudflare({
      gateway: { ...gateway(), collect_logs: true },
      providers: [],
      costs: [],
    });
    const outcome = await restore({ ...options(world.fetchStub), dry: true });
    expect(outcome.code).toBe(0);
    expect(world.writes()).toEqual([]);
    expect(outcome.lines.filter((l) => l.startsWith("would ") || l.startsWith("dry run"))).toEqual([
      "would update gateway isitlegit (collect_logs)",
      "would create provider meta",
      "would set provider meta's logo",
      "would create pricing rule muse-spark-1.3",
      "would create pricing rule muse-wonder-1.0",
      "dry run: 5 change(s), none sent",
    ]);
  });

  it("--dry shows each change's old and new value, prices with their units, and a logo by its size (E1)", async () => {
    const want = await take();
    const world = cloudflare({
      ...live(),
      gateway: { ...gateway(), collect_logs: true },
      providers: [{ ...provider(), logo: "short" }],
      costs: [
        {
          ...rules()[0],
          cost_out: 9e-6,
          token_pricing: JSON.stringify({ input_tokens: 1.25, output_tokens: 9, input_cached_tokens: 0.15 }),
        },
        rules()[1] as Raw,
      ],
    });
    const outcome = await restore({ ...options(world.fetchStub), dry: true });
    expect(outcome.lines).toContain("    collect_logs: true -> false");
    expect(outcome.lines).toContain(
      `    logo: <logo, 5 characters> -> <logo, ${want.provider.logo?.length} characters>`,
    );
    expect(outcome.lines).toContain("    cost_out: 0.000009 (US$ per token) -> 0.00000425 (US$ per token)");
    expect(outcome.lines).toContain(
      '    token_pricing: {"input_tokens":1.25,"output_tokens":9,"input_cached_tokens":0.15} (US$ per million tokens) -> {"input_tokens":1.25,"output_tokens":4.25,"input_cached_tokens":0.15} (US$ per million tokens)',
    );
    expect(outcome.lines.join("\n")).not.toContain(want.provider.logo ?? "no logo");
    expect(world.writes()).toEqual([]);
  });

  it("refuses a file whose fields break Cloudflare's constraints, or that carries a credential field, before any request (G1)", async () => {
    const want = await take();
    const cases: [string, unknown, RegExp][] = [
      [
        "a string for a boolean",
        { ...want, gateway: { ...want.gateway, authentication: "false" } },
        /gateway\.authentication/,
      ],
      [
        "an object for a count",
        { ...want, gateway: { ...want.gateway, retry_max_attempts: {} } },
        /gateway\.retry_max_attempts/,
      ],
      [
        "too many retries",
        { ...want, gateway: { ...want.gateway, retry_max_attempts: 9 } },
        /gateway\.retry_max_attempts/,
      ],
      [
        "otel in the file",
        { ...want, gateway: { ...want.gateway, otel: [{ authorization: "Bearer x" }] } },
        /gateway\.otel: can hold a credential/,
      ],
      [
        "headers in the file",
        { ...want, provider: { ...want.provider, headers: '{"k":"v"}' } },
        /provider\.headers: can hold a credential/,
      ],
      [
        "an http provider",
        { ...want, provider: { ...want.provider, base_url: "http://api.meta.ai" } },
        /provider\.base_url: must be an https URL/,
      ],
      ["a negative price", { ...want, rules: [{ ...want.rules[0], cost_in: -1 }] }, /rules\.0\.cost_in/],
    ];
    const world = cloudflare(live());
    for (const [label, file, why] of cases) {
      writeFileSync(FILE, JSON.stringify(file));
      const outcome = await restore(options(world.fetchStub));
      expect(outcome.code, label).toBe(2);
      expect(failed(outcome.lines), label).toMatch(why);
      expect(failed(outcome.lines), label).not.toContain("Bearer x");
    }
    expect(world.requests).toEqual([]);
  });

  it("refuses a URL that carries a user name or password, in the file and in the account, without printing it (round 2)", async () => {
    const want = await take();
    const world = cloudflare(live());
    for (const [field, url] of [
      ["base_url", "https://user:SYNTHETIC_PASSWORD@api.meta.ai"],
      ["link", "https://SYNTHETIC_PASSWORD@dev.meta.ai/docs"],
    ] as const) {
      writeFileSync(FILE, JSON.stringify({ ...want, provider: { ...want.provider, [field]: url } }));
      const outcome = await restore({ ...options(world.fetchStub), dry: true });
      expect(outcome.code, field).toBe(2);
      expect(failed(outcome.lines), field).toMatch(new RegExp(`provider\\.${field}: carries a user name or password`));
      expect(failed(outcome.lines), field).not.toContain("SYNTHETIC_PASSWORD");
    }
    expect(world.requests).toEqual([]);
    writeFileSync(FILE, "the previous snapshot\n");
    const keyed = cloudflare({
      ...live(),
      providers: [{ ...provider(), base_url: "https://u:SYNTHETIC_PASSWORD@api.meta.ai" }],
    });
    const refused = await snapshot(options(keyed.fetchStub));
    expect(refused.code).toBe(2);
    expect(failed(refused.lines)).toMatch(/the provider's base_url \(a user name or password in the URL\) is set/);
    expect(failed(refused.lines)).not.toContain("SYNTHETIC_PASSWORD");
    expect(readFileSync(FILE, "utf-8")).toBe("the previous snapshot\n");
    // In the account, a restore refuses before showing any value, dry or not (round 3).
    await take();
    for (const dry of [true, false]) {
      const account = cloudflare({
        ...live(),
        providers: [{ ...provider(), base_url: "https://user:SYNTHETIC_PASSWORD@api.meta.ai" }],
      });
      const outcome = await restore({ ...options(account.fetchStub), dry });
      expect(outcome.code).toBe(2);
      expect(failed(outcome.lines)).toMatch(/the provider's base_url \(a user name or password in the URL\) is set/);
      expect(failed(outcome.lines)).not.toContain("SYNTHETIC_PASSWORD");
      expect(account.writes()).toEqual([]);
    }
  });

  it("refuses a file over 1 MiB before reading it (round 2)", async () => {
    const want = await take();
    writeFileSync(
      FILE,
      JSON.stringify({ ...want, provider: { ...want.provider, description: "x".repeat(1024 * 1024) } }),
    );
    const world = cloudflare(live());
    const outcome = await restore({ ...options(world.fetchStub), dry: true });
    expect(outcome.code).toBe(2);
    expect(failed(outcome.lines)).toMatch(/is \d+ bytes, over the 1 MiB a snapshot can be/);
    expect(world.requests).toEqual([]);
  });

  it("never quotes a malformed file, which may hold a credential (round 1)", async () => {
    writeFileSync(FILE, '{"provider": {"headers": FAKE_SECRET_VALUE}}');
    const world = cloudflare(live());
    const outcome = await restore(options(world.fetchStub));
    expect(outcome.code).toBe(2);
    expect(failed(outcome.lines)).toMatch(/is not valid JSON( \(at character \d+\))?; restore it from git/);
    expect(failed(outcome.lines)).not.toMatch(/FAKE|SECRE/);
    expect(world.requests).toEqual([]);
  });

  it("writes prices only as token_pricing, per million tokens, so a restored rule reads back at its price (round 1)", async () => {
    const want = await take();
    const world = cloudflare({ ...live(), costs: [rules()[1] as Raw] });
    const outcome = await restore(options(world.fetchStub));
    expect(outcome.code, failed(outcome.lines)).toBe(0);
    const [created] = world.writes();
    expect(created?.body).not.toHaveProperty("cost_in");
    expect(created?.body).not.toHaveProperty("cost_out");
    expect(created?.body?.token_pricing).toEqual({
      input_tokens: 1.25,
      output_tokens: 4.25,
      input_cached_tokens: 0.15,
    });
    const spark = world.state.costs.find((c) => c.model === "muse-spark-1.3");
    expect([spark?.cost_in, spark?.cost_out]).toEqual([want.rules[0]?.cost_in, want.rules[0]?.cost_out]);
    // A file whose per-token costs disagree with its token_pricing is refused before any request.
    writeFileSync(FILE, JSON.stringify({ ...want, rules: [{ ...want.rules[0], cost_in: 1.25 }, want.rules[1]] }));
    const fresh = cloudflare(live());
    const refused = await restore(options(fresh.fetchStub));
    expect(refused.code).toBe(2);
    expect(failed(refused.lines)).toMatch(/rules\.0\.cost_in: cost_in and cost_out must be token_pricing's/);
    writeFileSync(FILE, JSON.stringify({ ...want, rules: [{ ...want.rules[0], token_pricing: null }] }));
    expect((await restore(options(fresh.fetchStub))).code).toBe(2);
    expect(fresh.requests).toEqual([]);
  });

  it("checks the gateway's nested settings against Cloudflare's schema before any request (round 1)", async () => {
    const want = await take();
    const cases: [string, Raw, RegExp][] = [
      ["dlp with a string flag", { dlp: { enabled: "false" } }, /gateway\.dlp/],
      ["a guardrail of a number", { guardrails: { prompt: 42, response: {} } }, /gateway\.guardrails\.prompt/],
      [
        "a spend limit with no window",
        { spend_limits: { enabled: true, rules: [{ limitType: "cost", limit: 5 }] } },
        /gateway\.spend_limits\.rules\.0\.window/,
      ],
      ["an unknown billing mode", { workers_ai_billing_mode: "invalid" }, /gateway\.workers_ai_billing_mode/],
    ];
    const world = cloudflare(live());
    for (const [label, extra, why] of cases) {
      writeFileSync(FILE, JSON.stringify({ ...want, gateway: { ...want.gateway, ...extra } }));
      const outcome = await restore({ ...options(world.fetchStub), dry: true });
      expect(outcome.code, label).toBe(2);
      expect(failed(outcome.lines), label).toMatch(why);
    }
    expect(world.requests).toEqual([]);
    // Valid nested settings pass, and are shown as a change.
    const good = {
      dlp: { action: "FLAG", enabled: true, profiles: ["p1"] },
      guardrails: { prompt: { P1: "BLOCK" }, response: { S3: "FLAG" } },
      spend_limits: { enabled: true, rules: [{ limitType: "cost", limit: 5, window: 86_400 }] },
      workers_ai_billing_mode: "postpaid",
    };
    writeFileSync(FILE, JSON.stringify({ ...want, gateway: { ...want.gateway, ...good } }));
    const dry = await restore({ ...options(world.fetchStub), dry: true });
    expect(dry.code, failed(dry.lines)).toBe(0);
    expect(failed(dry.lines)).toMatch(/would update gateway isitlegit \(.*dlp.*guardrails.*spend_limits/);
  });

  it("keeps an interrupt's inventory current: before, during and after a write (G2)", async () => {
    await take();
    const progress = newProgress();
    const during: string[][] = [];
    const world = cloudflare(
      { ...live(), gateway: { ...gateway(), zdr: true }, costs: [{ ...rules()[0], enable: false }, rules()[1] as Raw] },
      (r) => {
        if (r.method !== "GET") during.push(interrupted(progress));
        return undefined;
      },
    );
    expect(interrupted(progress)).toEqual([
      "gateway-config: interrupted",
      "  confirmed: none",
      "  uncertain: none",
      "  not tried: none",
      expect.stringMatching(/Run restore again/),
    ]);
    const outcome = await restore({ ...options(world.fetchStub), progress });
    expect(outcome.code, failed(outcome.lines)).toBe(0);
    // Stopped mid-write, the change in flight is uncertain and the rest not tried.
    expect(during[0]).toEqual([
      "gateway-config: interrupted",
      "  confirmed: none",
      "  uncertain: update gateway isitlegit (zdr)",
      "  not tried: update pricing rule muse-spark-1.3 (enable)",
      expect.stringMatching(/Run restore again/),
    ]);
    expect(during[1]?.slice(1, 4)).toEqual([
      "  confirmed: update gateway isitlegit (zdr)",
      "  uncertain: update pricing rule muse-spark-1.3 (enable)",
      "  not tried: none",
    ]);
    expect(interrupted(progress).slice(1, 4)).toEqual([
      "  confirmed: update gateway isitlegit (zdr); update pricing rule muse-spark-1.3 (enable)",
      "  uncertain: none",
      "  not tried: none",
    ]);
  });

  it("names the confirmed changes when the read-back fails after them (G3)", async () => {
    await take();
    let writes = 0;
    const world = cloudflare(
      { ...live(), gateway: { ...gateway(), zdr: true }, costs: [{ ...rules()[0], enable: false }, rules()[1] as Raw] },
      (r) => {
        if (r.method !== "GET") writes++;
        return r.method === "GET" && writes === 2 ? new Response("{}", { status: 503 }) : undefined;
      },
    );
    const outcome = await restore(options(world.fetchStub));
    expect(outcome.code).toBe(1);
    const text = failed(outcome.lines);
    expect(text).toMatch(/failed: the read-back failed \(GET \/gateways\/isitlegit answered HTTP 503\)/);
    expect(text).toMatch(/confirmed: update gateway isitlegit \(zdr\); update pricing rule muse-spark-1.3 \(enable\)/);
    expect(text).toMatch(/unverified: the read-back could not confirm .*; run restore --dry to see what differs/);
  });

  it("announces each stage at once and says it is still waiting during a slow answer (E2)", async () => {
    await take();
    const world = cloudflare(live());
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 250));
      return world.fetchStub(input, init);
    }) as typeof fetch;
    const seen: [number, string][] = [];
    const started = Date.now();
    const outcome = await restore({
      ...options(slow, { progressMs: 100 }),
      dry: true,
      log: (line) => seen.push([Date.now() - started, line]),
    });
    expect(outcome.code).toBe(0);
    expect(seen[0]?.[1]).toBe("Reading gateway isitlegit, provider meta and its pricing rules...");
    expect(seen[0]?.[0]).toBeLessThan(1_000);
    expect(seen.some(([, l]) => /^ {2}still waiting for GET \/gateways\/isitlegit \(\d+ s\)$/.test(l))).toBe(true);
  });

  it("reports a refused write with its endpoint and permission, and what was and was not done", async () => {
    await take();
    const world = cloudflare(
      {
        ...live(),
        gateway: { ...gateway(), cache_ttl: 60 },
        costs: [{ ...rules()[0], cost_in: 1 }, rules()[1] as Raw],
      },
      (r) =>
        r.method === "PATCH"
          ? new Response(JSON.stringify({ errors: [{ code: 10000, message: "Authentication error" }] }), {
              status: 403,
            })
          : undefined,
    );
    const outcome = await restore(options(world.fetchStub));
    expect(outcome.code).toBe(1);
    const text = failed(outcome.lines);
    expect(text).toMatch(
      /PATCH \/custom-providers\/costs\/r-spark was refused \(HTTP 403 .*\); the token needs "AI Gateway Write"/,
    );
    expect(text).toMatch(/confirmed: update gateway isitlegit \(cache_ttl\)/);
    expect(text).toMatch(/uncertain: none/);
    expect(text).toMatch(/not tried: update pricing rule muse-spark-1.3/);
  });

  it("names a create whose answer was lost as uncertain, and a rerun finishes without a duplicate", async () => {
    await take();
    const state = { gateway: gateway(), providers: [] as Raw[], costs: [] as Raw[] };
    let lose = true;
    const first = cloudflare(state, (r) =>
      r.method === "POST" && r.path === "/custom-providers" && lose ? "lost" : undefined,
    );
    const outcome = await restore(options(first.fetchStub));
    expect(outcome.code).toBe(1);
    const text = failed(outcome.lines);
    expect(text).toMatch(/POST \/custom-providers got no answer \(TypeError\)/);
    expect(text).toMatch(/uncertain: create provider meta/);
    expect(text).toMatch(
      /not tried: set provider meta's logo; create pricing rule muse-spark-1.3; create pricing rule muse-wonder-1.0/,
    );
    expect(text).toMatch(/Run restore again/);
    expect(state.providers).toHaveLength(1);
    lose = false;
    const again = cloudflare(state);
    const rerun = await restore(options(again.fetchStub));
    expect(rerun.code, failed(rerun.lines)).toBe(0);
    expect(again.writes().some((w) => w.method === "POST" && w.path === "/custom-providers")).toBe(false);
    expect(state.providers).toHaveLength(1);
    expect(state.costs).toHaveLength(2);
  });

  it("stops midway on a server error, naming the change it cannot vouch for", async () => {
    await take();
    const world = cloudflare(
      {
        ...live(),
        gateway: { ...gateway(), zdr: true },
        costs: [
          { ...rules()[0], enable: false },
          { ...rules()[1], cost_out: 1 },
        ],
      },
      (r) => (r.path === "/custom-providers/costs/r-spark" ? new Response("{}", { status: 502 }) : undefined),
    );
    const outcome = await restore(options(world.fetchStub));
    expect(outcome.code).toBe(1);
    const text = failed(outcome.lines);
    expect(text).toMatch(/confirmed: update gateway isitlegit \(zdr\)/);
    expect(text).toMatch(/uncertain: update pricing rule muse-spark-1.3 \(enable\)/);
    expect(text).toMatch(/not tried: update pricing rule muse-wonder-1.0 \(cost_out\)/);
  });

  it("refuses live credential fields before any write, without printing their values", async () => {
    await take();
    const keyed = cloudflare({
      ...live(),
      gateway: { ...gateway(), cache_ttl: 5 },
      providers: [{ ...provider(), headers: '{"authorization":"Bearer sk-9"}' }],
    });
    const outcome = await restore(options(keyed.fetchStub));
    expect(outcome.code).toBe(2);
    expect(failed(outcome.lines)).toMatch(/refused, nothing changed: the provider's headers is set/);
    expect(failed(outcome.lines)).not.toContain("sk-9");
    expect(keyed.writes()).toEqual([]);
  });

  it("fails when the read-back still differs, or a credential field appeared", async () => {
    await take();
    // Cloudflare answers 200 to the update but keeps the old setting.
    const ignored = cloudflare({ ...live(), gateway: { ...gateway(), collect_logs: true } }, (r) =>
      r.method === "PUT" ? new Response(JSON.stringify({ result: {} }), { status: 200 }) : undefined,
    );
    const outcome = await restore(options(ignored.fetchStub));
    expect(outcome.code).toBe(1);
    expect(failed(outcome.lines)).toMatch(/still differs from .* after restoring: gateway.collect_logs/);
    const state = { ...live(), gateway: { ...gateway(), cache_ttl: 9 } };
    const appeared = cloudflare(state, (r) => {
      if (r.method === "PUT") (state.providers[0] as Raw).headers = '{"x":"y"}';
      return undefined;
    });
    const after = await restore(options(appeared.fetchStub));
    expect(after.code).toBe(1);
    expect(failed(after.lines)).toMatch(/after restoring, the provider's headers is set/);
  });

  it("refuses a missing, unreadable or malformed file before any request", async () => {
    const world = cloudflare(live());
    const missing = await restore(options(world.fetchStub, { file: join(DIR, "none.json") }));
    expect(missing.code).toBe(2);
    expect(failed(missing.lines)).toMatch(
      /does not exist; take one with snapshot, or write an earlier one out with git show/,
    );
    writeFileSync(FILE, "{ not json");
    expect(failed((await restore(options(world.fetchStub))).lines)).toMatch(/is not valid JSON/);
    const want = await take();
    world.requests.length = 0;
    const bad = { ...want, rules: [{ ...want.rules[0], cost_in: "cheap" }] };
    writeFileSync(FILE, JSON.stringify(bad));
    const malformed = await restore(options(world.fetchStub));
    expect(malformed.code).toBe(2);
    expect(failed(malformed.lines)).toMatch(/is not a snapshot \(rules\.0\.cost_in: /);
    writeFileSync(FILE, JSON.stringify({ ...want, rules: [want.rules[0], want.rules[0]] }));
    expect(failed((await restore(options(world.fetchStub))).lines)).toMatch(/two pricing rules name the same model/);
    expect(world.requests).toEqual([]);
  });

  it("sends the token only to Cloudflare's API, and only one in Cloudflare's format", async () => {
    const world = cloudflare(live());
    const elsewhere = await snapshot({ token: TOKEN, file: FILE, fetch: world.fetchStub, api: STAND_IN });
    expect(elsewhere.code).toBe(2);
    expect(failed(elsewhere.lines)).toMatch(/requests go only to https:\/\/api\.cloudflare\.com\/client\/v4/);
    const odd = await restore(options(world.fetchStub, { token: "bad token\nx" }));
    expect(odd.code).toBe(2);
    expect(world.requests).toEqual([]);
  });
});

describe("scripts/gateway-config.ts command line", () => {
  it("prints the restore inventory when interrupted, as a real process (G2)", async () => {
    // A conclave-op that never answers holds the run at its first stage, where Ctrl+C arrives.
    const bin = join(DIR, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "conclave-op"), "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const child = spawn(process.execPath, [join(import.meta.dirname, "../../scripts/gateway-config.ts"), "restore"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    while (!out.includes("from Conclave...")) await new Promise((r) => setTimeout(r, 25));
    child.kill("SIGINT");
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(out).toMatch(/^Reading "IsItLegit AI Gateway admin token" from Conclave\.\.\./);
    expect(code).toBe(130);
    expect(err).toMatch(/gateway-config: interrupted\n {2}confirmed: none\n {2}uncertain: none\n {2}not tried: none/);
  }, 20_000);

  it("--help works offline and names the commands, the vault item, the permissions and the exit codes", () => {
    const out = execFileSync(
      process.execPath,
      [join(import.meta.dirname, "../../scripts/gateway-config.ts"), "--help"],
      {
        env: { PATH: "/nonexistent" },
        encoding: "utf-8",
      },
    );
    for (const fact of [
      "snapshot",
      "restore",
      "--dry",
      "--file",
      "IsItLegit AI Gateway admin token",
      "AI Gateway Write",
      "Exit codes",
    ])
      expect(out).toContain(fact);
    expect(() => parseConfigArgs(["snapshot", "--dry"])).toThrow(/--dry goes with restore/);
    expect(() => parseConfigArgs([])).toThrow(/name a command/);
    expect(parseConfigArgs(["restore", "--file", "/x/y.json"])).toMatchObject({
      command: "restore",
      file: "/x/y.json",
    });
  });
});
