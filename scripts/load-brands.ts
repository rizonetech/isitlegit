// Loads the curated brand table into the Worker's `CACHE` namespace under `brands:v1` (D02 T03 §3), so a new revision is
// read without a deploy. It validates the table first, keeps the value it replaces under `brands:v1:previous`, writes,
// then reads the key back and compares it whole, retrying for KV's eventual consistency, and exits non-zero on a refused
// write or a read-back that never matches. `--restore` makes the previous value live again and leaves the copy as it is,
// so a restore retried after a lost answer restores the same revision (round 1). The target is always named:
// `--local` (Wrangler's local storage) or `--remote` (production).
//
//   node scripts/load-brands.ts --local|--remote [--restore] [--table data/brands.json]
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BRANDS_KEY, BRANDS_PREVIOUS_KEY, BrandTable } from "../src/checks/brand-schema.ts";

// One Wrangler command, stopped after `timeoutMs` (a stopped command answers a null status).
export type Run = (args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string };
export type LoadOptions = {
  target: "local" | "remote";
  restore?: boolean;
  table?: string;
  run?: Run;
  sleep?: (ms: number) => Promise<void>;
  verifyMs?: number;
};

export class LoadRefused extends Error {
  override name = "LoadRefused";
}

const wrangler: Run = (args, timeoutMs) => {
  const done = spawnSync("pnpm", ["exec", "wrangler", ...args], { encoding: "utf8", timeout: timeoutMs });
  return { status: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "" };
};
// A key that is not there: local storage prints this and exits 0; the remote API answers 404, and Wrangler exits 1.
const MISSING = "Value not found";
const REMOTE_MISSING = /\b404: Not Found\b/;

export async function loadBrands(options: LoadOptions): Promise<{ revision: string; key: string }> {
  const run = options.run ?? wrangler;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const where = `--${options.target}`;
  // Every command is bounded, so verification ends within its window even when Wrangler stalls (completion review).
  const COMMAND_MS = 30_000;
  let deadline = Number.POSITIVE_INFINITY;
  const bound = () => Math.max(1, Math.min(COMMAND_MS, deadline - Date.now()));
  const get = (key: string): string | null => {
    const done = run(["kv", "key", "get", "--binding", "CACHE", key, where], bound());
    if (done.status !== 0 && REMOTE_MISSING.test(done.stdout + done.stderr)) return null;
    if (done.status === null) throw new LoadRefused(`reading ${key} did not finish in time`);
    if (done.status !== 0) throw new LoadRefused(`reading ${key} failed (exit ${done.status})`);
    const value = done.stdout.trim();
    return value === MISSING || value === "" ? null : value;
  };
  const dir = mkdtempSync(join(tmpdir(), "brands-"));
  const put = (key: string, value: string) => {
    // From a file, so the table is never a command-line argument.
    const path = join(dir, "value.json");
    writeFileSync(path, value);
    const done = run(["kv", "key", "put", "--binding", "CACHE", key, "--path", path, where], bound());
    if (done.status !== 0) throw new LoadRefused(`writing ${key} failed (exit ${done.status})`);
  };
  try {
    const current = get(BRANDS_KEY);
    let value: string;
    if (options.restore) {
      const previous = get(BRANDS_PREVIOUS_KEY);
      if (previous === null) throw new LoadRefused(`there is no ${BRANDS_PREVIOUS_KEY} to restore`);
      value = previous;
    } else {
      value = readFileSync(options.table ?? "data/brands.json", "utf8");
    }
    const parsed = BrandTable.safeParse(JSON.parse(value));
    if (!parsed.success)
      throw new LoadRefused(`the table is malformed: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const text = JSON.stringify(parsed.data);
    // A load keeps the value it replaces as the rollback copy first, so a refused or interrupted write leaves the live
    // value where it was and a retry works. A restore never writes the copy: the revision it restores stays the rollback
    // target however often it is retried (completion review, round 1); the revision it replaces is in git.
    if (!options.restore && current !== null && current !== text) put(BRANDS_PREVIOUS_KEY, current);
    put(BRANDS_KEY, text);
    // KV is eventually consistent: the key may read its old value for a while after the write.
    deadline = Date.now() + (options.verifyMs ?? 60_000);
    for (;;) {
      if (get(BRANDS_KEY) === text) break;
      if (Date.now() >= deadline) throw new LoadRefused(`${BRANDS_KEY} did not read back as written`);
      await sleep(2_000);
    }
    return { revision: parsed.data.revision, key: BRANDS_KEY };
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
      table: { type: "string", default: "data/brands.json" },
    },
  });
  if (values.local === values.remote) {
    console.error("load-brands: name the target, --local or --remote");
    process.exit(2);
  }
  try {
    const { revision, key } = await loadBrands({
      target: values.local ? "local" : "remote",
      restore: values.restore,
      table: values.table,
    });
    console.log(`load-brands: ${key} reads back revision ${revision} (${values.local ? "local" : "remote"})`);
  } catch (error) {
    console.error(`load-brands: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
