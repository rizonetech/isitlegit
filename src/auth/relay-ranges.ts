// D02 T02 §10. Server-only lifecycle API. Principals come from signedIn/activeMembership or
// requireAccess's accessEmail, never request JSON. Console owns those authenticated route adapters.
import { z } from "zod";
import { parseCidr } from "../checks/receiving-chain";
import { receiversOf } from "./receivers";
import { caseLookups, providersOf, type Resolve, resolveDoh } from "./receiving-chains";

// IANA special-purpose registries, checked 2026-11-04. Configuration accepts ordinary global
// unicast only, not special-purpose allocations, translation, multicast or documentation space.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const SPECIAL = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.31.196.0/24",
  "192.52.193.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "192.175.48.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/3",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "2620:4f:8000::/48",
  "3fff::/20",
].map((s) => {
  const parsed = parseCidr(s);
  if (!parsed) throw new Error("Invalid configured special-purpose range");
  return parsed;
});

export function canonicalRelayRanges(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) return null;
  const out = new Set<string>();
  for (const text of input) {
    if (typeof text !== "string" || text.length > 50 || !/^[0-9a-fA-F:.]+\/[1-9]\d{0,2}$/.test(text)) return null;
    const [address = ""] = text.split("/");
    if (address.includes(":") && address.includes(".")) return null;
    if (!address.includes(":") && !address.split(".").every((p) => /^(0|[1-9]\d{0,2})$/.test(p))) return null;
    const p = parseCidr(text);
    if (!p) return null;
    const shift = BigInt(p.bits - p.prefix);
    if ((p.value >> shift) << shift !== p.value) return null;
    // IPv6 ordinary global unicast is 2000::/3; special allocations inside it are excluded below.
    if (p.bits === 128 && (p.prefix < 3 || p.value >> 125n !== 1n)) return null;
    if (
      SPECIAL.some(
        (r) =>
          r.bits === p.bits &&
          p.value >> BigInt(p.bits - Math.min(p.prefix, r.prefix)) ===
            r.value >> BigInt(p.bits - Math.min(p.prefix, r.prefix)),
      )
    )
      return null;
    const canonical = p.bits === 32 ? address : new URL(`http://[${address}]/`).hostname.slice(1, -1);
    out.add(`${canonical}/${p.prefix}`);
  }
  return [...out];
}

export type RelayPrincipal =
  | { kind: "member"; userId: string; orgId: string }
  | { kind: "reviewer"; accessEmail: string };
export type RelayDeps = { db: D1Database; resolve?: Resolve; now?: () => number };
const textId = z.string().min(1).max(128);
const bindingSchema = z
  .object({
    orgId: textId,
    claimId: textId,
    gateway: z
      .string()
      .min(4)
      .max(255)
      .regex(/^\*\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
    provider: z.enum(["microsoft", "google"]),
  })
  .strict();
export type RelayBinding = z.infer<typeof bindingSchema>;
const sourceSchema = z
  .object({
    url: z
      .string()
      .max(2048)
      .url()
      .refine((s) => {
        const u = new URL(s);
        return u.protocol === "https:" && !u.username && !u.password && !u.hash;
      }),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    retrievedAt: z.string().datetime(),
  })
  .strict();
const snapshotSchema = bindingSchema.extend({
  version: z.number().int().nonnegative(),
  revision: z.number().int().positive().nullable(),
  state: z.enum(["automatic", "pending", "verified", "rejected", "revoked"]),
  cidrs: z.array(z.string()).max(64),
  actor: z.string(),
  updatedAt: z.string(),
  source: sourceSchema.nullable(),
  reason: z.enum(["owner-request", "source-unavailable", "range-mismatch", "binding-changed", "verified"]).nullable(),
});
export type RelaySnapshot = z.infer<typeof snapshotSchema>;
const baseAction = bindingSchema.extend({
  expectedVersion: z.number().int().nonnegative(),
  requestKey: z.string().min(8).max(128),
});
const actionSchema = z.discriminatedUnion("action", [
  baseAction.extend({ action: z.literal("propose"), cidrs: z.array(z.string()).min(1).max(64) }).strict(),
  baseAction
    .extend({ action: z.literal("approve"), revision: z.number().int().positive(), source: sourceSchema })
    .strict(),
  baseAction
    .extend({
      action: z.literal("reject"),
      revision: z.number().int().positive(),
      reason: z.enum(["source-unavailable", "range-mismatch", "binding-changed"]),
    })
    .strict(),
  baseAction.extend({ action: z.literal("revoke") }).strict(),
  baseAction.extend({ action: z.literal("restore") }).strict(),
]);
export type RelayAction = z.infer<typeof actionSchema>;
export type RelayResult<T = RelaySnapshot> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; kind: "invalid" | "forbidden" | "conflict" | "unavailable" };
const fail = (kind: "invalid" | "forbidden" | "conflict" | "unavailable"): RelayResult<never> => ({ ok: false, kind });
const actorId = (a: RelayPrincipal) =>
  a.kind === "member" ? `member:${a.userId}` : `access:${a.accessEmail.trim().toLowerCase()}`;

