import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `pnpm build:css` replaces the stylesheet only when Tailwind succeeds, and only the app's own sources (src/web) decide
// which utilities ship. Every run here passes `--no-tokens` (or a scratch `--tokens-out`), so `pnpm test` never rewrites
// the tracked src/web/styles/tokens.css. Scratch folders live in build/ so `@import "tailwindcss"` resolves.
const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-build-css-${process.pid}`);
const TOKENS = join(ROOT, "src/web/styles/tokens.css");
const buildCss = (...args: string[]) =>
  spawnSync(process.execPath, [join(ROOT, "scripts/build-css.ts"), ...args], { cwd: ROOT, encoding: "utf-8" });

beforeAll(() => mkdirSync(DIR, { recursive: true }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("build:css", () => {
  it("leaves the previous stylesheet untouched when Tailwind fails, with no temporary file left", () => {
    const dir = join(DIR, "failed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "app.css"), "previous");
    writeFileSync(join(dir, "bad.css"), '@import "./missing.css";\n');
    const run = buildCss("--no-tokens", "--input", join(dir, "bad.css"), "--out", join(dir, "app.css"));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Tailwind failed (exit 1)");
    expect(run.stderr).toContain("was left as it was");
    expect(readFileSync(join(dir, "app.css"), "utf-8")).toBe("previous");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces the stylesheet by renaming a finished file when Tailwind succeeds, at an absolute path", () => {
    const out = join(DIR, "ok/app.css");
    mkdirSync(join(DIR, "ok"), { recursive: true });
    writeFileSync(out, "previous");
    const before = statSync(out).ino;
    const tokensBefore = statSync(TOKENS).mtimeMs;
    const run = buildCss("--no-tokens", "--out", out);
    expect(run.status, run.stderr).toBe(0);
    const css = readFileSync(out, "utf-8");
    expect(css).toContain("--color-ink");
    // Replaced by renaming a finished file over it (a new inode), never written in place, where an interrupted write
    // would leave a truncated stylesheet.
    expect(statSync(out).ino).not.toBe(before);
    // `mt-[13px]` appears only in this test's own source: a test must not decide what ships.
    expect(css).not.toContain("mt-\\[13px\\]");
    expect(statSync(TOKENS).mtimeMs, "--no-tokens must not touch tokens.css").toBe(tokensBefore);
  });

  it("ships a utility a page uses and ignores one only tests or documentation use", () => {
    const web = join(DIR, "probe/web");
    cpSync(join(ROOT, "src/web"), web, { recursive: true });
    writeFileSync(join(web, "page.tsx"), 'export const Page = () => <p class="rounded-pill">p</p>;\n');
    writeFileSync(join(DIR, "probe/notes.md"), '<p class="mt-[13px]">only in notes</p>\n');
    const out = join(DIR, "probe/out.css");
    const run = buildCss("--no-tokens", "--input", join(web, "styles/app.css"), "--out", out);
    expect(run.status, run.stderr).toBe(0);
    const css = readFileSync(out, "utf-8");
    expect(css).toContain(".rounded-pill");
    expect(css).not.toContain("mt-\\[13px\\]");
  });

  it("names the failing step and its cause, and refuses a flag with no path", () => {
    const tokens = buildCss("--tokens-out", join(DIR, "no-such-folder/tokens.css"), "--out", join(DIR, "never.css"));
    expect(tokens.status).not.toBe(0);
    expect(tokens.stderr).toContain("the token step failed (exit 1); nothing was compiled");
    const flag = buildCss("--no-tokens", "--out");
    expect(flag.status).not.toBe(0);
    expect(flag.stderr).toContain("--out needs a path");
  });
});
