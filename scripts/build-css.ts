// Compiles the app stylesheet (D07 T01 §2): regenerates src/web/styles/tokens.css, then runs Tailwind into a temporary
// file beside the output and renames it into place only when Tailwind succeeds, so a failed or interrupted build leaves
// the previous stylesheet intact.
//
//   node scripts/build-css.ts [--input <css>] [--out <css>] [--tokens-out <css> | --no-tokens]
//
// Paths are relative to the repository unless absolute. `--no-tokens` compiles the tokens.css already on disk, which the
// tests use so that `pnpm test` never rewrites a tracked file.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { option } from "./build-tokens.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Why a child process failed, in one line: it could not start, it timed out, it was killed, or its exit code.
function why(run: SpawnSyncReturns<Buffer>): string {
  if (run.error) return (run.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timed out" : run.error.message;
  return run.signal ? `killed by ${run.signal}` : `exit ${run.status}`;
}

function main(argv: string[]): number {
  const input = option(argv, "--input", "src/web/styles/app.css");
  const out = option(argv, "--out", "build/css/app.css");
  if (!argv.includes("--no-tokens")) {
    const tokensOut = option(argv, "--tokens-out", "src/web/styles/tokens.css");
    const tokens = spawnSync(process.execPath, [join(ROOT, "scripts/build-tokens.ts"), "--out", tokensOut], {
      stdio: "inherit",
      timeout: 60_000,
    });
    if (tokens.status !== 0) {
      console.error(`build-css: the token step failed (${why(tokens)}); nothing was compiled`);
      return 1;
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  const tailwind = spawnSync(join(ROOT, "node_modules/.bin/tailwindcss"), ["-i", input, "-o", tmp, "--minify"], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 300_000,
  });
  if (tailwind.status !== 0) {
    rmSync(tmp, { force: true });
    console.error(`build-css: Tailwind failed (${why(tailwind)}); ${out} was left as it was`);
    return 1;
  }
  renameSync(tmp, out);
  return 0;
}

try {
  process.exit(main(process.argv));
} catch (error) {
  console.error(`build-css: ${(error as Error).message}`);
  process.exit(1);
}
