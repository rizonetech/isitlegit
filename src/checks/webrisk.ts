// Google Web Risk's Lookup API, `uris.search` only (D02 T06 §1; spec 4.3a): whether a link is on Google's lists of
// malware, social engineering and unwanted software. Never the Update API, which reprices every lookup to US$50 per 1,000
// (`test/checks/webrisk-api-guard.test.ts`). Called by the Workflow's checks step, since a check never reaches the
// network or KV itself; this file is the client only.
//
// What leaves the Worker is the link's scheme, host, port and path: no query, no fragment, no user information (the
// privacy rule of spec 4.3a). The key goes in a header, never in a URL. An answer is cached by the hash of that stripped
// URL; a failure, a refusal or a malformed answer is never cached and never read as "not listed".
import { recordEvent } from "../pipeline/events";
import { type CapScope, dayOf, release, reserve, WEB_RISK_GLOBAL_DAILY, WEB_RISK_ORG_DAILY } from "./caps";
import { bounded, boundedText, deadline, KV_MIN_TTL_S, letGo, sha256Hex } from "./lookup-io";

export const WEB_RISK_URL = "https://webrisk.googleapis.com/v1/uris:search";
export const THREAT_TYPES = ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"] as const;
export type ThreatType = (typeof THREAT_TYPES)[number];
// The most a lookup may take, the cache's share of it, and the most of an answer read: an answer is a few hundred bytes.
export const WEB_RISK_TIMEOUT_MS = 4_000;
export const MAX_WEB_RISK_BYTES = 64 * 1024;
export const MAX_URI = 2_048;
export const LISTED_TTL_MS = 24 * 60 * 60 * 1_000;
export const NOT_LISTED_TTL_MS = 6 * 60 * 60 * 1_000;

export type NotChecked =
  | "no_key"
  | "invalid_url"
  | "counting"
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "rejected"
  | "malformed";
export type WebRiskResult =
  | { state: "listed"; threatTypes: ThreatType[]; expiresAt: string; cached: boolean; obtainedAt?: string }
  | { state: "not_listed"; cached: boolean; obtainedAt?: string }
  | { state: "capped"; scope: CapScope }
  | { state: "not_checked"; reason: NotChecked };

export type WebRiskDeps = {
  fetch: typeof fetch;
  cache: KVNamespace | null;
  db: D1Database;
  key: string | null;
  orgId: string;
  caseId: string;
  now?: () => Date;
  // The lookup's time budget, WEB_RISK_TIMEOUT_MS unless a test shortens it.
  timeoutMs?: number;
};

// A link as Web Risk is asked about it: scheme, host, port and path only. Null for anything that is not an http or https
// URL with a host, or that is longer than Web Risk takes.
export function stripUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  const stripped = `${url.protocol}//${url.host}${url.pathname}`;
  return stripped.length <= MAX_URI ? stripped : null;
}

type Entry = { v: 1; listed: boolean; threatTypes: ThreatType[]; expiresAt: string; fetchedAt?: string | undefined };
const isThreat = (t: unknown): t is ThreatType => (THREAT_TYPES as readonly unknown[]).includes(t);
const isEntry = (value: unknown): value is Entry => {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.listed === "boolean" &&
    Array.isArray(e.threatTypes) &&
    e.threatTypes.every(isThreat) &&
    (!e.listed || e.threatTypes.length > 0) &&
    typeof e.expiresAt === "string" &&
    Number.isFinite(Date.parse(e.expiresAt)) &&
    (e.fetchedAt === undefined || (typeof e.fetchedAt === "string" && Number.isFinite(Date.parse(e.fetchedAt))))
  );
};

// The answer read: `{}` is not listed; a `threat` with a non-empty list of known threat types and a valid `expireTime` is
// listed; anything else is not an answer (an unknown threat type, a missing or invalid expiry, a non-object).
type Parsed = { listed: false } | { listed: true; threatTypes: ThreatType[]; expireTime: number } | null;
export function parseAnswer(text: string): Parsed {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const threat = (body as Record<string, unknown>).threat;
  if (threat === undefined) return Object.keys(body).length === 0 ? { listed: false } : null;
  if (threat === null || typeof threat !== "object" || Array.isArray(threat)) return null;
  const { threatTypes, expireTime } = threat as Record<string, unknown>;
  if (!Array.isArray(threatTypes) || threatTypes.length === 0 || !threatTypes.every(isThreat)) return null;
  const expires = typeof expireTime === "string" ? Date.parse(expireTime) : Number.NaN;
  if (!Number.isFinite(expires)) return null;
  return { listed: true, threatTypes: [...new Set(threatTypes)], expireTime: expires };
}

