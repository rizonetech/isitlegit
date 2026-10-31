// D09 T01 §1: the limits script against a stub deployment. Nothing here reaches the network, the live D1 or Wrangler.
import { describe, expect, it } from "vitest";
import {
  CAP_MESSAGE,
  type CheckName,
  dailyCap,
  type LimitsDeps,
  line,
  mailSize,
  parseLimitsArgs,
  RATE_MAX,
  RATE_TARGETS,
  r2Lifecycle,
  rateLimit,
  rawRule,
  runChecks,
  sastDayStart,
  UPLOAD_LIMIT,
  UPLOAD_TOO_LARGE,
  uploadSize,
} from "../../eval/launch/check-limits.ts";
import { sastDayStart as casesSastDayStart } from "../../src/db/cases.ts";
import type { Statement } from "../../src/meta/budget-sql.ts";

const ORG = "org-test";
const SESSION = "better-auth.session_token=secret-cookie-value";
const KEY = "api-secret-smtp2go-key";

type Limits = { daily_cases: number; plan: string | null; trial_ends_at: string | null } | null;
type World = {
  clock: number;
  active: string | null;
  orgs: string[];
  limits: Limits;
  cases: { id: string; org_id: string; created_at: string; name: string }[];
  // what the upload route does with an oversized body and a capped one
  oversized: { status: number; body: string };
  cappedStatus: number;
  // the per-IP limiter: hits in the current window by path, and the window's start
  buckets: Map<string, { count: number; start: number }>;
  rateMax: number;
  rateExpect: Record<string, number>;
  rateStuck: boolean;
  wrongOrigin: boolean;
  mail: { event: string; reason: string } | null;
  lifecycle: string;
  sqlFails: (statement: Statement) => boolean;
  restoreLies: boolean;
  requests: string[];
  writes: Statement[];
  mailsSent: number;
};

