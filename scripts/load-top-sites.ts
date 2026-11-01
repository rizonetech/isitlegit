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
  // Where the temporary directory is made; the system's by default.
  tmpRoot?: string;
};

// `published`: false when the list in use is as it was; null when the new meta may or may not be live (a lost
// acknowledgement or a read that never settles), which the message says, with what to run.
export class LoadRefused extends Error {
  override name = "LoadRefused";
  readonly published: false | null;
  constructor(message: string, published: false | null = false) {
    super(message);
    this.published = published;
  }
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

// Temporary directories of loads in progress, removed when a signal ends the process (Ctrl+C, a stop).
const openDirs = new Set<string>();
export function cleanupNow(): void {
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
}

export type LoadResult = { generation: string; count: number; shards: number; warning?: string };

// KV's bulk limits: 100 keys a read; writes and deletes in chunks well under the 10,000 a request may hold.
const READ_KEYS = 100;
const WRITE_KEYS = 1_000;
const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export async function loadTopSites(options: LoadOptions): Promise<LoadResult> {
  const run = options.run ?? wrangler;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const where = `--${options.target}`;
  const commandMs = options.commandMs ?? 30_000;
  const bulkMs = options.bulkMs ?? 120_000;
  let dir: string;
  try {
    dir = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "top-sites-"));
  } catch {
    throw new LoadRefused("a temporary directory cannot be created");
  }
  openDirs.add(dir);
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
  // Values by key, null for a key that is not there, in reads of at most 100 keys. Wrangler prints `{ key: { value } }`
  // for local storage and `{ key: value }` for the remote API; both are read.
  const getMany = (keys: string[], ms = commandMs): Map<string, string | null> => {
    const out = new Map<string, string | null>();
    for (const batch of chunks(keys, READ_KEYS)) {
      const done = run(["kv", "bulk", "get", file("keys.json", batch), "--binding", "CACHE", where], ms);
      check(done, "reading keys");
      const parsed = jsonOf(done.stdout, "{") as Record<string, unknown>;
      for (const key of batch) {
        const entry = parsed[key];
        if (entry === null || entry === undefined) out.set(key, null);
        else if (typeof entry === "string") out.set(key, entry);
        else if (
          typeof entry === "object" &&
          "value" in entry &&
          (typeof entry.value === "string" || entry.value === null)
        )
          out.set(key, entry.value as string | null);
        else throw new LoadRefused(`reading keys: Wrangler's answer for ${key} is not a value`);
      }
    }
    return out;
  };
  const putMany = (entries: { key: string; value: string }[], what: string) => {
    for (const batch of chunks(entries, WRITE_KEYS))
      check(run(["kv", "bulk", "put", file("put.json", batch), "--binding", "CACHE", where], bulkMs), what);
  };
  // KV is eventually consistent: reads are retried until they match the exact text written, all within one deadline that
  // every command and every wait is cut to, so nothing outlasts it (a late success is not accepted).
  const verify = async (expected: Map<string, string>, what: string, uncertain = false) => {
    const deadline = Date.now() + (options.verifyMs ?? 60_000);
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new LoadRefused(
          `${what}: did not read back as written within ${Math.round((options.verifyMs ?? 60_000) / 1000)} s`,
          uncertain ? null : false,
        );
      const got = getMany([...expected.keys()], Math.max(1, Math.min(bulkMs, left)));
      const wrong = [...expected].filter(([k, v]) => got.get(k) !== v);
      if (wrong.length === 0) return;
      if (deadline - Date.now() <= 0)
        throw new LoadRefused(`${what}: ${wrong.length} key(s) did not read back as written`, uncertain ? null : false);
      await sleep(Math.max(1, Math.min(2_000, deadline - Date.now())));
    }
  };
  try {
    if (options.restore) {
      const previous = getMany([PREVIOUS_META_KEY]).get(PREVIOUS_META_KEY) ?? null;
      const meta = previous === null ? null : parseMeta(previous);
      if (!meta) throw new LoadRefused(`there is no usable ${PREVIOUS_META_KEY} to restore`);
      const have = getMany(
        Object.keys(meta.shards).map((p) => shardKey(meta.generation, p)),
        bulkMs,
      );
      if ([...have.values()].some((v) => v === null))
        throw new LoadRefused("the previous list's shards are no longer there");
      putMany([{ key: META_KEY, value: previous as string }], "restoring the meta");
      await verify(new Map([[META_KEY, previous as string]]), "the restored meta", true);
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
    // The write that publishes: a refusal leaves the list as it was; a write that does not answer may have landed, so
    // the meta is read to settle it, and a list that cannot be settled is reported as uncertain, never as unchanged.
    const published = run(
      ["kv", "bulk", "put", file("meta.json", [{ key: META_KEY, value: metaText }]), "--binding", "CACHE", where],
      bulkMs,
    );
    if (published.status !== null && published.status !== 0)
      throw new LoadRefused(`publishing the meta failed (exit ${published.status}); the list in use is unchanged`);
    await verify(
      new Map([[META_KEY, metaText]]),
      published.status === null ? "the meta (its write did not answer)" : "the meta",
      true,
    );
    // 3. Shards of older generations than the previous one: the new list is live, so a failure here is a warning.
    try {
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
      for (const batch of chunks(stale, WRITE_KEYS))
        check(
          run(["kv", "bulk", "delete", file("delete.json", batch), "--binding", "CACHE", where, "--force"], bulkMs),
          "deleting stale shards",
        );
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        generation,
        count: names.length,
        shards: shards.size,
        warning: `generation ${generation} is live, but older shards were not cleaned up (${why}); run the load again to retry`,
      };
    }
    return { generation, count: names.length, shards: shards.size };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    openDirs.delete(dir);
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
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.on(signal, () => {
      cleanupNow();
      process.exit(code);
    });
  try {
    const done = await loadTopSites({
      target: values.local ? "local" : "remote",
      restore: values.restore,
      source: values.source,
    });
    if (done.warning) console.error(`load-top-sites: warning: ${done.warning}`);
    console.log(
      `load-top-sites: generation ${done.generation} (${done.count} domains in ${done.shards} shards) reads back (${values.local ? "local" : "remote"})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const uncertain =
      error instanceof LoadRefused && error.published === null
        ? " Publication is uncertain: the new list may be live. Read top:meta, then load again or run with --restore."
        : "";
    console.error(`load-top-sites: ${message}.${uncertain}`);
    process.exit(1);
  }
}
