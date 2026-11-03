// The auth audit trail (D07 T02 §6): one `auth_events` row for each sign-in, failed link, invitation, team change,
// verification attempt and rate-limit refusal. Ids, kinds and outcomes only: the client's IP is an HMAC under the auth
// secret, so a row can be matched to others from the same client without holding the address itself, and no email
// address, token, code or link is written. Recording never fails what it records: a row that cannot be written is
// logged, and the sign-in or the change goes on.

export type AuthEventKind =
  | "sign-in"
  | "sign-in-failed"
  | "invite"
  | "update-member-role"
  | "cancel-invitation"
  | "remove-member"
  | "leave-organization"
  | "verify-domain"
  | "verify-address"
  // A claim removed (D07 T04 §4): the claim's id as the target, never the domain or address.
  | "remove-domain"
  | "remove-address"
  | "rate-limited";

export type AuthEvent = {
  kind: AuthEventKind;
  outcome: string;
  orgId?: string | null;
  userId?: string | null;
  actorId?: string | null;
  targetId?: string | null;
  ip?: string | null;
  // Only labels and counts (a method, a path, a role, a retry time): never an address, a token or a code.
  detail?: Record<string, string | number | boolean | null>;
};

// The team changes the owners' history shows (D07 T04 §3).
export const TEAM_ACTIONS = ["update-member-role", "cancel-invitation", "remove-member", "leave-organization"] as const;

// Authentication logs are kept 12 months, the usual window for them; the operator can shorten it here.
export const AUTH_EVENTS_RETENTION_DAYS = 365;
// The longest rate-limit window (src/auth/ratelimit.ts): a bucket older than this has expired.
export const LONGEST_WINDOW_SECONDS = 600;
const SWEEP_BATCH = 1_000;

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The client's address as Better Auth's limiter keys it (an IPv6 address by its /64, a mapped IPv4 as IPv4, lowercase),
// so a refusal's hash matches the same client's other rows (round 1).
export function normalizeIp(ip: string): string {
  const value = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1]) return mapped[1];
  // The same mapping written in hex (`::ffff:c000:0201`), as Better Auth reads it.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  if (!value.includes(":")) return value;
  const [head = "", tail] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups =
    tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return value;
  return groups.map((g, i) => (i < 4 ? g.padStart(4, "0") : "0000")).join(":");
}

export const ipHash = (secret: string, ip: string) => hmac(secret, `ip\n${normalizeIp(ip)}`);
export const bucketKey = (secret: string, key: string) => hmac(secret, `bucket\n${key}`);

export async function recordAuthEvent(db: D1Database, secret: string, event: AuthEvent): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO auth_events (id, at, kind, outcome, org_id, user_id, actor_id, target_id, ip_hash, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        event.kind,
        event.outcome,
        event.orgId ?? null,
        event.userId ?? null,
        event.actorId ?? null,
        event.targetId ?? null,
        event.ip ? await ipHash(secret, event.ip) : null,
        event.detail ? JSON.stringify(event.detail) : null,
      )
      .run();
  } catch (error) {
    // The event survives in the Worker's log when its row could not be written, attributable by ids alone (never an
    // address, a token or a code), so a refusal or a change can be recovered once storage returns (D07 T02 §21).
    console.error(
      JSON.stringify({
        event: "auth-audit",
        outcome: "unrecorded",
        kind: event.kind,
        recorded: event.outcome,
        orgId: event.orgId ?? null,
        actorId: event.actorId ?? null,
        targetId: event.targetId ?? null,
        error: (error as Error).name,
      }),
    );
  }
}

// The client's address as Cloudflare set it (D07 T02 §10: the one header a client cannot write).
export const clientIp = (headers: Headers | undefined | null) => headers?.get("cf-connecting-ip") ?? null;

export type TeamChange = {
  seq: number;
  id: string;
  at: string;
  kind: (typeof TEAM_ACTIONS)[number];
  outcome: string;
  actor_id: string | null;
  target_id: string | null;
  detail_json: string | null;
};

