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
// How long a refusal waits before it is tied to a forward, so every forward that will show has shown (a delivered
// forward took about 14 minutes to show, probe 1).
export const MATCH_GRACE_MS = 20 * 60 * 1000;
// How long a Worker failure waits for the sender's retry before it is alerted as unresolved.
export const RECOVERY_MS = 60 * 60 * 1000;
// The dataset's limit on one query's span (4 weeks 3 days), kept under; a longer gap starts from this far back.
export const MAX_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
// Settled incidents are kept this long, past any replay window, then deleted.
export const INCIDENTS_KEPT_MS = 90 * 24 * 60 * 60 * 1000;
export const PAGE = 1000;
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
  // MATCH_GRACE_MS unless a test says otherwise.
  graceMs?: number;
};

export type ForwardingOutcome = {
  state: "disabled" | "ok" | "partial" | "degraded";
  events: number;
  incidents: number;
  alerted: number;
  errors: string[];
};

const encoder = new TextEncoder();
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const domainOf = (address: string | null) => {
  const a = (address ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at > 0 && at < a.length - 1 ? a.slice(at + 1) : null;
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
  const outcome: ForwardingOutcome = { state: "ok", events: 0, incidents: 0, alerted: 0, errors: [] };
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
  for (const event of events) {
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
        "DELETE FROM forward_incidents WHERE alert IN ('none', 'sent', 'refused') AND state <> 'retrying' AND detected_at < ?",
      )
      .bind(new Date(now.getTime() - INCIDENTS_KEPT_MS).toISOString()),
  ]);
  await resolveRefusals(db, now, deps.graceMs ?? MATCH_GRACE_MS);
  const pending = await db
    .prepare(
      "SELECT key, kind, alias, uncertain, sender_domain, destination_domain, received_at, occurred_at, reason, reports, possible_retry_at FROM forward_incidents WHERE alert = 'pending' ORDER BY alert_tries, detected_at LIMIT ?",
    )
    .bind(ALERTS_PER_RUN)
    .all<Incident>();
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
  if (event.action === "forward" && event.isNDR === 0) {
    await db
      .prepare(
        "INSERT INTO forward_seen (message_hash, subject_hash, alias, sender_domain, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (message_hash) DO NOTHING",
      )
      .bind(
        await eventKey(event),
        await subjectKey(event.subject),
        (event.to ?? "").toLowerCase(),
        domainOf(event.from),
        at,
      )
      .run();
    return 0;
  }
  if (event.isNDR === 1 && (event.to ?? "").toLowerCase().startsWith("cfbounces+")) {
    const subject = await subjectKey(event.subject);
    const destination = domainOf(event.from);
    // Another notice of a refusal already recorded: the same subject and destination in the same second (Exchange sent
    // two for probe 2, together). It is counted, and the alert says how many came, so a merge is never silent (round 2).
    const known = await db
      .prepare(
        "SELECT key FROM forward_incidents WHERE kind = 'refused' AND subject_hash = ? AND destination_domain IS ? AND occurred_at = ?",
      )
      .bind(subject, destination, at)
      .first<{ key: string }>();
    if (known) {
      if (known.key !== (await eventKey(event)))
        await db.prepare("UPDATE forward_incidents SET reports = reports + 1 WHERE key = ?").bind(known.key).run();
      return 0;
    }
    // Recorded under the report's own identity, waiting: which forward it refused is resolved each run, once every
    // forward of the window can have been read (`resolveRefusals`).
    const opened = await db
      .prepare(
        "INSERT INTO forward_incidents (key, kind, subject_hash, destination_domain, occurred_at, detected_at, state, alert) VALUES (?, 'refused', ?, ?, ?, ?, 'open', 'waiting') ON CONFLICT (key) DO NOTHING",
      )
      .bind(await eventKey(event), subject, destination, at, now.toISOString())
      .run();
    return opened.meta.changes;
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

// Each waiting refusal past MATCH_GRACE_MS (longer than a forward takes to show, about 14 minutes), oldest first, tied
// to the forwards of its subject within NDR_WINDOW_MS before it that no other refusal has claimed: one is the refused
// message; several are all named and the incident marked uncertain; none is alerted as it stands. Waiting the grace
// first means every forward that will show has shown, so a forward read late never leaves the wrong one named (round
// 2); claims are made in time order, so two refusals of the same subject take two forwards, never one (round 1).
async function resolveRefusals(db: D1Database, now: Date, graceMs: number): Promise<void> {
  const waiting = await db
    .prepare(
      "SELECT key, subject_hash, occurred_at, detected_at FROM forward_incidents WHERE kind = 'refused' AND alert = 'waiting' AND detected_at <= ? ORDER BY occurred_at",
    )
    .bind(new Date(now.getTime() - graceMs).toISOString())
    .all<{ key: string; subject_hash: string; occurred_at: string; detected_at: string }>();
  for (const incident of waiting.results) {
    const forwards = await db
      .prepare(
        "SELECT message_hash, alias, sender_domain, at FROM forward_seen WHERE subject_hash = ? AND at <= ? AND at >= ? AND message_hash NOT IN (SELECT forward_hash FROM forward_incidents WHERE forward_hash IS NOT NULL) ORDER BY at",
      )
      .bind(
        incident.subject_hash,
        incident.occurred_at,
        new Date(Date.parse(incident.occurred_at) - NDR_WINDOW_MS).toISOString(),
      )
      .all<{ message_hash: string; alias: string; sender_domain: string | null; at: string }>();
    const found = forwards.results;
    const only = found.length === 1 ? found[0] : undefined;
    if (only) {
      await db
        .prepare(
          "UPDATE forward_incidents SET alias = ?, sender_domain = ?, received_at = ?, forward_hash = ?, alert = 'pending' WHERE key = ?",
        )
        .bind(only.alias, only.sender_domain, only.at, only.message_hash, incident.key)
        .run();
    } else if (found.length > 1) {
      await db
        .prepare("UPDATE forward_incidents SET alias = ?, uncertain = 1, alert = 'pending' WHERE key = ?")
        .bind([...new Set(found.map((f) => f.alias))].join(", "), incident.key)
        .run();
    } else {
      await db.prepare("UPDATE forward_incidents SET alert = 'pending' WHERE key = ?").bind(incident.key).run();
    }
  }
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
        ? `one of ${incident.alias} (several messages had the same subject)`
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
