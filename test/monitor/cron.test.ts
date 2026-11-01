// The impersonation monitor's daily run (D05 T04 §2): hosts captured when new, their DNS changed since their last
// good capture, their capture a day old or failed (and retried), captures kept in R2 for §3, a failed
// lookup leaving a host's state alone, eligibility read when the run starts, Glimmer woken only for pages to capture
// and settled to the run's last request, each run recorded from its start, and the daily dispatch. The completion
// review's gaps: an interrupted run's owed capture (5), HTTP error answers (6), HTTP-only sites (7), the seven-day
// refresh under the per-run limit (8), the reservation under the daily cap on the real ledger (9), settlement failure
// and its retry (10), the run row's start, end and failure (11), and the scheduled entrypoint and browser lifecycle (12).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setPlan } from "../../src/auth/plans";
import worker from "../../src/index";
import {
  type Capture,
  CaptureFailed,
  type Lookup,
  MAX_CAPTURE_FAILURES,
  MAX_CAPTURES_PER_RUN,
  type MonitorDeps,
  monitorOrg,
  SCREEN_CALLS_PER_RUN,
  sastDay,
} from "../../src/monitor/run";
import {
  browserCapture,
  dohLookup,
  monitorDeps,
  runMonitor,
  scheduledMonitor,
  settleAgain,
} from "../../src/monitor/workflow";
import { FORWARD_CRON, MAIN_CRON, MONITOR_CRON, RETRY_CRON } from "../../src/schedules";
import { setIdentity } from "../../src/trust/identity";
import { burstMinutes } from "../../src/vision/glimmer-minutes";
import { type Burst, REQUEST_MS } from "../../src/vision/glimmer-wake";
import { fakeJpeg } from "../fixtures/jpeg";
import { business, DAY_MS, db, host, live, NO_FORM, runRow, START, stopsAfterBatch, world } from "./world";