function world(change: Partial<World> = {}): World {
  return {
    clock: Date.parse("2026-11-02T08:00:00Z"),
    active: ORG,
    orgs: [ORG],
    limits: { daily_cases: 50, plan: "protect", trial_ends_at: null },
    cases: [{ id: "case-old", org_id: ORG, created_at: "2026-11-02T06:30:00.000Z", name: "earlier.eml" }],
    oversized: { status: 413, body: JSON.stringify({ error: UPLOAD_TOO_LARGE }) },
    cappedStatus: 429,
    buckets: new Map(),
    rateMax: RATE_MAX,
    rateExpect: {},
    rateStuck: false,
    wrongOrigin: false,
    mail: { event: "rejected", reason: "552 5.3.4 Message too large" },
    lifecycle:
      "name:     raw-30-days\nenabled:  Yes\nprefix:   raw/\naction:   Expire objects after 30 days\n\nname:     smoke-1-day\nenabled:  Yes\nprefix:   smoke/\naction:   Expire objects after 1 day\n",
    sqlFails: () => false,
    restoreLies: false,
    requests: [],
    writes: [],
    mailsSent: 0,
    ...change,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function deps(w: World, change: Partial<LimitsDeps> = {}): LimitsDeps {
  const today = () => w.cases.filter((c) => c.org_id === ORG && c.created_at >= sastDayStart(new Date(w.clock))).length;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    w.requests.push(url.pathname);
    const headers = new Headers(init?.headers);
    if (url.hostname === "api.smtp2go.com") {
      if (headers.get("x-smtp2go-api-key") !== KEY) return json(401, {});
      if (url.pathname.endsWith("/email/send")) {
        w.mailsSent++;
        return json(200, { data: { succeeded: 1, failed: 0, email_id: "mail-1" } });
      }
      return json(200, {
        data: { events: w.mail ? [{ email_id: "mail-1", event: w.mail.event, smtp_response: w.mail.reason }] : [] },
      });
    }
    if (url.pathname === "/api/auth/get-session")
      return json(
        200,
        headers.get("cookie") === SESSION && w.active ? { session: { activeOrganizationId: w.active } } : null,
      );
    if (url.pathname === "/api/upload") {
      const body = init?.body;
      let size: number;
      if (body instanceof ReadableStream) {
        size = 0;
        const reader = body.getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) size += r.value.byteLength;
      } else if (body instanceof Uint8Array) size = body.byteLength;
      else {
        const file = (body as FormData).get("file") as File;
        size = file.size;
        if (size > UPLOAD_LIMIT) return new Response(w.oversized.body, { status: w.oversized.status });
        const cap = w.limits?.daily_cases ?? 50;
        if (w.cases.some((c) => c.name === file.name)) return json(200, { caseId: "repeat", repeat: true });
        if (today() >= cap) return json(w.cappedStatus, { error: CAP_MESSAGE });
        const id = `case-${w.cases.length + 1}`;
        w.cases.push({ id, org_id: ORG, created_at: new Date(w.clock).toISOString(), name: file.name });
        return json(201, { caseId: id });
      }
      return size > UPLOAD_LIMIT ? new Response(w.oversized.body, { status: w.oversized.status }) : json(400, {});
    }
    const target = RATE_TARGETS.find((t) =>
      url.pathname.endsWith(
        t.check === "passkey-options-rate"
          ? "/generate-authenticate-options"
          : t.check === "sign-in-code-rate"
            ? "/signin/code"
            : "/signin/confirm",
      ),
    );
    if (target) {
      if (w.wrongOrigin && init?.method === "POST") return new Response("Forbidden", { status: 403 });
      const bucket = w.buckets.get(url.pathname) ?? { count: 0, start: w.clock };
      if (w.clock - bucket.start >= 600_000) Object.assign(bucket, { count: 0, start: w.clock });
      bucket.count++;
      w.buckets.set(url.pathname, bucket);
      if (w.rateStuck || bucket.count > w.rateMax) {
        const left = Math.ceil((bucket.start + 600_000 - w.clock) / 1000);
        return new Response(`Too many tries. Try again in ${left} seconds.`, { status: 429 });
      }
      return new Response("", { status: w.rateExpect[target.check] ?? target.expect });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  const sql = async (statement: Statement) => {
    if (w.sqlFails(statement)) throw new Error("D1 unavailable");
    const [a, b] = statement.params;
    if (/^SELECT id FROM "organization"/.test(statement.sql)) return w.orgs.includes(a as string) ? [{ id: a }] : [];
    if (/^SELECT COUNT\(\*\) AS n FROM cases/.test(statement.sql))
      return [{ n: w.cases.filter((c) => c.org_id === a && c.created_at >= (b as string)).length }];
    if (/^SELECT org_id FROM cases WHERE id/.test(statement.sql))
      return w.cases.filter((c) => c.id === a).map((c) => ({ org_id: c.org_id }));
    if (/^SELECT daily_cases, plan, trial_ends_at FROM org_limits/.test(statement.sql))
      return w.limits ? [{ ...w.limits }] : [];
    w.writes.push(statement);
    if (/^UPDATE org_limits SET daily_cases/.test(statement.sql)) {
      if (w.limits) w.limits = { ...w.limits, daily_cases: w.restoreLies ? 999 : (a as number) };
      return [];
    }
    if (/^INSERT INTO org_limits/.test(statement.sql)) {
      w.limits = { daily_cases: b as number, plan: null, trial_ends_at: null };
      return [];
    }
    if (/^DELETE FROM org_limits/.test(statement.sql)) {
      if (!w.restoreLies) w.limits = null;
      return [];
    }
    throw new Error(`unexpected SQL: ${statement.sql}`);
  };
  return {
    base: "https://app.test",
    org: ORG,
    session: SESSION,
    smtp2goKey: KEY,
    runId: "run12345",
    fetch,
    sql,
    wrangler: async () => w.lifecycle,
    sleep: async (ms) => {
      w.clock += ms;
    },
    now: () => new Date(w.clock),
    log: () => {},
    ...change,
  };
}

describe("the command line", () => {
  it("refuses a run without --confirm-production, an unknown option or check, and a stray argument", () => {
    expect(parseLimitsArgs(["--org", ORG])).toMatchObject({ error: expect.stringMatching(/confirm-production/) });
    expect(parseLimitsArgs(["--confirm-production", "--org", ORG, "--force"])).toMatchObject({
      error: expect.any(String),
    });
    expect(parseLimitsArgs(["--confirm-production", "--org", ORG, "extra"])).toMatchObject({
      error: expect.any(String),
    });
    expect(parseLimitsArgs(["--confirm-production", "--org", ORG, "--only", "upload-size,nope"])).toMatchObject({
      error: expect.stringMatching(/unknown check nope/),
    });
    expect(parseLimitsArgs(["--confirm-production"])).toMatchObject({ error: expect.stringMatching(/--org/) });
    expect(parseLimitsArgs(["--confirm-production", "--org", ORG, "--base-url", "http://x"])).toMatchObject({
      error: expect.stringMatching(/https/),
    });
  });

  it("reads a confirmed run", () => {
    expect(parseLimitsArgs(["--confirm-production", "--org", ORG, "--only", "daily-cap,r2-lifecycle"])).toEqual({
      base: "https://app.isitlegit.co.za",
      org: ORG,
      only: ["daily-cap", "r2-lifecycle"],
    });
  });
});

describe("the preflight", () => {
  for (const [name, change] of [
    ["a signed-out session", { active: null }],
    ["another active organisation", { active: "org-other" }],
    ["an --org the database does not hold", { orgs: [] }],
  ] as [string, Partial<World>][]) {
    it(`stops ${name} before any upload, write or mail`, async () => {
      const w = world(change);
      const run = await runChecks(deps(w), ["upload-size", "daily-cap", "mail-size"]);
      expect(run.code).toBe(1);
      expect(run.outcomes.every((o) => o.result === "FAIL" && o.why.startsWith("preflight:"))).toBe(true);
      expect(w.requests.filter((p) => p === "/api/upload")).toHaveLength(0);
      expect(w.writes).toHaveLength(0);
      expect(w.mailsSent).toBe(0);
    });
  }
});

describe("upload-size", () => {
  it("passes when both oversized uploads answer 413 with the route's message and no case appears", async () => {
    const w = world();
    expect(await uploadSize(deps(w))).toMatchObject({ result: "ok" });
    expect(w.requests.filter((p) => p === "/api/upload")).toHaveLength(2);
  });

  it("fails an admitted oversized upload, a 413 with another message, and a case count that moved", async () => {
    expect(await uploadSize(deps(world({ oversized: { status: 201, body: "{}" } })))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/not 413/),
    });
    expect(await uploadSize(deps(world({ oversized: { status: 413, body: "Payload Too Large" } })))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/message/),
    });
    const w = world();
    const d = deps(w);
    const fetch = d.fetch;
    d.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await fetch(input, init);
      if (String(input).endsWith("/api/upload"))
        w.cases.push({ id: "x", org_id: ORG, created_at: new Date(w.clock).toISOString(), name: "x" });
      return answer;
    }) as typeof globalThis.fetch;
    expect(await uploadSize(d)).toMatchObject({ result: "FAIL", why: expect.stringMatching(/moved/) });
  });
});

