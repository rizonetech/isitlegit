import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupNow, type LoadOptions, LoadRefused, loadTopSites, type Run } from "../../scripts/load-top-sites.ts";
import { META_KEY, PREVIOUS_META_KEY, parseMeta, shardKey } from "../../src/checks/top-list.ts";

// D02 T06 §3: the loader reduces the list to registrable domains, publishes it as a generation read back whole, and leaves
// the list in use alone whenever anything fails, with a fake Wrangler holding KV in memory.
const dir = mkdtempSync(join(tmpdir(), "load-top-sites-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const HEADER =
  "GlobalRank,TldRank,Domain,TLD,RefSubNets,RefIPs,IDN_Domain,IDN_TLD,PrevGlobalRank,PrevTldRank,PrevRefSubNets,PrevRefIPs";
const csv = (domains: string[], header = HEADER) =>
  [
    header,
    ...domains.map((d, i) => `${i + 1},${i + 1},${d},${d.split(".").pop()},10,10,${d},x,${i + 1},${i + 1},10,10`),
  ].join("\n");
let n = 0;
const listFile = (domains: string[], header?: string) => {
  const path = join(dir, `list-${n++}.csv`);
  writeFileSync(path, csv(domains, header));
  return path;
};
const OPTIONS = {
  limit: 100,
  minNames: 4,
  sleep: async () => {},
  verifyMs: 50,
  now: () => new Date("2026-11-01T10:00:00Z"),
};
const LIST_A = [
  "google.com",
  "support.google.com",
  "microsoft.com",
  "news.bbc.co.uk",
  "github.io",
  "a.github.io",
  "b.github.io",
  "player.vimeo.com",
  "bad_name.example",
  "1.2.3.4",
  "google.com",
];
const LIST_B = ["microsoft.com", "amazon.com", "zoom.us", "mozilla.org", "apple.com"];
const LIST_C = ["wikipedia.org", "reddit.com", "netflix.com", "adobe.com", "oracle.com"];

type Hooks = {
  // The remote API's answer shape, `{ key: value }`, in place of local storage's `{ key: { value } }`.
  remote?: boolean;
  // Called for each command with its number; returns a result to use in place of the real one.
  on?: (command: string, count: number) => ReturnType<Run> | undefined;
  // Replaces what a bulk get returns for a key.
  read?: (key: string, value: string | null) => string | null;
};
// Wrangler's KV commands over a Map, with the banner lines it prints before its JSON.
function fakeWrangler(store: Map<string, string>, hooks: Hooks = {}) {
  const calls: string[] = [];
  const run: Run = (args) => {
    const command = args.slice(0, 3).join(" ");
    calls.push(command);
    const hooked = hooks.on?.(command, calls.filter((c) => c === command).length);
    if (hooked) return hooked;
    const file = args[3] as string;
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (command === "kv bulk put") {
      for (const { key, value } of JSON.parse(readFile(file)) as { key: string; value: string }[])
        store.set(key, value);
      return ok("Success!\n");
    }
    if (command === "kv bulk get") {
      const keys = JSON.parse(readFile(file)) as string[];
      // Cloudflare's API takes at most 100 keys a read.
      if (keys.length > 100) return { status: 1, stdout: "", stderr: "too many keys" };
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const value = hooks.read ? hooks.read(key, store.get(key) ?? null) : (store.get(key) ?? null);
        out[key] = hooks.remote ? value : { value };
      }
      return ok(`Resource location: ${hooks.remote ? "remote" : "local"}\n\n${JSON.stringify(out, null, 2)}\n`);
    }
    if (command === "kv bulk delete") {
      for (const key of JSON.parse(readFile(file)) as string[]) store.delete(key);
      return ok("Success!\n");
    }
    if (command === "kv key list") {
      const prefix = args[args.indexOf("--prefix") + 1] as string;
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return ok(`Resource location: local\n${JSON.stringify(names, null, 2)}\n`);
    }
    return { status: 1, stdout: "", stderr: `unexpected ${command}` };
  };
  return { run, calls };
}

import { readFileSync } from "node:fs";

const readFile = (path: string) => readFileSync(path, "utf8");

const load = (source: string, run: Run, extra: Partial<LoadOptions> = {}) =>
  loadTopSites({ target: "local", source, run, ...OPTIONS, ...extra });
const metaOf = (store: Map<string, string>) => parseMeta(store.get(META_KEY) ?? "");
const liveNames = (store: Map<string, string>) => {
  const meta = metaOf(store);
  if (!meta) return null;
  return Object.keys(meta.shards)
    .flatMap((p) => (JSON.parse(store.get(shardKey(meta.generation, p)) ?? "{}") as { domains: string[] }).domains)
    .sort();
};
const afterEachCleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of afterEachCleanup.splice(0)) undo();
});