describe("one organisation's run", () => {
  it("captures a new live host, opening Loupe's session just before the first capture, screens it, and records the run from its start", async () => {
    const b = await business();
    const w = world(START);
    const site = b.candidates[0] as string;
    w.answers.set(site, live("192.0.2.10"));
    const summary = await monitorOrg(w.deps, b.orgId, "run-1");
    const firstCapture = w.calls.indexOf(`capture:${site}`);
    expect(w.calls[firstCapture - 1]).toBe("open:1");
    expect(w.calls.slice(0, firstCapture - 1).every((c) => c.startsWith("dns:"))).toBe(true);
    // Captured, then screened, then the session closed, in that order.
    expect(w.calls.slice(firstCapture)).toEqual([`capture:${site}`, `screen:${site}`, "settle"]);
    // Closed to Loupe's last request, not to the end of the captures or of the run.
    expect(w.closed[0]?.until).toBe(START.getTime() + 30_000 + 2_000);
    expect(summary).toMatchObject({
      outcome: "completed",
      resolved: 1,
      captured: 1,
      lookupFailed: 0,
      deferred: 0,
      screened: 1,
      parked: 0,
      lures: 0,
      screenFailed: 0,
    });
    const row = await host(b.orgId, site);
    expect(row).toMatchObject({ resolves: 1, capture_failures: 0, capture_url: `https://${site}/` });
    expect(row?.captured_dns_hash).toBe(row?.dns_hash);
    const prefix = row?.capture_key as string;
    expect(prefix.startsWith(`monitor/${b.orgId}/${site}/`)).toBe(true);
    expect(await (await env.ARTEFACTS.get(`${prefix}text.txt`))?.text()).toContain(`Welcome to ${site}`);
    // What the parking rules read: the counts and the tree's own text.
    expect(JSON.parse((await (await env.ARTEFACTS.get(`${prefix}signals.json`))?.text()) as string)).toEqual({
      ...NO_FORM,
      text: expect.stringContaining(`Welcome to ${site}`),
    });
    expect((await env.ARTEFACTS.get(`${prefix}screenshot.jpg`)) !== null).toBe(true);
    const run = await runRow(b.orgId);
    expect(run).toMatchObject({ outcome: "completed", resolved: 1, captured: 1, day: "2026-11-02" });
    expect(run?.started_at).toBe(START.toISOString());
    expect(Date.parse(run?.finished_at as string) - START.getTime()).toBe(32_000);
    expect(run).toMatchObject({ screened: 1, parked: 0, lures: 0, screen_failed: 0, screen_deferred: 0 });
    expect(JSON.parse(run?.glimmer_json as string)).toMatchObject({ calls: 1, state: "ready", settled: true });
  });

  it("opens no session and settles nothing when nothing is to be captured or screened", async () => {
    const b = await business();
    const w = world(START);
    expect(await monitorOrg(w.deps, b.orgId, "quiet")).toMatchObject({
      outcome: "completed",
      captured: 0,
      screened: 0,
    });
    expect(w.calls.some((c) => c.startsWith("open") || c === "settle" || c.startsWith("capture:"))).toBe(false);
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

  it("reports a host at the failure limit as blocked, probes it once a day, and starts it afresh when the DNS changes", async () => {
    const b = await business();
    const w = world(START);
    const stubborn = b.candidates[1] as string;
    w.answers.set(stubborn, live("192.0.2.41"));
    w.failing.set(stubborn, new Error("browser timed out"));
    const summaries = [];
    for (let i = 0; i < MAX_CAPTURE_FAILURES + 2; i++) {
      summaries.push(await monitorOrg(w.deps, b.orgId, `s${i}`));
      w.later(DAY_MS);
    }
    // One attempt a day throughout: five retries, then two probes, none of them more than once in a day.
    expect(w.captures()).toHaveLength(MAX_CAPTURE_FAILURES + 2);
    expect(await host(b.orgId, stubborn)).toMatchObject({ capture_failures: MAX_CAPTURE_FAILURES + 2 });
    // From the day it reaches the limit the run says a live host is blocked, and is never complete.
    for (const [day, s] of summaries.entries()) {
      const atLimit = day >= MAX_CAPTURE_FAILURES - 1;
      expect(s.captureBlocked, `day ${day}`).toBe(day >= MAX_CAPTURE_FAILURES ? 1 : 0);
      expect(s.outcome, `day ${day}`).toBe("partial");
      expect(s.errors.includes("capture:blocked"), `day ${day} ${atLimit}`).toBe(day >= MAX_CAPTURE_FAILURES);
    }
    // The day's probe, then a second run the same day does not probe again.
    w.calls.length = 0;
    await monitorOrg(w.deps, b.orgId, "probe");
    expect(w.captures()).toEqual([stubborn]);
    w.calls.length = 0;
    w.later(60 * 60_000);
    await monitorOrg(w.deps, b.orgId, "same-day");
    expect(w.captures()).toEqual([]);
    // A new address starts it afresh.
    w.failing.clear();
    w.answers.set(stubborn, live("192.0.2.42"));
    await monitorOrg(w.deps, b.orgId, "moved");
    expect(w.captures()).toEqual([stubborn]);
    expect(await host(b.orgId, stubborn)).toMatchObject({ capture_failures: 0 });
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
    // The retry is to settle to Loupe's last request, the cutoff the close used.
    expect(summary.unsettled?.until).toBe(w.closed[0]?.until);
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
    thrown.deps.close = async () => {
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
  // Loupe's answer to the wake and to every page screened: a benign verdict, which the wake takes as any completion.
  const ANSWER = JSON.stringify({
    brand: null,
    has_login_form: false,
    has_payment_form: false,
    lure: false,
    lure_type: "none",
    confidence: 0.05,
  });
  const COMPLETION = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: ANSWER } }] });
  // A whole page for the run to capture, in a form its screener accepts.
  const page = async (h: string): Promise<Capture> => {
    const words = `Welcome to ${h}. ${"A page of ordinary words about freight. ".repeat(12)}`;
    return {
      screenshot: fakeJpeg(1280, 800, 30_000),
      text: words,
      parkText: words,
      url: `https://${h}/`,
      signals: NO_FORM,
    };
  };

  it("reserves within the daily cap for a business with every candidate live, and settles to the wake's request", async () => {
    await db.prepare("DELETE FROM glimmer_runtime").run();
    const b = await business();
    const runId = `monitor-${b.orgId}-2026-11-02`;
    const fetcher = (async () => new Response(COMPLETION, { status: 200 })) as unknown as typeof fetch;
    const real = monitorDeps({ ...env, ...ENV } as unknown as Env, runId, { fetcher });
    const deps: MonitorDeps = {
      ...real,
      resolve: async () => live("192.0.2.99"),
      capture: page,
    };
    const summary = await monitorOrg(deps, b.orgId, runId);
    expect(b.candidates.length).toBeGreaterThan(200);
    expect(summary).toMatchObject({
      captured: MAX_CAPTURES_PER_RUN,
      deferred: b.candidates.length - MAX_CAPTURES_PER_RUN,
    });
    expect(summary.unsettled).toBeUndefined();
    // Every page captured was screened by Loupe inside its reservation, and none went on to Spark.
    expect(summary).toMatchObject({ screened: MAX_CAPTURES_PER_RUN, screenFailed: 0, screenDeferred: 0 });
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM monitor_screens WHERE org_id = ? AND screener = 'glimmer'")
          .bind(b.orgId)
          .first<{ n: number }>()
      )?.n,
    ).toBe(MAX_CAPTURES_PER_RUN);
    const row = await db
      .prepare("SELECT reserved_minutes, used_minutes, settled_at FROM glimmer_runtime WHERE reservation_id = ?")
      .bind(runId)
      .first<{ reserved_minutes: number; used_minutes: number; settled_at: string | null }>();
    expect(row?.reserved_minutes).toBeCloseTo(burstMinutes(SCREEN_CALLS_PER_RUN, 20), 6);
    expect(row?.reserved_minutes).toBeLessThan(30);
    expect(row?.settled_at).not.toBeNull();
    // Settled to Loupe's last request, not to the end of the run: the tail, and the seconds the requests took.
    expect(row?.used_minutes).toBeGreaterThanOrEqual(6);
    expect(row?.used_minutes).toBeLessThanOrEqual(7);
  });

  for (const outage of ["the settlement", "the settlement and the lookup"] as const)
    it(`hands back a reservation the wake could not settle after a final answer, and settles it again: ${outage} failing (rounds 1 and 2)`, async () => {
      await db.prepare("DELETE FROM glimmer_runtime").run();
      const b = await business();
      const runId = `monitor-${b.orgId}-final`;
      // The ledger goes down when Fireworks refuses the key, after the reservation was made.
      let down = false;
      const fetcher = (async () => {
        down = true;
        return new Response("", { status: 401 });
      }) as unknown as typeof fetch;
      const failing = (sql: string) =>
        down &&
        (sql.includes("reserved_minutes, used_minutes, last_answer_at") ||
          (outage === "the settlement and the lookup" && sql.startsWith("SELECT day, wake_at, reserved_minutes")));
      const flaky = new Proxy(db, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (failing(sql)) throw new Error("D1_ERROR: overloaded");
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
        resolve: async (h) => (h === b.candidates[0] ? live("192.0.2.130") : { status: "none" as const }),
        capture: page,
      };
      const summary = await monitorOrg(deps, b.orgId, runId);
      expect(summary.outcome).toBe("partial");
      expect(summary.errors.some((e) => e.startsWith("settle:"))).toBe(true);
      expect(summary.unsettled?.id).toBe(runId);
      // The wake itself names the cutoff its settlement was to land on (D03 T04 §40), so the retry charges that moment.
      expect(Number.isFinite(summary.unsettled?.until)).toBe(true);
      // The obligation goes through the Workflow step as JSON, as the retry step receives it.
      const handed = JSON.parse(JSON.stringify(summary.unsettled)) as Burst;
      if (outage === "the settlement and the lookup") {
        // While the ledger is still down the retry throws, so the step tries again.
        await expect(settleAgain(real, handed)).rejects.toThrow();
      }
      down = false;
      await expect(settleAgain(real, handed)).resolves.toBe(true);
      const row = await db
        .prepare("SELECT settled_at, used_minutes FROM glimmer_runtime WHERE reservation_id = ?")
        .bind(runId)
        .first<{ settled_at: string | null; used_minutes: number }>();
      expect(row?.settled_at).not.toBeNull();
      expect(row?.used_minutes).toBeLessThanOrEqual(REQUEST_MS / 60_000 + 6 + 1e-6);
    });

  it("settles a reservation an attempt left held even when its retry has nothing to capture (round 3)", async () => {
    for (const ending of ["the retry succeeds", "every attempt fails"] as const) {
      await db.prepare("DELETE FROM glimmer_runtime").run();
      const b = await business();
      const runId = `monitor-${b.orgId}-held-${ending.length}`;
      const fetcher = (async () => new Response(COMPLETION, { status: 200 })) as unknown as typeof fetch;
      // The database goes down once the capture is stored, for the settlement and the run's last write.
      let down = false;
      const flaky = new Proxy(db, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (
                down &&
                (sql.includes("reserved_minutes, used_minutes, last_answer_at") ||
                  sql.startsWith("UPDATE monitor_runs"))
              )
                throw new Error("D1_ERROR: overloaded");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const real = monitorDeps({ ...env, ...ENV, DB: flaky } as unknown as Env, runId, { fetcher });
      const deps = {
        ...real,
        db: flaky,
        resolve: async (h: string) => (h === b.candidates[0] ? live("192.0.2.140") : ({ status: "none" } as Lookup)),
        capture: async (h: string) => {
          down = true;
          return page(h);
        },
      };
      // A step runner as Workflows retry: the run step up to three attempts, the database back between them when the
      // retry is to succeed.
      const step = {
        do: async (name: string, _options: unknown, work: () => Promise<unknown>) => {
          const attempts = name === "monitor" ? 3 : 1;
          let last: unknown;
          for (let a = 0; a < attempts; a++) {
            if (a > 0 && ending === "the retry succeeds") down = false;
            if (name === "settle") down = false;
            try {
              return await work();
            } catch (error) {
              last = error;
              await new Promise((r) => setTimeout(r, 1));
            }
          }
          throw last;
        },
      } as unknown as Parameters<typeof runMonitor>[0];
      const done = runMonitor(step, deps, b.orgId, runId);
      if (ending === "every attempt fails") await expect(done, ending).rejects.toThrow("overloaded");
      else expect((await done).unsettled, ending).toBeUndefined();
      const row = await db
        .prepare("SELECT settled_at FROM glimmer_runtime WHERE reservation_id = ?")
        .bind(runId)
        .first<{ settled_at: string | null }>();
      expect(row?.settled_at, ending).not.toBeNull();
    }
  });
});

