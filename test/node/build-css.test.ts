import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// `pnpm build:css` replaces the stylesheet only when Tailwind succeeds, and only the app's own sources (src/web) decide
// which utilities ship. Scratch folders live in build/ so `@import "tailwindcss"` resolves from the repository.
const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-build-css-${process.pid}`);
const buildCss = (...args: string[]) =>
  spawnSync(process.execPath, [join(ROOT, "scripts/build-css.ts"), ...args], { cwd: ROOT, encoding: "utf-8" });

beforeAll(() => mkdirSync(DIR, { recursive: true }));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("build:css", () => {
  it("leaves the previous stylesheet untouched when Tailwind fails, with no temporary file left", () => {
    const out = join(DIR, "failed/app.css");
    mkdirSync(join(DIR, "failed"), { recursive: true });
    writeFileSync(out, "previous");
    writeFileSync(join(DIR, "failed/bad.css"), '@import "./missing.css";\n');
    const run = buildCss(
      "--input",
      join(DIR, "failed/bad.css").slice(ROOT.length + 1),
      "--out",
      out.slice(ROOT.length + 1),
    );
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("was left as it was");
    expect(readFileSync(out, "utf-8")).toBe("previous");
    expect(readdirSync(join(DIR, "failed")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces the stylesheet by renaming a finished file when Tailwind succeeds", () => {
    const out = join(DIR, "ok/app.css");
    mkdirSync(join(DIR, "ok"), { recursive: true });
    writeFileSync(out, "previous");
    const before = statSync(out).ino;
    const run = buildCss("--out", out.slice(ROOT.length + 1));
    expect(run.status, run.stderr).toBe(0);
    const css = readFileSync(out, "utf-8");
    expect(css).toContain("--color-ink");
    // Replaced by renaming a finished file over it (a new inode), never written in place, where an interrupted write
    // would leave a truncated stylesheet.
    expect(statSync(out).ino).not.toBe(before);
    // `h-control` appears only in test/node/theme.test.ts's fixture: a test must not decide what ships.
    expect(css).not.toContain(".h-control");
  });

  it("ships a utility a page uses and ignores one only tests or documentation use", () => {
    const web = join(DIR, "probe/web");
    cpSync(join(ROOT, "src/web"), web, { recursive: true });
    writeFileSync(join(web, "page.tsx"), 'export const Page = () => <p class="rounded-pill">p</p>;\n');
    writeFileSync(join(DIR, "probe/notes.md"), '<p class="rounded-control-small">only in notes</p>\n');
    const out = join(DIR, "probe/out.css");
    const run = buildCss(
      "--input",
      join(web, "styles/app.css").slice(ROOT.length + 1),
      "--out",
      out.slice(ROOT.length + 1),
    );
    expect(run.status, run.stderr).toBe(0);
    const css = readFileSync(out, "utf-8");
    expect(css).toContain(".rounded-pill");
    expect(css).not.toContain(".rounded-control-small");
    expect(existsSync(join(ROOT, "src/web/page.tsx"))).toBe(false);
  });
});
