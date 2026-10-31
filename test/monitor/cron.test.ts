// The impersonation monitor's daily run (D05 T04 §2): Glimmer woken before the first lookup and settled at the end,
// hosts captured when new, their DNS changed, their capture a week old or failed (and retried), captures kept in R2
// for §3, a failed lookup leaving a host's state alone, eligibility read when the run starts, each run recorded, and
// the daily dispatch across organisations, repeated ticks, the next day and a failed creation.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setPlan } from "../../src/auth/plans";
import { candidatesForBusiness } from "../../src/monitor/candidates";
import {
  type Capture,
  type Lookup,
  MAX_CAPTURE_FAILURES,
  type MonitorDeps,
  monitorOrg,
  sastDay,
} from "../../src/monitor/run";
import { dohLookup, scheduledMonitor } from "../../src/monitor/workflow";
import { FORWARD_CRON, MAIN_CRON, MONITOR_CRON, RETRY_CRON } from "../../src/schedules";
import { setIdentity } from "../../src/trust/identity";
import type { Burst, Woken } from "../../src/vision/glimmer-wake";
import { protectableOrg } from "../trust/helpers";

const db = env.DB;
const DAY_MS = 24 * 60 * 60_000;
let n = 0;

async function business() {
  const tag = `${++n}${crypto.randomUUID().slice(0, 6)}`;
  const domain = `fynbos${tag}.co.za`;
  const contact = `accounts@${domain}`;
  const orgId = await protectableOrg(domain, contact, `Fynbos ${tag}`);
  await setIdentity(db, orgId, "owner", { displayNames: ["Fynbos"], financeContact: contact, protected: true });
  return { orgId, domain, contact, candidates: candidatesForBusiness([domain]) };
}

