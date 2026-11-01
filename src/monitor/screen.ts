// Screening the monitor's captured pages (D05 T04 §3; spec 4.11). A capture is owed a screening while it has no
// `monitor_screens` row, a model's verdict or the parking rules' decision, so a run stopped after its captures, or a
// Workflow retry, screens exactly the pages still missing and never one twice. Each owed page is read back from R2 (its
// screenshot, text and the browser's signals), parked without a model when the rules say so (./parked.ts), and
// otherwise screened by `screenPage` (D03 T04 §1): Loupe first inside the run's reservation, Spark after. A page neither
// can answer stays owed with its failure counted, five at most for one capture, and is never taken for benign.
import type { GlimmerSession, Page, Screened } from "../vision/screen";
import { parkedPage, type Signals } from "./parked";

export const MAX_SCREENS_PER_RUN = 50;
export const MAX_SCREEN_FAILURES = 5;

export type ScreenDeps = {
  db: D1Database;
  store: R2Bucket;
  screen: (page: Page, session: GlimmerSession, run: string) => Promise<Screened>;
};

export type ScreenCounts = {
  screened: number;
  parked: number;
  lures: number;
  failed: number;
  // Owed pages left for the next run: past the 50 a run, or at the failure limit.
  deferred: number;
  errors: string[];
};

type Owed = { domain: string; capture_key: string; screen_failures: number };

// The SQL for "this host's current capture has no screening row".
const OWED = `capture_key IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM monitor_screens s WHERE s.org_id = monitor_hosts.org_id AND s.domain = monitor_hosts.domain
    AND s.capture_key = monitor_hosts.capture_key)`;