// The same predicate is used at preflight and inside the atomic batch. Losing membership,
// closing the tenant or removing/unverifying the claim while DNS runs cannot admit a late write.
function authority(a: RelayPrincipal, b: RelayBinding) {
  const common = `EXISTS (SELECT 1 FROM org_domains d JOIN organization o ON o.id=d.org_id WHERE d.id=? AND d.org_id=? AND d.state='verified' AND o.closedAt IS NULL)`;
  if (a.kind === "member")
    return {
      sql: `${common} AND ?=? AND EXISTS (SELECT 1 FROM member m WHERE m.organizationId=? AND m.userId=? AND m.role IN ('owner','admin'))`,
      args: [b.claimId, b.orgId, a.orgId, b.orgId, b.orgId, a.userId],
    };
  return {
    sql: `${common} AND ?<>'' AND NOT EXISTS (SELECT 1 FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? AND lower(trim(u.email))=?)`,
    args: [b.claimId, b.orgId, a.accessEmail.trim().toLowerCase(), b.orgId, a.accessEmail.trim().toLowerCase()],
  };
}
async function authorized(db: D1Database, a: RelayPrincipal, b: RelayBinding) {
  const guard = authority(a, b);
  return !!(await db
    .prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`)
    .bind(...guard.args)
    .first());
}
async function current(db: D1Database, b: RelayBinding): Promise<RelaySnapshot> {
  const row = await db
    .prepare("SELECT snapshot FROM relay_range_heads WHERE org_id=? AND claim_id=? AND gateway=? AND provider=?")
    .bind(b.orgId, b.claimId, b.gateway, b.provider)
    .first<{ snapshot: string }>();
  if (row) return snapshotSchema.parse(JSON.parse(row.snapshot));
  return {
    ...b,
    version: 0,
    revision: null,
    state: "automatic",
    cidrs: [],
    actor: "",
    updatedAt: "",
    source: null,
    reason: null,
  };
}
async function bindingCurrent(deps: RelayDeps, b: RelayBinding): Promise<"current" | "changed" | "unavailable"> {
  const claim = await deps.db
    .prepare("SELECT domain FROM org_domains WHERE id=? AND org_id=? AND state='verified'")
    .bind(b.claimId, b.orgId)
    .first<{ domain: string }>();
  if (!claim) return "changed";
  const lookups = caseLookups(deps.resolve ?? resolveDoh);
  const mx = await lookups.ask(claim.domain, "MX");
  if (!Array.isArray(mx)) return "unavailable";
  if (!receiversOf(mx).some((r) => r.kind === "other" && r.pattern === b.gateway)) return "changed";
  const providers = await providersOf(claim.domain, lookups.ask);
  if (!providers.complete) return "unavailable";
  return providers.providers.includes(b.provider) ? "current" : "changed";
}

export async function readRelayBinding(deps: RelayDeps, actor: RelayPrincipal, input: unknown): Promise<RelayResult> {
  const parsed = bindingSchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const b = parsed.data;
  try {
    if (!(await authorized(deps.db, actor, b))) return fail("forbidden");
    const bound = await bindingCurrent(deps, b);
    if (bound !== "current") return fail(bound === "changed" ? "conflict" : "unavailable");
    const value = await current(deps.db, b);
    if (!(await authorized(deps.db, actor, b))) return fail("forbidden");
    return { ok: true, value };
  } catch {
    return fail("unavailable");
  }
}

export async function mutateRelayBinding(deps: RelayDeps, actor: RelayPrincipal, input: unknown): Promise<RelayResult> {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) return fail("invalid");
  const action = parsed.data;
  const b: RelayBinding = {
    orgId: action.orgId,
    claimId: action.claimId,
    gateway: action.gateway,
    provider: action.provider,
  };
  const reviewing = action.action === "approve" || action.action === "reject";
  if (reviewing !== (actor.kind === "reviewer")) return fail("forbidden");
  const cidrs = action.action === "propose" ? canonicalRelayRanges(action.cidrs) : null;
  if (action.action === "propose" && !cidrs) return fail("invalid");
  const now = new Date((deps.now ?? Date.now)()).toISOString();
  if (action.action === "approve" && Date.parse(action.source.retrievedAt) > Date.parse(now)) return fail("invalid");
  const actorKey = actorId(actor);
  const payload = JSON.stringify({ ...action, ...(cidrs ? { cidrs } : {}) });
  const replay = async (): Promise<RelayResult | null> => {
    const row = await deps.db
      .prepare("SELECT actor,payload,outcome FROM relay_range_actions WHERE org_id=? AND request_key=?")
      .bind(b.orgId, action.requestKey)
      .first<{ actor: string; payload: string; outcome: string }>();
    if (!row) return null;
    if (row.actor !== actorKey || row.payload !== payload) return fail("conflict");
    return { ok: true, value: snapshotSchema.parse(JSON.parse(row.outcome)), replayed: true };
  };
  try {
    if (!(await authorized(deps.db, actor, b))) return fail("forbidden");
    const previous = await replay();
    if (previous) return previous;
    // Revocation/restoration remain available when a gateway has changed or DNS is unavailable.
    // They only remove trust. Proposal and review require fresh, complete binding discovery.
    if (action.action !== "revoke" && action.action !== "restore") {
      const bound = await bindingCurrent(deps, b);
      if (bound !== "current") return fail(bound === "changed" ? "conflict" : "unavailable");
    }
    const old = await current(deps.db, b);
    if (old.version !== action.expectedVersion) return fail("conflict");
    if (reviewing && (old.state !== "pending" || old.revision !== action.revision)) return fail("conflict");
    if (action.action === "revoke" && old.revision === null) return fail("conflict");
    const next: RelaySnapshot = {
      ...old,
      version: old.version + 1,
      actor: actorKey,
      updatedAt: now,
      state:
        action.action === "propose"
          ? "pending"
          : action.action === "approve"
            ? "verified"
            : action.action === "reject"
              ? "rejected"
              : action.action === "revoke"
                ? "revoked"
                : "automatic",
      ...(action.action === "propose" ? { revision: old.version + 1, cidrs: cidrs ?? [] } : {}),
      ...(action.action === "restore" ? { revision: null, cidrs: [] } : {}),
      source: action.action === "approve" ? action.source : null,
      reason:
        action.action === "approve"
          ? "verified"
          : action.action === "reject"
            ? action.reason
            : action.action === "revoke" || action.action === "restore"
              ? "owner-request"
              : null,
    };
    const guard = authority(actor, b);
    const opId = crypto.randomUUID();
    const admitted = "EXISTS (SELECT 1 FROM relay_range_actions WHERE id=?)";
    const batch = [
      deps.db
        .prepare(`INSERT INTO relay_range_actions(id,org_id,claim_id,request_key,actor,payload,outcome,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql} AND COALESCE((SELECT version FROM relay_range_heads WHERE claim_id=? AND gateway=? AND provider=?),0)=?
      ON CONFLICT(org_id,request_key) DO NOTHING`)
        .bind(
          opId,
          b.orgId,
          b.claimId,
          action.requestKey,
          actorKey,
          payload,
          JSON.stringify(next),
          now,
          ...guard.args,
          b.claimId,
          b.gateway,
          b.provider,
          old.version,
        ),
    ];
    if (action.action === "propose")
      batch.push(
        deps.db
          .prepare(
            `INSERT INTO relay_range_revisions(claim_id,org_id,gateway,provider,revision,cidrs,actor,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${admitted}`,
          )
          .bind(b.claimId, b.orgId, b.gateway, b.provider, next.revision, JSON.stringify(cidrs), actorKey, now, opId),
      );
    batch.push(
      deps.db
        .prepare(`INSERT INTO relay_range_heads(claim_id,org_id,gateway,provider,version,snapshot) SELECT ?,?,?,?,?,? WHERE ${admitted}
      ON CONFLICT(claim_id,gateway,provider) DO UPDATE SET version=excluded.version,snapshot=excluded.snapshot`)
        .bind(b.claimId, b.orgId, b.gateway, b.provider, next.version, JSON.stringify(next), opId),
    );
    batch.push(
      deps.db
        .prepare(
          `DELETE FROM org_receiving_chains WHERE org_id=? AND claim_id=? AND gateway=? AND provider=? AND ${admitted}`,
        )
        .bind(b.orgId, b.claimId, b.gateway, b.provider, opId),
    );
    batch.push(deps.db.prepare("SELECT outcome FROM relay_range_actions WHERE id=?").bind(opId));
    const results = await deps.db.batch(batch);
    const result = results.at(-1)?.results[0] as { outcome?: string } | undefined;
    if (result?.outcome) return { ok: true, value: snapshotSchema.parse(JSON.parse(result.outcome)) };
    if (!(await authorized(deps.db, actor, b))) return fail("forbidden");
    return (await replay()) ?? fail("conflict");
  } catch {
    return fail("unavailable");
  }
}

// One verified domain per selector request keeps DNS work bounded. No new configuration or
// cached trust is created by discovering the choices; mutation independently revalidates them.
export async function discoverRelayBindings(
  deps: RelayDeps,
  actor: RelayPrincipal,
  input: unknown,
): Promise<RelayResult<RelayBinding[]>> {
  const parsed = z.object({ orgId: textId, claimId: textId }).strict().safeParse(input);
  if (!parsed.success) return fail("invalid");
  if (actor.kind !== "member") return fail("forbidden");
  const check: RelayBinding = { ...parsed.data, gateway: "*.unused.example", provider: "microsoft" };
  try {
    if (!(await authorized(deps.db, actor, check))) return fail("forbidden");
    const claim = await deps.db
      .prepare("SELECT domain FROM org_domains WHERE org_id=? AND id=? AND state='verified'")
      .bind(check.orgId, check.claimId)
      .first<{ domain: string }>();
    if (!claim) return fail("forbidden");
    const lookups = caseLookups(deps.resolve ?? resolveDoh);
    const mx = await lookups.ask(claim.domain, "MX");
    if (!Array.isArray(mx) || mx.length > 64) return fail("unavailable");
    const providers = await providersOf(claim.domain, lookups.ask);
    if (!providers.complete) return fail("unavailable");
    const gateways = receiversOf(mx).filter((r) => r.kind === "other" && r.pattern.startsWith("*."));
    if (!(await authorized(deps.db, actor, check))) return fail("forbidden");
    return {
      ok: true,
      value: gateways.flatMap((g) =>
        providers.providers.map((provider) => ({ ...parsed.data, gateway: g.pattern, provider })),
      ),
    };
  } catch {
    return fail("unavailable");
  }
}

// Keyset pagination of current pending revisions. A reviewer sees no configuration for a
// tenant in which its verified Access email has any membership. Exact approval rechecks it.
export async function pendingRelayBindings(
  deps: RelayDeps,
  actor: RelayPrincipal,
  input: unknown,
): Promise<RelayResult<{ items: RelaySnapshot[]; nextCursor: number | null }>> {
  const parsed = z
    .object({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(25) })
    .strict()
    .safeParse(input);
  if (!parsed.success) return fail("invalid");
  if (actor.kind !== "reviewer" || !actor.accessEmail.trim()) return fail("forbidden");
  try {
    const rows = await deps.db
      .prepare(`SELECT h.rowid AS cursor,h.snapshot FROM relay_range_heads h
      JOIN org_domains d ON d.id=h.claim_id AND d.org_id=h.org_id AND d.state='verified'
      JOIN organization o ON o.id=h.org_id AND o.closedAt IS NULL
      WHERE h.rowid>? AND json_extract(h.snapshot,'$.state')='pending'
      AND NOT EXISTS(SELECT 1 FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=h.org_id AND lower(trim(u.email))=?)
      ORDER BY h.rowid LIMIT ?`)
      .bind(parsed.data.after, actor.accessEmail.trim().toLowerCase(), parsed.data.limit + 1)
      .all<{ cursor: number; snapshot: string }>();
    const page = rows.results.slice(0, parsed.data.limit);
    return {
      ok: true,
      value: {
        items: page.map((row) => snapshotSchema.parse(JSON.parse(row.snapshot))),
        nextCursor: rows.results.length > parsed.data.limit ? (page.at(-1)?.cursor ?? null) : null,
      },
    };
  } catch {
    return fail("unavailable");
  }
}

export async function relayBindingHistory(
  deps: RelayDeps,
  actor: RelayPrincipal,
  input: unknown,
): Promise<RelayResult<{ items: RelaySnapshot[]; nextCursor: number | null }>> {
  const parsed = bindingSchema
    .extend({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(25) })
    .strict()
    .safeParse(input);
  if (!parsed.success) return fail("invalid");
  try {
    const b = parsed.data;
    if (!(await authorized(deps.db, actor, b))) return fail("forbidden");
    const guard = authority(actor, b);
    const rows = await deps.db
      .prepare(`SELECT rowid AS cursor,outcome FROM relay_range_actions
      WHERE org_id=? AND claim_id=? AND json_extract(payload,'$.gateway')=? AND json_extract(payload,'$.provider')=? AND rowid>?
      AND ${guard.sql} ORDER BY rowid LIMIT ?`)
      .bind(b.orgId, b.claimId, b.gateway, b.provider, b.after, ...guard.args, b.limit + 1)
      .all<{ cursor: number; outcome: string }>();
    if (!(await authorized(deps.db, actor, b))) return fail("forbidden");
    const page = rows.results.slice(0, b.limit);
    return {
      ok: true,
      value: {
        items: page.map((row) => snapshotSchema.parse(JSON.parse(row.outcome))),
        nextCursor: rows.results.length > b.limit ? (page.at(-1)?.cursor ?? null) : null,
      },
    };
  } catch {
    return fail("unavailable");
  }
}
