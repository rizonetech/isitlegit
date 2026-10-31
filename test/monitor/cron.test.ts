// The impersonation monitor's daily run (D05 T04 §2): hosts captured when new, their DNS changed since their last
// good capture, their capture due for its weekly refresh or failed (and retried), captures kept in R2 for §3, a failed
// lookup leaving a host's state alone, eligibility read when the run starts, Glimmer woken only for pages to capture
// and settled to the run's last request, each run recorded from its start, and the daily dispatch. The completion
// review's gaps: an interrupted run's owed capture (5), HTTP error answers (6), HTTP-only sites (7), the seven-day
// refresh under the per-run limit (8), the reservation under the daily cap on the real ledger (9), settlement failure
// and its retry (10), the run row's start, end and failure (11), and the scheduled entrypoint and browser lifecycle (12).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setPlan } from "../../src/auth/plans";
import worker from "../../src/index";
import { candidatesForBusiness } from "../../src/monitor/candidates";
import {
  type Capture,
  CaptureFailed,
  type Lookup,
  MAX_CAPTURE_FAILURES,
  MAX_CAPTURES_PER_RUN,
  type MonitorDeps,
  monitorOrg,
  REFRESH_DAYS,
  SCREEN_CALLS_PER_RUN,
  sastDay,
} from "../../src/monitor/run";
import { browserCapture, dohLookup, monitorDeps, scheduledMonitor, settleAgain } from "../../src/monitor/workflow";
import { FORWARD_CRON, MAIN_CRON, MONITOR_CRON, RETRY_CRON } from "../../src/schedules";
import { setIdentity } from "../../src/trust/identity";
import { burstMinutes } from "../../src/vision/glimmer-minutes";
import { type Burst, REQUEST_MS, type Woken } from "../../src/vision/glimmer-wake";
import { protectableOrg } from "../trust/helpers";

const db = env.DB;
const DAY_MS = 24 * 60 * 60_000;
const START = new Date("2026-11-02T04:15:00Z");
let n = 0;

async function business() {
  const tag = `${++n}${crypto.randomUUID().slice(0, 6)}`;
  const domain = `fynbos${tag}.co.za`;
  const contact = `accounts@${domain}`;
  const orgId = await protectableOrg(domain, contact, `Fynbos ${tag}`);
  await setIdentity(db, orgId, "owner", { displayNames: ["Fynbos"], financeContact: contact, protected: true });
  return { orgId, domain, contact, candidates: candidatesForBusiness([domain]) };
}

// A world the run talks to: DNS answers by host, captures that succeed or fail by host (each taking 30 seconds), a
// settlement that can be refused, and a log of every call.
function world(at: Date) {
  const calls: string[] = [];
  const answers = new Map<string, Lookup>();
  const failing = new Map<string, Error>();
  const settled: { burst: Burst; until: number }[] = [];
  let settleAnswer: unknown = { ok: true };
  let now = at;
  const deps: MonitorDeps = {
    db,
    store: env.ARTEFACTS,
    now: () => now,
    resolve: async (host) => {
      calls.push(`dns:${host}`);
      return answers.get(host) ?? { status: "none" };
    },
    capture: async (host): Promise<Capture> => {
      calls.push(`capture:${host}`);
      now = new Date(now.getTime() + 30_000);
      const error = failing.get(host);
      if (error) throw error;
      return {
        screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
        text: `page of ${host} at ${now.toISOString()}`,
        url: `https://${host}/`,
      };
    },
    wake: async (count): Promise<Woken> => {
      calls.push(`wake:${count}`);
      const wakeAt = now.getTime();
      return {
        outcome: "woken",
        burst: { id: "burst-1", wakeAt, deadline: wakeAt + 60_000 },
        reused: false,
        first: null,
      };
    },
    settle: async (burst, until) => {
      calls.push("settle");
      settled.push({ burst, until });
      return settleAnswer;
    },
  };
  return {
    deps,
    calls,
    answers,
    failing,
    settled,
    refuseSettlement: (answer: unknown) => {
      settleAnswer = answer;
    },
    later: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    captures: () => calls.filter((c) => c.startsWith("capture:")).map((c) => c.slice(8)),
  };
}

