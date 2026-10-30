// Domain registration dates from RDAP (D02 T03 §4; RFC 9083, the IANA bootstrap of RFC 9224), read by the Workflow's
// `checks` step for the case's header domains and put in the view as `domainAges`, since a check never reaches the
// network or KV itself. KV `CACHE` keeps the bootstrap a day and each registration date seven days; a failure is never
// cached and never a guess.
import type { CaseView } from "./case-view";
import { headerDomains, knownDomains } from "./domain-lookalike";

export const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
export const MAX_AGE_LOOKUPS = 5;
export const RDAP_TIMEOUT_MS = 4_000;
// One lookup's whole budget (the bootstrap, the cache and the answer): past it the lookup is unavailable and its network
// work is cancelled, so the step's lookups end in bounded time whatever a registry, a body or KV does (plan review).
export const LOOKUP_BUDGET_MS = 5_000;
// The most of an RDAP answer read: a domain object is a few kilobytes (Verisign's example.com is 2.5 KB).
export const MAX_RDAP_BYTES = 256 * 1024;
const BOOTSTRAP_TTL_S = 24 * 60 * 60;
const DOMAIN_TTL_S = 7 * 24 * 60 * 60;

export type DomainAge =
  | { state: "known"; registered: string; server: string }
  | { state: "unknown"; reason: "no-service" | "unavailable" | "malformed" | "no-date" };
export type RdapDeps = { fetch: typeof fetch; cache: KVNamespace | null };
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
  try {
    response = await deps.fetch(url, {
      headers: { accept: "application/rdap+json, application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(RDAP_TIMEOUT_MS)]),
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
    return signal.aborted ? null : "malformed";
  }
}

type Services = [string[], string[]][];
async function bootstrap(deps: RdapDeps, signal: AbortSignal): Promise<Services | null> {
  const cached = await deps.cache?.get("rdap:bootstrap", "json").catch(() => null);
  if (cached) return (cached as { services: Services }).services;
  const read = await fetchJson(BOOTSTRAP_URL, deps, signal);
  if (!read || read === "malformed" || !Array.isArray((read as { services?: unknown }).services)) return null;
  const services = (read as { services: Services }).services;
  await deps.cache
    ?.put("rdap:bootstrap", JSON.stringify({ services }), { expirationTtl: BOOTSTRAP_TTL_S })
    .catch(() => undefined);
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
    return await Promise.race([lookup(domain, deps, budget.signal), deadline]);
  } catch {
    return { state: "unknown", reason: "unavailable" };
  } finally {
    clearTimeout(timer);
    budget.abort();
  }
}

async function lookup(domain: string, deps: RdapDeps, signal: AbortSignal): Promise<DomainAge> {
  const key = `rdap:domain:${domain}`;
  const cached = await deps.cache?.get(key, "json").catch(() => null);
  if (cached) return cached as DomainAge;
  const services = await bootstrap(deps, signal);
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
  const date = typeof event?.eventDate === "string" ? new Date(event.eventDate) : null;
  if (!date || Number.isNaN(date.getTime())) return { state: "unknown", reason: "no-date" };
  const age: DomainAge = { state: "known", registered: date.toISOString(), server };
  await deps.cache?.put(key, JSON.stringify(age), { expirationTtl: DOMAIN_TTL_S }).catch(() => undefined);
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
