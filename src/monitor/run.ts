// One organisation's daily monitor run (D05 T04 §2; spec 4.11): its lookalike candidates (§1) resolved over DNS, the
// hosts that need it captured for §3 to screen, and the run recorded. The network, the browser and Glimmer come in as
// `MonitorDeps`, so the Workflow (./workflow.ts) gives the real ones and the tests their own.
//
// Corrections of the section: an organisation runs only while its protection is in effect and its plan has `monitor`,
// read when the run starts (12); a lookup that could not be made leaves the host's last observation untouched and is
// counted apart from a host that does not resolve (13). From the completion review:
// - a capture is owed while the host's DNS differs from the DNS of its last successful capture (`captured_dns_hash`),
//   so a run stopped between the DNS write and the capture leaves the capture owed, never lost (gap 5);
// - a failed capture (an HTTP error answer included, gap 6) is retried while under the failure limit, the count reset
//   when the DNS changes, and never replaces the last good capture;
// - refreshes are spread so every live capture is at most a week old: each run takes the oldest captures that the
//   next days' room cannot absorb, and at most `MAX_CAPTURES_PER_RUN` pages are captured a run (gap
//   8), anything left over counted as deferred in the run row;
// - Glimmer is woken only when there are pages to capture, before the first capture so its warm-up overlaps them, for
//   at most `SCREEN_CALLS_PER_RUN` pages, so the reservation fits the daily cap (gap 9); it is settled to the last
//   request this run sent (the wake's), and a settlement that fails is recorded and returned for the Workflow to retry
//   (gap 10);
// - the run row is written as `running` before anything else, finished with its real end time, and a failure of the
//   run itself is recorded and then thrown, so the Workflow step retries it (gap 11).
import { hasFeature } from "../auth/plans";
import { getIdentity, orgDomains } from "../trust/identity";
import { type Burst, REQUEST_MS, type Woken } from "../vision/glimmer-wake";
import { candidatesForBusiness } from "./candidates";

export const DNS_CONCURRENCY = 20;
export const REFRESH_DAYS = 7;
export const MAX_REFRESHES = 50;
export const MAX_CAPTURES_PER_RUN = 50;
export const MAX_CAPTURE_FAILURES = 5;
// Pages Glimmer is reserved for in one run: with its warm-up and tail, well inside the shared 30 daily minutes.
export const SCREEN_CALLS_PER_RUN = 15;
const DAY_MS = 24 * 60 * 60_000;
// A run a little earlier in the day than the last one still counts that capture as a day (or a week) old.
const EARLY_MS = 60 * 60_000;
const SAST_OFFSET_MS = 2 * 60 * 60_000;

export type Lookup =
  | { status: "resolves"; answers: string[] }
  | { status: "none" }
  | { status: "failed"; error: string };
// What the browser saw: the page as shown, its visible text, and the address it ended on (`https://` or `http://`).
export type Capture = { screenshot: Uint8Array; text: string; url: string };
// A capture the browser could make but that is no page to keep: an HTTP error answer, or no answer.
export class CaptureFailed extends Error {
  override name = "CaptureFailed";
}
export type Settled = { ok: true } | { ok: false; detail?: string } | unknown;
export type MonitorDeps = {
  db: D1Database;
  store: R2Bucket;
  resolve: (host: string) => Promise<Lookup>;
  capture: (host: string) => Promise<Capture>;
  // The wake's answer; a final one whose own settlement failed carries the reservation it left held, as `burst`.
  wake: (calls: number) => Promise<Woken | (Woken & { burst?: Burst })>;
  settle: (burst: Burst, until: number) => Promise<Settled>;
  now?: () => Date;
};
export type RunSummary = {
  outcome: "completed" | "partial" | "skipped" | "failed";
  resolved: number;
  notResolving: number;
  lookupFailed: number;
  captured: number;
  captureFailed: number;
  deferred: number;
  errors: string[];
  // A reservation still held because its settlement failed: the Workflow settles it again in its own step.
  unsettled?: Burst;
};

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
// The SAST day a moment falls on, as the run's key: South Africa keeps UTC+2 all year, so the date two hours ahead of
// UTC.
export const sastDay = (now: Date) => new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
const errorName = (error: unknown) =>
  error instanceof CaptureFailed ? error.message : (error as Error)?.name || "Error";

