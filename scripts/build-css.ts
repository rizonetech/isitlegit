// Compiles the app stylesheet (D07 T01 §2): regenerates src/web/styles/tokens.css, then runs Tailwind into a temporary
// file beside the output and renames it into place only when Tailwind succeeds, so a failed or interrupted build leaves
// the previous stylesheet intact. `node scripts/build-css.ts [--input <css>] [--out <css>]`.
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(name);
  return join(ROOT, at > 0 ? (process.argv[at + 1] ?? fallback) : fallback);
};
const input = arg("--input", "src/web/styles/app.css");
const out = arg("--out", "build/css/app.css");
const tmp = `${out}.${process.pid}.tmp`;

const tokens = spawnSync(process.execPath, [join(ROOT, "scripts/build-tokens.ts")], { stdio: "inherit" });
if (tokens.status !== 0) process.exit(tokens.status ?? 1);
mkdirSync(dirname(out), { recursive: true });
const tailwind = spawnSync(join(ROOT, "node_modules/.bin/tailwindcss"), ["-i", input, "-o", tmp, "--minify"], {
  cwd: ROOT,
  stdio: "inherit",
});
if (tailwind.status !== 0) {
  rmSync(tmp, { force: true });
  console.error(`build-css: Tailwind failed (exit ${tailwind.status ?? tailwind.signal}); ${out} was left as it was`);
  process.exit(tailwind.status ?? 1);
}
renameSync(tmp, out);
