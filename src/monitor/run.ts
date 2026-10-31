// One organisation's daily monitor run (D05 T04 §2; spec 4.11): its lookalike candidates (§1) resolved over DNS, the
// hosts that need it captured for §3 to screen, and the run recorded. The network, the browser and Glimmer come in as
// `MonitorDeps`, so the Workflow (./workflow.ts) gives the real ones and the tests their own.
//
// Corrections of the section: an organisation runs only while its protection is in effect and its plan has `monitor`,
// read when the run starts (12); Glimmer is woken before the first lookup and settled at the end, whatever happened
// (5, 10); a host is captured when it resolves and is new, its DNS answers changed, its last capture is over 7 days old
// (the 50 oldest a run), or its last capture failed (fewer than 5 times in a row) (2, 7, 8); a lookup that could not be
// made leaves the host's last observation untouched and is counted apart from a host that does not resolve (13).
import { hasFeature } from "../auth/plans";
import { getIdentity, orgDomains } from "../trust/identity";
import type { Burst, Woken } from "../vision/glimmer-wake";
import { candidatesForBusiness } from "./candidates";

export const DNS_CONCURRENCY = 20;
export const REFRESH_DAYS = 7;
export const MAX_REFRESHES = 50;
export const MAX_CAPTURE_FAILURES = 5;
const DAY_MS = 24 * 60 * 60_000;
const SAST_OFFSET_MS = 2 * 60 * 60_000;

export type Lookup =
  | { status: "resolves"; answers: string[] }
  | { status: "none" }
  | { status: "failed"; error: string };
export type Capture = { screenshot: Uint8Array; text: string };
export type MonitorDeps = {
  db: D1Database;
  store: R2Bucket;
  resolve: (host: string) => Promise<Lookup>;
  capture: (host: string) => Promise<Capture>;
  wake: (calls: number) => Promise<Woken>;
  settle: (burst: Burst) => Promise<unknown>;
  now?: () => Date;
};
export type RunSummary = {
  outcome: "completed" | "partial" | "skipped" | "failed";
  resolved: number;
  notResolving: number;
  lookupFailed: number;
  captured: number;
  captureFailed: number;
  errors: string[];
};

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
// The SAST day a moment falls on, as the run's key: South Africa keeps UTC+2 all year, so the date two hours ahead of
// UTC (`sastDayStart` gives the day's start as a UTC instant, the previous calendar date at 22:00).
export const sastDay = (now: Date) => new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);

type HostRow = {
  domain: string;
  dns_hash: string | null;
  captured_at: string | null;
  capture_failures: number;
};

// Whether an organisation is monitored now: protection in effect and `monitor` in its plan.
export async function monitored(db: D1Database, orgId: string): Promise<boolean> {
  const identity = await getIdentity(db, orgId);
  if (!identity?.effective.on) return false;
  return hasFeature(db, orgId, "monitor");
}

// The organisations to dispatch today: every identity with protection switched on (each run checks again when it
// starts, so this list may be generous).
export async function protectedOrgs(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare("SELECT org_id FROM identities WHERE protected = 1 ORDER BY org_id")
    .all<{ org_id: string }>();
  return rows.results.map((r) => r.org_id);
}

async function inBatches<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(work))));
  return out;
}

async function writeRun(
  db: D1Database,
  orgId: string,
  day: string,
  runId: string,
  s: RunSummary,
  glimmer: unknown,
  now: Date,
) {
  await db
    .prepare(
      `INSERT INTO monitor_runs (org_id, day, run_id, outcome, resolved, not_resolving, lookup_failed, captured, capture_failed,
         errors_json, glimmer_json, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (org_id, day) DO UPDATE SET run_id = excluded.run_id, outcome = excluded.outcome,
         resolved = excluded.resolved, not_resolving = excluded.not_resolving, lookup_failed = excluded.lookup_failed,
         captured = excluded.captured, capture_failed = excluded.capture_failed, errors_json = excluded.errors_json,
         glimmer_json = excluded.glimmer_json, finished_at = excluded.finished_at`,
    )
    .bind(
      orgId,
      day,
      runId,
      s.outcome,
      s.resolved,
      s.notResolving,
      s.lookupFailed,
      s.captured,
      s.captureFailed,
      JSON.stringify(s.errors.slice(0, 20)),
      glimmer === undefined ? null : JSON.stringify(glimmer),
      now.toISOString(),
      now.toISOString(),
    )
    .run();
}