const host = async (orgId: string, domain: string) =>
  db
    .prepare("SELECT * FROM monitor_hosts WHERE org_id = ? AND domain = ?")
    .bind(orgId, domain)
    .first<Record<string, unknown>>();
const runRow = async (orgId: string) =>
  db
    .prepare("SELECT * FROM monitor_runs WHERE org_id = ? ORDER BY day DESC LIMIT 1")
    .bind(orgId)
    .first<Record<string, unknown>>();
const live = (ip: string): Lookup => ({ status: "resolves", answers: [ip] });

// A database that commits the run's DNS batch and then stops answering, as a Worker stopped right after it would.
function stopsAfterBatch(target: D1Database): D1Database {
  let committed = false;
  return new Proxy(target, {
    get(t, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await t.batch(statements);
          committed = true;
          return result;
        };
      if (key === "prepare")
        return (sql: string) => {
          if (committed) throw new Error("worker stopped");
          return t.prepare(sql);
        };
      const value = Reflect.get(t, key);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

describe("one organisation's run", () => {
  it("captures a new live host for §3, waking Glimmer just before the first capture, and records the run from its start", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.10"));
    const summary = await monitorOrg(w.deps, b.orgId, "run-1");
    const firstCapture = w.calls.indexOf(`capture:${site}`);
    expect(w.calls[firstCapture - 1]).toBe("wake:1");
    expect(w.calls.slice(0, firstCapture - 1).every((c) => c.startsWith("dns:"))).toBe(true);
    expect(w.calls.at(-1)).toBe("settle");
    // Settled to the deadline of the wake's own request, the last this run sent, not to the end of the captures.
    expect(w.settled[0]?.until).toBe((w.settled[0]?.burst.wakeAt as number) + REQUEST_MS);
    expect(summary).toMatchObject({ outcome: "completed", resolved: 1, captured: 1, lookupFailed: 0, deferred: 0 });
    const row = await host(b.orgId, site);
    expect(row).toMatchObject({ resolves: 1, capture_failures: 0, capture_url: `https://${site}/` });
    expect(row?.captured_dns_hash).toBe(row?.dns_hash);
    const prefix = row?.capture_key as string;
    expect(prefix.startsWith(`monitor/${b.orgId}/${site}/`)).toBe(true);
    expect(await (await env.ARTEFACTS.get(`${prefix}text.txt`))?.text()).toContain(`page of ${site}`);
    expect((await env.ARTEFACTS.get(`${prefix}screenshot.jpg`)) !== null).toBe(true);
    const run = await runRow(b.orgId);
    expect(run).toMatchObject({ outcome: "completed", resolved: 1, captured: 1, day: "2026-11-02" });
    expect(run?.started_at).toBe(START.toISOString());
    expect(Date.parse(run?.finished_at as string) - START.getTime()).toBe(30_000);
    expect(JSON.parse(run?.glimmer_json as string)).toMatchObject({ outcome: "woken", settled: true });
  });

  it("wakes nothing and settles nothing when nothing is to be captured", async () => {
    const b = await business();
    const w = world(START);
    expect(await monitorOrg(w.deps, b.orgId, "quiet")).toMatchObject({ outcome: "completed", captured: 0 });
    expect(w.calls.some((c) => c.startsWith("wake") || c === "settle" || c.startsWith("capture:"))).toBe(false);
  });

  it("captures a host whose DNS changed and leaves an unchanged one alone", async () => {
    const b = await business();
    const w = world(START);
    const [parked, moved] = b.candidates as [string, string];
    w.answers.set(parked, live("192.0.2.20"));
    w.answers.set(moved, live("192.0.2.30"));
    await monitorOrg(w.deps, b.orgId, "first");
    w.calls.length = 0;
    w.later(6 * 60 * 60_000);
    w.answers.set(moved, live("198.51.100.30"));
    await monitorOrg(w.deps, b.orgId, "second");
    expect(w.captures()).toEqual([moved]);
  });

  it("keeps a capture owed when the run stops between the DNS write and the capture (gap 5)", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.60"));
    await monitorOrg(w.deps, b.orgId, "before");
    const before = await host(b.orgId, site);
    // The next day the DNS changes and the Worker stops right after committing it.
    w.later(DAY_MS);
    w.answers.set(site, live("203.0.113.60"));
    await expect(monitorOrg({ ...w.deps, db: stopsAfterBatch(db) }, b.orgId, "stopped")).rejects.toThrow();
    expect(await runRow(b.orgId)).toMatchObject({ outcome: "running", finished_at: null });
    const stopped = await host(b.orgId, site);
    expect(stopped?.dns_hash).not.toBe(before?.dns_hash);
    expect(stopped?.capture_key).toBe(before?.capture_key);
    // The restart sees DNS already up to date and a recent capture, and still captures.
    w.calls.length = 0;
    w.later(60_000);
    await monitorOrg(w.deps, b.orgId, "restart");
    expect(w.captures()).toEqual([site]);
    expect((await host(b.orgId, site))?.captured_dns_hash).toBe(stopped?.dns_hash);
  });

  it("treats an HTTP error answer as a failed capture that keeps the last good one and is retried (gap 6)", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.40"));
    await monitorOrg(w.deps, b.orgId, "good");
    const good = await host(b.orgId, site);
    w.later(DAY_MS);
    w.answers.set(site, live("192.0.2.41"));
    w.failing.set(site, new CaptureFailed("http-503"));
    const failed = await monitorOrg(w.deps, b.orgId, "503");
    expect(failed).toMatchObject({ outcome: "partial", captureFailed: 1 });
    expect(failed.errors).toContain("capture:http-503");
    expect(await host(b.orgId, site)).toMatchObject({
      capture_key: good?.capture_key,
      captured_at: good?.captured_at,
      captured_dns_hash: good?.captured_dns_hash,
      capture_failures: 1,
    });
    w.failing.delete(site);
    w.calls.length = 0;
    w.later(60 * 60_000);
    expect(await monitorOrg(w.deps, b.orgId, "recovered")).toMatchObject({ captured: 1 });
    expect(await host(b.orgId, site)).toMatchObject({ capture_failures: 0 });
  });

  it("keeps the last good capture when storing a new one fails, and retries it", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.70"));
    await monitorOrg(w.deps, b.orgId, "good");
    const good = await host(b.orgId, site);
    w.later(DAY_MS);
    w.answers.set(site, live("192.0.2.71"));
    const store = {
      put: async () => {
        throw new Error("R2 unavailable");
      },
    } as unknown as R2Bucket;
    expect(await monitorOrg({ ...w.deps, store }, b.orgId, "r2")).toMatchObject({ captureFailed: 1 });
    expect(await host(b.orgId, site)).toMatchObject({ capture_key: good?.capture_key, capture_failures: 1 });
    w.calls.length = 0;
    await monitorOrg(w.deps, b.orgId, "again");
    expect(w.captures()).toEqual([site]);
  });

  it("stops retrying at the failure limit, and starts again when the DNS changes", async () => {
    const b = await business();
    const w = world(START);
    const stubborn = b.candidates[1] as string;
    w.answers.set(stubborn, live("192.0.2.41"));
    w.failing.set(stubborn, new Error("browser timed out"));
    for (let i = 0; i < MAX_CAPTURE_FAILURES + 2; i++) {
      await monitorOrg(w.deps, b.orgId, `s${i}`);
      w.later(DAY_MS);
    }
    expect(await host(b.orgId, stubborn)).toMatchObject({ capture_failures: MAX_CAPTURE_FAILURES });
    expect(w.captures()).toHaveLength(MAX_CAPTURE_FAILURES);
    w.calls.length = 0;
    w.answers.set(stubborn, live("192.0.2.42"));
    await monitorOrg(w.deps, b.orgId, "moved");
    expect(w.captures()).toEqual([stubborn]);
  });

  it("refreshes a lone capture exactly a week on, not before, even from a run a little earlier in the day (gap 8)", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.80"));
    await monitorOrg(w.deps, b.orgId, "d0");
    const days: number[] = [];
    for (let d = 1; d <= REFRESH_DAYS; d++) {
      w.calls.length = 0;
      // Each day's run starts 5 minutes earlier than the day before's.
      w.later(DAY_MS - 5 * 60_000 - (d === 1 ? 30_000 : 0));
      await monitorOrg(w.deps, b.orgId, `d${d}`);
      if (w.captures().length) days.push(d);
    }
    expect(days).toEqual([REFRESH_DAYS]);
  });

  it("keeps every capture of a cohort under a week old within the per-run limit (gap 8)", async () => {
    const b = await business();
    expect(b.candidates.length).toBeGreaterThan(MAX_CAPTURES_PER_RUN * 3);
    const w = world(START);
    for (const c of b.candidates) w.answers.set(c, live("192.0.2.90"));
    // Day 0: every candidate goes live and the first captures are taken, the rest deferred to later runs.
    const lastCapture = new Map<string, number>();
    const perRun: number[] = [];
    for (let d = 0; d < 21; d++) {
      w.calls.length = 0;
      const summary = await monitorOrg(w.deps, b.orgId, `c${d}`);
      perRun.push(summary.captured);
      for (const c of w.captures()) lastCapture.set(c, d);
      if (d >= 14)
        for (const c of b.candidates)
          expect(d - (lastCapture.get(c) ?? -99), `${c} on day ${d}`).toBeLessThanOrEqual(7);
      w.later(DAY_MS);
    }
    expect(Math.max(...perRun)).toBeLessThanOrEqual(MAX_CAPTURES_PER_RUN);
  });

  it("refreshes an unchanged host within the week even while the per-run limit of others change DNS daily (round 1)", async () => {
    const b = await business();
    const w = world(START);
    const [lure, ...rest] = b.candidates as [string, ...string[]];
    const churning = rest.slice(0, MAX_CAPTURES_PER_RUN);
    w.answers.set(lure, live("192.0.2.110"));
    churning.forEach((c, i) => w.answers.set(c, live(`198.51.100.${i}`)));
    await monitorOrg(w.deps, b.orgId, "r0");
    w.later(60 * 60_000);
    await monitorOrg(w.deps, b.orgId, "r0b");
    const lureCaptured = (await host(b.orgId, lure))?.captured_at as string;
    const refreshedOn: number[] = [];
    for (let d = 1; d <= 9; d++) {
      w.calls.length = 0;
      w.later(DAY_MS - 60 * 60_000 * (d === 1 ? 1 : 0));
      churning.forEach((c, i) => w.answers.set(c, live(`203.0.${d}.${i}`)));
      await monitorOrg(w.deps, b.orgId, `r${d}`);
      if (w.captures().includes(lure)) refreshedOn.push(d);
    }
    expect(lureCaptured).not.toBeUndefined();
    expect(refreshedOn[0]).toBe(REFRESH_DAYS);
  });

  it("counts every overdue refresh the limit leaves for the next run, after an outage (round 1)", async () => {
    const b = await business();
    const w = world(START);
    const hundred = b.candidates.slice(0, 2 * MAX_CAPTURES_PER_RUN);
    for (const c of hundred) w.answers.set(c, live("192.0.2.120"));
    await monitorOrg(w.deps, b.orgId, "o1");
    w.later(60 * 60_000);
    expect(await monitorOrg(w.deps, b.orgId, "o2")).toMatchObject({ captured: MAX_CAPTURES_PER_RUN, deferred: 0 });
    // No run for eight days, then every capture is overdue.
    w.later(8 * DAY_MS);
    const summary = await monitorOrg(w.deps, b.orgId, "after");
    expect(summary).toMatchObject({
      outcome: "partial",
      captured: MAX_CAPTURES_PER_RUN,
      deferred: MAX_CAPTURES_PER_RUN,
    });
    expect(await runRow(b.orgId)).toMatchObject({ deferred: MAX_CAPTURES_PER_RUN });
  });

  it("keeps a host's last observation when its lookup fails, counted apart from a host that does not resolve", async () => {
    const b = await business();
    const w = world(START);
    const [site] = b.candidates as [string];
    w.answers.set(site, live("192.0.2.50"));
    await monitorOrg(w.deps, b.orgId, "a");
    const before = await host(b.orgId, site);
    w.later(DAY_MS);
    w.answers.set(site, { status: "failed", error: "TimeoutError" });
    const summary = await monitorOrg(w.deps, b.orgId, "b");
    expect(summary).toMatchObject({ outcome: "partial", lookupFailed: 1 });
    expect(summary.notResolving).toBe(b.candidates.length - 1);
    expect(await host(b.orgId, site)).toEqual(before);
    expect(await runRow(b.orgId)).toMatchObject({ outcome: "partial", lookup_failed: 1 });
  });

  it("records a refused settlement, hands the reservation back, and settles it again on its own (gap 10)", async () => {
    const b = await business();
    const w = world(START);
    w.answers.set(b.candidates[0] as string, live("192.0.2.95"));
    w.refuseSettlement({ ok: false, reason: "ledger-unavailable", detail: "ledger down" });
    const summary = await monitorOrg(w.deps, b.orgId, "unsettled");
    expect(summary).toMatchObject({ outcome: "partial", captured: 1 });
    expect(summary.errors).toContain("settle:ledger down");
    expect(summary.unsettled?.id).toBe("burst-1");
    expect(JSON.parse((await runRow(b.orgId))?.glimmer_json as string)).toMatchObject({
      settled: false,
      settleError: "ledger down",
    });
    await expect(settleAgain(w.deps, summary.unsettled as Burst)).rejects.toThrow("ledger down");
    w.refuseSettlement({ ok: true, used: 6.2 });
    await expect(settleAgain(w.deps, summary.unsettled as Burst)).resolves.toBe(true);
    // A settlement that throws is recorded the same way.
    const thrown = world(START);
    thrown.answers.set(b.candidates[1] as string, live("192.0.2.96"));
    thrown.deps.settle = async () => {
      throw new TypeError("network");
    };
    expect((await monitorOrg(thrown.deps, b.orgId, "thrown")).errors).toContain("settle:TypeError");
  });

  it("records a run that fails as failed with its end, and throws so the Workflow retries it (gap 11)", async () => {
    const b = await business();
    const w = world(START);
    const failing = new Proxy(db, {
      get(t, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("FROM monitor_hosts WHERE org_id")) throw new Error("D1_ERROR: overloaded");
            return t.prepare(sql);
          };
        const value = Reflect.get(t, key);
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
    await expect(monitorOrg({ ...w.deps, db: failing }, b.orgId, "boom")).rejects.toThrow("overloaded");
    const run = await runRow(b.orgId);
    expect(run).toMatchObject({ outcome: "failed" });
    expect(JSON.parse(run?.errors_json as string)).toEqual(["run:Error"]);
    expect(run?.finished_at).not.toBeNull();
  });

  it("skips an organisation not monitored now: protection off, its last domain lost, or no monitor in its plan", async () => {
    for (const lose of ["protection", "domain", "plan"] as const) {
      const b = await business();
      if (lose === "protection")
        await setIdentity(db, b.orgId, "owner", {
          displayNames: ["Fynbos"],
          financeContact: b.contact,
          protected: false,
        });
      if (lose === "domain")
        await db.prepare("UPDATE org_domains SET state = 'pending' WHERE org_id = ?").bind(b.orgId).run();
      if (lose === "plan") await setPlan(db, b.orgId, "free");
      const w = world(START);
      expect(await monitorOrg(w.deps, b.orgId, `skip-${lose}`), lose).toMatchObject({ outcome: "skipped" });
      expect(w.calls, lose).toEqual([]);
      const run = await runRow(b.orgId);
      expect(run, lose).toMatchObject({ outcome: "skipped" });
      expect(run?.finished_at, lose).not.toBeNull();
    }
  });
});

