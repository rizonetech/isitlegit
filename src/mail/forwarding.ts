// Forwarding failures (D01 T02 §6). Cloudflare forwards an alias's mail and does not pass back what happens next: a
// destination that refuses it after the hand-over sends its non-delivery report to Cloudflare, which drops it
// (https://developers.cloudflare.com/email-service/reference/postmaster/#non-delivery-reports-ndrs). Email Routing's
// events (GraphQL `emailRoutingAdaptive`) still show it: probe 2 (2026-10-30, §6) read the forward as `delivered` and
// the refusal as `isNDR` 1 events from the destination's domain to `cfbounces+ndrdrop@`, subject `Undeliverable: ` and
// the original's. So a refusal is tied to its forward by a hash of that subject, and the operator is alerted, on two
// mailboxes, since OPERATOR_EMAIL is the aliases' own destination. Member mail the Worker failed to take
// (`deliveryFailed`, action `worker`) is an incident too, alerted only if the sender's retry has not arrived within
// RECOVERY_MS. The scan's progress and every incident are in D1 (migration 0036): a missed run catches up, and an
// alert not yet confirmed sent is tried again. Never a body, a subject or the sender's address: domains only.
import { type MailDeps, type SendOutcome, sendMail } from "./smtp2go";

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
// The overlap each scan reads again: a refusal shows within minutes, a delivered forward within about 14 (§6's probes).
export const LOOKBACK_MS = 30 * 60 * 1000;
// A refusal belongs to a forward of the same subject at most this long before it.
export const NDR_WINDOW_MS = 30 * 60 * 1000;
// How long after a refusal happened it waits before it is tied to a forward, so every forward that will show has shown:
// a delivered forward took about 14 minutes to show (probe 1), and a refused message's forward happened before its
// refusal. Counted from the refusal (D01 T02 §12), not from the scan that read it: probe 4's alert waited out the grace
// from its 18:45 reading and went at 19:15, 47 minutes after the refusal, where 22 were enough.
export const MATCH_GRACE_MS = 20 * 60 * 1000;
// A refusal is settled no sooner than this after a scan first read it (D01 T02 §12), so a forward whose event shows a
// little after its refusal's (a slow analytics batch) is read by at least one more scan; under the forwarding scan's
// five minutes (FORWARD_CRON, src/schedules.ts), so the next scan settles it.
export const SEEN_MS = 4 * 60 * 1000;
// One refusal's notices arrive together but not always in one second: probe 3's two came at 16:41:08 and 16:41:09, and
// the second, read as its own refusal, alerted a "forward not found" (D01 T02 §9). A notice with no forward of its own
// this close to a resolved one of the same subject and destination is that refusal's (`resolveRefusals`).
export const NOTICE_SPREAD_MS = 5 * 1000;
// How long a Worker failure waits for the sender's retry before it is alerted as unresolved.
export const RECOVERY_MS = 60 * 60 * 1000;
// The dataset's limit on one query's span (4 weeks 3 days), kept under; a longer gap starts from this far back.
export const MAX_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
// Settled incidents are kept this long, past any replay window, then deleted.
export const INCIDENTS_KEPT_MS = 90 * 24 * 60 * 60 * 1000;
export const PAGE = 1000;
const FORWARD_BATCH = 100;
export const MAX_PAGES = 10;
// Alerts sent per run, the least-tried first, so a new incident is never starved by older ones still retrying (round 1).
export const ALERTS_PER_RUN = 100;
const FORWARDS_KEPT_MS = 24 * 60 * 60 * 1000;
const ALERTS_FROM = "IsItLegit <alerts@isitlegit.co.za>";

export type RoutingEvent = {
  datetime: string;
  sessionId: string | null;
  messageId: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  status: string;
  action: string;
  isNDR: number;
  errorDetail?: string | null;
};

export type ForwardingDeps = {
  db: D1Database;
  token: string | undefined;
  zone: string | undefined;
  mail: MailDeps;
  operators: readonly string[];
  fetch?: typeof fetch;
  now?: () => Date;
  // MATCH_GRACE_MS and SEEN_MS unless a test says otherwise.
  graceMs?: number;
  seenMs?: number;
  // Send an early unattributed alert when a refusal is first read, before MATCH_GRACE_MS (D01 T02 §15; default true).
  earlyAlert?: boolean;
};

export type ForwardingOutcome = {
  state: "disabled" | "ok" | "partial" | "degraded";
  events: number;
  incidents: number;
  // Notices folded into a refusal already resolved, as another notice of it (D01 T02 §9): opened as incidents when read,
  // so `incidents` less `folded` is the refusals, counted across the runs that read and resolved them.
  folded: number;
  alerted: number;
  errors: string[];
};