// One organisation's team history, newest first, by action and date (D07 T04 §3 reads it through its owner-only route),
// a page at a time: each page ends with the cursor of its last row, `at` then its insertion order (`rowid`; completion
// review G5, final review), so rows sharing a time keep the order they happened in and are never skipped or repeated. Dates are compared as the stored ISO timestamps (G4: the route
// normalises them first).
// A cursor a page gave: a real stored timestamp (calendar-correct, UTC) and a rowid inside the safe integer range.
export function validHistoryCursor(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z\|(\d+)$/.exec(value);
  if (!m) return false;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] ?? 0)),
  );
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3]) ||
    d.getUTCHours() !== Number(m[4]) ||
    d.getUTCMinutes() !== Number(m[5]) ||
    d.getUTCSeconds() !== Number(m[6])
  )
    return false;
  const seq = Number(m[8]);
  return Number.isSafeInteger(seq) && seq >= 1;
}

export const HISTORY_PAGE = 100;
export async function readTeamHistory(
  db: D1Database,
  orgId: string,
  filter: {
    action?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    after?: string | undefined;
    // One person, as actor, as target, or as either (`person`, D07 T04 §24): predicates at the database layer,
    // before the page limit, always inside this organisation.
    actor?: string | undefined;
    target?: string | undefined;
    person?: string | undefined;
  } = {},
): Promise<{ changes: TeamChange[]; next: string | null }> {
  const actions =
    filter.action && (TEAM_ACTIONS as readonly string[]).includes(filter.action) ? [filter.action] : [...TEAM_ACTIONS];
  const [afterAt, afterId] = filter.after ? filter.after.split("|") : [null, null];
  const rows = await db
    .prepare(
      `SELECT rowid AS seq, id, at, kind, outcome, actor_id, target_id, detail_json FROM auth_events WHERE org_id = ? AND kind IN (${actions.map(() => "?").join(", ")}) AND at >= ? AND at <= ? AND (? IS NULL OR at < ? OR (at = ? AND rowid < ?)) AND (? IS NULL OR actor_id = ?) AND (? IS NULL OR target_id = ?) AND (? IS NULL OR actor_id = ? OR target_id = ?) ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .bind(
      orgId,
      ...actions,
      filter.from ?? "",
      filter.to ?? "9999",
      afterAt ?? null,
      afterAt ?? null,
      afterAt ?? null,
      afterId === null || afterId === undefined ? null : Number(afterId),
      filter.actor ?? null,
      filter.actor ?? null,
      filter.target ?? null,
      filter.target ?? null,
      filter.person ?? null,
      filter.person ?? null,
      filter.person ?? null,
      HISTORY_PAGE + 1,
    )
    .all<TeamChange>();
  const changes = rows.results.slice(0, HISTORY_PAGE);
  const last = changes.at(-1);
  return { changes, next: rows.results.length > HISTORY_PAGE && last ? `${last.at}|${last.seq}` : null };
}

// The cron's sweep (D07 T02 §6): expired limiter buckets, and audit rows past their retention, each in a bounded batch.
export async function sweepAuthTables(db: D1Database, now = new Date()): Promise<{ buckets: number; events: number }> {
  const bucketsBefore = Math.floor(now.getTime() / 1000) - LONGEST_WINDOW_SECONDS;
  const eventsBefore = new Date(now.getTime() - AUTH_EVENTS_RETENTION_DAYS * 86_400_000).toISOString();
  const [buckets, events] = await db.batch([
    db
      .prepare(
        `DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE window_start < ? LIMIT ${SWEEP_BATCH})`,
      )
      .bind(bucketsBefore),
    db
      .prepare(`DELETE FROM auth_events WHERE id IN (SELECT id FROM auth_events WHERE at < ? LIMIT ${SWEEP_BATCH})`)
      .bind(eventsBefore),
  ]);
  return { buckets: buckets?.meta.changes ?? 0, events: events?.meta.changes ?? 0 };
}