describe("Glimmer on the real ledger (gap 9)", () => {
  const ENV = {
    FIREWORKS_API_KEY: "fw-key",
    GLIMMER_GATEWAY_URL: "https://gateway.test/v1/acct/isitlegit/custom-fireworks/v1",
    CF_AIG_TOKEN: "aig-token",
  };
  const COMPLETION = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "p" } }] });

  it("reserves within the daily cap for a business with every candidate live, and settles to the wake's request", async () => {
    await db.prepare("DELETE FROM glimmer_runtime").run();
    const b = await business();
    const runId = `monitor-${b.orgId}-2026-11-02`;
    const fetcher = (async () => new Response(COMPLETION, { status: 200 })) as unknown as typeof fetch;
    const real = monitorDeps({ ...env, ...ENV } as unknown as Env, runId, { fetcher });
    const deps: MonitorDeps = {
      ...real,
      resolve: async () => live("192.0.2.99"),
      capture: async (h) => ({ screenshot: new Uint8Array([1]), text: h, url: `https://${h}/` }),
    };
    const summary = await monitorOrg(deps, b.orgId, runId);
    expect(b.candidates.length).toBeGreaterThan(200);
    expect(summary).toMatchObject({
      captured: MAX_CAPTURES_PER_RUN,
      deferred: b.candidates.length - MAX_CAPTURES_PER_RUN,
    });
    expect(summary.unsettled).toBeUndefined();
    const row = await db
      .prepare("SELECT reserved_minutes, used_minutes, settled_at FROM glimmer_runtime WHERE reservation_id = ?")
      .bind(runId)
      .first<{ reserved_minutes: number; used_minutes: number; settled_at: string | null }>();
    expect(row?.reserved_minutes).toBeCloseTo(burstMinutes(SCREEN_CALLS_PER_RUN, 20), 6);
    expect(row?.reserved_minutes).toBeLessThan(30);
    expect(row?.settled_at).not.toBeNull();
    // Only the wake's request was sent: charged at most to its deadline and the tail, never to the captures' minutes.
    expect(row?.used_minutes).toBeGreaterThanOrEqual(6);
    expect(row?.used_minutes).toBeLessThanOrEqual(REQUEST_MS / 60_000 + 6 + 1e-6);
  });

  it("hands back a reservation the wake could not settle after a final answer, and settles it again (round 1)", async () => {
    await db.prepare("DELETE FROM glimmer_runtime").run();
    const b = await business();
    const runId = `monitor-${b.orgId}-final`;
    const fetcher = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    let failSettle = true;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (failSettle && sql.includes("reserved_minutes, used_minutes, last_answer_at"))
              throw new Error("D1_ERROR: overloaded");
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const real = monitorDeps({ ...env, ...ENV, DB: flaky } as unknown as Env, runId, { fetcher });
    const deps: MonitorDeps = {
      ...real,
      db,
      resolve: async () => live("192.0.2.130"),
      capture: async (h) => ({ screenshot: new Uint8Array([1]), text: h, url: `https://${h}/` }),
    };
    const summary = await monitorOrg(deps, b.orgId, runId);
    expect(summary.outcome).toBe("partial");
    expect(summary.errors).toContain("settle:unauthorized");
    expect(summary.unsettled?.id).toBe(runId);
    failSettle = false;
    await expect(settleAgain(real, summary.unsettled as Burst)).resolves.toBe(true);
    const row = await db
      .prepare("SELECT settled_at FROM glimmer_runtime WHERE reservation_id = ?")
      .bind(runId)
      .first<{ settled_at: string | null }>();
    expect(row?.settled_at).not.toBeNull();
  });
});