describe("a load", () => {
  it("reduces names to registrable domains, keeps the best rank, and reads the shards and meta back whole", async () => {
    const store = new Map<string, string>();
    const done = await load(listFile(LIST_A), fakeWrangler(store).run);
    // google.com once (support.google.com is the same), bbc.co.uk, vimeo.com; github.io dropped, its tenants kept apart,
    // an invalid name and an IP dropped.
    expect(liveNames(store)).toEqual([
      "a.github.io",
      "b.github.io",
      "bbc.co.uk",
      "google.com",
      "microsoft.com",
      "vimeo.com",
    ]);
    const meta = metaOf(store);
    expect(meta).toMatchObject({
      generation: done.generation,
      source: "majestic-million",
      date: "2026-11-01",
      count: 6,
    });
    expect(Object.values(meta?.shards ?? {}).reduce((a, b) => a + b, 0)).toBe(6);
    expect(done).toMatchObject({ count: 6, shards: Object.keys(meta?.shards ?? {}).length });
    expect(store.has(PREVIOUS_META_KEY)).toBe(false);
  });

  it("stops at the limit, in rank order", async () => {
    const store = new Map<string, string>();
    await load(listFile(["a1.com", "a2.com", "a3.com", "a4.com", "a5.com", "a6.com"]), fakeWrangler(store).run, {
      limit: 4,
    });
    expect(liveNames(store)).toEqual(["a1.com", "a2.com", "a3.com", "a4.com"]);
  });

  it("keeps the list it replaces as the previous one, restores it, and deletes only older generations", async () => {
    const store = new Map<string, string>();
    const wrangler = fakeWrangler(store);
    const a = await load(listFile(LIST_A), wrangler.run);
    const metaA = store.get(META_KEY);
    const b = await load(listFile(LIST_B), wrangler.run);
    expect(store.get(PREVIOUS_META_KEY)).toBe(metaA);
    expect(liveNames(store)).toEqual([...LIST_B].sort());
    expect([...store.keys()].some((k) => k.startsWith(`top:${a.generation}:`))).toBe(true);
    // Restore: the previous list is live again, its shards still there, the other generation's kept.
    const restored = await load("unused", wrangler.run, { restore: true });
    expect(restored.generation).toBe(a.generation);
    expect(store.get(META_KEY)).toBe(metaA);
    expect([...store.keys()].some((k) => k.startsWith(`top:${b.generation}:`))).toBe(true);
    // A third list: the generation before the previous one is deleted.
    await load(listFile(LIST_B), wrangler.run);
    const c = await load(listFile(LIST_C), wrangler.run);
    const generations = new Set([...store.keys()].map((k) => /^top:([0-9a-f]{12}):/.exec(k)?.[1]).filter(Boolean));
    expect(generations.has(a.generation)).toBe(false);
    expect(generations.has(c.generation)).toBe(true);
    expect(generations.size).toBe(2);
  });

  it("does not make a list its own previous when it is loaded again", async () => {
    const store = new Map<string, string>();
    const wrangler = fakeWrangler(store);
    await load(listFile(LIST_B), wrangler.run);
    await load(listFile(LIST_B), wrangler.run, { now: () => new Date("2026-11-02T10:00:00Z") });
    expect(store.has(PREVIOUS_META_KEY)).toBe(false);
    expect(metaOf(store)?.date).toBe("2026-11-02");
  });

  it("restores nothing when there is no previous list, or its shards are gone", async () => {
    const store = new Map<string, string>();
    await expect(load("unused", fakeWrangler(store).run, { restore: true })).rejects.toThrow(
      /no usable top:meta:previous/,
    );
    const wrangler = fakeWrangler(store);
    await load(listFile(LIST_A), wrangler.run);
    await load(listFile(LIST_B), wrangler.run);
    for (const key of [...store.keys()])
      if (key.startsWith(`top:${JSON.parse(store.get(PREVIOUS_META_KEY) ?? "{}").generation}:`)) store.delete(key);
    await expect(load("unused", wrangler.run, { restore: true })).rejects.toThrow(/shards are no longer there/);
  });
});

