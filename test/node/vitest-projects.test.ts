// The browser tests run as their own vitest project, one file at a time in CI (vitest.config.ts, 2026-11-01): this
// checks the split finds every file that drives Chromium and loses no Node test between the two projects.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import config, { browserTestFiles } from "../../vitest.config.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "vitest-projects-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function project(name: string) {
  const found = (config.test?.projects ?? []).find(
    (p) => typeof p === "object" && p !== null && "test" in p && p.test?.name === name,
  ) as { test: { include?: string[]; exclude?: string[] } } | undefined;
  if (!found) throw new Error(`no ${name} project`);
  return found.test;
}

function nodeTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.test\.tsx?$/.test(name)) out.push(relative(ROOT, path).split("\\").join("/"));
    }
  };
  walk(join(ROOT, "test/node"));
  return out.sort();
}

describe("the browser project", () => {
  it("takes a file by what it imports or launches, and leaves a plain test to the node project", () => {
    const dir = join(scratch, "test/node/nested");
    mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = {
      "pw.test.ts": 'import { chromium } from "playwright-core";\n',
      "helper.test.tsx": 'import { launch } from "./browser";\n',
      "render.test.ts": 'import { render } from "../../../scripts/glimmer/render.ts";\n',
      "source.test.ts": 'import { visibleText } from "../../../scripts/glimmer/source-pages.ts";\n',
      "logos.test.ts": 'import { grab } from "../../../scripts/load-reference-logos.ts";\n',
      "spawn.test.ts": "const chrome = process.env.MOCKUP_CHROMIUM;\n",
      "plain.test.ts": 'import { expect } from "vitest";\n// mentions a browser in prose only\n',
      "helper.ts": 'import { chromium } from "playwright-core";\n',
    };
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    expect(browserTestFiles(scratch)).toEqual(
      ["helper.test.tsx", "logos.test.ts", "pw.test.ts", "render.test.ts", "source.test.ts", "spawn.test.ts"].map(
        (name) => `test/node/nested/${name}`,
      ),
    );
  });

  it("holds every repository test that drives Chromium, and the node project none of them", () => {
    const browser = browserTestFiles();
    expect(browser).toContain("test/node/signin-page-browser.test.tsx");
    expect(browser).toContain("test/node/glimmer-source-pages.test.ts");
    expect(browser).toContain("test/node/fonts.test.ts");
    expect(project("browser").include).toEqual(browser);
    for (const file of browser) expect(project("node").exclude).toContain(file);
  });

  it("loses no Node test: each one is in exactly one project, the accessibility run apart", () => {
    const browser = new Set(project("browser").include);
    const excluded = new Set(project("node").exclude);
    for (const file of nodeTestFiles()) {
      if (file === "test/node/a11y.test.tsx") continue;
      const inNode = !excluded.has(file);
      expect([file, inNode !== browser.has(file)]).toEqual([file, true]);
    }
  });
});
