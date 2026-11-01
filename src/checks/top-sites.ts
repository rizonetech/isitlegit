// Whether a host is one of the well-known sites (D02 T06 §3; spec 4.3a), read from the live generation in KV. The list's
// shape and how it is loaded are in ./top-list and scripts/load-top-sites.ts.
import { bounded } from "./lookup-io";
import { listName, META_KEY, parseMeta, parseShard, shardKey, shardPrefix } from "./top-list";

export type WellKnown =
  | { state: "known" | "unknown"; date: string; source: string }
  | { state: "not_loaded" }
  | { state: "not_checked"; reason: "invalid_name" | "unavailable" | "incomplete" | "malformed" };

const FAILED = Symbol("kv read failed");
const read = (cache: KVNamespace, key: string): Promise<string | null | typeof FAILED> =>
  bounded<string | null | typeof FAILED>(cache.get(key, "text"), FAILED);

// Whether a host is one of the well-known sites: its registrable domain looked up in the live generation. `unknown` is
// only "not in the list": no counter-signal, never a mark against the domain. A list that cannot be read whole is
// `not_checked`; a prefix the meta has no shard for is `unknown`; no meta at all is `not_loaded`.
export async function isWellKnown(host: string, deps: { cache: KVNamespace }): Promise<WellKnown> {
  const name = listName(host);
  if (name === null) return { state: "not_checked", reason: "invalid_name" };
  const metaText = await read(deps.cache, META_KEY);
  if (metaText === FAILED) return { state: "not_checked", reason: "unavailable" };
  if (metaText === null) return { state: "not_loaded" };
  const meta = parseMeta(metaText);
  if (meta === null) return { state: "not_checked", reason: "malformed" };
  const prefix = shardPrefix(name);
  const info = { date: meta.date, source: meta.source };
  const count = meta.shards[prefix];
  if (count === undefined) return { state: "unknown", ...info };
  const shardText = await read(deps.cache, shardKey(meta.generation, prefix));
  if (shardText === FAILED) return { state: "not_checked", reason: "unavailable" };
  // The meta lists it: a shard that has not reached this location yet is not a negative.
  if (shardText === null) return { state: "not_checked", reason: "incomplete" };
  const domains = parseShard(shardText, prefix);
  if (domains === null || domains.length !== count) return { state: "not_checked", reason: "malformed" };
  return { state: domains.includes(name) ? "known" : "unknown", ...info };
}