describe("a load that is refused", () => {
  it("refuses a list that is too short, mis-headed, or empty, writing nothing", async () => {
    for (const [list, header] of [
      [["only.com", "two.com"], undefined],
      [LIST_B, "Rank,Name,Other"],
      [LIST_B, "GlobalRank,TldRank,Site"],
      [[], undefined],
    ] as const) {
      const store = new Map<string, string>();
      const wrangler = fakeWrangler(store);
      await expect(load(listFile([...list], header), wrangler.run)).rejects.toThrow(LoadRefused);
      expect(store.size).toBe(0);
      expect(wrangler.calls).toEqual([]);
    }
    await expect(load(join(dir, "no-such-file.csv"), fakeWrangler(new Map()).run)).rejects.toThrow(/could not be read/);
  });

  it("refuses a download that is too large, stalls, is interrupted, never finishes or answers an error", async () => {
    const run = fakeWrangler(new Map()).run;
    const body = (chunks: Uint8Array[], failAfter = false) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
          if (failAfter) controller.error(new Error("reset"));
          else controller.close();
        },
      });
    const fetches: [RegExp, typeof fetch][] = [
      [
        /larger than 120 MB/,
        (async () =>
          new Response(body([new Uint8Array(1)]), {
            headers: { "content-length": String(130 * 1024 * 1024) },
          })) as typeof fetch,
      ],
      [/interrupted/, (async () => new Response(body([new TextEncoder().encode(HEADER)], true))) as typeof fetch],
      [
        /stalled/,
        (async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) }))) as typeof fetch,
      ],
      [
        /did not finish in time/,
        ((_: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          )) as unknown as typeof fetch,
      ],
      [/HTTP 503/, (async () => new Response("down", { status: 503 })) as typeof fetch],
    ];
    for (const [expected, fetcher] of fetches)
      await expect(
        load("https://example.test/list.csv", run, { fetch: fetcher, stallMs: 30, downloadMs: 60 }),
        String(expected),
      ).rejects.toThrow(expected);
  });

  it("refuses when a temporary directory cannot be made", async () => {
    const before = process.env.TMPDIR;
    process.env.TMPDIR = join(dir, "no", "such", "place");
    afterEachCleanup.push(() => {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    });
    await expect(load(listFile(LIST_B), fakeWrangler(new Map()).run)).rejects.toThrow(
      /temporary directory cannot be created/,
    );
  });
});

describe("a load that fails part way leaves the list in use alone, and a retry works", () => {
  const live = async () => {
    const store = new Map<string, string>();
    const first = await load(listFile(LIST_A), fakeWrangler(store).run);
    return { store, metaBefore: store.get(META_KEY), first, snapshot: new Map(store) };
  };

  it.each([
    [
      "a failing shard write",
      (c: string) => (c === "kv bulk put" ? { status: 1, stdout: "", stderr: "no" } : undefined),
    ],
    [
      "a stalled shard write",
      (c: string) => (c === "kv bulk put" ? { status: null, stdout: "", stderr: "" } : undefined),
    ],
    ["a failing read", (c: string) => (c === "kv bulk get" ? { status: 1, stdout: "", stderr: "no" } : undefined)],
    ["a stalled read", (c: string) => (c === "kv bulk get" ? { status: null, stdout: "", stderr: "" } : undefined)],
  ])("%s", async (_name, fail) => {
    const { store, metaBefore, snapshot } = await live();
    const wrangler = fakeWrangler(store, { on: (command) => fail(command) });
    await expect(load(listFile(LIST_B), wrangler.run)).rejects.toThrow(LoadRefused);
    expect(store.get(META_KEY)).toBe(metaBefore);
    // Whatever shards the failure left are of a generation nobody reads; the list in use is whole.
    for (const [key, value] of snapshot) expect(store.get(key)).toBe(value);
    // A retry on a healthy Wrangler succeeds.
    await load(listFile(LIST_B), fakeWrangler(store).run);
    expect(liveNames(store)).toEqual([...LIST_B].sort());
  });

  it("a write that stops half way", async () => {
    const { store, metaBefore } = await live();
    const namesBefore = liveNames(store);
    const wrangler = fakeWrangler(store, {
      on: (command, count) => {
        if (command !== "kv bulk put" || count !== 1) return undefined;
        // Part of the new generation reaches KV and the command fails.
        store.set("top:ffffffffffff:xx", "{}");
        return { status: 1, stdout: "", stderr: "connection lost" };
      },
    });
    await expect(load(listFile(LIST_B), wrangler.run)).rejects.toThrow(LoadRefused);
    expect(store.get(META_KEY)).toBe(metaBefore);
    expect(liveNames(store)).toEqual(namesBefore);
    await load(listFile(LIST_B), fakeWrangler(store).run);
    expect(liveNames(store)).toEqual([...LIST_B].sort());
  });

  it("a read that never matches, a same-size substitution, and a read that converges late", async () => {
    const { store, metaBefore } = await live();
    // A shard that reads back as a different text of the same size.
    const same = fakeWrangler(store, {
      read: (key, value) =>
        key.startsWith("top:") && key !== META_KEY && value ? value.replace(/\.com/, ".con") : value,
    });
    await expect(load(listFile(LIST_B), same.run)).rejects.toThrow(/did not read back as written/);
    expect(store.get(META_KEY)).toBe(metaBefore);
    // One that never converges.
    const stale = fakeWrangler(store, {
      read: (key, value) => (key.startsWith("top:") && key !== META_KEY ? null : value),
    });
    await expect(load(listFile(LIST_B), stale.run)).rejects.toThrow(/did not read back as written/);
    expect(store.get(META_KEY)).toBe(metaBefore);
    // One that shows the old value twice, then the new: the load waits, within its bound.
    let seen = 0;
    const late = fakeWrangler(store, {
      read: (key, value) => (key.startsWith("top:") && key !== META_KEY && seen++ < 2 ? null : value),
    });
    await load(listFile(LIST_B), late.run, { verifyMs: 60_000 });
    expect(liveNames(store)).toEqual([...LIST_B].sort());
  });

  it("a meta that cannot be published leaves the list in use", async () => {
    const { store, metaBefore } = await live();
    let puts = 0;
    const wrangler = fakeWrangler(store, {
      on: (command) => {
        if (command !== "kv bulk put") return undefined;
        puts++;
        // Puts: the shards (1), the previous meta (2), the new meta (3).
        return puts === 3 ? { status: 1, stdout: "", stderr: "no" } : undefined;
      },
    });
    await expect(load(listFile(LIST_B), wrangler.run)).rejects.toThrow(/publishing the meta failed/);
    expect(store.get(META_KEY)).toBe(metaBefore);
    expect(liveNames(store)).not.toBeNull();
  });
});

