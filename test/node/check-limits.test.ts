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
  type Recovery,
  r2Lifecycle,
  rateLimit,
  rateLimits,
  rawRule,
  recoverPending,
  runChecks,
  stoppable,
  timed,
  UPLOAD_LIMIT,
  UPLOAD_TOO_LARGE,
  uploadSize,
} from "../../eval/launch/check-limits.ts";
import { sastDayStart } from "../../eval/launch/sast-day.ts";
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
  recovery: Recovery | null;
  recoveryWriteFails: boolean;
  logs: string[];
  searches: Record<string, unknown>[];
  searchStatus: number;
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
    mail: { event: "hard-bounced", reason: "552 5.3.4 Message size exceeds fixed maximum message size" },
    lifecycle:
      "name:     raw-30-days\nenabled:  Yes\nprefix:   raw/\naction:   Expire objects after 30 days\n\nname:     smoke-1-day\nenabled:  Yes\nprefix:   smoke/\naction:   Expire objects after 1 day\n",
    sqlFails: () => false,
    restoreLies: false,
    requests: [],
    writes: [],
    mailsSent: 0,
    recovery: null,
    recoveryWriteFails: false,
    logs: [],
    searches: [],
    searchStatus: 200,
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
      w.searches.push(JSON.parse(String(init?.body)));
      if (w.searchStatus !== 200) return json(w.searchStatus, {});
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
    log: (l) => w.logs.push(l),
    state: {
      read: () => w.recovery,
      write: (record) => {
        if (w.recoveryWriteFails) throw new Error("ENOSPC");
        w.recovery = record;
      },
      remove: () => {
        w.recovery = null;
      },
    },
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
    // After the window it must answer as the route answers, not merely anything but 429.
    const late = world();
    const ld = deps(late);
    const lfetch = ld.fetch;
    let refusedTwice = 0;
    ld.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await lfetch(input, init);
      if (answer.status === 429) refusedTwice++;
      return refusedTwice >= 2 && answer.status !== 429 ? new Response("", { status: 500 }) : answer;
    }) as typeof globalThis.fetch;
    expect(await rateLimit(ld, confirm)).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/after the window.*500/),
    });
  });
});

describe("mail-size", () => {
  it("passes only on a rejection that names the size, searching SMTP2GO by the message's id", async () => {
    const w = world();
    expect(await mailSize(deps(w))).toMatchObject({
      result: "ok",
      evidence: { emailId: "mail-1", event: "hard-bounced" },
    });
    expect(w.searches[0]).toMatchObject({ search_email_id: "mail-1" });
    expect(await mailSize(deps(world({ mail: { event: "rejected", reason: "Message too large" } })))).toMatchObject({
      result: "ok",
    });
  });

  it("fails a delivery, a rejection for another reason and a record that never becomes final", async () => {
    expect(await mailSize(deps(world({ mail: { event: "delivered", reason: "250 OK" } })))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/delivered/),
    });
    for (const reason of [
      "550 5.1.1 No such user",
      "554 5.7.1 Sender refused",
      "421 provider error",
      "552 5.2.2 Mailbox full",
    ])
      expect(await mailSize(deps(world({ mail: { event: "hard-bounced", reason } })))).toMatchObject({
        result: "FAIL",
        why: expect.stringMatching(/another reason/),
      });
    // A soft bounce is retried by SMTP2GO, so it is not final.
    expect(await mailSize(deps(world({ mail: { event: "soft-bounced", reason: "Message too large" } })))).toMatchObject(
      {
        result: "FAIL",
        why: expect.stringMatching(/no final/),
      },
    );
    expect(await mailSize(deps(world({ mail: null })))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/no final/),
    });
  });

  it("fails at once when SMTP2GO refuses the search, and asks again on its other errors", async () => {
    expect(await mailSize(deps(world({ searchStatus: 401 })))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/refused the activity search/),
    });
    const w = world({ searchStatus: 503 });
    expect(await mailSize(deps(w))).toMatchObject({ result: "FAIL", why: expect.stringMatching(/no final/) });
    expect(w.searches.length).toBeGreaterThan(1);
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
    expect(rawRule(world().lifecycle)).toEqual({ enabled: true, prefix: "raw/", expireDays: 30 });
    expect(rawRule(table)).toEqual({ enabled: true, prefix: "raw/", expireDays: 30 });
  });

  it("passes on the rule and fails a missing, disabled, other-prefix, other-age or non-expiring rule", async () => {
    expect(await r2Lifecycle(deps(world()))).toMatchObject({ result: "ok" });
    const base = world().lifecycle;
    for (const [lifecycle, why] of [
      [base.replace("raw-30-days", "raw-31-days"), /no raw-30-days/],
      [base.replace("enabled:  Yes\nprefix:   raw/", "enabled:  No\nprefix:   raw/"), /not enabled/],
      [base.replace("prefix:   raw/", "prefix:   rawdata/"), /not raw\//],
      [base.replace("Expire objects after 30 days", "Expire objects after 31 days"), /\(31\)/],
      [base.replace("Expire objects after 30 days", "Transition to Infrequent Access after 30 days"), /no expiration/],
      [
        base.replace("Expire objects after 30 days", "Abort incomplete multipart uploads after 30 days"),
        /no expiration/,
      ],
    ] as [string, RegExp][])
      expect(await r2Lifecycle(deps(world({ lifecycle })))).toMatchObject({
        result: "FAIL",
        why: expect.stringMatching(why),
      });
  });

  it("passes a rule that expires after 30 days beside another action", async () => {
    const lifecycle = world().lifecycle.replace(
      "action:   Expire objects after 30 days",
      "action:   Transition to Infrequent Access after 7 days\naction:   Expire objects after 30 days",
    );
    expect(await r2Lifecycle(deps(world({ lifecycle })))).toMatchObject({ result: "ok", evidence: { expireDays: 30 } });
  });
});

