// Domain registration dates from RDAP (D02 T03 §4; RFC 9083, the IANA bootstrap of RFC 9224), read by the Workflow's
// `checks` step for the case's header domains and put in the view as `domainAges`, since a check never reaches the
// network or KV itself. KV `CACHE` keeps the bootstrap a day and each registration date seven days; a failure is never
// cached and never a guess.

import type { CaseView } from "./case-view";
import { headerDomains, knownDomains } from "./domain-lookalike";
import { type Connect, readWhois, whoisAnswer, whoisServerFor } from "./whois";

export const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export const MAX_AGE_LOOKUPS = 5;
export const RDAP_TIMEOUT_MS = 4_000;
// One lookup's whole budget (the bootstrap, the cache and the answer): past it the lookup is unavailable and its network
// work is cancelled, so the step's lookups end in bounded time whatever a registry, a body or KV does (plan review).
export const LOOKUP_BUDGET_MS = 5_000;
// The most of an RDAP answer read: a domain object is a few kilobytes (Verisign's example.com is 2.5 KB).
export const MAX_RDAP_BYTES = 256 * 1024;
const BOOTSTRAP_TTL_S = 24 * 60 * 60;
// KV is a cache: a read or write that takes longer than this is given up, never holding a lookup's answer back
// (completion review: a stalled write lost a good date).
export const CACHE_MS = 500;
const bounded = <T>(work: Promise<T>, fallback: T): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), CACHE_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};
const cacheGet = (deps: RdapDeps, key: string) =>
  deps.cache ? bounded(deps.cache.get(key, "json") as Promise<unknown>, null) : Promise.resolve(null);
const cachePut = (deps: RdapDeps, key: string, value: unknown, ttl: number) =>
  deps.cache
    ? bounded(deps.cache.put(key, JSON.stringify(value), { expirationTtl: ttl }), undefined)
    : Promise.resolve();
const DOMAIN_TTL_S = 7 * 24 * 60 * 60;

export type DomainAge =
  | { state: "known"; registered: string; server: string }
  | { state: "unknown"; reason: "no-service" | "unavailable" | "malformed" | "no-date" | "not-registered" };
// `connect` reads `.za` names from ZACR's WHOIS (D02 T03 §9); without it they are asked of RDAP, which has no `za` service.
export type RdapDeps = { fetch: typeof fetch; cache: KVNamespace | null; connect?: Connect };
export type DomainAges = {
  checkedAt: string;
  ages: { domain: string; fields: string[]; age: DomainAge }[];
  // Header domains past MAX_AGE_LOOKUPS, not looked up.
  unread: string[];
};

// A response's body as text, at most MAX_RDAP_BYTES, or null past it.
async function boundedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RDAP_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

// A 200 answer's JSON, `malformed` when it is too large or not JSON, null when there is no 200 answer.
async function fetchJson(url: string, deps: RdapDeps, signal: AbortSignal): Promise<unknown | "malformed" | null> {
  let response: Response;
  const within = AbortSignal.any([signal, AbortSignal.timeout(RDAP_TIMEOUT_MS)]);
  try {
    response = await deps.fetch(url, {
      headers: { accept: "application/rdap+json, application/json" },
      signal: within,
    });
  } catch {
    return null;
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const text = await boundedText(response);
    if (text === null) return "malformed";
    const json: unknown = JSON.parse(text);
    return typeof json === "object" && json !== null ? json : "malformed";
  } catch {
    // A body cut off by either deadline is no answer, not a bad one (completion review).
    return within.aborted ? null : "malformed";
  }
}

type Services = [string[], string[]][];
// What a lookup found to keep, written after its answer is had (each write still bounded), so a slow KV never costs the
// lookup its answer (round 1).
type Writes = (() => Promise<unknown>)[];

async function bootstrap(deps: RdapDeps, signal: AbortSignal, writes: Writes): Promise<Services | null> {
  const cached = await cacheGet(deps, "rdap:bootstrap");
  if (cached) return (cached as { services: Services }).services;
  const read = await fetchJson(BOOTSTRAP_URL, deps, signal);
  if (!read || read === "malformed" || !Array.isArray((read as { services?: unknown }).services)) return null;
  const services = (read as { services: Services }).services;
  writes.push(() => cachePut(deps, "rdap:bootstrap", { services }, BOOTSTRAP_TTL_S));
  return services;
}

// The RDAP base URL for a domain: the service whose entry is the longest suffix of it (RFC 9224 section 4).
export function serviceFor(domain: string, services: Services): string | null {
  const labels = domain.toLowerCase().split(".");
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const found = services.find(([tlds]) => tlds.includes(suffix));
    const base = found?.[1].find((u) => u.startsWith("https://")) ?? found?.[1][0];
    if (base) return base.endsWith("/") ? base : `${base}/`;
  }
  return null;
}