// Completion review: what production KV would do that local storage does not.
describe("against the remote API", () => {
  const MANY = Array.from(
    { length: 26 * 6 },
    (_, i) => `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}-site.com`,
  );

  it("reads Wrangler's remote answer, `{ key: value }`, as well as local storage's, through a load, a restore and a verify", async () => {
    const store = new Map<string, string>();
    const wrangler = fakeWrangler(store, { remote: true });
    const a = await load(listFile(LIST_A), wrangler.run);
    await load(listFile(LIST_B), wrangler.run);
    expect(liveNames(store)).toEqual([...LIST_B].sort());
    const restored = await load("unused", wrangler.run, { restore: true });
    expect(restored.generation).toBe(a.generation);
    expect(metaOf(store)?.generation).toBe(a.generation);
  });

  it("verifies a generation of more than 100 shards in reads of at most 100 keys", async () => {
    const store = new Map<string, string>();
    const wrangler = fakeWrangler(store, { remote: true });
    const done = await load(listFile(MANY), wrangler.run, { limit: 1_000, minNames: 100 });
    expect(done.shards).toBeGreaterThan(100);
    expect(Object.keys(metaOf(store)?.shards ?? {})).toHaveLength(done.shards);
    expect(wrangler.calls.filter((c) => c === "kv bulk get").length).toBeGreaterThan(2);
    // A restore reads the previous list's shards the same way.
    await load(listFile(LIST_B), wrangler.run);
    expect((await load("unused", wrangler.run, { restore: true })).shards).toBe(done.shards);
  });
});

describe("the verification deadline", () => {
  it("cuts every read and every wait to what is left of it, and ends within it", async () => {
    const store = new Map<string, string>();
    const asked: number[] = [];
    const burn = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const wrangler = fakeWrangler(store, {
      // Every read takes a while and shows nothing.
      on: (command) => {
        if (command === "kv bulk get") burn(30);
        return undefined;
      },
      read: () => null,
    });
    const run: Run = (args, ms) => {
      if (args.slice(0, 3).join(" ") === "kv bulk get") asked.push(ms);
      return wrangler.run(args, ms);
    };
    const began = Date.now();
    await expect(
      load(listFile(LIST_B), run, {
        verifyMs: 120,
        sleep: async (ms) => {
          burn(Math.min(ms, 20));
        },
      }),
    ).rejects.toThrow(/did not read back as written/);
    expect(Date.now() - began).toBeLessThan(600);
    expect(asked.length).toBeGreaterThan(1);
    expect(Math.max(...asked)).toBeLessThanOrEqual(120);
    expect(asked[asked.length - 1] as number).toBeLessThan(asked[0] as number);
  });
});

