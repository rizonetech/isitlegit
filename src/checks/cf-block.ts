// Cloudflare's malware-blocking resolver as a second opinion (D02 T06 §2; spec 4.3a): 1.1.1.2 answers `0.0.0.0` for a
// domain it blocks. Asked over DNS-over-HTTPS (RFC 8484, Cloudflare's JSON form). Called by the Workflow's checks step,
// since a check never reaches the network or KV itself; this file is the client only. Only a host name leaves the Worker.
// A failure or an answer that cannot be read is `not_checked`, never `clear`, and is never cached.
import { recordEvent } from "../pipeline/events";
import { bounded, boundedText, deadline, KV_MIN_TTL_S, letGo, sha256Hex } from "./lookup-io";

export const CLOUDFLARE_DOH_URL = "https://security.cloudflare-dns.com/dns-query";
export const CF_TIMEOUT_MS = 4_000;
export const MAX_CF_BYTES = 64 * 1024;
export const BLOCKED_TTL_MS = 24 * 60 * 60 * 1_000;
// A negative answer is kept six hours, as spec 4.3a keeps one: a domain blocked after it was clear must not read clear for a day.
export const CLEAR_TTL_MS = 6 * 60 * 60 * 1_000;
// Cloudflare publishes no uptime commitment for 1.1.1.2 and its terms are to be confirmed before launch: carried on a
// result, so the evidence item that reports it (D02 T06 §4) has it in its detail.
export const CLOUDFLARE_TERMS_CAVEAT =
  "Cloudflare publishes no uptime commitment for its 1.1.1.2 resolver; confirm its terms before launch.";

export type CfNotChecked = "invalid_name" | "timeout" | "rate_limited" | "unavailable" | "rejected" | "malformed";
export type CfResult =
  | { state: "blocked"; cached: boolean; caveat: string; obtainedAt?: string }
  | { state: "clear"; cached: boolean; caveat: string; obtainedAt?: string }
  | { state: "not_checked"; reason: CfNotChecked };

export type CfDeps = {
  fetch: typeof fetch;
  cache: KVNamespace | null;
  db: D1Database;
  caseId: string;
  now?: () => Date;
  // The lookup's time budget, CF_TIMEOUT_MS unless a test shortens it.
  timeoutMs?: number;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A host name Cloudflare is asked about: ASCII (a punycode name as the URL parser gives it), at least two labels, each of
// letters, digits and hyphens, at most 253 characters, and no IP literal (a last label that is all digits). Null otherwise.
export function checkName(raw: string): string | null {
  const name = raw.trim().toLowerCase().replace(/\.$/, "");
  if (name.length === 0 || name.length > 253) return null;
  const labels = name.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return /^[0-9]+$/.test(labels[labels.length - 1] as string) ? null : name;
}

// The answer read, in Cloudflare's DNS JSON: `Status` 0 with an A record of 0.0.0.0 is a block; `Status` 0 without one
// and `Status` 3 (the name does not exist) are not; any other status, or a shape that is not the format, is not an answer.
type Parsed = "blocked" | "clear" | "unavailable" | null;
export function parseDns(text: string): Parsed {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { Status, Answer, TC } = body as Record<string, unknown>;
  if (typeof Status !== "number" || !Number.isInteger(Status)) return null;
  if (TC !== undefined && typeof TC !== "boolean") return null;
  // A truncated answer (it did not fit the packet) may have lost the record that blocks: not an answer (completion review).
  if (TC === true) return "unavailable";
  if (Answer !== undefined) {
    if (!Array.isArray(Answer)) return null;
    for (const a of Answer)
      if (
        a === null ||
        typeof a !== "object" ||
        !Number.isInteger((a as Record<string, unknown>).type) ||
        typeof (a as Record<string, unknown>).data !== "string"
      )
        return null;
  }
  if (Status === 3) return "clear";
  if (Status !== 0) return "unavailable";
  const blocked = ((Answer ?? []) as { type: number; data: string }[]).some(
    (a) => a.type === 1 && a.data === "0.0.0.0",
  );
  return blocked ? "blocked" : "clear";
}

type Entry = { v: 1; blocked: boolean; expiresAt: string; fetchedAt?: string | undefined };
const isEntry = (value: unknown): value is Entry => {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.blocked === "boolean" &&
    typeof e.expiresAt === "string" &&
    Number.isFinite(Date.parse(e.expiresAt))
  );
};

