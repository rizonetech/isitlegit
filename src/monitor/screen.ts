// Screening the monitor's captured pages (D05 T04 §3; spec 4.11). A capture is owed a screening while it has no
// `monitor_screens` row, a model's verdict or the parking rules' decision, so a run stopped after its captures, or a
// Workflow retry, screens exactly the pages still missing and never one twice. Each owed page is read back from R2 (its
// screenshot, text and the browser's signals), parked without a model when the rules say so (./parked.ts), and
// otherwise screened by `screenPage` (D03 T04 §1): Loupe first inside the run's reservation, Spark after. A page neither
// can answer stays owed with its failure counted, five at most for one capture, and is never taken for benign.
import type { GlimmerSession, Page, Screened } from "../vision/screen";
import { parkedPage, type Signals } from "./parked";
import type { SecondLook } from "./second-look";
import { readCounts } from "./signals";
import { copyForTraining, recoverPendingTrainingCopies, resolveCaptureUrl } from "./training";

export const MAX_SCREENS_PER_RUN = 50;
export const MAX_SCREEN_FAILURES = 5;

export type ScreenDeps = {
  db: D1Database;
  store: R2Bucket;
  screen: (page: Page, session: GlimmerSession, run: string) => Promise<Screened>;
  // Spark's second look at a page Loupe flagged (D05 T04 §9); without it no second look is asked.
  second?: (page: Page, run: string) => Promise<SecondLook>;
};

export type ScreenCounts = {
  screened: number;
  parked: number;
  lures: number;
  failed: number;
  // Owed pages left for the next run: past the 50 a run, or at the failure limit.
  deferred: number;
  errors: string[];
  // The domains tried in this run, so a page that failed before the captures is not tried again after them.
  tried: Set<string>;
  trainingRecoveryFailed?: number;
  trainingRecoveryErrors?: string[];
};

export const newScreenCounts = (): ScreenCounts => ({
  screened: 0,
  parked: 0,
  lures: 0,
  failed: 0,
  deferred: 0,
  errors: [],
  tried: new Set(),
});