describe("the browser capture (gap 12)", () => {
  type Goto = (url: string) => Promise<{ status: () => number } | null>;
  function fakeBrowser(goto: Goto) {
    const log: string[] = [];
    let url = "";
    const session = {
      newPage: async () => ({
        target: () => ({
          createCDPSession: async () => ({
            send: async (method: string, params: { behavior: string }) => log.push(`${method}:${params.behavior}`),
          }),
        }),
        goto: async (u: string) => {
          log.push(`goto:${u}`);
          const response = await goto(u);
          url = u;
          return response;
        },
        screenshot: async () => new Uint8Array([0xff, 0xd8]),
        evaluate: async () => "Pay your invoice here",
        url: () => url,
      }),
      close: async () => {
        log.push("close");
      },
    };
    const launch = (async () => session) as unknown as Parameters<typeof browserCapture>[2];
    return { log, launch };
  }
  const ok = { status: () => 200 };

  it("captures over HTTPS with downloads refused and the session closed", async () => {
    const b = fakeBrowser(async () => ok);
    expect(await browserCapture({} as Env["BROWSER"], "x.example", b.launch)).toMatchObject({
      text: "Pay your invoice here",
      url: "https://x.example/",
    });
    expect(b.log).toEqual(["Browser.setDownloadBehavior:deny", "goto:https://x.example/", "close"]);
  });

  it("falls back to HTTP for a host with no HTTPS listener, and records it (gap 7)", async () => {
    const b = fakeBrowser(async (u) => {
      if (u.startsWith("https:")) throw new Error("net::ERR_CONNECTION_REFUSED at https://x.example/");
      return ok;
    });
    expect((await browserCapture({} as Env["BROWSER"], "x.example", b.launch)).url).toBe("http://x.example/");
    expect(b.log.at(-1)).toBe("close");
  });

  it("fails an HTTP error answer, and does not retry a timeout over HTTP, closing the session each time (gap 6)", async () => {
    const error = fakeBrowser(async () => ({ status: () => 503 }));
    await expect(browserCapture({} as Env["BROWSER"], "x.example", error.launch)).rejects.toThrow(
      new CaptureFailed("http-503"),
    );
    expect(error.log.at(-1)).toBe("close");
    const none = fakeBrowser(async () => null);
    await expect(browserCapture({} as Env["BROWSER"], "x.example", none.launch)).rejects.toThrow("no-response");
    const slow = fakeBrowser(async () => {
      throw new Error("Navigation timeout of 20000 ms exceeded");
    });
    await expect(browserCapture({} as Env["BROWSER"], "x.example", slow.launch)).rejects.toThrow("timeout");
    expect(slow.log.filter((l) => l.startsWith("goto:"))).toEqual(["goto:https://x.example/"]);
    expect(slow.log.at(-1)).toBe("close");
  });
});