describe("what a failed publication means", () => {
  const live = async () => {
    const store = new Map<string, string>();
    await load(listFile(LIST_A), fakeWrangler(store).run);
    return { store, metaBefore: store.get(META_KEY) };
  };
  const isMetaPut = (file: string) => (JSON.parse(readFile(file)) as { key: string }[]).some((e) => e.key === META_KEY);

  it("is unchanged when KV refuses the meta write", async () => {
    const { store, metaBefore } = await live();
    const error = await load(
      listFile(LIST_B),
      fakeWrangler(store, {
        on: (command, count) =>
          command === "kv bulk put" && count === 3 ? { status: 1, stdout: "", stderr: "no" } : undefined,
      }).run,
    ).catch((e: LoadRefused) => e);
    expect(error).toBeInstanceOf(LoadRefused);
    expect((error as LoadRefused).published).toBe(false);
    expect(String((error as LoadRefused).message)).toMatch(/list in use is unchanged/);
    expect(store.get(META_KEY)).toBe(metaBefore);
  });

  it("is settled by reading when the write landed but its answer was lost: the new list is live and the load succeeds", async () => {
    const { store } = await live();
    const base = fakeWrangler(store);
    const run: Run = (args, ms) => {
      const done = base.run(args, ms);
      // The meta write is applied, then the command is reported as not having answered.
      return args.slice(0, 3).join(" ") === "kv bulk put" && isMetaPut(args[3] as string)
        ? { ...done, status: null }
        : done;
    };
    const done = await load(listFile(LIST_B), run);
    expect(metaOf(store)?.generation).toBe(done.generation);
    expect(liveNames(store)).toEqual([...LIST_B].sort());
  });

  it("is reported as uncertain, never as unchanged, when the write did not answer and the meta cannot be settled", async () => {
    const { store, metaBefore } = await live();
    const base = fakeWrangler(store);
    const run: Run = (args, ms) =>
      args.slice(0, 3).join(" ") === "kv bulk put" && isMetaPut(args[3] as string)
        ? { status: null, stdout: "", stderr: "" }
        : base.run(args, ms);
    const error = await load(listFile(LIST_B), run, { verifyMs: 40 }).catch((e: LoadRefused) => e);
    expect(error).toBeInstanceOf(LoadRefused);
    expect((error as LoadRefused).published).toBeNull();
    expect(store.get(META_KEY)).toBe(metaBefore);
  });

  it("is still a success, with a warning, when only the cleanup after publication fails", async () => {
    const { store } = await live();
    const done = await load(
      listFile(LIST_B),
      fakeWrangler(store, {
        on: (command) => (command === "kv key list" ? { status: 1, stdout: "", stderr: "no" } : undefined),
      }).run,
    );
    expect(done.warning).toMatch(/is live, but older shards were not cleaned up/);
    expect(metaOf(store)?.generation).toBe(done.generation);
    expect(liveNames(store)).toEqual([...LIST_B].sort());
  });
});

describe("cancellation and write failures", () => {
  it("removes the temporary directory when the process is told to stop", async () => {
    const root = mkdtempSync(join(dir, "root-"));
    const never = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as unknown as typeof fetch;
    const loading = load("https://example.test/list.csv", fakeWrangler(new Map()).run, {
      tmpRoot: root,
      fetch: never,
      downloadMs: 200,
    });
    loading.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readdirSync(root)).toHaveLength(1);
    cleanupNow();
    expect(readdirSync(root)).toHaveLength(0);
    await expect(loading).rejects.toThrow(LoadRefused);
  });

  it("refuses, with the list in use untouched and no temporary file left, when the download cannot be written", async () => {
    const store = new Map<string, string>();
    await load(listFile(LIST_A), fakeWrangler(store).run);
    const before = new Map(store);
    const root = mkdtempSync(join(dir, "root-"));
    // The directory exists; writing into it is denied as the body starts.
    const denied = (async () => {
      for (const entry of readdirSync(root)) chmodSync(join(root, entry), 0o500);
      return new Response(csv(LIST_B));
    }) as unknown as typeof fetch;
    await expect(
      load("https://example.test/list.csv", fakeWrangler(store).run, { tmpRoot: root, fetch: denied }),
    ).rejects.toThrow(/cannot be written to a temporary file/);
    expect(readdirSync(root)).toHaveLength(0);
    expect(new Map(store)).toEqual(before);
  });
});
