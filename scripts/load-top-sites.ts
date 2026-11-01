// Loads the well-known sites list into the Worker's `CACHE` namespace (D02 T06 §3): Majestic Million, licensed under
// Creative Commons Attribution 3.0 Unported (NOTICE.md). The top 100,000 registrable domains become one generation of
// shards (`top:<generation>:<xx>`), read back whole, and only then made live by writing `top:meta`; the meta it replaces
// is kept as `top:meta:previous`, so an interrupted load leaves the list in use where it was and `--restore` makes the
// last one live again. The target is always named: `--local` (Wrangler's local storage) or `--remote` (production,
// which is D02 T06 §6's and the coordinator's).
//
//   node scripts/load-top-sites.ts --local|--remote [--restore] [--source <url or file>]
import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  generationOf,
  listName,
  META_KEY,
  MIN_LIST_SIZE,
  PREVIOUS_META_KEY,
  parseMeta,
  shardKey,
  TOP_LIST_SIZE,
  TOP_SOURCE,
  type TopMeta,
} from "../src/checks/top-list.ts";

export const SOURCE_URL = "https://downloads.majestic.com/majestic_million.csv";
export const MAX_BYTES = 120 * 1024 * 1024;

export type Run = (args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string };
export type LoadOptions = {
  target: "local" | "remote";
  restore?: boolean;
  // A URL or a file; the Majestic Million CSV by default.
  source?: string;
  run?: Run;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  downloadMs?: number;
  stallMs?: number;
  commandMs?: number;
  bulkMs?: number;
  verifyMs?: number;
  // The list's size: the most kept and the fewest accepted (the Majestic Million's own, unless a test says otherwise).
  limit?: number;
  minNames?: number;
};

export class LoadRefused extends Error {
  override name = "LoadRefused";
}

const wrangler: Run = (args, timeoutMs) => {
  const done = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
};