// The domains owed a screening now and not at the failure limit: the run's backlog, for sizing Loupe's reservation.
export async function owedDomains(db: D1Database, orgId: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT domain FROM monitor_hosts WHERE org_id = ? AND screen_failures < ? AND ${OWED}`)
    .bind(orgId, MAX_SCREEN_FAILURES)
    .all<{ domain: string }>();
  return rows.results.map((r) => r.domain);
}

// What the browser counted, read back defensively: anything but four plain counts is no signals, which screens the page.
function readSignals(text: string | null): Signals | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const count = (k: string) => (Number.isInteger(v[k]) && (v[k] as number) >= 0 ? (v[k] as number) : null);
    const inputs = count("inputs");
    const passwords = count("passwords");
    const forms = count("forms");
    const iframes = count("iframes");
    return inputs === null || passwords === null || forms === null || iframes === null
      ? null
      : { inputs, passwords, forms, iframes };
  } catch {
    return null;
  }
}

const failed = (counts: ScreenCounts, why: string) => {
  counts.failed++;
  if (!counts.errors.includes(`screen:${why}`)) counts.errors.push(`screen:${why}`);
};

async function countFailure(db: D1Database, orgId: string, domain: string, captureKey: string) {
  // Only the capture that failed: a new capture replacing it has already reset the count.
  await db
    .prepare(
      "UPDATE monitor_hosts SET screen_failures = screen_failures + 1 WHERE org_id = ? AND domain = ? AND capture_key = ?",
    )
    .bind(orgId, domain, captureKey)
    .run();
}

// Screens the pages owed, oldest capture first, at most `MAX_SCREENS_PER_RUN`. A failure on one page never stops the rest.
export async function screenOwed(
  deps: ScreenDeps,
  orgId: string,
  run: string,
  session: GlimmerSession | null,
  at: () => Date,
): Promise<ScreenCounts> {
  const counts: ScreenCounts = { screened: 0, parked: 0, lures: 0, failed: 0, deferred: 0, errors: [] };
  const owed = (
    await deps.db
      .prepare(
        `SELECT domain, capture_key, screen_failures FROM monitor_hosts
         WHERE org_id = ? AND screen_failures < ? AND ${OWED} ORDER BY captured_at ASC, domain ASC`,
      )
      .bind(orgId, MAX_SCREEN_FAILURES)
      .all<Owed>()
  ).results;
  const stuck =
    (
      await deps.db
        .prepare(`SELECT COUNT(*) AS n FROM monitor_hosts WHERE org_id = ? AND screen_failures >= ? AND ${OWED}`)
        .bind(orgId, MAX_SCREEN_FAILURES)
        .first<{ n: number }>()
    )?.n ?? 0;
  counts.deferred = Math.max(0, owed.length - MAX_SCREENS_PER_RUN) + stuck;
  for (const page of owed.slice(0, MAX_SCREENS_PER_RUN)) {
    const prefix = page.capture_key;
    // The capture's own objects: unreadable or missing is a failure of this page alone, named.
    let screenshot: Uint8Array | null = null;
    let text: string | null = null;
    let signals: Signals | null = null;
    try {
      const [shot, words, sig] = await Promise.all([
        deps.store.get(`${prefix}screenshot.jpg`),
        deps.store.get(`${prefix}text.txt`),
        deps.store.get(`${prefix}signals.json`),
      ]);
      screenshot = shot ? new Uint8Array(await shot.arrayBuffer()) : null;
      text = words ? await words.text() : null;
      signals = readSignals(sig ? await sig.text() : null);
    } catch {
      screenshot = null;
    }
    if (!screenshot || text === null) {
      failed(counts, "r2-missing");
      await countFailure(deps.db, orgId, page.domain, page.capture_key);
      continue;
    }
    const moment = at().toISOString();
    const parked = parkedPage(text, signals, screenshot.length);
    if (parked.parked) {
      await deps.db.batch([
        deps.db
          .prepare(
            `INSERT INTO monitor_screens (org_id, domain, capture_key, outcome, parked_reason, screened_at)
             VALUES (?, ?, ?, 'parked', ?, ?) ON CONFLICT (org_id, domain, capture_key) DO NOTHING`,
          )
          .bind(orgId, page.domain, page.capture_key, parked.reason, moment),
        // A dismissed host stays dismissed (§5's); only a watched one is parked.
        deps.db
          .prepare(
            "UPDATE monitor_hosts SET status = 'parked' WHERE org_id = ? AND domain = ? AND capture_key = ? AND status = 'watching'",
          )
          .bind(orgId, page.domain, page.capture_key),
      ]);
      counts.parked++;
      continue;
    }
    if (!session) {
      failed(counts, "no-session");
      await countFailure(deps.db, orgId, page.domain, page.capture_key);
      continue;
    }
    // The host is the one the monitor holds, never one the page names; the text goes only through the request builder,
    // in its untrusted block (D03 T04 §1).
    // The request builder refuses a screenshot that is not a whole JPEG, and a model call can throw: either is this one
    // page's failure, named, never the run's.
    let result: Awaited<ReturnType<ScreenDeps["screen"]>>;
    try {
      result = await deps.screen({ image: screenshot, text, host: page.domain, mode: "image" }, session, run);
    } catch (error) {
      failed(counts, `request/${(error as Error)?.name || "Error"}`);
      await countFailure(deps.db, orgId, page.domain, page.capture_key);
      continue;
    }
    if (!result.ok) {
      failed(counts, `${result.glimmer_reason}/${result.spark_reason}`);
      await countFailure(deps.db, orgId, page.domain, page.capture_key);
      continue;
    }
    const s = result.screen;
    await deps.db.batch([
      deps.db
        .prepare(
          `INSERT INTO monitor_screens (org_id, domain, capture_key, outcome, screener, brand, has_login_form,
             has_payment_form, lure, lure_type, confidence, glimmer_reason, spark_call_id, spark_log_id, screened_at)
           VALUES (?, ?, ?, 'screened', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (org_id, domain, capture_key) DO NOTHING`,
        )
        .bind(
          orgId,
          page.domain,
          page.capture_key,
          s.screener,
          s.brand,
          s.has_login_form ? 1 : 0,
          s.has_payment_form ? 1 : 0,
          s.lure ? 1 : 0,
          s.lure_type,
          s.confidence,
          result.glimmer_reason,
          result.spark_call?.callId ?? null,
          result.spark_call?.logId ?? null,
          moment,
        ),
      // A page that was parked and now screens as a page worth a look goes back to being watched.
      deps.db
        .prepare(
          "UPDATE monitor_hosts SET status = 'watching' WHERE org_id = ? AND domain = ? AND capture_key = ? AND status = 'parked'",
        )
        .bind(orgId, page.domain, page.capture_key),
    ]);
    counts.screened++;
    if (s.lure) counts.lures++;
  }
  return counts;
}