export async function monitorOrg(deps: MonitorDeps, orgId: string, runId: string): Promise<RunSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const day = sastDay(now);
  const summary: RunSummary = {
    outcome: "completed",
    resolved: 0,
    notResolving: 0,
    lookupFailed: 0,
    captured: 0,
    captureFailed: 0,
    errors: [],
  };
  if (!(await monitored(deps.db, orgId))) {
    await writeRun(deps.db, orgId, day, runId, { ...summary, outcome: "skipped" }, undefined, now);
    return { ...summary, outcome: "skipped" };
  }
  const domains = (await orgDomains(deps.db, orgId)).filter((d) => d.state === "verified").map((d) => d.domain);
  const candidates = candidatesForBusiness(domains);
  // Glimmer's warm-up overlaps the lookups: woken before the first one (correction 5).
  const woken = await deps.wake(candidates.length);
  try {
    const at = now.toISOString();
    const known = new Map(
      (
        await deps.db
          .prepare("SELECT domain, dns_hash, captured_at, capture_failures FROM monitor_hosts WHERE org_id = ?")
          .bind(orgId)
          .all<HostRow>()
      ).results.map((r) => [r.domain, r]),
    );
    const looked = await inBatches(candidates, DNS_CONCURRENCY, async (host) => ({
      host,
      lookup: await deps.resolve(host),
    }));
    const toCapture: string[] = [];
    const stale: { host: string; at: string }[] = [];
    const writes: D1PreparedStatement[] = [];
    for (const { host, lookup } of looked) {
      const row = known.get(host);
      if (lookup.status === "failed") {
        summary.lookupFailed++;
        if (!summary.errors.includes(`lookup:${lookup.error}`)) summary.errors.push(`lookup:${lookup.error}`);
        continue;
      }
      if (lookup.status === "none") {
        summary.notResolving++;
        writes.push(
          deps.db
            .prepare(
              `INSERT INTO monitor_hosts (org_id, domain, resolves, dns_hash, dns_at, first_seen, last_seen)
               VALUES (?, ?, 0, NULL, ?, ?, ?)
               ON CONFLICT (org_id, domain) DO UPDATE SET resolves = 0, dns_hash = NULL, dns_at = excluded.dns_at`,
            )
            .bind(orgId, host, at, at, at),
        );
        continue;
      }
      summary.resolved++;
      const dnsHash = await sha256([...lookup.answers].sort().join("\n"));
      writes.push(
        deps.db
          .prepare(
            `INSERT INTO monitor_hosts (org_id, domain, resolves, dns_hash, dns_at, first_seen, last_seen)
             VALUES (?, ?, 1, ?, ?, ?, ?)
             ON CONFLICT (org_id, domain) DO UPDATE SET resolves = 1, dns_hash = excluded.dns_hash,
               dns_at = excluded.dns_at, last_seen = excluded.last_seen`,
          )
          .bind(orgId, host, dnsHash, at, at, at),
      );
      // New or its answers changed: captured. Never captured, or its last capture failed: retried while under the
      // failure limit. Otherwise a capture over a week old joins the bounded refresh.
      if (!row || row.dns_hash !== dnsHash) toCapture.push(host);
      else if (!row.captured_at || row.capture_failures > 0) {
        if (row.capture_failures < MAX_CAPTURE_FAILURES) toCapture.push(host);
      } else if (now.getTime() - Date.parse(row.captured_at) > REFRESH_DAYS * DAY_MS)
        stale.push({ host, at: row.captured_at });
    }
    // The week-old captures, the oldest first, bounded (correction 7).
    stale.sort((a, b) => a.at.localeCompare(b.at));
    toCapture.push(...stale.slice(0, MAX_REFRESHES).map((s) => s.host));
    if (writes.length) await deps.db.batch(writes);
    for (const host of toCapture) {
      try {
        const capture = await deps.capture(host);
        const prefix = `monitor/${orgId}/${host}/${at}/`;
        await deps.store.put(`${prefix}screenshot.jpg`, capture.screenshot);
        await deps.store.put(`${prefix}text.txt`, capture.text);
        await deps.db
          .prepare(
            `UPDATE monitor_hosts SET captured_at = ?, capture_key = ?, content_hash = ?, capture_failures = 0, capture_failed_at = NULL
             WHERE org_id = ? AND domain = ?`,
          )
          .bind(at, prefix, await sha256(capture.text), orgId, host)
          .run();
        summary.captured++;
      } catch (error) {
        summary.captureFailed++;
        const name = (error as Error).name || "Error";
        if (!summary.errors.includes(`capture:${name}`)) summary.errors.push(`capture:${name}`);
        await deps.db
          .prepare(
            "UPDATE monitor_hosts SET capture_failed_at = ?, capture_failures = capture_failures + 1 WHERE org_id = ? AND domain = ?",
          )
          .bind(at, orgId, host)
          .run();
      }
    }
    summary.outcome = summary.lookupFailed || summary.captureFailed ? "partial" : "completed";
  } catch (error) {
    summary.outcome = "failed";
    summary.errors.push(`run:${(error as Error).name || "Error"}`);
  } finally {
    // The reservation is settled whatever happened, so an unused one never eats the next run's allowance (correction
    // 10); §3 settles after screening when it runs in this Workflow.
    if (woken.outcome === "woken") await deps.settle(woken.burst).catch(() => undefined);
  }
  await writeRun(deps.db, orgId, day, runId, summary, woken, now);
  return summary;
}