describe("recovery of the cap", () => {
  it("changes nothing when the recovery record cannot be written", async () => {
    const w = world({ recoveryWriteFails: true });
    expect(await dailyCap(deps(w))).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/nothing was changed/),
    });
    expect(w.writes).toHaveLength(0);
    expect(w.requests.filter((p) => p === "/api/upload")).toHaveLength(0);
  });

  it("keeps the recovery record while the cap is changed, and removes it once restored", async () => {
    const w = world();
    const d = deps(w);
    const fetch = d.fetch;
    let seen: Recovery | null = null;
    d.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/upload")) seen ??= w.recovery;
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    expect(await dailyCap(d)).toMatchObject({ result: "ok" });
    expect(seen).toMatchObject({
      org: ORG,
      original: { daily_cases: 50 },
      restore: { sql: expect.stringMatching(/^UPDATE/) },
    });
    expect(w.recovery).toBeNull();
  });

  it("restores what an interrupted run left before running anything else", async () => {
    const w = world({ limits: { daily_cases: 2, plan: "protect", trial_ends_at: null } });
    w.recovery = {
      runId: "dead-run",
      org: ORG,
      at: "2026-11-02T07:00:00Z",
      original: { daily_cases: 50, plan: "protect", trial_ends_at: null },
      restore: { sql: "UPDATE org_limits SET daily_cases = ?1 WHERE org_id = ?2", params: [50, ORG] },
    };
    expect(await recoverPending(deps(w))).toBeNull();
    expect(w.limits?.daily_cases).toBe(50);
    expect(w.recovery).toBeNull();
    expect(w.logs).toContain("restored the cap run dead-run left changed");
  });

  it("stops every check when what an interrupted run left cannot be restored", async () => {
    const w = world({ restoreLies: true });
    w.recovery = {
      runId: "dead-run",
      org: ORG,
      at: "2026-11-02T07:00:00Z",
      original: { daily_cases: 50, plan: "protect", trial_ends_at: null },
      restore: { sql: "UPDATE org_limits SET daily_cases = ?1 WHERE org_id = ?2", params: [50, ORG] },
    };
    const run = await runChecks(deps(w), ["upload-size", "r2-lifecycle"]);
    expect(run.code).toBe(1);
    expect(
      run.outcomes.every((o) => /^recovery: run dead-run left the cap changed.*UPDATE org_limits/.test(o.why)),
    ).toBe(true);
    expect(w.requests.filter((p) => p === "/api/upload")).toHaveLength(0);
    expect(w.recovery).not.toBeNull();
  });
});

describe("an interrupted run", () => {
  it("waits for a cap change still on its way before restoring, so the restoration is never overwritten", async () => {
    const w = world();
    const base = deps(w);
    // The change to the cap is slow: it is still on its way when the operator presses Ctrl+C.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async (statement: Statement) => {
      if (/^UPDATE org_limits SET daily_cases/.test(statement.sql) && statement.params[0] !== 50) await held;
      return base.sql(statement);
    };
    const run = stoppable(slow);
    const d = { ...base, sql: run.sql };
    const check = dailyCap(d);
    while (!w.recovery) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Ctrl+C: the pending change lands 30 ms later; a stop that did not wait would restore first and be overwritten.
    setTimeout(release, 30);
    await run.stop();
    await recoverPending({ ...base, sql: base.sql });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await check.catch(() => {});
    expect(w.limits?.daily_cases).toBe(50);
    expect(w.recovery).toBeNull();
    await expect(run.sql({ sql: "SELECT 1", params: [] })).rejects.toThrow(/interrupted/);
  });
});

