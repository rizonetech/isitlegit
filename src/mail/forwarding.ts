// Forwarding failures (D01 T02 §6). Cloudflare forwards an alias's mail and does not pass back what happens next: a
// destination that refuses it after the hand-over sends its non-delivery report to Cloudflare, which drops it
// (https://developers.cloudflare.com/email-service/reference/postmaster/#non-delivery-reports-ndrs). Email Routing's
// events (GraphQL `emailRoutingAdaptive`) still show it: probe 2 (2026-10-30, §6) read the forward as `delivered` and
// the refusal as `isNDR` 1 events from the destination's domain to `cfbounces+ndrdrop@`, subject `Undeliverable: ` and
// the original's. So each refusal is tied to its forward by a hash of that subject within NDR_WINDOW_MS, and the
// operator is alerted, on two mailboxes, since OPERATOR_EMAIL is the aliases' own destination. Member mail the Worker
// failed to take (`deliveryFailed`, action `worker`) is an incident too, alerted only if the sender's retry has not
// arrived within RECOVERY_MS. The scan's progress and every incident are in D1 (migration 0036): a missed run catches
// up, and an alert not yet handed over is tried again. Never a body, a subject or the sender's address: domains only.
import { type MailDeps, type SendOutcome, sendMail } from "./smtp2go";

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
// The overlap each scan reads again: a refusal shows within minutes, a delivered forward within about 14 (§6's probes).
export const LOOKBACK_MS = 30 * 60 * 1000;
// A refusal belongs to a forward of the same subject at most this long before it.
export const NDR_WINDOW_MS = 30 * 60 * 1000;
// How long a Worker failure waits for the sender's retry before it is alerted as unresolved.
export const RECOVERY_MS = 60 * 60 * 1000;
// The dataset's limit on one query's span (4 weeks 3 days), kept under; a longer gap starts from this far back.
export const MAX_SPAN_MS = 30 * 24 * 60 * 60 * 1000;
export const PAGE = 1000;
export const MAX_PAGES = 10;
export const ALERTS_PER_RUN = 20;
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
};

export type ForwardingDeps = {
  db: D1Database;
  token: string | undefined;
  zone: string | undefined;
  mail: MailDeps;
  operators: readonly string[];
  fetch?: typeof fetch;
  now?: () => Date;
};

export type ForwardingOutcome = {
  state: "disabled" | "ok" | "degraded";
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

const QUERY = `query($zone: String!, $from: Time!, $to: Time!, $limit: Int!) {
  viewer { zones(filter: { zoneTag: $zone }) {
    emailRoutingAdaptive(limit: $limit, filter: { datetime_geq: $from, datetime_leq: $to }, orderBy: [datetime_ASC]) {
      datetime sessionId messageId from to subject status action isNDR
    }
  } }
}`;

async function readEvents(deps: ForwardingDeps, from: Date, to: Date): Promise<RoutingEvent[]> {
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
    if (batch.length < PAGE) return events;
    // A full page: the next starts at its last event's time (an event at that instant is read twice, and deduplicated).
    start = new Date(batch[batch.length - 1]?.datetime ?? to.toISOString());
  }
  return events;
}