// How a pass picks its pages: the run's pages left to screen (the 50 a run is shared by its passes), the domains whose
// capture this run is about to replace (never worth a model call), the counts the passes add to, and, when given, only
// these domains in this order (the pages this run captured, in capture order).
export type ScreenOptions = {
  limit?: number;
  skip?: ReadonlySet<string>;
  into?: ScreenCounts;
  only?: readonly string[];
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

// What the capture kept for parking, read back defensively: five plain counts and the tree's own text, or nothing,
// which screens the page.
function readEvidence(raw: string | null): { signals: Signals; text: string } | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const signals = readCounts(parsed);
    return signals && typeof parsed?.text === "string" ? { signals, text: parsed.text } : null;
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

// Screens the pages owed, oldest capture first, at most `limit` (the 50 a run, shared by the run's passes). A failure on
// one page never stops the rest, and a page tried once in a run is not tried again in it.
export async function screenOwed(
  deps: ScreenDeps,
  orgId: string,
  run: string,
  session: GlimmerSession | null,
  at: () => Date,
  options: ScreenOptions = {},
): Promise<ScreenCounts> {
  const counts = options.into ?? newScreenCounts();
  const limit = Math.max(0, options.limit ?? MAX_SCREENS_PER_RUN);
  const skip = options.skip ?? new Set<string>();
  let owed = (
    await deps.db
      .prepare(
        `SELECT domain, capture_key, screen_failures FROM monitor_hosts
         WHERE org_id = ? AND screen_failures < ? AND ${OWED} ORDER BY captured_at ASC, domain ASC`,
      )
      .bind(orgId, MAX_SCREEN_FAILURES)
      .all<Owed>()
  ).results.filter((o) => !skip.has(o.domain) && !counts.tried.has(o.domain));
  if (options.only) {
    const order = new Map(options.only.map((domain, i) => [domain, i]));
    owed = owed.filter((o) => order.has(o.domain));
    owed.sort((a, b) => (order.get(a.domain) as number) - (order.get(b.domain) as number));
  }
  const stuck =
    (
      await deps.db
        .prepare(`SELECT COUNT(*) AS n FROM monitor_hosts WHERE org_id = ? AND screen_failures >= ? AND ${OWED}`)
        .bind(orgId, MAX_SCREEN_FAILURES)
        .first<{ n: number }>()
    )?.n ?? 0;
  // What this pass leaves, replacing the earlier pass's count: the last pass states what the run leaves for the next.
  counts.deferred = Math.max(0, owed.length - limit) + stuck;
  for (const page of owed.slice(0, limit)) {
    counts.tried.add(page.domain);
    const prefix = page.capture_key;
    // The capture's own objects: unreadable or missing is a failure of this page alone, named.
    let screenshot: Uint8Array | null = null;
    let text: string | null = null;
    let evidence: { signals: Signals; text: string } | null = null;
    try {
      const [shot, words, sig] = await Promise.all([
        deps.store.get(`${prefix}screenshot.jpg`),
        deps.store.get(`${prefix}text.txt`),
        deps.store.get(`${prefix}signals.json`),
      ]);
      screenshot = shot ? new Uint8Array(await shot.arrayBuffer()) : null;
      text = words ? await words.text() : null;
      evidence = readEvidence(sig ? await sig.text() : null);
    } catch {
      screenshot = null;
    }
    if (!screenshot || text === null) {
      failed(counts, "r2-missing");
      await countFailure(deps.db, orgId, page.domain, page.capture_key);
      continue;
    }
    const moment = at().toISOString();
    // Parking trusts only what the browser's own tree said, never the text the page handed over.
    const parked = evidence
      ? parkedPage(evidence.text, evidence.signals, screenshot.length)
      : { parked: false as const };
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
      // The failed page's paid calls stay findable in the run's stored errors, though the page stays owed (§45):
      // one entry for the whole run, so the run row's 20-entry error cap cannot drop a page's references; a call id
      // alone finds its record, whose owner names the run and host.
      if (result.spark_calls.length) {
        const ids = result.spark_calls.map((c) => c.callId).join(",");
        const at = counts.errors.findIndex((e) => e.startsWith("screen-calls:"));
        if (at >= 0) counts.errors[at] += `,${ids}`;
        else counts.errors.push(`screen-calls:${ids}`);
      }
      await countFailure(deps.db, orgId, page.domain, page.capture_key);
      continue;
    }
    const s = result.screen;
    // Loupe flagged it: Spark looks once more before the walkthrough is paid for. A page Spark screened itself needs none.
    // The verdicts are stored together, so a run stopped before this leaves the page owed, never half-recorded.
    const second =
      s.lure && s.screener === "glimmer" && deps.second
        ? await deps.second({ image: screenshot, text, host: page.domain, mode: "image" }, run)
        : null;
    if (second?.verdict === "unavailable" && !counts.errors.includes(`second-look:${second.reason}`))
      counts.errors.push(`second-look:${second.reason}`);
    const asked = second && second.verdict !== "unavailable" ? second : null;
    await deps.db.batch([
      deps.db
        .prepare(
          `INSERT INTO monitor_screens (org_id, domain, capture_key, outcome, screener, brand, has_login_form,
             has_payment_form, lure, lure_type, confidence, glimmer_reason, spark_call_id, spark_log_id, screened_at,
             second_look, second_look_lure, second_look_type, second_look_call_id, second_look_log_id, tier,
             spark_first_call_id)
           VALUES (?, ?, ?, 'screened', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (org_id, domain, capture_key) DO NOTHING`,
        )
        .bind(
          orgId,
          page.domain,
          page.capture_key,
          s.screener,
          // SQL null records unavailable brand metadata; it is never added to the model answer.
          "brand" in s ? s.brand : null,
          s.has_login_form ? 1 : 0,
          s.has_payment_form ? 1 : 0,
          s.lure ? 1 : 0,
          s.lure_type,
          s.confidence,
          result.glimmer_reason,
          result.spark_call?.callId ?? null,
          result.spark_call?.logId ?? null,
          moment,
          second?.verdict ?? null,
          asked ? (asked.verdict === "confirmed" ? 1 : 0) : null,
          asked ? (asked.verdict === "confirmed" ? asked.lureType : "none") : null,
          asked?.callId ?? null,
          asked?.logId ?? null,
          result.tier,
          result.spark_calls[0]?.callId ?? null,
        ),
      // A page that was parked and now screens as a page worth a look goes back to being watched.
      deps.db
        .prepare(
          "UPDATE monitor_hosts SET status = 'watching' WHERE org_id = ? AND domain = ? AND capture_key = ? AND status = 'parked'",
        )
        .bind(orgId, page.domain, page.capture_key),
    ]);
    counts.screened++;
    // A flag Spark declined is no longer a standing lure; the store keeps it, with both verdicts,
    // and copies its fetched page to R2 `training/` for Loupe's training (D05 T04 §10).
    if (s.lure && second?.verdict === "declined") {
      const captureUrl = await resolveCaptureUrl(deps.db, deps.store, orgId, page.domain, page.capture_key);
      await copyForTraining(
        deps.store,
        {
          orgId,
          host: page.domain,
          captureKey: page.capture_key,
          captureUrl,
          label: "benign",
          why: "Muse Spark second look declined Loupe's lure flag",
          source: "second-look",
          sourceRef: `screen:${orgId}:${page.domain}:${page.capture_key}`,
        },
        at,
      ).catch(() => "missing-source");
    }
    if (s.lure && second?.verdict !== "declined") counts.lures++;
  }
  const rec = await recoverPendingTrainingCopies(deps.db, deps.store, orgId, at).catch((err) => ({
    recovered: 0,
    failed: 1,
    errors: [err instanceof Error ? err.message : String(err)],
  }));
  if (rec.failed > 0) {
    counts.trainingRecoveryFailed = (counts.trainingRecoveryFailed ?? 0) + rec.failed;
    if (rec.errors) counts.trainingRecoveryErrors = [...(counts.trainingRecoveryErrors ?? []), ...rec.errors];
  }
  return counts;
}
