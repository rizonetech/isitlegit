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
// - every live host is captured and screened again each day (D05 T04 §8, superseding the weekly refresh): new and changed
//   hosts first, then retries, then the unchanged ones oldest capture first, at most `MAX_CAPTURES_PER_RUN` a run,
//   anything left over counted as deferred in the run row;
// - Glimmer is woken only when there are pages to capture, before the first capture so its warm-up overlaps them, for
//   at most `SCREEN_CALLS_PER_RUN` pages, so the reservation fits the daily cap (gap 9); it is settled to the last
//   request this run sent (the wake's), and a settlement that fails is recorded and returned for the Workflow to retry
//   (gap 10);
// - the run row is written as `running` before anything else, finished with its real end time, and a failure of the
//   run itself is recorded and then thrown, so the Workflow step retries it (gap 11).
import { hasFeature } from "../auth/plans";
import { getIdentity, orgDomains } from "../trust/identity";
import type { Burst } from "../vision/glimmer-wake";
import type { GlimmerSession } from "../vision/screen";
import { candidatesForBusiness, MAX_CANDIDATES } from "./candidates";
import { brandTokens, type CtResult } from "./ct";
import type { Signals } from "./parked";
import { MAX_SCREENS_PER_RUN, newScreenCounts, owedDomains, type ScreenDeps, screenOwed } from "./screen";
import { inactiveSeedHosts, seedsFor } from "./seeds";

export const DNS_CONCURRENCY = 20;
export const MAX_CAPTURES_PER_RUN = 50;
export const MAX_CAPTURE_FAILURES = 5;
// The day's captures are shared (D05 T04 §8, correction 6): at most this many go to new, changed and retried hosts, so
// at least `MAX_CAPTURES_PER_RUN - OWED_SLOTS` are held for the unchanged ones, each class lending the other its unused
// slots. Sustained DNS churn on any number of hosts cannot starve the unchanged ones.
export const OWED_SLOTS = 30;
// At most this many of the day's screenings go to the backlog before the captures (correction 7), the rest being held
// for the pages this run captures, so a lure that changed today is never behind a backlog.
export const SCREEN_BACKLOG_SHARE = 25;
// Pages Glimmer is reserved for in one run: with its warm-up and tail, well inside the shared 30 daily minutes.
export const SCREEN_CALLS_PER_RUN = 15;
const DAY_MS = 24 * 60 * 60_000;
// A run a little earlier in the day than the last one still counts that capture as a day old.
const EARLY_MS = 60 * 60_000;
const SAST_OFFSET_MS = 2 * 60 * 60_000;

export type Lookup =
  | { status: "resolves"; answers: string[] }
  | { status: "none" }
  | { status: "failed"; error: string };