// An RFC 3339 timestamp (RDAP's, RFC 9083 section 4.5) as a Date, only when it names a real moment: `2026-02-30` is no
// date, where JavaScript would read March 2 (completion review).
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
export function rfc3339(text: string): Date | null {
  const m = RFC3339.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as number[];
  const calendar = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== (month as number) - 1 ||
    calendar.getUTCDate() !== day ||
    (hour as number) > 23 ||
    (minute as number) > 59 ||
    (second as number) > 60
  )
    return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

// A domain's registration date, within LOOKUP_BUDGET_MS, never throwing: an answer that cannot be had is `unavailable`.
export async function rdapLookup(domain: string, deps: RdapDeps): Promise<DomainAge> {
  const budget = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DomainAge>((resolve) => {
    timer = setTimeout(() => {
      budget.abort();
      resolve({ state: "unknown", reason: "unavailable" });
    }, LOOKUP_BUDGET_MS);
  });
  try {
    const writes: Writes = [];
    const age = await Promise.race([lookup(domain, deps, budget.signal, writes), deadline]);
    await Promise.all(writes.map((write) => write()));
    return age;
  } catch {
    return { state: "unknown", reason: "unavailable" };
  } finally {
    clearTimeout(timer);
    budget.abort();
  }
}

async function lookup(domain: string, deps: RdapDeps, signal: AbortSignal, writes: Writes): Promise<DomainAge> {
  const key = `rdap:domain:${domain}`;
  const cached = await cacheGet(deps, key);
  if (cached) return cached as DomainAge;
  const whois = deps.connect ? whoisServerFor(domain) : null;
  if (whois && deps.connect) {
    const text = await whoisAnswer(domain, whois, deps.connect, signal);
    if (text === null) return { state: "unknown", reason: "unavailable" };
    if (text === "oversized") return { state: "unknown", reason: "malformed" };
    const age = readWhois(domain, text, rfc3339, whois);
    // Only a date is cached, as for RDAP: a name not registered today may be tomorrow.
    if (age.state === "known") writes.push(() => cachePut(deps, key, age, DOMAIN_TTL_S));
    return age;
  }
  const services = await bootstrap(deps, signal, writes);
  if (!services) return { state: "unknown", reason: "unavailable" };
  const server = serviceFor(domain, services);
  if (!server) return { state: "unknown", reason: "no-service" };
  const answer = await fetchJson(`${server}domain/${encodeURIComponent(domain)}`, deps, signal);
  if (!answer) return { state: "unknown", reason: "unavailable" };
  if (answer === "malformed") return { state: "unknown", reason: "malformed" };
  // Only the registration event's own date: RDAP may leave it out (RFC 9083 section 2.1), and no other event stands in.
  const events = (answer as { events?: unknown }).events;
  const event = (Array.isArray(events) ? (events as { eventAction?: unknown; eventDate?: unknown }[]) : []).find(
    (e) => e?.eventAction === "registration",
  );
  const date = typeof event?.eventDate === "string" ? rfc3339(event.eventDate) : null;
  if (!date) return { state: "unknown", reason: "no-date" };
  const age: DomainAge = { state: "known", registered: date.toISOString(), server };
  writes.push(() => cachePut(deps, key, age, DOMAIN_TTL_S));
  return age;
}

// Names under the reserved top-level domains (RFC 2606, RFC 6761) cannot be registered, so they have no age to ask for.
const RESERVED = ["example", "test", "invalid", "localhost"];
const reserved = (domain: string) => RESERVED.includes(domain.slice(domain.lastIndexOf(".") + 1));

// The ages the `checks` step puts in the view: the header domains the case's context does not vouch for, From first,
// at most MAX_AGE_LOOKUPS of them, looked up together.
export async function domainAgesOf(view: CaseView, deps: RdapDeps, now = new Date()): Promise<DomainAges> {
  const known = knownDomains(view);
  const domains = headerDomains(view).filter((d) => !known.has(d.domain) && !reserved(d.domain));
  const looked = domains.slice(0, MAX_AGE_LOOKUPS);
  const ages = await Promise.all(
    looked.map(async (d) => ({
      domain: d.domain,
      fields: d.fields as string[],
      age: await rdapLookup(d.domain, deps),
    })),
  );
  return { checkedAt: now.toISOString(), ages, unread: domains.slice(MAX_AGE_LOOKUPS).map((d) => d.domain) };
}
