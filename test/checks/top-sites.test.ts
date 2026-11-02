import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { CACHE_MS } from "../../src/checks/lookup-io";
import {
  generationOf,
  listName,
  META_KEY,
  parseMeta,
  parseShard,
  shardKey,
  type TopMeta,
} from "../../src/checks/top-list";
import { isWellKnown } from "../../src/checks/top-sites";

// D02 T06 §3: the well-known sites list read from KV by generation, with fixture shards.
const NAMES = ["microsoft.com", "google.com", "bbc.co.uk", "mozilla.org", "amazon.com", "zoom.us"];

async function publish(names: readonly string[] = NAMES, date = "2026-11-01") {
  const { generation, shards, counts } = await generationOf(names);
  for (const [prefix, text] of shards) await env.CACHE.put(shardKey(generation, prefix), text);
  const meta: TopMeta = { generation, source: "majestic-million", date, count: names.length, shards: counts };
  await env.CACHE.put(META_KEY, JSON.stringify(meta));
  return { generation, shards, meta };
}
const kv = (over: Partial<KVNamespace>) =>
  new Proxy(env.CACHE, {
    get: (t, k) => {
      if (k in over) return (over as never)[k];
      const value = Reflect.get(t, k, t);
      return typeof value === "function" ? value.bind(t) : value;
    },
  }) as KVNamespace;

beforeEach(async () => {
  const listed = await env.CACHE.list({ prefix: "top:" });
  for (const key of listed.keys) await env.CACHE.delete(key.name);
});

describe("isWellKnown", () => {
  it("knows a listed site, also by a host under it, and not a random new one", async () => {
    await publish();
    const cache = env.CACHE;
    expect(await isWellKnown("microsoft.com", { cache })).toEqual({
      state: "known",
      date: "2026-11-01",
      source: "majestic-million",
      generation: ((await env.CACHE.get(META_KEY, "json")) as { generation: string }).generation,
      obtainedAt: expect.any(String),
    });
    expect((await isWellKnown("www.microsoft.com", { cache })).state).toBe("known");
    expect((await isWellKnown("login.accounts.bbc.co.uk", { cache })).state).toBe("known");
    expect(await isWellKnown(`new-${crypto.randomUUID().slice(0, 8)}.example`, { cache })).toMatchObject({
      state: "unknown",
    });
    // The same prefix as a listed name but not listed: still unknown.
    expect((await isWellKnown("microsoftx.com", { cache })).state).toBe("unknown");
  });

  it("stamps each answer with when it was obtained", async () => {
    await publish();
    const at = new Date("2026-11-02T12:34:56.000Z");
    expect(await isWellKnown("microsoft.com", { cache: env.CACHE, now: () => at })).toMatchObject({
      state: "known",
      obtainedAt: at.toISOString(),
    });
    expect(await isWellKnown("qq-never-listed.example", { cache: env.CACHE, now: () => at })).toMatchObject({
      state: "unknown",
      obtainedAt: at.toISOString(),
    });
  });

  it("says unknown for a prefix the list has no shard for, never a failure", async () => {
    await publish();
    expect((await isWellKnown("qq-never-listed.example", { cache: env.CACHE })).state).toBe("unknown");
  });

  it("is not loaded with no meta", async () => {
    expect(await isWellKnown("microsoft.com", { cache: env.CACHE })).toEqual({
      state: "not_loaded",
      obtainedAt: expect.any(String),
    });
  });

  it("is not checked for a host that has no registrable domain", async () => {
    await publish();
    for (const bad of ["", "localhost", "192.0.2.7", "github.io", "exa mple.com"])
      expect(await isWellKnown(bad, { cache: env.CACHE }), JSON.stringify(bad)).toEqual({
        state: "not_checked",
        reason: "invalid_name",
        obtainedAt: expect.any(String),
      });
  });

  it("is not checked, never unknown, for storage that is incomplete or wrong", async () => {
    const { generation, meta } = await publish();
    const cache = env.CACHE;
    // A shard the meta lists that is missing (not yet visible here).
    await env.CACHE.delete(shardKey(generation, "mi"));
    expect(await isWellKnown("microsoft.com", { cache })).toEqual({
      state: "not_checked",
      reason: "incomplete",
      obtainedAt: expect.any(String),
    });
    // A shard that is not the format, and one whose count is not the meta's.
    await env.CACHE.put(shardKey(generation, "mi"), "{nope");
    expect(await isWellKnown("microsoft.com", { cache })).toMatchObject({ state: "not_checked", reason: "malformed" });
    await env.CACHE.put(shardKey(generation, "mi"), JSON.stringify({ domains: ["microsoft.com", "mihaj.com"] }));
    expect(await isWellKnown("microsoft.com", { cache })).toMatchObject({ state: "not_checked", reason: "malformed" });
    await env.CACHE.put(shardKey(generation, "mi"), JSON.stringify({ domains: ["mozilla.org"] }));
    expect(await isWellKnown("microsoft.com", { cache })).toMatchObject({ state: "not_checked", reason: "malformed" });
    // Malformed meta: not JSON, a wrong generation, counts that do not add up.
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ ...meta, generation: "xyz" }),
      JSON.stringify({ ...meta, count: meta.count + 1 }),
    ]) {
      await env.CACHE.put(META_KEY, bad);
      expect(await isWellKnown("microsoft.com", { cache }), bad).toMatchObject({
        state: "not_checked",
        reason: "malformed",
      });
    }
  });

  it("is not checked when KV stalls or fails, within the cache budget", async () => {
    await publish();
    const stall = () => new Promise<never>(() => {});
    const fail = () => Promise.reject(new Error("kv down"));
    for (const [name, cache] of [
      ["meta stalls", kv({ get: stall as never })],
      ["meta fails", kv({ get: fail as never })],
      [
        "shard stalls",
        kv({ get: ((key: string) => (key === META_KEY ? env.CACHE.get(key, "text") : stall())) as never }),
      ],
      [
        "shard fails",
        kv({ get: ((key: string) => (key === META_KEY ? env.CACHE.get(key, "text") : fail())) as never }),
      ],
    ] as const) {
      const began = Date.now();
      expect(await isWellKnown("microsoft.com", { cache }), name).toEqual({
        state: "not_checked",
        reason: "unavailable",
        obtainedAt: expect.any(String),
      });
      expect(Date.now() - began, name).toBeLessThan(CACHE_MS * 4);
    }
  });

  it("reads the new list only when its meta says so: shards of a generation not yet live change nothing", async () => {
    const first = await publish(["microsoft.com", "google.com"]);
    // A second generation's shards are written, its meta not yet: readers stay on the first list.
    const next = await generationOf(["microsoft.com", "newsite.com"]);
    for (const [prefix, text] of next.shards) await env.CACHE.put(shardKey(next.generation, prefix), text);
    expect((await isWellKnown("newsite.com", { cache: env.CACHE })).state).toBe("unknown");
    expect((await isWellKnown("google.com", { cache: env.CACHE })).state).toBe("known");
    expect(first.generation).not.toBe(next.generation);
    // Its meta flips them all at once.
    await publish(["microsoft.com", "newsite.com"]);
    expect((await isWellKnown("newsite.com", { cache: env.CACHE })).state).toBe("known");
    expect((await isWellKnown("google.com", { cache: env.CACHE })).state).toBe("unknown");
  });
});

