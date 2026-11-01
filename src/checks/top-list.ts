// The well-known sites list's shape (D02 T06 §3; spec 4.3a), without the Worker: what the loader and the reader share: a counter-signal against false positives on big legitimate sites.
// The list is Majestic Million, licensed under Creative Commons Attribution 3.0 Unported (NOTICE.md); the top 100,000
// registrable domains are held in KV by generation, so a load never writes over the list in use:
//
//   top:<generation>:<first two characters>   { "domains": [sorted names] }     one shard per prefix
//   top:meta                                  { generation, source, date, count, shards: { "<xx>": n } }
//   top:meta:previous                         the meta the last load replaced, so a restore is one write
//
// The meta is what makes a generation live; the loader (scripts/load-top-sites.ts) writes it last, after every shard has
// been read back whole. A reader that cannot read the list says so (`not_checked`) and never answers "unknown" for it.
import { registrable } from "./brand-schema.ts";

export const TOP_SOURCE = "majestic-million";
export const TOP_ATTRIBUTION = "Majestic Million, licensed under Creative Commons Attribution 3.0 Unported";
export const TOP_LIST_SIZE = 100_000;
export const MIN_LIST_SIZE = 90_000;
export const META_KEY = "top:meta";
export const PREVIOUS_META_KEY = "top:meta:previous";
// A load in progress marks its generation here, so another load's cleanup does not delete shards that are not live yet.
export const PENDING_PREFIX = "top:pending:";
export const pendingKey = (generation: string): string => `${PENDING_PREFIX}${generation}`;

export type TopMeta = {
  generation: string;
  source: string;
  date: string;
  count: number;
  shards: Record<string, number>;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A name the list may hold: its registrable domain in ASCII, lower case, labels of letters, digits and hyphens, at least
// two of them, at most 253 characters, and not an IP literal.
export function listName(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return null;
  const domain = registrable(host);
  if (!domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return /^[0-9]+$/.test(labels[labels.length - 1] as string) ? null : domain;
}

export const shardPrefix = (domain: string): string => domain.slice(0, 2);
export const shardKey = (generation: string, prefix: string): string => `top:${generation}:${prefix}`;

const isGeneration = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{12}$/.test(value);
const isPrefix = (value: string) => value.length === 2 && /^[a-z0-9.-]{2}$/.test(value);

// The meta as stored, or null when it is anything else.
export function parseMeta(text: unknown): TopMeta | null {
  let value: unknown = text;
  if (typeof text === "string") {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (!isGeneration(m.generation) || typeof m.source !== "string" || typeof m.date !== "string") return null;
  if (!Number.isFinite(Date.parse(m.date)) || !Number.isInteger(m.count) || (m.count as number) < 0) return null;
  const shards = m.shards;
  if (shards === null || typeof shards !== "object" || Array.isArray(shards)) return null;
  let sum = 0;
  for (const [prefix, n] of Object.entries(shards)) {
    if (!isPrefix(prefix) || !Number.isInteger(n) || (n as number) < 1) return null;
    sum += n as number;
  }
  return sum === m.count ? (m as unknown as TopMeta) : null;
}

// A shard as stored: its names, each belonging to its prefix, sorted and without repeats; null when it is anything else.
export function parseShard(text: unknown, prefix: string): string[] | null {
  let value: unknown = text;
  if (typeof text === "string") {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const domains = (value as Record<string, unknown>).domains;
  if (!Array.isArray(domains)) return null;
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    if (typeof d !== "string" || !d.startsWith(prefix) || (i > 0 && (domains[i - 1] as string) >= d)) return null;
  }
  return domains as string[];
}

// The names of one source row's `Domain` column in rank order, each reduced to its registrable domain and kept once, at
// its best rank, until `limit` are held (the loader's reading of the file; the same policy the Worker looks names up with).
export function collect(domains: Iterable<string>, limit: number = TOP_LIST_SIZE): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of domains) {
    const name = listName(raw);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

// The shards of a list: text by prefix, names sorted. The generation names the whole dataset (the first 12 hex of the
// SHA-256 of its shards in prefix order), so a changed list is a new generation and an unchanged one the same.
export async function generationOf(
  names: readonly string[],
): Promise<{ generation: string; shards: Map<string, string>; counts: Record<string, number> }> {
  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const prefix = shardPrefix(name);
    const list = byPrefix.get(prefix);
    if (list) list.push(name);
    else byPrefix.set(prefix, [name]);
  }
  const shards = new Map<string, string>();
  const counts: Record<string, number> = {};
  const parts: string[] = [];
  for (const prefix of [...byPrefix.keys()].sort()) {
    const sorted = [...(byPrefix.get(prefix) as string[])].sort();
    const text = JSON.stringify({ domains: sorted });
    shards.set(prefix, text);
    counts[prefix] = sorted.length;
    parts.push(`${prefix}\n${text}`);
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  const generation = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
  return { generation, shards, counts };
}