async function ask(name: string, deps: CfDeps): Promise<CfResult> {
  const limit = deadline(deps.timeoutMs ?? CF_TIMEOUT_MS);
  try {
    const response = await Promise.race([
      deps.fetch(`${CLOUDFLARE_DOH_URL}?${new URLSearchParams({ name, type: "A" })}`, {
        headers: { accept: "application/dns-json" },
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
    const text = await boundedText(response, MAX_CF_BYTES, limit.expired);
    if (text === "timeout") return { state: "not_checked", reason: "timeout" };
    const parsed = text === null ? null : parseDns(text);
    if (parsed === null) return { state: "not_checked", reason: "malformed" };
    if (parsed === "unavailable") return { state: "not_checked", reason: "unavailable" };
    return {
      state: parsed,
      cached: false,
      caveat: CLOUDFLARE_TERMS_CAVEAT,
      obtainedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
  } catch {
    return { state: "not_checked", reason: limit.passed ? "timeout" : "unavailable" };
  } finally {
    limit.finish();
  }
}

// Whether Cloudflare's malware-blocking resolver blocks the host name. Reads the cache, asks once, caches a block 24 hours
// and a clear answer six, and logs the lookup in `case_events` (step `reputation`). Throws when the audit write fails,
// after the answer is cached, so a retry costs no lookup.
export async function cloudflareBlocked(domain: string, deps: CfDeps): Promise<CfResult> {
  const name = checkName(domain);
  if (name === null) return { state: "not_checked", reason: "invalid_name" };
  const began = Date.now();
  const clock = deps.now ?? (() => new Date());
  const hash = await sha256Hex(name);
  const result = await lookup(name, hash, deps, clock);
  const recorded = await recordEvent(
    deps.db,
    deps.caseId,
    "reputation",
    result.state === "not_checked" ? "error" : "done",
    {
      ms: Date.now() - began,
      errorClass: `cloudflare:${result.state}:${hash.slice(0, 12)}`,
    },
  );
  if (!recorded.ok) throw new Error("recording reputation: database");
  return result;
}

async function lookup(name: string, hash: string, deps: CfDeps, clock: () => Date): Promise<CfResult> {
  const cacheKey = `cfblock:${hash}`;
  const hit = deps.cache ? await bounded(deps.cache.get(cacheKey, "json") as Promise<unknown>, null) : null;
  if (isEntry(hit) && Date.parse(hit.expiresAt) > clock().getTime())
    return {
      state: hit.blocked ? "blocked" : "clear",
      cached: true,
      caveat: CLOUDFLARE_TERMS_CAVEAT,
      obtainedAt: hit.fetchedAt ?? clock().toISOString(),
    };
  const answer = await ask(name, deps);
  if (answer.state === "blocked" || answer.state === "clear") {
    const ttlMs = answer.state === "blocked" ? BLOCKED_TTL_MS : CLEAR_TTL_MS;
    if (deps.cache && ttlMs / 1_000 >= KV_MIN_TTL_S) {
      const entry: Entry = {
        v: 1,
        blocked: answer.state === "blocked",
        expiresAt: new Date(clock().getTime() + ttlMs).toISOString(),
        fetchedAt: answer.obtainedAt,
      };
      await bounded(deps.cache.put(cacheKey, JSON.stringify(entry), { expirationTtl: ttlMs / 1_000 }), undefined);
    }
  }
  return answer;
}