type HostRow = {
  domain: string;
  dns_hash: string | null;
  captured_at: string | null;
  captured_dns_hash: string | null;
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

// The run row, written `running` when the run starts (its counts zero), so an interrupted run is never missing.
async function startRun(db: D1Database, orgId: string, day: string, runId: string, at: Date) {
  await db
    .prepare(
      `INSERT INTO monitor_runs (org_id, day, run_id, outcome, started_at) VALUES (?, ?, ?, 'running', ?)
       ON CONFLICT (org_id, day) DO UPDATE SET run_id = excluded.run_id, outcome = 'running',
         started_at = excluded.started_at, finished_at = NULL`,
    )
    .bind(orgId, day, runId, at.toISOString())
    .run();
}

async function finishRun(db: D1Database, orgId: string, day: string, s: RunSummary, glimmer: unknown, at: Date) {
  await db
    .prepare(
      `UPDATE monitor_runs SET outcome = ?, resolved = ?, not_resolving = ?, lookup_failed = ?, captured = ?,
         capture_failed = ?, deferred = ?, errors_json = ?, glimmer_json = ?, finished_at = ?
       WHERE org_id = ? AND day = ?`,
    )
    .bind(
      s.outcome,
      s.resolved,
      s.notResolving,
      s.lookupFailed,
      s.captured,
      s.captureFailed,
      s.deferred,
      JSON.stringify(s.errors.slice(0, 20)),
      glimmer === undefined ? null : JSON.stringify(glimmer),
      at.toISOString(),
      orgId,
      day,
    )
    .run();
}

const noteError = (s: RunSummary, entry: string) => {
  if (!s.errors.includes(entry)) s.errors.push(entry);
};

// The pages this run captures: overdue refreshes first, then owed captures (new hosts and changed DNS), then the early
// refreshes that keep every capture under a week old, then retries of a failed capture, at most
// `MAX_CAPTURES_PER_RUN`; and how many of them all were left for the next run.
function choose(
  now: number,
  looked: { host: string; dnsHash: string; row: HostRow | undefined }[],
): { hosts: string[]; deferred: number } {
  const owed: string[] = [];
  const retries: string[] = [];
  const captured: { host: string; age: number }[] = [];
  for (const { host, dnsHash, row } of looked) {
    const failures = row && row.dns_hash === dnsHash ? row.capture_failures : 0;
    if (!row?.captured_at || row.captured_dns_hash !== dnsHash) {
      if (failures < MAX_CAPTURE_FAILURES) (failures ? retries : owed).push(host);
      continue;
    }
    if (failures > 0) {
      if (failures < MAX_CAPTURE_FAILURES) retries.push(host);
      continue;
    }
    captured.push({ host, age: now - Date.parse(row.captured_at) });
  }
  // The oldest first. A capture is due at a week; one due within k more days can still be taken on one of those k
  // days, each with room for `MAX_REFRESHES`, so today takes what those days cannot: for every k from 0 to 6, the
  // captures due within k days less k days' room. A lone capture is refreshed on its seventh day, a cohort spread
  // over the days before it (gap 8).
  captured.sort((a, b) => b.age - a.age);
  let take = 0;
  for (let k = 0; k < REFRESH_DAYS; k++) {
    const dueWithin = captured.filter((c) => c.age >= (REFRESH_DAYS - k) * DAY_MS - EARLY_MS).length;
    take = Math.max(take, dueWithin - k * MAX_REFRESHES);
  }
  // Every refresh needed today is counted (an outage can leave more than the limit), but at most `MAX_REFRESHES` run.
  // The overdue ones go before the owed captures, so DNS churn on some hosts never starves another's weekly refresh
  // (round 1); the early ones spread the next days' load after them.
  const needed = captured.slice(0, take).map((c) => c.host);
  const refreshes = needed.slice(0, MAX_REFRESHES);
  const overdue = captured.filter((c) => c.age >= REFRESH_DAYS * DAY_MS - EARLY_MS).length;
  const ordered = [...refreshes.slice(0, overdue), ...owed, ...refreshes.slice(overdue), ...retries];
  const hosts = ordered.slice(0, MAX_CAPTURES_PER_RUN);
  const chosen = new Set(hosts);
  const deferred = [...owed, ...needed, ...retries].filter((h) => !chosen.has(h)).length;
  return { hosts, deferred };
}

export async function monitorOrg(deps: MonitorDeps, orgId: string, runId: string): Promise<RunSummary> {
  const clock = deps.now ?? (() => new Date());
  const started = clock();
  const day = sastDay(started);
  const summary: RunSummary = {
    outcome: "completed",
    resolved: 0,
    notResolving: 0,
    lookupFailed: 0,
    captured: 0,
    captureFailed: 0,
    deferred: 0,
    errors: [],
  };
  await startRun(deps.db, orgId, day, runId, started);
  let woken: Woken | undefined;
  let failure: unknown;
  try {
    if (!(await monitored(deps.db, orgId))) {
      summary.outcome = "skipped";
      await finishRun(deps.db, orgId, day, summary, undefined, clock());
      return summary;
    }
    const domains = (await orgDomains(deps.db, orgId)).filter((d) => d.state === "verified").map((d) => d.domain);
    const candidates = candidatesForBusiness(domains);
    const at = started.toISOString();
    const known = new Map(
      (
        await deps.db
          .prepare(
            "SELECT domain, dns_hash, captured_at, captured_dns_hash, capture_failures FROM monitor_hosts WHERE org_id = ?",
          )
          .bind(orgId)
          .all<HostRow>()
      ).results.map((r) => [r.domain, r]),
    );
    const looked = await inBatches(candidates, DNS_CONCURRENCY, async (host) => ({
      host,
      lookup: await deps.resolve(host),
    }));
    const live: { host: string; dnsHash: string; row: HostRow | undefined }[] = [];
    const writes: D1PreparedStatement[] = [];
    // The failure count starts again when the DNS answers change.
    const observe = `ON CONFLICT (org_id, domain) DO UPDATE SET resolves = excluded.resolves, dns_hash = excluded.dns_hash,
         dns_at = excluded.dns_at, last_seen = CASE WHEN excluded.resolves = 1 THEN excluded.last_seen ELSE last_seen END,
         capture_failures = CASE WHEN dns_hash IS excluded.dns_hash THEN capture_failures ELSE 0 END`;
    for (const { host, lookup } of looked) {
      if (lookup.status === "failed") {
        summary.lookupFailed++;
        noteError(summary, `lookup:${lookup.error}`);
        continue;
      }
      const resolves = lookup.status === "resolves";
      const dnsHash = resolves ? await sha256([...lookup.answers].sort().join("\n")) : null;
      if (resolves) summary.resolved++;
      else summary.notResolving++;
      writes.push(
        deps.db
          .prepare(
            `INSERT INTO monitor_hosts (org_id, domain, resolves, dns_hash, dns_at, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?) ${observe}`,
          )
          .bind(orgId, host, resolves ? 1 : 0, dnsHash, at, at, at),
      );
      if (dnsHash) live.push({ host, dnsHash, row: known.get(host) });
    }
    // The observations are committed before any capture: a run stopped after this leaves the captures owed (gap 5).
    if (writes.length) await deps.db.batch(writes);
    const { hosts, deferred } = choose(started.getTime(), live);
    summary.deferred = deferred;
    const hashes = new Map(live.map((l) => [l.host, l.dnsHash]));
    // Glimmer's warm-up overlaps the captures, for the pages it may screen (§3); nothing to capture wakes nothing.
    if (hosts.length) woken = await deps.wake(Math.min(hosts.length, SCREEN_CALLS_PER_RUN));
    for (const host of hosts) {
      const moment = clock().toISOString();
      try {
        const capture = await deps.capture(host);
        const prefix = `monitor/${orgId}/${host}/${moment}/`;
        await deps.store.put(`${prefix}screenshot.jpg`, capture.screenshot);
        await deps.store.put(`${prefix}text.txt`, capture.text);
        await deps.db
          .prepare(
            `UPDATE monitor_hosts SET captured_at = ?, capture_key = ?, capture_url = ?, content_hash = ?,
               captured_dns_hash = ?, capture_failures = 0, capture_failed_at = NULL
             WHERE org_id = ? AND domain = ?`,
          )
          .bind(moment, prefix, capture.url, await sha256(capture.text), hashes.get(host), orgId, host)
          .run();
        summary.captured++;
      } catch (error) {
        summary.captureFailed++;
        noteError(summary, `capture:${errorName(error)}`);
        // The last good capture stays as it was; only the failure is counted.
        await deps.db
          .prepare(
            "UPDATE monitor_hosts SET capture_failed_at = ?, capture_failures = capture_failures + 1 WHERE org_id = ? AND domain = ?",
          )
          .bind(moment, orgId, host)
          .run();
      }
    }
    summary.outcome = summary.lookupFailed || summary.captureFailed || summary.deferred ? "partial" : "completed";
  } catch (error) {
    failure = error;
    summary.outcome = "failed";
    noteError(summary, `run:${(error as Error)?.name || "Error"}`);
  }
  // The reservation is settled whatever happened, to the deadline of the wake's own request, the last this run sent
  // (§3 settles after its screening when it runs here); a settlement that fails is recorded and handed back.
  let glimmer: unknown = woken;
  // A final answer to the wake (a missing deployment, a refused key, a bad answer) was settled by the wake itself; one
  // whose settlement failed is handed back like this run's own (round 1).
  const wakeSettled = woken as { outcome: string; settled?: boolean; burst?: Burst } | undefined;
  if (wakeSettled && wakeSettled.outcome !== "woken" && wakeSettled.settled === false) {
    noteError(summary, `settle:${wakeSettled.outcome}`);
    if (wakeSettled.burst) summary.unsettled = wakeSettled.burst;
    if (summary.outcome === "completed") summary.outcome = "partial";
  }
  if (woken?.outcome === "woken") {
    const until = woken.burst.wakeAt + REQUEST_MS;
    let detail: string | undefined;
    try {
      const result = (await deps.settle(woken.burst, until)) as { ok?: boolean; detail?: string } | undefined;
      if (result && result.ok === false) detail = result.detail ?? "refused";
    } catch (error) {
      detail = (error as Error)?.name || "Error";
    }
    glimmer = { ...woken, settled: detail === undefined, ...(detail ? { settleError: detail } : {}) };
    if (detail !== undefined) {
      noteError(summary, `settle:${detail}`);
      summary.unsettled = woken.burst;
      if (summary.outcome === "completed") summary.outcome = "partial";
    }
  }
  await finishRun(deps.db, orgId, day, summary, glimmer, clock());
  if (failure !== undefined) throw failure;
  return summary;
}
