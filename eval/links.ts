// Offline component measurement; no provider, browser navigation or verdict calls.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { loadCorpus, parseHarness, summarize } from "./links-measure.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
const entries = loadCorpus("eval/components/links");
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
const start = performance.now();
const run = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "eval/links.config.ts", "eval/links-worker.test.ts"],
  {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
    env: { ...process.env, NO_COLOR: "1" },
  },
);
if (run.error) throw run.error;
if (run.status !== 0) process.stderr.write(run.stderr + run.stdout);
const report = summarize(entries, parseHarness(run.status, run.stdout), 5);
console.log(
  JSON.stringify(
    {
      sourceSha: sha,
      sourceDirty: dirty,
      node: process.version,
      runtime: "local workerd via @cloudflare/vitest-plugin",
      cpu: readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1] ?? null,
      repeats: 5,
      wallMs: performance.now() - start,
      timing:
        "Worker performance.now milliseconds; includes HTML/SVG preparation, excludes startup, payload decoding and hashing; workerd clock may quantize synchronous work to zero",
      ...report,
    },
    null,
    2,
  ),
);