// One run: read the events since the last scan (with LOOKBACK_MS of overlap), record forwards and incidents, settle
// Worker incidents, and send each alert not yet handed over.
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
  let events: RoutingEvent[] = [];
  try {
    events = await readEvents(deps, from, now);
  } catch (error) {
    outcome.state = "degraded";
    outcome.errors.push((error as Error).message);
  }
  outcome.events = events.length;
  for (const event of events) {
    try {
      outcome.incidents += await record(db, event, now);
    } catch (error) {
      outcome.state = "degraded";
      outcome.errors.push(`recording an event: ${(error as Error).name}`);
    }
  }
  if (outcome.state === "ok") {
    await db
      .prepare(
        "INSERT INTO forward_scan (zone, scanned_to) VALUES (?, ?) ON CONFLICT (zone) DO UPDATE SET scanned_to = excluded.scanned_to",
      )
      .bind(deps.zone, now.toISOString())
      .run();
  }
  await db.batch([
    // A Worker failure whose retry never arrived is unresolved, and alerted.
    db
      .prepare(
        "UPDATE forward_incidents SET state = 'unresolved', alert = 'pending' WHERE kind = 'worker' AND state = 'retrying' AND occurred_at <= ?",
      )
      .bind(new Date(now.getTime() - RECOVERY_MS).toISOString()),
    db.prepare("DELETE FROM forward_seen WHERE at < ?").bind(new Date(now.getTime() - FORWARDS_KEPT_MS).toISOString()),
  ]);
  const pending = await db
    .prepare(
      "SELECT key, kind, alias, sender_domain, destination_domain, occurred_at FROM forward_incidents WHERE alert = 'pending' ORDER BY detected_at LIMIT ?",
    )
    .bind(ALERTS_PER_RUN)
    .all<Incident>();
  for (const incident of pending.results) {
    const alerted = await alert(deps, incident);
    if (alerted === "sent") outcome.alerted++;
    if (alerted === "retry") {
      outcome.state = "degraded";
      outcome.errors.push(`an alert for ${incident.key.slice(0, 12)} was not handed over; tried again next run`);
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
    // The refusal's forward: the same subject, at most NDR_WINDOW_MS before the report. Several reports for one
    // forward are one incident, keyed by the forward.
    const forward = await db
      .prepare(
        "SELECT message_hash, alias, sender_domain FROM forward_seen WHERE subject_hash = ? AND at <= ? AND at >= ? ORDER BY at DESC LIMIT 1",
      )
      .bind(await subjectKey(event.subject), at, new Date(Date.parse(at) - NDR_WINDOW_MS).toISOString())
      .first<{ message_hash: string; alias: string; sender_domain: string | null }>();
    const key = forward?.message_hash ?? (await eventKey(event));
    const opened = await db
      .prepare(
        "INSERT INTO forward_incidents (key, kind, alias, sender_domain, destination_domain, occurred_at, detected_at, state, alert) VALUES (?, 'refused', ?, ?, ?, ?, ?, 'open', 'pending') ON CONFLICT (key) DO NOTHING",
      )
      .bind(key, forward?.alias ?? null, forward?.sender_domain ?? null, domainOf(event.from), at, now.toISOString())
      .run();
    return opened.meta.changes;
  }
  if (event.action === "worker" && event.status === "deliveryFailed") {
    const opened = await db
      .prepare(
        "INSERT INTO forward_incidents (key, kind, alias, sender_domain, destination_domain, occurred_at, detected_at, state, alert) VALUES (?, 'worker', ?, ?, NULL, ?, ?, 'retrying', 'none') ON CONFLICT (key) DO NOTHING",
      )
      .bind(await eventKey(event), (event.to ?? "").toLowerCase(), domainOf(event.from), at, now.toISOString())
      .run();
    return opened.meta.changes;
  }
  if (event.action === "worker" && event.status === "delivered") {
    // The sender's retry arrived: the failure is recovered, and never alerted.
    await db
      .prepare(
        "UPDATE forward_incidents SET state = 'recovered' WHERE key = ? AND kind = 'worker' AND state = 'retrying'",
      )
      .bind(await eventKey(event))
      .run();
  }
  return 0;
}

type Incident = {
  key: string;
  kind: "refused" | "worker";
  alias: string | null;
  sender_domain: string | null;
  destination_domain: string | null;
  occurred_at: string;
};

export function alertText(incident: Incident): { subject: string; text: string } {
  const alias = incident.alias ?? "an alias";
  const from = incident.sender_domain ? ` from ${incident.sender_domain}` : "";
  if (incident.kind === "refused")
    return {
      subject: `IsItLegit: mail to ${alias} was refused after forwarding`,
      text: [
        `A message${from} to ${alias}, received at ${incident.occurred_at}, was forwarded by Cloudflare and then refused by ${incident.destination_domain ?? "the destination"}.`,
        "The sender was not told: Cloudflare drops the refusal notice.",
        "",
        "Check the destination mailbox's health (quota, rules, filtering), then ask the sender to send again (docs/live-checks.md).",
      ].join("\n"),
    };
  return {
    subject: `IsItLegit: the Worker could not take mail to ${alias}`,
    text: [
      `A message${from} to ${alias}, received at ${incident.occurred_at}, was not taken by the Worker, and the sender's retry has not arrived within an hour.`,
      "",
      "Check the Worker's logs and the intake sweep (docs/live-checks.md); the sender's server may still retry.",
    ].join("\n"),
  };
}

// Both mailboxes, each under its own send key: a repeated run sends neither twice (`duplicate`).
async function alert(deps: ForwardingDeps, incident: Incident): Promise<"sent" | "refused" | "retry"> {
  const { subject, text } = alertText(incident);
  const outcomes: SendOutcome[] = [];
  for (const [n, to] of deps.operators.entries())
    outcomes.push(
      await sendMail(
        { ...deps.mail, operator: deps.operators },
        { sendKey: `forward-failure:${incident.key}:${n}`, kind: "alert", to, from: ALERTS_FROM, subject, text },
      ),
    );
  const state = outcomes.some((o) => o.status === "failed")
    ? "retry"
    : outcomes.every((o) => o.status === "refused")
      ? "refused"
      : "sent";
  await deps.db
    .prepare(
      "UPDATE forward_incidents SET alert = ?, alert_tries = alert_tries + 1 WHERE key = ? AND alert = 'pending'",
    )
    .bind(state === "retry" ? "pending" : state, incident.key)
    .run();
  return state;
}