describe("mail-size on a failed poll", () => {
  it("keeps the sent message's id and time when a search connection fails", async () => {
    const w = world();
    const d = deps(w);
    const fetch = d.fetch;
    d.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/activity/search")) throw new TypeError("fetch failed: connection reset");
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    expect(await mailSize(d)).toMatchObject({
      result: "FAIL",
      why: expect.stringMatching(/connection reset/),
      evidence: { emailId: "mail-1", sentAt: expect.any(String) },
    });
  });
});

describe("bounded requests", () => {
  it("aborts a request that outlives its time, and the cap is still restored", async () => {
    const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))),
      )) as typeof globalThis.fetch;
    await expect(timed(hanging, 20)("https://app.test/api/upload")).rejects.toThrow(/timed out/);
    const w = world();
    const d = deps(w);
    const fetch = d.fetch;
    d.fetch = timed(
      (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/api/upload") ? hanging(input, init) : fetch(input, init)) as typeof globalThis.fetch,
      20,
    );
    expect(await dailyCap(d)).toMatchObject({ result: "FAIL", why: expect.stringMatching(/TimeoutError/) });
    expect(w.limits?.daily_cases).toBe(50);
  });
});

describe("a whole run", () => {
  const all: CheckName[] = [
    "upload-size",
    "daily-cap",
    "sign-in-confirm-rate",
    "sign-in-code-rate",
    "passkey-options-rate",
    "mail-size",
    "r2-lifecycle",
  ];

  it("prints one line per check with its evidence, exits 0 only when all are ok, and never prints a secret", async () => {
    const good = world();
    const run = await runChecks(deps(good), all);
    expect(run.code).toBe(0);
    const results = good.logs.filter((l) => /^(ok|FAIL|skipped) /.test(l));
    // The sign-in checks run together after the others; the record keeps the order asked for.
    expect(results.map((l) => l.split(":")[0]).sort()).toEqual(all.map((c) => `ok ${c}`).sort());
    expect(run.record.outcomes.map((o) => o.check)).toEqual(all);
    expect(results.find((l) => l.startsWith("ok daily-cap"))).toMatch(/case case-\d+ admitted/);
    const bad = world({ mail: { event: "delivered", reason: "250" } });
    const failed = await runChecks(deps(bad), all);
    expect(failed.code).toBe(1);
    expect(bad.logs.filter((l) => l.startsWith("FAIL"))).toEqual([expect.stringMatching(/^FAIL mail-size: /)]);
    for (const l of [...good.logs, ...bad.logs, JSON.stringify(run.record), JSON.stringify(failed.record)]) {
      expect(l).not.toContain("secret-cookie-value");
      expect(l).not.toContain(KEY);
    }
    expect(line({ check: "r2-lifecycle", result: "skipped", why: "x", evidence: {} })).toBe("skipped r2-lifecycle: x");
  });

  it("keeps a run record with every id and response observed, and the cap's restoration", async () => {
    const w = world();
    const { record } = await runChecks(deps(w), all);
    expect(record).toMatchObject({ runId: "run12345", org: ORG, base: "https://app.test", code: 0 });
    const by = Object.fromEntries(record.outcomes.map((o) => [o.check, o.evidence]));
    expect(by["daily-cap"]).toMatchObject({
      caseId: expect.stringMatching(/^case-/),
      first: 201,
      second: 429,
      restored: true,
    });
    expect(by["mail-size"]).toMatchObject({ emailId: "mail-1", event: "hard-bounced" });
    expect(by["upload-size"]).toMatchObject({ declared: 413, streamed: 413 });
    expect(by["sign-in-code-rate"]).toMatchObject({ answered: 20, over: 429, after: 400 });
  });

  it("waits for the three sign-in buckets together, about two windows, saying so at least once a minute", async () => {
    const w = world();
    const started = w.clock;
    await rateLimits(deps(w), RATE_TARGETS);
    expect(w.clock - started).toBeLessThan(24 * 60_000);
    const waits = w.logs.filter((l) => l.startsWith("waiting "));
    expect(waits).toHaveLength(2);
    expect(waits[0]).toMatch(/resumes about 2026-/);
    expect(w.logs.filter((l) => l.startsWith("  still waiting")).length).toBeGreaterThanOrEqual(16);
  });
});