describe("daily-cap", () => {
  it("admits one upload at today's count plus one, refuses the next, and restores the cap exactly", async () => {
    const w = world();
    const original = { ...w.limits };
    expect(await dailyCap(deps(w))).toMatchObject({ result: "ok" });
    expect(w.limits).toEqual(original);
    expect(w.cases.filter((c) => c.name.startsWith("limits-check-run12345"))).toHaveLength(1);
    expect(w.writes.map((s) => s.sql.split(" ")[0])).toEqual(["UPDATE", "UPDATE"]);
  });

  it("deletes the row it inserted when the organisation had none", async () => {
    const w = world({ limits: null });
    expect(await dailyCap(deps(w))).toMatchObject({ result: "ok" });
    expect(w.limits).toBeNull();
    expect(w.writes.map((s) => s.sql.split(" ")[0])).toEqual(["INSERT", "DELETE"]);
  });

  it("fails when the upload past the cap is admitted, and still restores", async () => {
    const w = world({ cappedStatus: 201 });
    w.cappedStatus = 201;
    const d = deps(w);
    const fetch = d.fetch;
    let n = 0;
    d.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/upload") && ++n === 2) return json(201, { caseId: "case-extra" });
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    expect(await dailyCap(d)).toMatchObject({ result: "FAIL", why: expect.stringMatching(/not 429/) });
    expect(w.limits?.daily_cases).toBe(50);
  });

  it("fails on a repeat (200) for the first upload instead of a new case", async () => {
    const w = world();
    w.cases.push({
      id: "c",
      org_id: "elsewhere",
      created_at: "2026-11-01T00:00:00Z",
      name: "limits-check-run12345-1.eml",
    });
    expect(await dailyCap(deps(w))).toMatchObject({ result: "FAIL", why: expect.stringMatching(/HTTP 200/) });
  });

  it("restores the cap on every path: a 500 on the first upload and a thrown read", async () => {
    const w = world();
    const d = deps(w);
    const fetch = d.fetch;
    d.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/api/upload")
        ? new Response("", { status: 500 })
        : fetch(input, init)) as typeof globalThis.fetch;
    expect(await dailyCap(d)).toMatchObject({ result: "FAIL" });
    expect(w.limits?.daily_cases).toBe(50);
    const thrown = world();
    let reads = 0;
    thrown.sqlFails = (s) => /COUNT/.test(s.sql) && ++reads === 2;
    expect(await dailyCap(deps(thrown))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/D1 unavailable/),
    });
    expect(thrown.limits?.daily_cases).toBe(50);
  });

  it("exits nonzero with the recovery SQL when the restoration fails or reads back wrong", async () => {
    const failing = world();
    failing.sqlFails = (s) => /^UPDATE/.test(s.sql) && failing.writes.length >= 1;
    const a = await dailyCap(deps(failing));
    expect(a).toMatchObject({ result: "FAIL", why: expect.stringMatching(/not restored; run: wrangler d1 execute/) });
    expect(a.why).toContain("UPDATE org_limits SET daily_cases = 50 WHERE org_id = 'org-test'");
    const lying = world();
    const d = deps(lying);
    const sql = d.sql;
    let updates = 0;
    d.sql = async (s) => {
      if (/^UPDATE/.test(s.sql) && ++updates === 2) lying.restoreLies = true;
      return sql(s);
    };
    expect(await dailyCap(d)).toMatchObject({ result: "FAIL", why: expect.stringMatching(/not restored/) });
  });
});