describe("the list's shape", () => {
  it("reduces every name to its registrable domain, as the Worker looks it up", () => {
    expect(listName("support.google.com")).toBe("google.com");
    expect(listName("PLAYER.vimeo.com.")).toBe("vimeo.com");
    expect(listName("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(listName("github.io")).toBeNull();
    expect(listName("a.github.io")).toBe("a.github.io");
    expect(listName("b.github.io")).toBe("b.github.io");
    for (const bad of ["", "localhost", "1.2.3.4", "münchen.example", "bad_name.example", `${"a".repeat(64)}.com`])
      expect(listName(bad), bad).toBeNull();
  });

  it("makes one generation of the same names whatever their order, and another of different ones", async () => {
    const a = await generationOf(["b.com", "a.com", "ab.com"]);
    const b = await generationOf(["ab.com", "a.com", "b.com"]);
    expect(a.generation).toBe(b.generation);
    expect(a.generation).toMatch(/^[0-9a-f]{12}$/);
    expect((await generationOf(["a.com", "b.com"])).generation).not.toBe(a.generation);
    expect(JSON.parse(a.shards.get("a.") ?? "{}")).toEqual({ domains: ["a.com"] });
    expect(JSON.parse(a.shards.get("ab") ?? "{}")).toEqual({ domains: ["ab.com"] });
  });

  it("parses only a meta and a shard in the stored format", () => {
    expect(parseShard('{"domains":["ab.com","ac.com"]}', "a")).toEqual(["ab.com", "ac.com"]);
    for (const bad of [
      '{"domains":["ac.com","ab.com"]}',
      '{"domains":["ab.com","ab.com"]}',
      '{"domains":["xb.com"]}',
      '{"domains":[1]}',
      "[]",
      "null",
    ])
      expect(parseShard(bad, "a"), bad).toBeNull();
    expect(
      parseMeta({ generation: "0123456789ab", source: "s", date: "2026-11-01", count: 3, shards: { ab: 2, cd: 1 } }),
    ).not.toBeNull();
    expect(
      parseMeta({ generation: "0123456789ab", source: "s", date: "2026-11-01", count: 4, shards: { ab: 2, cd: 1 } }),
    ).toBeNull();
  });
});