describe("migration 0063", () => {
  it("creates both tables with every column the run writes", async () => {
    const columns = async (table: string) =>
      (
        await db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all<{ name: string }>()
      ).results.map((r) => r.name);
    expect(await columns("monitor_hosts")).toEqual([
      "org_id",
      "domain",
      "resolves",
      "dns_hash",
      "dns_at",
      "content_hash",
      "captured_at",
      "capture_key",
      "captured_dns_hash",
      "capture_url",
      "capture_failed_at",
      "capture_failures",
      "first_seen",
      "last_seen",
      "status",
    ]);
    expect(await columns("monitor_runs")).toEqual(expect.arrayContaining(["deferred", "glimmer_json", "finished_at"]));
  });
});

describe("the SAST day", () => {
  it("dates a run by the day in South Africa, two hours ahead of UTC", () => {
    expect(sastDay(new Date("2026-11-02T04:15:00Z"))).toBe("2026-11-02");
    expect(sastDay(new Date("2026-11-01T21:59:59Z"))).toBe("2026-11-01");
    expect(sastDay(new Date("2026-11-01T22:00:00Z"))).toBe("2026-11-02");
  });
});

describe("the daily dispatch", () => {
  function fakeMonitor(failOrg?: string) {
    const created = new Set<string>();
    let healed = false;
    const MONITOR = {
      create: async (options: { id: string; params: { orgId: string } }) => {
        if (options.params.orgId === failOrg && !healed) throw new Error("internal error");
        if (created.has(options.id)) throw new Error("instance.already_exists");
        created.add(options.id);
        return { id: options.id };
      },
    } as unknown as Env["MONITOR"];
    return { MONITOR, created, heal: () => (healed = true) };
  }

  it("starts one instance per organisation a day, goes on past a failed creation, and starts again the next day", async () => {
    await db.prepare("UPDATE identities SET protected = 0").run();
    const orgs = [await business(), await business(), await business()];
    const m = fakeMonitor(orgs[1]?.orgId);
    const lines: string[] = [];
    expect(await scheduledMonitor({ DB: db, MONITOR: m.MONITOR }, START, (l) => lines.push(l))).toEqual({
      started: 2,
      existing: 0,
      failed: 1,
    });
    expect(lines.join("\n")).toContain('"outcome":"failed"');
    m.heal();
    expect(await scheduledMonitor({ DB: db, MONITOR: m.MONITOR }, START, (l) => lines.push(l))).toEqual({
      started: 1,
      existing: 2,
      failed: 0,
    });
    const day2 = new Date(START.getTime() + DAY_MS);
    expect(await scheduledMonitor({ DB: db, MONITOR: m.MONITOR }, day2, (l) => lines.push(l))).toEqual({
      started: 3,
      existing: 0,
      failed: 0,
    });
  });

  it("is what the Worker's scheduled entrypoint runs on the monitor's cron", async () => {
    await db.prepare("UPDATE identities SET protected = 0").run();
    const b = await business();
    const m = fakeMonitor();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => {}, props: {} };
    await worker.scheduled(
      { scheduledTime: START.getTime(), cron: MONITOR_CRON, noRetry: () => {} },
      { ...env, MONITOR: m.MONITOR } as unknown as Env,
      ctx as unknown as ExecutionContext,
    );
    await Promise.all(waits);
    expect([...m.created]).toEqual([`monitor-${b.orgId}-${sastDay(new Date())}`]);
  });

  it("adds the daily cron to the three existing ones", () => {
    expect(new Set([MAIN_CRON, RETRY_CRON, FORWARD_CRON, MONITOR_CRON]).size).toBe(4);
    expect(MONITOR_CRON).toBe("15 4 * * *");
  });
});