describe("the per-IP sign-in buckets", () => {
  for (const target of RATE_TARGETS) {
    it(`${target.check}: 20 answered and a 21st refused on a fresh window, answered again after it`, async () => {
      const w = world();
      expect(await rateLimit(deps(w), target)).toMatchObject({ result: "ok" });
    });

    it(`${target.check}: passes on a bucket already part used`, async () => {
      const w = world();
      const path =
        target.check === "passkey-options-rate"
          ? "/api/auth/passkey/generate-authenticate-options"
          : target.check === "sign-in-code-rate"
            ? "/signin/code"
            : "/signin/confirm";
      w.buckets.set(path, { count: 7, start: w.clock - 120_000 });
      expect(await rateLimit(deps(w), target)).toMatchObject({ result: "ok" });
    });
  }

  const confirm = RATE_TARGETS[0] as (typeof RATE_TARGETS)[number];
  it("fails when the 21st is not refused, an earlier one is, the Origin is refused, or the window never reopens", async () => {
    expect(await rateLimit(deps(world({ rateMax: 25 })), confirm)).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/21/),
    });
    expect(await rateLimit(deps(world({ rateMax: 15 })), confirm)).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/fresh window was refused/),
    });
    expect(await rateLimit(deps(world({ wrongOrigin: true })), confirm)).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/403/),
    });
    expect(await rateLimit(deps(world({ rateStuck: true })), confirm)).toMatchObject({ result: "FAIL" });
  });
});