// The JSON a Wrangler command printed after any banner lines.
function jsonOf(text: string, open: "{" | "["): unknown {
  const at = text.search(open === "{" ? /^\{/m : /^\[/m);
  if (at < 0) throw new LoadRefused("Wrangler printed no JSON");
  try {
    return JSON.parse(text.slice(at));
  } catch {
    throw new LoadRefused("Wrangler printed JSON that could not be read");
  }
}

// The source into `path`, bounded in size, total time, and the time between chunks.
async function download(source: string, path: string, options: LoadOptions): Promise<void> {
  if (!/^https?:\/\//.test(source)) {
    try {
      if (statSync(source).size > MAX_BYTES) throw new LoadRefused("the list is larger than 120 MB");
      copyFileSync(source, path);
    } catch (error) {
      if (error instanceof LoadRefused) throw error;
      throw new LoadRefused(`the list file ${source} could not be read`);
    }
    return;
  }
  const controller = new AbortController();
  const total = setTimeout(() => controller.abort(), options.downloadMs ?? 120_000);
  let fd: number | null = null;
  try {
    const response = await (options.fetch ?? fetch)(source, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new LoadRefused(`the list download answered HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new LoadRefused("the list is larger than 120 MB");
    const reader = response.body.getReader();
    try {
      fd = openSync(path, "w");
    } catch {
      throw new LoadRefused("the download cannot be written to a temporary file");
    }
    let size = 0;
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LoadRefused("the download stalled")), options.stallMs ?? 30_000);
      });
      const chunk = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BYTES) throw new LoadRefused("the list is larger than 120 MB");
      try {
        writeSync(fd, chunk.value);
      } catch {
        throw new LoadRefused("the download cannot be written to a temporary file");
      }
    }
  } catch (error) {
    if (error instanceof LoadRefused) throw error;
    throw new LoadRefused(
      controller.signal.aborted ? "the download did not finish in time" : "the download was interrupted",
    );
  } finally {
    clearTimeout(total);
    controller.abort();
    if (fd !== null) closeSync(fd);
  }
}

// The registrable domains of the file's first rows, in rank order, each once at its best rank, until `limit` are held:
// its header must name GlobalRank and Domain. Reading stops as soon as the list is full.
async function readNames(path: string, limit: number): Promise<string[]> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Number.POSITIVE_INFINITY });
  let domainAt = -1;
  let header = true;
  const seen = new Set<string>();
  const names: string[] = [];
  try {
    for await (const line of lines) {
      if (header) {
        const columns = line.replace(/^\uFEFF/, "").split(",");
        domainAt = columns.indexOf("Domain");
        if (domainAt < 0 || columns.indexOf("GlobalRank") < 0)
          throw new LoadRefused("the list's header is not Majestic's");
        header = false;
        continue;
      }
      const name = listName(line.split(",")[domainAt] ?? "");
      if (name === null || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
      if (names.length >= limit) break;
    }
  } finally {
    lines.close();
  }
  return names;
}

export async function loadTopSites(
  options: LoadOptions,
): Promise<{ generation: string; count: number; shards: number }> {
  const run = options.run ?? wrangler;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const where = `--${options.target}`;
  const commandMs = options.commandMs ?? 30_000;
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "top-sites-"));
  } catch {
    throw new LoadRefused("a temporary directory cannot be created");
  }
  const file = (name: string, value: unknown) => {
    const path = join(dir, name);
    try {
      writeFileSync(path, JSON.stringify(value));
    } catch {
      throw new LoadRefused("a temporary file cannot be written");
    }
    return path;
  };
  const check = (done: ReturnType<Run>, what: string) => {
    if (done.status === null) throw new LoadRefused(`${what} did not finish in time`);
    if (done.status !== 0) throw new LoadRefused(`${what} failed (exit ${done.status})`);
  };
  // Values by key, null for a key that is not there: one Wrangler call, whatever the number of keys.
  const getMany = (keys: string[], ms = commandMs): Map<string, string | null> => {
    const done = run(["kv", "bulk", "get", file("keys.json", keys), "--binding", "CACHE", where], ms);
    check(done, "reading keys");
    const parsed = jsonOf(done.stdout, "{") as Record<string, { value: string | null }>;
    return new Map(keys.map((k) => [k, parsed[k]?.value ?? null]));
  };
  const putMany = (entries: { key: string; value: string }[], what: string) =>
    check(
      run(["kv", "bulk", "put", file("put.json", entries), "--binding", "CACHE", where], options.bulkMs ?? 120_000),
      what,
    );
  // KV is eventually consistent: reads are retried within a bound until they match the exact text written.
  const verify = async (expected: Map<string, string>, what: string) => {
    const deadline = Date.now() + (options.verifyMs ?? 60_000);
    for (;;) {
      const got = getMany([...expected.keys()], options.bulkMs ?? 120_000);
      const wrong = [...expected].filter(([k, v]) => got.get(k) !== v);
      if (wrong.length === 0) return;
      if (Date.now() >= deadline) throw new LoadRefused(`${what}: ${wrong.length} key(s) did not read back as written`);
      await sleep(2_000);
    }
  };
  try {
    if (options.restore) {
      const previous = getMany([PREVIOUS_META_KEY]).get(PREVIOUS_META_KEY) ?? null;
      const meta = previous === null ? null : parseMeta(previous);
      if (!meta) throw new LoadRefused(`there is no usable ${PREVIOUS_META_KEY} to restore`);
      const have = getMany(
        Object.keys(meta.shards).map((p) => shardKey(meta.generation, p)),
        options.bulkMs ?? 120_000,
      );
      if ([...have.values()].some((v) => v === null))
        throw new LoadRefused("the previous list's shards are no longer there");
      putMany([{ key: META_KEY, value: previous as string }], "restoring the meta");
      await verify(new Map([[META_KEY, previous as string]]), "the restored meta");
      return { generation: meta.generation, count: meta.count, shards: Object.keys(meta.shards).length };
    }
    const path = join(dir, "list.csv");
    await download(options.source ?? SOURCE_URL, path, options);
    const names = await readNames(path, options.limit ?? TOP_LIST_SIZE);
    const least = options.minNames ?? MIN_LIST_SIZE;
    if (names.length < least)
      throw new LoadRefused(`only ${names.length} usable domains, at least ${least} are needed`);
    const { generation, shards, counts } = await generationOf(names);
    const meta: TopMeta = {
      generation,
      source: TOP_SOURCE,
      date: (options.now ?? (() => new Date()))().toISOString().slice(0, 10),
      count: names.length,
      shards: counts,
    };
    // 1. The shards, under keys no reader uses yet, read back whole.
    const expected = new Map([...shards].map(([prefix, text]) => [shardKey(generation, prefix), text]));
    putMany(
      [...expected].map(([key, value]) => ({ key, value })),
      "writing the shards",
    );
    await verify(expected, "the shards");
    // 2. The meta that makes them live, after keeping the one it replaces.
    const metaText = JSON.stringify(meta);
    const currentText = getMany([META_KEY]).get(META_KEY) ?? null;
    const current = currentText === null ? null : parseMeta(currentText);
    if (currentText !== null && current?.generation !== generation) {
      putMany([{ key: PREVIOUS_META_KEY, value: currentText }], "keeping the previous meta");
      await verify(new Map([[PREVIOUS_META_KEY, currentText]]), "the previous meta");
    }
    putMany([{ key: META_KEY, value: metaText }], "publishing the meta");
    await verify(new Map([[META_KEY, metaText]]), "the meta");
    // 3. Shards of older generations than the previous one.
    const keep = new Set([generation]);
    const previousText = getMany([PREVIOUS_META_KEY]).get(PREVIOUS_META_KEY) ?? null;
    const previous = previousText === null ? null : parseMeta(previousText);
    if (previous) keep.add(previous.generation);
    const listed = run(["kv", "key", "list", "--binding", "CACHE", "--prefix", "top:", where], commandMs);
    check(listed, "listing keys");
    const stale = (jsonOf(listed.stdout, "[") as { name: string }[])
      .map((k) => k.name)
      .filter((name) => {
        const m = /^top:([0-9a-f]{12}):/.exec(name);
        return m !== null && !keep.has(m[1] as string);
      });
    if (stale.length > 0)
      check(
        run(
          ["kv", "bulk", "delete", file("delete.json", stale), "--binding", "CACHE", where, "--force"],
          options.bulkMs ?? 120_000,
        ),
        "deleting stale shards",
      );
    return { generation, count: names.length, shards: shards.size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      restore: { type: "boolean", default: false },
      source: { type: "string", default: SOURCE_URL },
    },
  });
  if (values.local === values.remote) {
    console.error("load-top-sites: name the target, --local or --remote");
    process.exit(2);
  }
  try {
    const done = await loadTopSites({
      target: values.local ? "local" : "remote",
      restore: values.restore,
      source: values.source,
    });
    console.log(
      `load-top-sites: generation ${done.generation} (${done.count} domains in ${done.shards} shards) reads back (${values.local ? "local" : "remote"})`,
    );
  } catch (error) {
    console.error(`load-top-sites: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