// A world the run talks to: DNS answers by host, captures that succeed or fail by host, and a log of every call.
function world(at: Date) {
  const calls: string[] = [];
  const answers = new Map<string, Lookup>();
  const failing = new Set<string>();
  const settled: Burst[] = [];
  let now = at;
  const burst: Burst = { id: "burst-1", wakeAt: at.getTime(), deadline: at.getTime() + 60_000 };
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
      if (failing.has(host)) throw new Error("browser timed out");
      return { screenshot: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), text: `page of ${host} at ${now.toISOString()}` };
    },
    wake: async (count): Promise<Woken> => {
      calls.push(`wake:${count}`);
      return { outcome: "woken", burst, reused: false, first: null };
    },
    settle: async (b) => {
      calls.push("settle");
      settled.push(b);
    },
  };
  return {
    deps,
    calls,
    answers,
    failing,
    settled,
    later: (days: number) => (now = new Date(now.getTime() + days * DAY_MS)),
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

describe("one organisation's run", () => {
  it("wakes Glimmer before the first lookup, captures a new live host for §3, settles, and records the run", async () => {
    const b = await business();
    const w = world(new Date("2026-11-02T04:15:00Z"));
    const live = b.candidates[0] as string;
    w.answers.set(live, { status: "resolves", answers: ["192.0.2.10"] });
    const summary = await monitorOrg(w.deps, b.orgId, "run-1");
    expect(w.calls[0]).toBe(`wake:${b.candidates.length}`);
    expect(w.calls[1]?.startsWith("dns:")).toBe(true);
    expect(w.calls.filter((c) => c.startsWith("capture:"))).toEqual([`capture:${live}`]);
    expect(w.calls.at(-1)).toBe("settle");
    expect(summary).toMatchObject({ outcome: "completed", resolved: 1, captured: 1, lookupFailed: 0 });
    const row = await host(b.orgId, live);
    expect(row).toMatchObject({ resolves: 1, capture_failures: 0 });
    const prefix = row?.capture_key as string;
    expect(prefix.startsWith(`monitor/${b.orgId}/${live}/`)).toBe(true);
    expect(await (await env.ARTEFACTS.get(`${prefix}text.txt`))?.text()).toContain(`page of ${live}`);
    expect((await env.ARTEFACTS.get(`${prefix}screenshot.jpg`)) !== null).toBe(true);
    expect(await runRow(b.orgId)).toMatchObject({ outcome: "completed", resolved: 1, captured: 1, day: "2026-11-02" });
  });

  it("leaves an unchanged host alone, captures one whose DNS changed, and a week-old one behind identical DNS", async () => {
    const b = await business();
    const w = world(new Date("2026-11-02T04:15:00Z"));
    const [parked, moved] = b.candidates as [string, string];
    w.answers.set(parked, { status: "resolves", answers: ["192.0.2.20"] });
    w.answers.set(moved, { status: "resolves", answers: ["192.0.2.30"] });
    await monitorOrg(w.deps, b.orgId, "day-1");
    w.calls.length = 0;
    w.later(1);
    w.answers.set(moved, { status: "resolves", answers: ["198.51.100.30"] });
    await monitorOrg(w.deps, b.orgId, "day-2");
    expect(w.calls.filter((c) => c.startsWith("capture:"))).toEqual([`capture:${moved}`]);
    // The parked page becomes a lure behind the same DNS: captured again once its capture is over a week old.
    w.calls.length = 0;
    w.later(7);
    await monitorOrg(w.deps, b.orgId, "day-9");
    expect(w.calls).toContain(`capture:${parked}`);
  });

  it("retries a failed capture the next run, from a fresh start, and stops at the failure limit", async () => {
    const b = await business();
    const w = world(new Date("2026-11-02T04:15:00Z"));
    const live = b.candidates[0] as string;
    w.answers.set(live, { status: "resolves", answers: ["192.0.2.40"] });
    w.failing.add(live);
    expect(await monitorOrg(w.deps, b.orgId, "r1")).toMatchObject({ outcome: "partial", captureFailed: 1 });
    expect(await host(b.orgId, live)).toMatchObject({ capture_failures: 1, captured_at: null });
    // A new Workflow instance (a restart) reads the state back and retries; this time the page answers.
    w.failing.delete(live);
    const fresh = world(new Date("2026-11-03T04:15:00Z"));
    fresh.answers.set(live, { status: "resolves", answers: ["192.0.2.40"] });
    expect(await monitorOrg(fresh.deps, b.orgId, "r2")).toMatchObject({ captured: 1 });
    expect(await host(b.orgId, live)).toMatchObject({ capture_failures: 0 });
    // A host that keeps failing is retried until the limit, then left for a DNS change.
    const stubborn = b.candidates[1] as string;
    fresh.answers.set(stubborn, { status: "resolves", answers: ["192.0.2.41"] });
    fresh.failing.add(stubborn);
    for (let i = 0; i < MAX_CAPTURE_FAILURES + 1; i++) {
      fresh.later(1);
      await monitorOrg(fresh.deps, b.orgId, `s${i}`);
    }
    expect(await host(b.orgId, stubborn)).toMatchObject({ capture_failures: MAX_CAPTURE_FAILURES });
  });

  it("keeps a host's last observation when its lookup fails, counted apart from a host that does not resolve", async () => {
    const b = await business();
    const w = world(new Date("2026-11-02T04:15:00Z"));
    const [live, gone] = b.candidates as [string, string];
    w.answers.set(live, { status: "resolves", answers: ["192.0.2.50"] });
    await monitorOrg(w.deps, b.orgId, "a");
    const before = await host(b.orgId, live);
    w.later(1);
    w.answers.set(live, { status: "failed", error: "TimeoutError" });
    w.answers.set(gone, { status: "none" });
    const summary = await monitorOrg(w.deps, b.orgId, "b");
    expect(summary).toMatchObject({ outcome: "partial", lookupFailed: 1 });
    expect(summary.notResolving).toBe(b.candidates.length - 1);
    expect(await host(b.orgId, live)).toEqual(before);
    expect(await runRow(b.orgId)).toMatchObject({ outcome: "partial", lookup_failed: 1 });
  });

  it("settles Glimmer even when nothing was captured", async () => {
    const b = await business();
    const w = world(new Date("2026-11-02T04:15:00Z"));
    await monitorOrg(w.deps, b.orgId, "quiet");
    expect(w.settled).toHaveLength(1);
    expect(w.calls.some((c) => c.startsWith("capture:"))).toBe(false);
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
      const w = world(new Date("2026-11-02T04:15:00Z"));
      expect(await monitorOrg(w.deps, b.orgId, `skip-${lose}`), lose).toMatchObject({ outcome: "skipped" });
      expect(w.calls, lose).toEqual([]);
      expect(await runRow(b.orgId), lose).toMatchObject({ outcome: "skipped" });
    }
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
      "capture_failed_at",
      "capture_failures",
      "first_seen",
      "last_seen",
      "status",
    ]);
    expect(await columns("monitor_runs")).toContain("glimmer_json");
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
  it("starts one instance per organisation a day, goes on past a failed creation, and starts again the next day", async () => {
    await db.prepare("UPDATE identities SET protected = 0").run();
    const orgs = [await business(), await business(), await business()];
    const created = new Set<string>();
    const lines: string[] = [];
    const failingOrg = orgs[1]?.orgId as string;
    const MONITOR = {
      create: async (options: { id: string; params: { orgId: string } }) => {
        if (options.params.orgId === failingOrg && !created.has("retry")) throw new Error("internal error");
        if (created.has(options.id)) throw new Error("instance.already_exists");
        created.add(options.id);
        return { id: options.id };
      },
    } as unknown as Env["MONITOR"];
    const day1 = new Date("2026-11-02T04:15:00Z");
    expect(await scheduledMonitor({ DB: db, MONITOR }, day1, (l) => lines.push(l))).toEqual({
      started: 2,
      existing: 0,
      failed: 1,
    });
    expect(lines.join("\n")).toContain('"outcome":"failed"');
    created.add("retry");
    expect(await scheduledMonitor({ DB: db, MONITOR }, day1, (l) => lines.push(l))).toEqual({
      started: 1,
      existing: 2,
      failed: 0,
    });
    const day2 = new Date(day1.getTime() + DAY_MS);
    expect(await scheduledMonitor({ DB: db, MONITOR }, day2, (l) => lines.push(l))).toEqual({
      started: 3,
      existing: 0,
      failed: 0,
    });
  });

  it("adds the daily cron to the three existing ones, each dispatched on its own", () => {
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
    ).toEqual({
      status: "failed",
      error: "http-503",
    });
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