describe("DNS over HTTPS", () => {
  const answering = (byType: Record<string, unknown>) =>
    (async (input: RequestInfo | URL) => {
      const type = new URL(String(input)).searchParams.get("type") as string;
      const body = byType[type];
      if (body instanceof Error) throw body;
      if (typeof body === "number") return new Response("", { status: body });
      return Response.json(body);
    }) as typeof fetch;

  it("reads A and AAAA answers, NXDOMAIN as not resolving, and any failed family as a failed lookup", async () => {
    expect(
      await dohLookup(
        "x.example",
        answering({
          A: { Status: 0, Answer: [{ type: 1, data: "192.0.2.1" }] },
          AAAA: { Status: 0, Answer: [{ type: 28, data: "2001:db8::1" }] },
        }),
      ),
    ).toEqual({ status: "resolves", answers: ["192.0.2.1", "2001:db8::1"] });
    expect(await dohLookup("x.example", answering({ A: { Status: 3 }, AAAA: { Status: 3 } }))).toEqual({
      status: "none",
    });
    expect(
      await dohLookup(
        "x.example",
        answering({ A: { Status: 0, Answer: [{ type: 1, data: "192.0.2.1" }] }, AAAA: 503 }),
      ),
    ).toEqual({ status: "failed", error: "http-503" });
    expect(await dohLookup("x.example", answering({ A: new TypeError("network"), AAAA: { Status: 3 } }))).toEqual({
      status: "failed",
      error: "TypeError",
    });
    expect(await dohLookup("x.example", answering({ A: { Status: 2 }, AAAA: { Status: 0 } }))).toEqual({
      status: "failed",
      error: "rcode-2",
    });
  });
});