describe("mail-size", () => {
  it("passes only on a rejection that names the size", async () => {
    expect(await mailSize(deps(world()))).toMatchObject({ result: "ok" });
    expect(await mailSize(deps(world({ mail: { event: "bounce", reason: "Message too large" } })))).toMatchObject({
      result: "ok",
    });
  });

  it("fails a delivery, a rejection for another reason and a record that never becomes final", async () => {
    expect(await mailSize(deps(world({ mail: { event: "delivered", reason: "250 OK" } })))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/delivered/),
    });
    for (const reason of ["550 5.1.1 No such user", "554 5.7.1 Sender refused", "421 provider error"])
      expect(await mailSize(deps(world({ mail: { event: "rejected", reason } })))).toMatchObject({
        result: "FAIL",
        why: expect.stringMatching(/another reason/),
      });
    expect(await mailSize(deps(world({ mail: null })))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/no final/),
    });
  });

  it("skips without a key and sends nothing", async () => {
    const w = world();
    expect(await mailSize(deps(w, { smtp2goKey: null }))).toMatchObject({ result: "skipped" });
    expect(w.mailsSent).toBe(0);
  });
});

describe("r2-lifecycle", () => {
  it("reads the rule as a block or a table row", () => {
    const table =
      "name          enabled  prefix  action\nraw-30-days   Yes      raw/    Expire objects after 30 days\n";
    expect(rawRule(world().lifecycle)).toEqual({ enabled: true, prefix: "raw/", days: 30 });
    expect(rawRule(table)).toEqual({ enabled: true, prefix: "raw/", days: 30 });
  });

  it("passes on the rule and fails a missing, disabled, other-prefix or other-age rule", async () => {
    expect(await r2Lifecycle(deps(world()))).toMatchObject({ result: "ok" });
    const base = world().lifecycle;
    for (const [lifecycle, why] of [
      [base.replace("raw-30-days", "raw-31-days"), /no raw-30-days/],
      [base.replace("enabled:  Yes\nprefix:   raw/", "enabled:  No\nprefix:   raw/"), /not enabled/],
      [base.replace("prefix:   raw/", "prefix:   rawdata/"), /not raw\//],
      [base.replace("after 30 days", "after 31 days"), /not 30/],
    ] as [string, RegExp][])
      expect(await r2Lifecycle(deps(world({ lifecycle })))).toMatchObject({
        result: "FAIL",
        why: expect.stringMatching(why),
      });
  });
});

describe("a whole run", () => {
  it("prints one line per check, exits 0 only when all are ok, and never prints a secret", async () => {
    const lines: string[] = [];
    const all: CheckName[] = [
      "upload-size",
      "daily-cap",
      "sign-in-confirm-rate",
      "sign-in-code-rate",
      "passkey-options-rate",
      "mail-size",
      "r2-lifecycle",
    ];
    const good = await runChecks(deps(world(), { log: (l) => lines.push(l) }), all);
    expect(good.code).toBe(0);
    expect(lines).toEqual(all.map((c) => `ok ${c}`));
    const mixed: string[] = [];
    const bad = await runChecks(
      deps(world({ mail: { event: "delivered", reason: "250" } }), { log: (l) => mixed.push(l) }),
      all,
    );
    expect(bad.code).toBe(1);
    expect(mixed.filter((l) => l.startsWith("FAIL"))).toEqual([expect.stringMatching(/^FAIL mail-size: /)]);
    for (const l of [...lines, ...mixed]) {
      expect(l).not.toContain("secret-cookie-value");
      expect(l).not.toContain(KEY);
    }
    expect(line({ check: "r2-lifecycle", result: "skipped", why: "x" })).toBe("skipped r2-lifecycle: x");
  });

  it("counts the cap's day as src/db/cases.ts does", () => {
    for (const at of ["2026-11-02T21:59:59Z", "2026-11-02T22:00:00Z", "2026-11-03T05:00:00Z"])
      expect(sastDayStart(new Date(at))).toBe(casesSastDayStart(new Date(at)));
  });
});