const encoder = new TextEncoder();
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// The analytics write some addresses with their angle brackets ("<bounce@x>"): probe 3's alert read "from
// isitlegit.co.za>" (D01 T02 §9). The address inside them, and a domain only when it is a host name.
const domainOf = (address: string | null) => {
  const raw = (address ?? "").trim().toLowerCase();
  const a = /<([^<>]*)>?\s*$/.exec(raw)?.[1]?.trim() ?? raw;
  const at = a.lastIndexOf("@");
  const domain = at > 0 ? a.slice(at + 1) : "";
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null;
};
// A report's subject is the original's behind a prefix its writer adds.
const REPORT_PREFIX =
  /^\s*(?:undeliverable|undelivered mail returned to sender|delivery status notification \(failure\)|returned mail|mail delivery failed|failure notice)\s*:\s*/i;
const subjectKey = (subject: string | null) => sha256((subject ?? "").replace(REPORT_PREFIX, "").trim().toLowerCase());
// A bounded identity for an event: its message id, or, when it has none, its session, time and recipient.
const eventKey = (e: RoutingEvent) => sha256(e.messageId?.trim() || `${e.sessionId ?? ""}|${e.datetime}|${e.to ?? ""}`);
// A provider's reason with any address in it removed, bounded.
export const sanitized = (reason: string | null | undefined) =>
  (reason ?? "")
    .replace(/[^\s<>"'(),;:@]+@[^\s<>"'(),;:@]+/g, "[address]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim()
    .slice(0, 300) || null;

// The query exactly as it runs in production; §6 records it run against the live API.
export const QUERY = `query($zone: String!, $from: Time!, $to: Time!, $limit: Int!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    emailRoutingAdaptive(limit: $limit, filter: { datetime_geq: $from, datetime_leq: $to }, orderBy: [datetime_ASC]) {
      datetime sessionId messageId from to subject status action isNDR errorDetail
    }
  } }
}`;

// The events from `from` to `to`, page by page; `through` is how far they were read: `to` when complete, else the time
// of the last event read (a page budget spent, or a page that did not advance past its start), so the caller resumes
// there and loses nothing (an event at that instant is read again and deduplicated).
async function readEvents(
  deps: ForwardingDeps,
  from: Date,
  to: Date,
): Promise<{ events: RoutingEvent[]; through: Date; complete: boolean }> {
  const call = deps.fetch ?? fetch;
  const events: RoutingEvent[] = [];
  let start = from;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await call(GRAPHQL_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: { zone: deps.zone, from: start.toISOString(), to: to.toISOString(), limit: PAGE },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Cloudflare's GraphQL API answered HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: { viewer?: { zones?: { emailRoutingAdaptive?: RoutingEvent[] }[] } };
      errors?: unknown[];
    };
    if (body.errors?.length) throw new Error("Cloudflare's GraphQL API returned errors");
    const batch = body.data?.viewer?.zones?.[0]?.emailRoutingAdaptive;
    if (!Array.isArray(batch)) throw new Error("Cloudflare's GraphQL API returned no event list");
    events.push(...batch);
    if (batch.length < PAGE) return { events, through: to, complete: true };
    const last = new Date(batch[batch.length - 1]?.datetime ?? start.toISOString());
    // A full page all at one instant cannot be paged past by time: stop there, and say the scan is partial.
    if (last.getTime() <= start.getTime()) return { events, through: start, complete: false };
    start = last;
  }
  return { events, through: start, complete: false };
}

// One run: read the events since the last scan (with LOOKBACK_MS of overlap), record forwards and incidents, settle
// waiting and retrying incidents, send each alert not yet confirmed, and delete settled incidents past their keep.
export async function checkForwarding(deps: ForwardingDeps): Promise<ForwardingOutcome> {
  const outcome: ForwardingOutcome = { state: "ok", events: 0, incidents: 0, folded: 0, alerted: 0, errors: [] };
  if (!deps.token || !deps.zone)
    return { ...outcome, state: "disabled", errors: ["CF_ANALYTICS_TOKEN or EMAIL_ZONE_ID is not set"] };
  const db = deps.db;
  const now = (deps.now ?? (() => new Date()))();
  const last = await db
    .prepare("SELECT scanned_to FROM forward_scan WHERE zone = ?")
    .bind(deps.zone)
    .first<{ scanned_to: string }>();
  // The first run records where scanning starts before it reads anything, so a first read that fails is caught up
  // from here, never skipped.
  if (!last)
    await db
      .prepare("INSERT INTO forward_scan (zone, scanned_to) VALUES (?, ?) ON CONFLICT (zone) DO NOTHING")
      .bind(deps.zone, now.toISOString())
      .run();
  const since = (last ? Date.parse(last.scanned_to) : now.getTime()) - LOOKBACK_MS;
  const from = new Date(Math.max(since, now.getTime() - MAX_SPAN_MS));
  let read: Awaited<ReturnType<typeof readEvents>> | null = null;
  try {
    read = await readEvents(deps, from, now);
  } catch (error) {
    outcome.state = "degraded";
    outcome.errors.push((error as Error).message);
  }
  const events = read?.events ?? [];
  outcome.events = events.length;
  let recorded = true;
  // Forwards, the bulk of the events, are written in batches of FORWARD_BATCH statements, so a long backlog stays
  // within what one scheduled run may ask of D1 (the CI run that read 10,000 one at a time timed out, round 4); the
  // rest, which open or settle incidents, one by one, after the forwards they may refer to.
  const isForward = (e: RoutingEvent) => e.action === "forward" && e.isNDR === 0;
  const forwards = events.filter(isForward);
  for (let i = 0; i < forwards.length; i += FORWARD_BATCH) {
    try {
      await db.batch(
        await Promise.all(
          forwards
            .slice(i, i + FORWARD_BATCH)
            .map(async (event) =>
              db
                .prepare(
                  "INSERT INTO forward_seen (message_hash, subject_hash, alias, sender_domain, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_hash) DO NOTHING",
                )
                .bind(
                  await eventKey(event),
                  await subjectKey(event.subject),
                  (event.to ?? "").toLowerCase(),
                  domainOf(event.from),
                  event.datetime,
                ),
            ),
        ),
      );
    } catch (error) {
      recorded = false;
      outcome.state = "degraded";
      outcome.errors.push(`recording forwards: ${(error as Error).name}`);
    }
  }
  for (const event of events.filter((e) => !isForward(e))) {
    try {
      outcome.incidents += await record(db, event, now);
    } catch (error) {
      recorded = false;
      outcome.state = "degraded";
      outcome.errors.push(`recording an event: ${(error as Error).name}`);
    }
  }
  if (read && recorded) {
    // Through what was read (plus the overlap the next run takes back): a partial read resumes from its last event.
    await db
      .prepare(
        "INSERT INTO forward_scan (zone, scanned_to) VALUES (?, ?) ON CONFLICT (zone) DO UPDATE SET scanned_to = excluded.scanned_to",
      )
      .bind(deps.zone, (read.complete ? now : new Date(read.through.getTime() + LOOKBACK_MS)).toISOString())
      .run();
    if (!read.complete) {
      outcome.state = "partial";
      outcome.errors.push(`read through ${read.through.toISOString()}; the next run continues from there`);
    }
  }
  await db.batch([
    // A Worker failure whose retry never arrived is unresolved, and alerted.
    db
      .prepare(
        "UPDATE forward_incidents SET state = 'unresolved', alert = 'pending' WHERE kind = 'worker' AND state = 'retrying' AND occurred_at <= ?",
      )
      .bind(new Date(now.getTime() - RECOVERY_MS).toISOString()),
    db.prepare("DELETE FROM forward_seen WHERE at < ?").bind(new Date(now.getTime() - FORWARDS_KEPT_MS).toISOString()),
    db
      .prepare(
        "DELETE FROM forward_notices WHERE incident_key IN (SELECT key FROM forward_incidents WHERE alert IN ('none', 'sent', 'refused') AND state <> 'retrying' AND detected_at < ?)",
      )
      .bind(new Date(now.getTime() - INCIDENTS_KEPT_MS).toISOString()),
    db
      .prepare(
        "DELETE FROM forward_incidents WHERE alert IN ('none', 'sent', 'refused') AND state <> 'retrying' AND detected_at < ?",
      )
      .bind(new Date(now.getTime() - INCIDENTS_KEPT_MS).toISOString()),
  ]);
  // Refusals are tied to forwards only by a run that read every event through now and recorded them all (D01 T02 §12
  // plan review): a failed or partial read may lack the very forward a refusal waited for, so they wait for one that
  // does not.
  if (read?.complete && recorded)
    outcome.folded = await resolveRefusals(
      db,
      now,
      deps.graceMs ?? MATCH_GRACE_MS,
      deps.seenMs ?? SEEN_MS,
      deps.operators.length,
      deps.earlyAlert ?? true,
    );
  let remainingAlerts = ALERTS_PER_RUN;
  if (deps.earlyAlert ?? true) remainingAlerts -= await sendEarlyAlerts(deps, outcome, remainingAlerts);
  const pending =
    remainingAlerts > 0
      ? await db
          .prepare(
            "SELECT key, kind, alias, uncertain, sender_domain, destination_domain, received_at, occurred_at, reason, possible_retry_at, (SELECT COUNT(*) FROM forward_notices n WHERE n.incident_key = forward_incidents.key) AS reports FROM forward_incidents WHERE alert = 'pending' ORDER BY alert_tries, detected_at LIMIT ?",
          )
          .bind(remainingAlerts)
          .all<Incident>()
      : { results: [] };
  for (const incident of pending.results) {
    const alerted = await alert(deps, incident);
    if (alerted === "sent") outcome.alerted++;
    if (alerted === "pending") {
      if (outcome.state === "ok") outcome.state = "degraded";
      outcome.errors.push(
        `the alert for incident ${incident.key.slice(0, 12)} is not confirmed sent; tried again next run`,
      );
    }
  }
  return outcome;
}

// One event recorded; returns 1 when it opened an incident.
async function record(db: D1Database, event: RoutingEvent, now: Date): Promise<number> {
  const at = event.datetime;
  if (event.isNDR === 1 && (event.to ?? "").toLowerCase().startsWith("cfbounces+")) {
    const subject = await subjectKey(event.subject);
    const destination = domainOf(event.from);
    // A notice already counted, on its own incident or folded into a sibling's (`resolveRefusals`), is not recorded
    // again however often the overlapping scans read it (round 3).
    const notice = await eventKey(event);
    const counted = await db.prepare("SELECT 1 FROM forward_notices WHERE notice_hash = ?").bind(notice).first();
    if (counted) return 0;
    // Recorded under the report's own identity, waiting: which forward it refused is resolved each run, once every
    // forward of the window can have been read (`resolveRefusals`).
    const [opened] = await db.batch([
      db
        .prepare(
          "INSERT INTO forward_incidents (key, kind, subject_hash, destination_domain, occurred_at, detected_at, state, alert) VALUES (?, 'refused', ?, ?, ?, ?, 'open', 'waiting') ON CONFLICT (key) DO NOTHING",
        )
        .bind(notice, subject, destination, at, now.toISOString()),
      db
        .prepare(
          "INSERT INTO forward_notices (notice_hash, incident_key) VALUES (?, ?) ON CONFLICT (notice_hash) DO NOTHING",
        )
        .bind(notice, notice),
    ]);
    return opened?.meta.changes ?? 0;
  }
  if (event.action === "worker" && event.status === "deliveryFailed") {
    const opened = await db
      .prepare(
        "INSERT INTO forward_incidents (key, kind, alias, sender_domain, sender_hash, no_message_id, received_at, occurred_at, detected_at, reason, state, alert) VALUES (?, 'worker', ?, ?, ?, ?, ?, ?, ?, ?, 'retrying', 'none') ON CONFLICT (key) DO NOTHING",
      )
      .bind(
        await eventKey(event),
        (event.to ?? "").toLowerCase(),
        domainOf(event.from),
        await sha256((event.from ?? "").trim().toLowerCase()),
        event.messageId?.trim() ? 0 : 1,
        at,
        at,
        now.toISOString(),
        sanitized(event.errorDetail),
      )
      .run();
    return opened.meta.changes;
  }
  if (event.action === "worker" && event.status === "delivered") {
    // The sender's retry arrived, however late: the failure is recovered, and an alert not yet sent is dropped. A
    // failure that carried no Message-ID cannot be matched to its retry: a later delivery from the same sender to the
    // same alias is only noted, as a possible retry, and the failure is still alerted (round 2).
    await db.batch([
      db
        .prepare(
          "UPDATE forward_incidents SET state = 'recovered', alert = CASE alert WHEN 'pending' THEN 'none' ELSE alert END WHERE kind = 'worker' AND no_message_id = 0 AND state IN ('retrying', 'unresolved') AND key = ?",
        )
        .bind(await eventKey(event)),
      db
        .prepare(
          "UPDATE forward_incidents SET possible_retry_at = ? WHERE kind = 'worker' AND no_message_id = 1 AND possible_retry_at IS NULL AND sender_hash = ? AND alias = ? AND occurred_at <= ?",
        )
        .bind(at, await sha256((event.from ?? "").trim().toLowerCase()), (event.to ?? "").toLowerCase(), at),
    ]);
  }
  return 0;
}

// Waiting refusal notices that happened MATCH_GRACE_MS ago (longer than a forward takes to show, about 14 minutes) and
// were read SEEN_MS ago, oldest first, in
// clusters: the notices of one subject and destination, each within NOTICE_SPREAD_MS of the one before. A notice does
// not say which message it refused, so a cluster is one incident counting all its notices (probe 2's came in one
// second, probe 3's a second apart, D01 T02 §9), tied to the forwards of its subject that no other refusal has claimed,
// from NDR_WINDOW_MS before its first notice up to its last: one is the refused message; several are all named and the
// incident marked uncertain, since any of them may be the one (a later successful forward and a duplicate notice look
// alike, §9 round 2); none is alerted as it stands. Waiting the grace first means every forward that will show has
// shown (round 2); clusters are resolved in time order, so two refusals of the same subject minutes apart take two
// forwards, never one (round 1). A cluster with no forward of its own beside a refusal already resolved (the same
// subject and destination within NOTICE_SPREAD_MS, its notices read in a later run) is that refusal's, folded into it.
// Returns how many notices' incidents were folded into another.
type Waiting = {
  key: string;
  subject_hash: string;
  destination_domain: string | null;
  occurred_at: string;
  detected_at: string;
};
async function resolveRefusals(
  db: D1Database,
  now: Date,
  graceMs: number,
  seenMs: number,
  operatorCount = 0,
  earlyAlert = true,
): Promise<number> {
  let folded = 0;
  const waiting = await db
    .prepare(
      "SELECT key, subject_hash, destination_domain, occurred_at, detected_at FROM forward_incidents WHERE kind = 'refused' AND alert = 'waiting' ORDER BY occurred_at, key",
    )
    .all<Waiting>();
  // A cluster starts from its earliest waiting notice and takes in every waiting notice beside it, read in whatever
  // scan: a related notice read a run later must not be left to claim a forward alone (§9 round 3).
  const cutoff = new Date(now.getTime() - graceMs).toISOString();
  const seen = new Date(now.getTime() - seenMs).toISOString();
  const done = new Set<string>();
  const gap = (a: string, b: string) => Math.abs(Date.parse(b) - Date.parse(a));
  for (const first of waiting.results) {
    if (done.has(first.key)) continue;
    const cluster = [first];
    for (const next of waiting.results) {
      const last = cluster[cluster.length - 1] as Waiting;
      if (done.has(next.key) || cluster.includes(next)) continue;
      if (next.subject_hash !== first.subject_hash || next.destination_domain !== first.destination_domain) continue;
      if (Date.parse(next.occurred_at) < Date.parse(last.occurred_at)) continue;
      if (gap(last.occurred_at, next.occurred_at) > NOTICE_SPREAD_MS) break;
      cluster.push(next);
    }
    for (const member of cluster) done.add(member.key);
    // A cluster is built whole first, from its earliest notice, and only then judged (D01 T02 §12 rounds 1 and 2): due
    // when its first refusal is past the grace and every notice was read SEEN_MS ago. One read too recently, its forward
    // perhaps not yet shown, holds the whole cluster to a later run; no notice of it is settled without the others.
    if (first.occurred_at > cutoff || cluster.some((member) => member.detected_at > seen)) continue;
    const last = cluster[cluster.length - 1] as Waiting;
    // Everything is read first and written in one batch: the cluster's folding and its incident's resolution land
    // together or not at all, so an interrupted run never leaves a folded cluster without the span it was matched over
    // (§9 round 4); the next run reads the same notices and decides again.
    const foldInto = (into: string, from: Waiting[]) =>
      from.flatMap((m) => [
        db.prepare("UPDATE forward_notices SET incident_key = ? WHERE incident_key = ?").bind(into, m.key),
        db.prepare("DELETE FROM forward_incidents WHERE key = ?").bind(m.key),
      ]);
    const forwards = await db
      .prepare(
        "SELECT message_hash, alias, sender_domain, at FROM forward_seen WHERE subject_hash = ? AND at <= ? AND at >= ? AND message_hash NOT IN (SELECT forward_hash FROM forward_incidents WHERE forward_hash IS NOT NULL) ORDER BY at",
      )
      .bind(first.subject_hash, last.occurred_at, new Date(Date.parse(first.occurred_at) - NDR_WINDOW_MS).toISOString())
      .all<{ message_hash: string; alias: string; sender_domain: string | null; at: string }>();
    const found = forwards.results;
    // Notices beside a refusal already resolved (read after it was): another notice of it, folded and counted there,
    // when no other forward could be theirs; otherwise their own incident, never definitive, naming the forwards that
    // could be (a delivered one included), since a notice does not say which message it refused (§9 round 3).
    const sibling = await db
      .prepare(
        "SELECT key FROM forward_incidents WHERE kind = 'refused' AND key <> ? AND alert <> 'waiting' AND subject_hash = ? AND destination_domain IS ? AND julianday(occurred_at) BETWEEN julianday(?) - ? AND julianday(?) + ? ORDER BY occurred_at LIMIT 1",
      )
      .bind(
        first.key,
        first.subject_hash,
        first.destination_domain,
        first.occurred_at,
        NOTICE_SPREAD_MS / 86400000,
        last.occurred_at,
        NOTICE_SPREAD_MS / 86400000,
      )
      .first<{ key: string }>();
    const only = !sibling && found.length === 1 ? found[0] : undefined;
    // When no forward was found after the grace, attribution adds nothing to an early alert that was already confirmed
    // delivered (D01 T02 §15: "or none when the first already said all").
    const earlyDelivered =
      earlyAlert && !found.length && !sibling && operatorCount > 0
        ? await isEarlyAlertDelivered(
            db,
            cluster.map((m) => m.key),
            operatorCount,
          )
        : false;
    const resolution =
      sibling && !found.length
        ? foldInto(sibling.key, cluster)
        : [
            ...foldInto(first.key, cluster.slice(1)),
            only
              ? db
                  .prepare(
                    "UPDATE forward_incidents SET alias = ?, sender_domain = ?, received_at = ?, forward_hash = ?, alert = 'pending' WHERE key = ?",
                  )
                  .bind(only.alias, only.sender_domain, only.at, only.message_hash, first.key)
              : found.length
                ? db
                    .prepare("UPDATE forward_incidents SET alias = ?, uncertain = 1, alert = 'pending' WHERE key = ?")
                    .bind([...new Set(found.map((f) => f.alias))].join(", "), first.key)
                : db
                    .prepare("UPDATE forward_incidents SET alert = ? WHERE key = ?")
                    .bind(earlyDelivered ? "sent" : "pending", first.key),
          ];
    await db.batch(resolution);
    folded += sibling && !found.length ? cluster.length : cluster.length - 1;
  }
  return folded;
}

async function isEarlyAlertDelivered(db: D1Database, keys: readonly string[], operatorCount: number): Promise<boolean> {
  for (const key of keys) {
    const sends = await db
      .prepare("SELECT status FROM mail_sends WHERE send_key >= ? AND send_key < ?")
      .bind(`forward-early:${key}:`, `forward-early:${key};`)
      .all<{ status: string }>();
    const rows = sends.results;
    if (
      rows.length === operatorCount &&
      rows.every((r) => r.status === "sent" || r.status === "refused") &&
      rows.some((r) => r.status === "sent")
    )
      return true;
  }
  return false;
}

export function earlyAlertText(
  incident: Pick<Waiting, "key" | "destination_domain" | "occurred_at">,
  reports: number,
): { subject: string; text: string } {
  const reference = `Incident ${incident.key.slice(0, 12)}.`;
  return {
    subject: "IsItLegit: a forwarded message was refused after forwarding",
    text: [
      `A forwarded message was refused by ${incident.destination_domain ?? "the destination"} at ${incident.occurred_at}. Which alias it was sent to is still being matched; a second alert will follow if its forward is found.`,
      reports > 1
        ? `The sender was not told: Cloudflare dropped the ${reports} refusal notices (a destination can send several for one message).`
        : "The sender was not told: Cloudflare drops the refusal notice.",
      "",
      "Check the destination mailbox's health (quota, rules, filtering), then ask the sender to send again (docs/live-checks.md).",
      "",
      reference,
    ].join("\n"),
  };
}

// Early refusal alerts (D01 T02 §15): for each waiting refusal cluster not yet settled in this scan, send one early
// alert naming the destination domain and refusal time (no alias), deduplicated across same-scan and later-scan notices
// of the same cluster, bounded by the per-run alert budget (ALERTS_PER_RUN) with batch state reads.
async function sendEarlyAlerts(deps: ForwardingDeps, outcome: ForwardingOutcome, maxAlerts: number): Promise<number> {
  if (maxAlerts <= 0 || deps.operators.length === 0) return 0;
  const db = deps.db;
  const waiting = await db
    .prepare(
      "SELECT key, subject_hash, destination_domain, occurred_at, detected_at FROM forward_incidents WHERE kind = 'refused' AND alert = 'waiting' ORDER BY occurred_at, key",
    )
    .all<Waiting>();
  if (!waiting.results.length) return 0;
  const firstOccurred = waiting.results[0]?.occurred_at ?? "";
  const lastOccurred = waiting.results[waiting.results.length - 1]?.occurred_at ?? firstOccurred;
  const [settledRows, earlySendRows] = await Promise.all([
    db
      .prepare(
        "SELECT key, subject_hash, destination_domain, occurred_at FROM forward_incidents WHERE kind = 'refused' AND alert <> 'waiting' AND julianday(occurred_at) BETWEEN julianday(?) - ? AND julianday(?) + ?",
      )
      .bind(firstOccurred, NOTICE_SPREAD_MS / 86400000, lastOccurred, NOTICE_SPREAD_MS / 86400000)
      .all<{ key: string; subject_hash: string; destination_domain: string | null; occurred_at: string }>(),
    db
      .prepare(
        "SELECT send_key, status FROM mail_sends WHERE send_key >= 'forward-early:' AND send_key < 'forward-early;'",
      )
      .all<{ send_key: string; status: string }>(),
  ]);
  const earlyStatuses = new Map<string, string[]>();
  for (const row of earlySendRows.results) {
    const key = row.send_key.split(":")[1];
    if (!key) continue;
    const list = earlyStatuses.get(key);
    if (list) list.push(row.status);
    else earlyStatuses.set(key, [row.status]);
  }
  const done = new Set<string>();
  const gap = (a: string, b: string) => Math.abs(Date.parse(b) - Date.parse(a));
  const candidates: { first: Waiting; cluster: Waiting[]; earlyKey: string; tried: number }[] = [];
  for (const first of waiting.results) {
    if (done.has(first.key)) continue;
    const cluster = [first];
    for (const next of waiting.results) {
      const last = cluster[cluster.length - 1] as Waiting;
      if (done.has(next.key) || cluster.includes(next)) continue;
      if (next.subject_hash !== first.subject_hash || next.destination_domain !== first.destination_domain) continue;
      if (Date.parse(next.occurred_at) < Date.parse(last.occurred_at)) continue;
      if (gap(last.occurred_at, next.occurred_at) > NOTICE_SPREAD_MS) break;
      cluster.push(next);
    }
    for (const member of cluster) done.add(member.key);
    const last = cluster[cluster.length - 1] as Waiting;
    const firstMs = Date.parse(first.occurred_at) - NOTICE_SPREAD_MS;
    const lastMs = Date.parse(last.occurred_at) + NOTICE_SPREAD_MS;
    // If a sibling refusal within NOTICE_SPREAD_MS was already settled, this notice belongs to it and needs no new
    // early alert of its own.
    const hasSettledSibling = settledRows.results.some(
      (s) =>
        s.key !== first.key &&
        s.subject_hash === first.subject_hash &&
        s.destination_domain === first.destination_domain &&
        Date.parse(s.occurred_at) >= firstMs &&
        Date.parse(s.occurred_at) <= lastMs,
    );
    if (hasSettledSibling) continue;
    // Reuse any member key that already initiated an early alert in mail_sends (so an earlier-timestamped notice read
    // in a later scan shares the cluster's existing early-alert key).
    let earlyKey = first.key;
    for (const member of cluster) {
      if (earlyStatuses.has(member.key)) {
        earlyKey = member.key;
        break;
      }
    }
    const statuses = earlyStatuses.get(earlyKey) ?? [];
    if (statuses.length === deps.operators.length && statuses.every((s) => s === "sent" || s === "refused")) continue;
    candidates.push({ first, cluster, earlyKey, tried: statuses.length > 0 ? 1 : 0 });
  }
  // Untried clusters go before retrying ones so a failing early send cannot starve new refusals.
  candidates.sort((a, b) => a.tried - b.tried);
  let attempted = 0;
  for (const { first, cluster, earlyKey } of candidates.slice(0, maxAlerts)) {
    attempted++;
    const { subject, text } = earlyAlertText({ ...first, key: earlyKey }, cluster.length);
    const outcomes: SendOutcome[] = [];
    for (const [n, to] of deps.operators.entries())
      outcomes.push(
        await sendMail(
          { ...deps.mail, operator: deps.operators },
          { sendKey: `forward-early:${earlyKey}:${n}`, kind: "alert", to, from: ALERTS_FROM, subject, text },
        ),
      );
    const confirmed = (o: SendOutcome) => o.status === "sent" || (o.status === "duplicate" && o.previous === "sent");
    const refused = (o: SendOutcome) =>
      o.status === "refused" || (o.status === "duplicate" && o.previous === "refused");
    if (outcomes.every(refused)) continue;
    if (outcomes.every((o) => confirmed(o) || refused(o))) {
      outcome.alerted++;
    } else {
      if (outcome.state === "ok") outcome.state = "degraded";
      outcome.errors.push(
        `the early alert for incident ${earlyKey.slice(0, 12)} is not confirmed sent; tried again next run`,
      );
    }
  }
  return attempted;
}

type Incident = {
  key: string;
  kind: "refused" | "worker";
  alias: string | null;
  uncertain: number;
  sender_domain: string | null;
  destination_domain: string | null;
  received_at: string | null;
  occurred_at: string;
  reason: string | null;
  reports: number;
  possible_retry_at: string | null;
};

export function alertText(incident: Incident): { subject: string; text: string } {
  const reference = `Incident ${incident.key.slice(0, 12)}.`;
  const from = incident.sender_domain ? ` from ${incident.sender_domain}` : "";
  if (incident.kind === "refused") {
    const alias = incident.alias
      ? incident.uncertain
        ? incident.alias.includes(",")
          ? `one of ${incident.alias} (several messages had the same subject)`
          : `possibly ${incident.alias} (another message had the same subject, and a refusal notice does not say which)`
        : incident.alias
      : "an alias (its forward was not found)";
    const received = incident.received_at ? `, received at ${incident.received_at},` : "";
    return {
      subject: `IsItLegit: mail to ${incident.uncertain || !incident.alias ? "an alias" : incident.alias} was refused after forwarding`,
      text: [
        `A message${from} to ${alias}${received} was forwarded by Cloudflare and refused by ${incident.destination_domain ?? "the destination"} at ${incident.occurred_at}.`,
        incident.reports > 1
          ? `The sender was not told: Cloudflare dropped the ${incident.reports} refusal notices (a destination can send several for one message).`
          : "The sender was not told: Cloudflare drops the refusal notice.",
        "",
        "Check the destination mailbox's health (quota, rules, filtering), then ask the sender to send again (docs/live-checks.md).",
        "",
        reference,
      ].join("\n"),
    };
  }
  const alias = incident.alias ?? "an alias";
  return {
    subject: `IsItLegit: the Worker could not take mail to ${alias}`,
    text: [
      `A message${from} to ${alias}, received at ${incident.occurred_at}, was not taken by the Worker, and the sender's retry has not arrived within an hour.`,
      ...(incident.reason ? [`Cloudflare's reason: ${incident.reason}`] : []),
      ...(incident.possible_retry_at
        ? [
            `A delivery from the same sender to ${alias} arrived at ${incident.possible_retry_at}; the failed message carried no Message-ID, so it may or may not be its retry.`,
          ]
        : []),
      "",
      "Check the Worker's logs and the intake sweep (docs/live-checks.md); the sender's server may still retry.",
      "",
      reference,
    ].join("\n"),
  };
}

// Each mailbox under its own send key, so a repeated run sends neither twice. An alert counts as sent only once
// SMTP2GO confirmed it to every mailbox the allowlist admits (or confirmed an earlier send of the same key): an
// uncertain hand-over stays pending, and the reconciler's settlement of it is read on a later run.
async function alert(deps: ForwardingDeps, incident: Incident): Promise<"sent" | "refused" | "pending"> {
  const { subject, text } = alertText(incident);
  const outcomes: SendOutcome[] = [];
  for (const [n, to] of deps.operators.entries())
    outcomes.push(
      await sendMail(
        { ...deps.mail, operator: deps.operators },
        { sendKey: `forward-failure:${incident.key}:${n}`, kind: "alert", to, from: ALERTS_FROM, subject, text },
      ),
    );
  const confirmed = (o: SendOutcome) => o.status === "sent" || (o.status === "duplicate" && o.previous === "sent");
  const refused = (o: SendOutcome) => o.status === "refused" || (o.status === "duplicate" && o.previous === "refused");
  const state = outcomes.every(refused)
    ? "refused"
    : outcomes.every((o) => confirmed(o) || refused(o))
      ? "sent"
      : "pending";
  await deps.db
    .prepare(
      "UPDATE forward_incidents SET alert = ?, alert_tries = alert_tries + 1 WHERE key = ? AND alert = 'pending'",
    )
    .bind(state, incident.key)
    .run();
  return state;
}