describe("the browser capture (gap 12)", () => {
  type Goto = (url: string) => Promise<{ status: () => number } | null>;
  const signalsOf = { inputs: 2, passwords: 1, forms: 0, iframes: 1, components: 0, hidden: 0 };
  // A document tree as the protocol returns it, holding exactly these counts (a password field and a text field, a frame).
  const documentWith = (s: typeof signalsOf) => ({
    nodeName: "#document",
    children: [
      {
        nodeName: "BODY",
        children: [
          ...Array.from({ length: s.passwords }, () => ({ nodeName: "INPUT", attributes: ["type", "password"] })),
          ...Array.from({ length: s.inputs - s.passwords }, () => ({
            nodeName: "INPUT",
            attributes: ["type", "text"],
          })),
          ...Array.from({ length: s.forms }, () => ({ nodeName: "FORM" })),
          ...Array.from({ length: s.iframes }, () => ({ nodeName: "IFRAME" })),
        ],
      },
    ],
  });
  function fakeBrowser(goto: Goto) {
    const log: string[] = [];
    let url = "";
    const session = {
      newPage: async () => ({
        target: () => ({
          createCDPSession: async () => ({
            // The protocol: downloads refused, and the document tree the page's signals are counted from.
            send: async (method: string, params: { behavior?: string }) => {
              if (method === "DOM.getDocument") {
                log.push("DOM.getDocument:pierce");
                return { root: documentWith(signalsOf) };
              }
              // What the browser renders: no text in this tree, so nothing is hidden.
              if (method === "Accessibility.getFullAXTree") {
                log.push("Accessibility.getFullAXTree");
                return { nodes: [] };
              }
              log.push(`${method}:${params.behavior}`);
              return {};
            },
          }),
        }),
        goto: async (u: string) => {
          log.push(`goto:${u}`);
          const response = await goto(u);
          url = u;
          return response;
        },
        screenshot: async () => {
          log.push("screenshot");
          return new Uint8Array([0xff, 0xd8]);
        },
        // The page's own text, which a page can make say anything.
        evaluate: async () => {
          log.push("text");
          return "Pay your invoice here";
        },
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

  it("captures over HTTPS with downloads refused and the session closed, taking the page's signals", async () => {
    const b = fakeBrowser(async () => ok);
    expect(await browserCapture({} as Env["BROWSER"], "x.example", b.launch)).toMatchObject({
      text: "Pay your invoice here",
      url: "https://x.example/",
      signals: signalsOf,
    });
    // Downloads refused, the page opened, its tree read over the protocol either side of the screenshot, and the page's
    // own text, which runs the page's script, last of all (completion review round 3).
    expect(b.log).toEqual([
      "Browser.setDownloadBehavior:deny",
      "goto:https://x.example/",
      "DOM.getDocument:pierce",
      "Accessibility.getFullAXTree",
      "screenshot",
      "DOM.getDocument:pierce",
      "Accessibility.getFullAXTree",
      "text",
      "close",
    ]);
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
      "screen_failures",
      "first_seen",
      "last_seen",
      "status",
    ]);
    expect(await columns("monitor_runs")).toEqual(
      expect.arrayContaining([
        "deferred",
        "glimmer_json",
        "finished_at",
        "screened",
        "parked",
        "lures",
        "screen_failed",
        "screen_deferred",
      ]),
    );
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