// What the browser saw: the page as shown, its visible text, the address it ended on (`https://` or `http://`), and what
// it counted on the page (inputs, forms, frames), which the parking rules need (§3), or null when it could not.
export type Capture = {
  screenshot: Uint8Array;
  text: string;
  url: string;
  signals: Signals | null;
  // The page's text from the browser's own tree, the only text the parking rules read; null with no signals.
  parkText: string | null;
};
// A capture the browser could make but that is no page to keep: an HTTP error answer, or no answer.
export class CaptureFailed extends Error {
  override name = "CaptureFailed";
}
export type Settled = { ok: true } | { ok: false; detail?: string } | unknown;
export type MonitorDeps = ScreenDeps & {
  resolve: (host: string) => Promise<Lookup>;
  // Certificate-transparency candidates for the day's brand tokens (D05 T04 §7); absent in
  // tests that do not exercise it, stated as failed tokens on the run when a query fails.
  ct?: (tokens: string[]) => Promise<CtResult>;
  // Capture of a seeded host's page path (D05 T04 §6), applying the fixtures prefix in the
  // Worker; absent, a seed host is captured at its root like any other.
  captureSeed?: (host: string, path: string) => Promise<Capture>;
  capture: (host: string) => Promise<Capture>;
  // The run's one Loupe session (D03 T04 §1), opened for this many pages before the first capture so its warm-up
  // overlaps them, and closed after the screening; a failed close is handed to the Workflow's settle step.
  open: (calls: number) => Promise<GlimmerSession>;
  close: (session: GlimmerSession) => Promise<Settled>;
  // The settle step's own settlement of a burst the run could not settle, to the cutoff the run named.
  settle: (burst: Burst, until: number) => Promise<Settled>;
  // Waits for what a model call left to write (the Spark call's budget record) before the step ends.
  flush?: () => Promise<unknown>;
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
  screened: number;
  parked: number;
  lures: number;
  screenFailed: number;
  screenDeferred: number;
  // Flags Spark's second look declined, and flags it could not look at (they stand), read back from the store for the
  // run's South African day, so a retried run reports what an earlier attempt stored (D05 T04 §9, correction 8).
  luresDeclined: number;
  secondLookUnavailable: number;
  // Live hosts at the capture-failure limit, probed once a day: while any is, the run is partial (correction 8).
  captureBlocked: number;
  // Brand tokens whose CT query failed today (D05 T04 §7): while any is, the run is partial.
  ctFailed: number;
  // Candidates the shared cap deferred today (D05 T04 §7): visible, and the run is partial.
  candidatesDeferred: number;
  errors: string[];
  // A reservation still held because its settlement failed: the Workflow settles it again in its own step.
  // `until` is the cutoff a failed settlement was to land on (D03 T04 §40), so the retry charges the same moment.
  unsettled?: Burst & { until?: number };
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
  capture_failed_at: string | null;
  last_seen?: string | null;
  dns_at?: string | null;
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
         capture_failed = ?, deferred = ?, screened = ?, parked = ?, lures = ?, screen_failed = ?, screen_deferred = ?,
         lures_declined = ?, second_look_unavailable = ?, errors_json = ?, glimmer_json = ?, finished_at = ?
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
      s.screened,
      s.parked,
      s.lures,
      s.screenFailed,
      s.screenDeferred,
      s.luresDeclined,
      s.secondLookUnavailable,
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

// The pages this run captures (D05 T04 §8): the 50 slots are shared by two classes, each ordered by how long the host has
// waited since its last attempt, the longest first (a host never captured first of all). The first class is the new,
// changed and retried hosts, and the failure-limit probes (a host at the limit, once a day after its last attempt); the
// second is every unchanged live host whose last capture is a day old or more. At most `OWED_SLOTS` go to the first
// class and at least the rest are held for the second, each lending what it does not use, so neither starves the other
// and no host in either waits for ever: a retry that has waited longest beats a host that changes daily. `blocked` is the
// live hosts at the failure limit, probed or not; the run settles the final count after its captures.
function choose(
  now: number,
  looked: { host: string; dnsHash: string; row: HostRow | undefined }[],
  seedHosts: ReadonlySet<string> = new Set(),
): { hosts: string[]; deferred: number; blocked: Set<string> } {
  type Waiting = { host: string; age: number };
  const wanted: Waiting[] = [];
  const due: Waiting[] = [];
  const blocked = new Set<string>();
  for (const { host, dnsHash, row } of looked) {
    const failures = row && row.dns_hash === dnsHash ? row.capture_failures : 0;
    // How long since the host was last tried: its last capture or its last failed attempt, the later of the two.
    const tried = Math.max(
      row?.captured_at ? Date.parse(row.captured_at) : Number.NEGATIVE_INFINITY,
      row?.capture_failed_at ? Date.parse(row.capture_failed_at) : Number.NEGATIVE_INFINITY,
    );
    const age = Number.isFinite(tried) ? now - tried : Number.POSITIVE_INFINITY;
    if (failures >= MAX_CAPTURE_FAILURES) {
      // Still live and still failing, whether or not it was ever captured: counted, and probed again once a day after
      // the last attempt (a site back on the same address is seen again).
      blocked.add(host);
      if (age >= DAY_MS - EARLY_MS) wanted.push({ host, age });
      continue;
    }
    if (!row?.captured_at || row.captured_dns_hash !== dnsHash || failures > 0) {
      wanted.push({ host, age });
      continue;
    }
    if (age >= DAY_MS - EARLY_MS) due.push({ host, age });
  }
  const longest = (a: Waiting, b: Waiting) =>
    Number(seedHosts.has(b.host)) - Number(seedHosts.has(a.host)) || b.age - a.age || a.host.localeCompare(b.host);
  wanted.sort(longest);
  due.sort(longest);
  const takeWanted = Math.min(
    wanted.length,
    MAX_CAPTURES_PER_RUN - Math.min(due.length, MAX_CAPTURES_PER_RUN - OWED_SLOTS),
  );
  const takeDue = Math.min(due.length, MAX_CAPTURES_PER_RUN - takeWanted);
  return {
    hosts: [...wanted.slice(0, takeWanted), ...due.slice(0, takeDue)].map((w) => w.host),
    deferred: wanted.length - takeWanted + due.length - takeDue,
    blocked,
  };
}

// What the settle step must settle when the close failed: a burst the wake or the warm-up could not settle, to its own
// cutoff, or the run's burst to the cutoff `closeGlimmer` used (Loupe's last request, else the end of the reserved
// window, never later).
function obligation(session: GlimmerSession): Burst & { until: number } {
  if (!session.burst && session.unsettled) return { ...session.unsettled.burst, until: session.unsettled.until };
  const burst = session.burst as Burst;
  return { ...burst, until: session.lastRequestEnd ?? Math.max(session.reservedUntil, burst.deadline) };
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
    screened: 0,
    parked: 0,
    lures: 0,
    screenFailed: 0,
    screenDeferred: 0,
    luresDeclined: 0,
    secondLookUnavailable: 0,
    captureBlocked: 0,
    ctFailed: 0,
    candidatesDeferred: 0,
    errors: [],
  };
  await startRun(deps.db, orgId, day, runId, started);
  let session: GlimmerSession | null = null;
  let calls = 0;
  let failure: unknown;
  try {
    if (!(await monitored(deps.db, orgId))) {
      summary.outcome = "skipped";
      await finishRun(deps.db, orgId, day, summary, undefined, clock());
      return summary;
    }
    const domains = (await orgDomains(deps.db, orgId)).filter((d) => d.state === "verified").map((d) => d.domain);
    const generated = candidatesForBusiness(domains);
    const at = started.toISOString();
    const known = new Map(
      (
        await deps.db
          .prepare(
            "SELECT domain, dns_hash, captured_at, captured_dns_hash, capture_failures, capture_failed_at, last_seen, dns_at FROM monitor_hosts WHERE org_id = ?",
          )
          .bind(orgId)
          .all<HostRow>()
      ).results.map((r) => [r.domain, r]),
    );
    // CT discoveries join the candidates before DNS (D05 T04 §7): first in the shared cap,
    // deduped, the business's own domains and subdomains never among them. Known hosts that
    // match a token stay monitored on later days even when CT later answers empty or fails.
    const identity = await getIdentity(deps.db, orgId).catch(() => null);
    const tokens = brandTokens(identity?.displayNames ?? [], domains);
    let ctNames: string[] = [];
    if (deps.ct && tokens.length) {
      const ct = await deps.ct(tokens).catch((): CtResult => ({ names: [], failed: tokens }));
      ctNames = ct.names;
      summary.ctFailed = ct.failed.length;
      for (const token of ct.failed) noteError(summary, `ct:${token}`);
    }
    const own = new Set(domains);
    const isOwn = (host: string) => domains.some((d) => host === d || host.endsWith(`.${d}`));
    const seeds = await seedsFor(deps.db, orgId).catch(() => []);
    const inactiveSeeds = await inactiveSeedHosts(deps.db, orgId, seeds).catch(() => new Set<string>());
    for (const host of inactiveSeeds) known.delete(host);
    const seedPaths = new Map(seeds.filter((s) => !own.has(s.host)).map((s) => [s.host, s.path]));
    const seedHostSet = new Set(seedPaths.keys());
    const knownCt = [...known.keys()].filter(
      (host) => tokens.some((token) => host.includes(token)) && !isOwn(host) && !inactiveSeeds.has(host),
    );
    // Inside the shared cap, active demo seeds stay pinned at the front so the rotating daily
    // window never drops a seeded fixture host when the candidate list exceeds 300.
    const rotatable = [...new Set([...knownCt, ...ctNames.filter((h) => !isOwn(h)), ...generated])].filter(
      (h) => !own.has(h) && !seedHostSet.has(h) && !inactiveSeeds.has(h),
    );
    // The window advances by a full cap each day, so a saturated list covers every host in
    // turn (a 5,000-host list in 17 days) instead of rechecking the same first 300; hosts
    // whose lookups fail rotate with everyone else.
    const dayIndex = Math.floor(started.getTime() / 86_400_000);
    const offset = rotatable.length ? (dayIndex * MAX_CANDIDATES) % rotatable.length : 0;
    const ordered = [...seedHostSet, ...rotatable.slice(offset), ...rotatable.slice(0, offset)];
    const candidates = ordered.slice(0, MAX_CANDIDATES);
    summary.candidatesDeferred = ordered.length - candidates.length;
    if (summary.candidatesDeferred > 0) noteError(summary, `ct:deferred:${summary.candidatesDeferred}`);
    // A CT discovery persists before any lookup (D05 T04 §7): a failed lookup today and an
    // empty CT answer tomorrow never lose it.
    const discovered = ctNames.filter((h) => !isOwn(h) && !inactiveSeeds.has(h) && !known.has(h));
    if (discovered.length)
      await deps.db.batch(
        discovered.map((host) =>
          deps.db
            .prepare(
              `INSERT INTO monitor_hosts (org_id, domain, resolves, first_seen, last_seen) VALUES (?, ?, 0, ?, ?)
               ON CONFLICT (org_id, domain) DO NOTHING`,
            )
            .bind(orgId, host, at, at),
        ),
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
    const { hosts, deferred, blocked } = choose(started.getTime(), live, seedHostSet);
    summary.deferred = deferred;
    // The hosts at the failure limit as the run ends, not as it began: a fifth failure today enters, a recovery leaves.
    const failuresBefore = new Map(
      live.map((l) => [l.host, l.row && l.row.dns_hash === l.dnsHash ? l.row.capture_failures : 0]),
    );
    const hashes = new Map(live.map((l) => [l.host, l.dnsHash]));
    // Loupe's warm-up overlaps the captures, sized by the screening workload (§3, correction 13): the hosts to capture
    // and the backlog already owed a screening, each once; nothing to capture and nothing owed wakes nothing.
    const owed = (await owedDomains(deps.db, orgId)).filter((d) => !inactiveSeeds.has(d));
    const workload = new Set([...hosts, ...owed]);
    calls = Math.min(workload.size, SCREEN_CALLS_PER_RUN);
    if (workload.size) session = await deps.open(calls);
    // The pages already captured and owed a screening go first, while the session is warm and before the slow captures:
    // their results do not wait for the batch (completion review G3), but at most `SCREEN_BACKLOG_SHARE` of the day's 50,
    // the rest held for the pages this run captures (D05 T04 §8, correction 7). A host about to be captured again is
    // left, its old page never worth a call.
    const screening = newScreenCounts();
    if (session)
      await screenOwed(deps, orgId, runId, session, clock, {
        into: screening,
        skip: new Set([...hosts, ...inactiveSeeds]),
        limit: SCREEN_BACKLOG_SHARE,
      });
    for (const host of hosts) {
      let stored = false;
      const moment = clock().toISOString();
      try {
        const capture =
          seedPaths.has(host) && deps.captureSeed
            ? await deps.captureSeed(host, seedPaths.get(host) as string)
            : await deps.capture(host);
        const prefix = `monitor/${orgId}/${host}/${moment}/`;
        await deps.store.put(`${prefix}screenshot.jpg`, capture.screenshot);
        await deps.store.put(`${prefix}text.txt`, capture.text);
        if (capture.url) await deps.store.put(`${prefix}url.txt`, capture.url);
        // What the parking rules read: the counts and the tree's own text, or null, which screens the page.
        await deps.store.put(
          `${prefix}signals.json`,
          JSON.stringify(
            capture.signals && capture.parkText !== null ? { ...capture.signals, text: capture.parkText } : null,
          ),
        );
        await deps.db
          .prepare(
            `UPDATE monitor_hosts SET captured_at = ?, capture_key = ?, capture_url = ?, content_hash = ?,
               captured_dns_hash = ?, capture_failures = 0, capture_failed_at = NULL, screen_failures = 0
             WHERE org_id = ? AND domain = ?`,
          )
          .bind(moment, prefix, capture.url, await sha256(capture.text), hashes.get(host), orgId, host)
          .run();
        summary.captured++;
        blocked.delete(host);
        stored = true;
      } catch (error) {
        summary.captureFailed++;
        noteError(summary, `capture:${errorName(error)}`);
        if ((failuresBefore.get(host) ?? 0) + 1 >= MAX_CAPTURE_FAILURES) blocked.add(host);
        // The last good capture stays as it was; only the failure is counted.
        await deps.db
          .prepare(
            "UPDATE monitor_hosts SET capture_failed_at = ?, capture_failures = capture_failures + 1 WHERE org_id = ? AND domain = ?",
          )
          .bind(moment, orgId, host)
          .run();
      }
      // The page is screened as soon as it is captured, so a lure captured first never waits for the slow hosts after it
      // (completion review E1), within what is left of the 50 a run.
      if (stored)
        await screenOwed(deps, orgId, runId, session, clock, {
          into: screening,
          only: [host],
          limit: MAX_SCREENS_PER_RUN - screening.tried.size,
        });
    }
    summary.captureBlocked = blocked.size;
    if (blocked.size) noteError(summary, "capture:blocked");
    // Any backlog still owed, with what is left of the 50 a run; then what a model call left to write.
    await screenOwed(deps, orgId, runId, session, clock, {
      into: screening,
      skip: inactiveSeeds,
      limit: MAX_SCREENS_PER_RUN - screening.tried.size,
    });
    await deps.flush?.();
    summary.screened = screening.screened;
    summary.parked = screening.parked;
    summary.lures = screening.lures;
    summary.screenFailed = screening.failed;
    summary.screenDeferred = screening.deferred;
    for (const e of screening.errors) noteError(summary, e);
    for (const e of screening.trainingRecoveryErrors ?? []) noteError(summary, `training:${e}`);
    const looks = await deps.db
      .prepare(
        `SELECT COALESCE(SUM(second_look = 'declined'), 0) AS declined, COALESCE(SUM(second_look = 'unavailable'), 0) AS unavailable,
           COALESCE(SUM(lure = 1 AND (second_look IS NULL OR second_look != 'declined')), 0) AS lures
         FROM monitor_screens WHERE org_id = ? AND screened_at >= ? AND screened_at < ?`,
      )
      .bind(
        orgId,
        new Date(`${day}T00:00:00+02:00`).toISOString(),
        new Date(Date.parse(`${day}T00:00:00+02:00`) + DAY_MS).toISOString(),
      )
      .first<{ declined: number; unavailable: number; lures: number }>();
    // The standing flags of the day come from the store too, with the declined and unavailable counts, so a retry after a
    // stored verdict reports the same numbers (completion review, gap 5).
    summary.lures = looks?.lures ?? 0;
    summary.luresDeclined = looks?.declined ?? 0;
    summary.secondLookUnavailable = looks?.unavailable ?? 0;
    summary.outcome =
      summary.lookupFailed ||
      summary.captureFailed ||
      summary.deferred ||
      summary.captureBlocked ||
      summary.secondLookUnavailable ||
      summary.screenFailed ||
      summary.screenDeferred ||
      summary.ctFailed ||
      summary.candidatesDeferred ||
      screening.trainingRecoveryFailed
        ? "partial"
        : "completed";
  } catch (error) {
    failure = error;
    summary.outcome = "failed";
    noteError(summary, `run:${(error as Error)?.name || "Error"}`);
  }
  // The reservation is closed whatever happened (`closeGlimmer`: to Loupe's last request, else the end of its reserved
  // window, and a failed wake or warm-up settlement again to its own cutoff); a close that fails is recorded and handed
  // to the Workflow's settle step with the cutoff it was to land on (corrections 13 and 14).
  let glimmer: unknown;
  if (session) {
    let detail: string | undefined;
    try {
      const result = (await deps.close(session)) as { ok?: boolean; detail?: string } | null | undefined;
      if (result && result.ok === false) detail = result.detail ?? "refused";
    } catch (error) {
      detail = (error as Error)?.name || "Error";
    }
    glimmer = {
      calls,
      state: session.state,
      lastRequestEnd: session.lastRequestEnd,
      settled: detail === undefined,
      ...(detail ? { settleError: detail } : {}),
    };
    if (detail !== undefined) {
      noteError(summary, `settle:${detail}`);
      summary.unsettled = obligation(session);
      if (summary.outcome === "completed") summary.outcome = "partial";
    }
  }
  await finishRun(deps.db, orgId, day, summary, glimmer, clock());
  if (failure !== undefined) throw failure;
  return summary;
}