async function ask(stripped: string, deps: WebRiskDeps, key: string): Promise<WebRiskResult> {
  const params = new URLSearchParams();
  for (const t of THREAT_TYPES) params.append("threatTypes", t);
  params.set("uri", stripped);
  const limit = deadline(deps.timeoutMs ?? WEB_RISK_TIMEOUT_MS);
  try {
    const response = await Promise.race([
      deps.fetch(`${WEB_RISK_URL}?${params}`, {
        headers: { "X-Goog-Api-Key": key, accept: "application/json" },
        redirect: "error",
        signal: limit.signal,
      }),
      limit.expired,
    ]);
    if (response.status !== 200) {
      letGo(response);
      if (response.status === 429) return { state: "not_checked", reason: "rate_limited" };
      if (response.status === 400 || response.status === 401 || response.status === 403)
        return { state: "not_checked", reason: "rejected" };
      return { state: "not_checked", reason: "unavailable" };
    }
    const text = await boundedText(response, MAX_WEB_RISK_BYTES, limit.expired);
    if (text === "timeout") return { state: "not_checked", reason: "timeout" };
    const parsed = text === null ? null : parseAnswer(text);
    if (parsed === null) return { state: "not_checked", reason: "malformed" };
    const now = (deps.now ?? (() => new Date()))().getTime();
    return parsed.listed
      ? {
          state: "listed",
          threatTypes: parsed.threatTypes,
          // Never kept past Google's own `expireTime`, nor past 24 hours.
          expiresAt: new Date(Math.min(parsed.expireTime, now + LISTED_TTL_MS)).toISOString(),
          cached: false,
          obtainedAt: new Date(now).toISOString(),
        }
      : { state: "not_listed", cached: false, obtainedAt: new Date(now).toISOString() };
  } catch {
    return { state: "not_checked", reason: limit.passed ? "timeout" : "unavailable" };
  } finally {
    limit.finish();
  }
}

// Whether the stripped URL is on Web Risk's lists. Reads the cache, then takes a place under the organisation's and the
// day's caps before the one request it may make; logs the lookup in `case_events` (step `reputation`). Throws when the
// audit write fails, after the answer is cached, so a retry costs no lookup.
export async function webRiskSearch(url: string, deps: WebRiskDeps): Promise<WebRiskResult> {
  const stripped = stripUrl(url);
  if (stripped === null) return { state: "not_checked", reason: "invalid_url" };
  const began = Date.now();
  const clock = deps.now ?? (() => new Date());
  const hash = await sha256Hex(stripped);
  const result = await lookup(stripped, hash, deps, clock);
  const recorded = await recordEvent(
    deps.db,
    deps.caseId,
    "reputation",
    result.state === "not_checked" ? "error" : "done",
    {
      ms: Date.now() - began,
      errorClass: `webrisk:${result.state}:${hash.slice(0, 12)}`,
    },
  );
  if (!recorded.ok) throw new Error("recording reputation: database");
  return result;
}

async function lookup(stripped: string, hash: string, deps: WebRiskDeps, clock: () => Date): Promise<WebRiskResult> {
  if (!deps.key) return { state: "not_checked", reason: "no_key" };
  const cacheKey = `webrisk:${hash}`;
  const hit = deps.cache ? await bounded(deps.cache.get(cacheKey, "json") as Promise<unknown>, null) : null;
  if (isEntry(hit) && Date.parse(hit.expiresAt) > clock().getTime())
    return hit.listed
      ? {
          state: "listed",
          threatTypes: hit.threatTypes,
          expiresAt: hit.expiresAt,
          cached: true,
          obtainedAt: hit.fetchedAt ?? clock().toISOString(),
        }
      : { state: "not_listed", cached: true, obtainedAt: hit.fetchedAt ?? clock().toISOString() };
  // Both places confirmed before the one request: a count that cannot be written is no licence to call.
  const day = dayOf(clock());
  const orgScope = `webrisk:${deps.orgId}`;
  const globalScope = "webrisk:*";
  let org = false;
  try {
    org = await reserve(deps.db, day, orgScope, WEB_RISK_ORG_DAILY);
    if (!org) return { state: "capped", scope: "organisation" };
    if (!(await reserve(deps.db, day, globalScope, WEB_RISK_GLOBAL_DAILY))) {
      await release(deps.db, day, orgScope);
      return { state: "capped", scope: "global" };
    }
  } catch {
    // A place taken that cannot be given back stays counted: high, never low.
    if (org) await release(deps.db, day, orgScope);
    return { state: "not_checked", reason: "counting" };
  }
  const answer = await ask(stripped, deps, deps.key);
  if (answer.state === "listed" || answer.state === "not_listed") {
    const expiresAt =
      answer.state === "listed" ? answer.expiresAt : new Date(clock().getTime() + NOT_LISTED_TTL_MS).toISOString();
    const ttl = Math.floor((Date.parse(expiresAt) - clock().getTime()) / 1_000);
    if (deps.cache && ttl >= KV_MIN_TTL_S) {
      const entry: Entry = {
        v: 1,
        listed: answer.state === "listed",
        threatTypes: answer.state === "listed" ? answer.threatTypes : [],
        expiresAt,
        fetchedAt: answer.obtainedAt,
      };
      await bounded(deps.cache.put(cacheKey, JSON.stringify(entry), { expirationTtl: ttl }), undefined);
    }
  }
  return answer;
}
