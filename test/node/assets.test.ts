import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { APP_CSS, FONTS } from "../../src/web/assets.ts";

// Everything under public/static/ is served with a year-long immutable cache (public/_headers), so every file there must
// carry a 12-hex content fingerprint, be named in src/web/assets.ts, and exist: a missing, unhashed or stray file fails.
const ROOT = join(import.meta.dirname, "../..");
const STATIC = join(ROOT, "public/static");
const FINGERPRINT = /\.[0-9a-f]{12}\.[a-z0-9]+$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("static assets", () => {
  const exported = [APP_CSS, ...Object.values(FONTS)];
  const served = files(STATIC).map((path) => `/${relative(join(ROOT, "public"), path).replaceAll("\\", "/")}`);

  it("serves every path src/web/assets.ts exports", () => {
    for (const path of exported) expect(existsSync(join(ROOT, "public", path)), path).toBe(true);
  });

  it("fingerprints every file under /static/", () => {
    expect(served.filter((path) => !FINGERPRINT.test(path))).toEqual([]);
  });

  it("leaves nothing under /static/ that no page can name", () => {
    expect(served.filter((path) => !exported.includes(path)).sort()).toEqual([]);
  });

  it("names both brand families", () => {
    expect(Object.keys(FONTS).sort()).toEqual(["Exo", "Exo 2"]);
  });
});

describe("a changed source font, end to end", () => {
  const COPY = join(ROOT, `build/test-assets-${process.pid}`);
  afterAll(() => rmSync(COPY, { recursive: true, force: true }));

  it.skipIf(!process.env.CI && spawnSync("python3", ["-c", "import fontTools, brotli"]).status !== 0)(
    "moves through the font name, fonts.css, the stylesheet hash and assets.ts, and survives a failed build",
    () => {
      mkdirSync(COPY, { recursive: true });
      for (const path of ["design/fonts", "public", "src/web"])
        cpSync(join(ROOT, path), join(COPY, path), { recursive: true });
      // Exo 2's outlines under Exo's file name: a real, different font.
      cpSync(join(COPY, "design/fonts/Exo2[wght].ttf"), join(COPY, "design/fonts/Exo[wght].ttf"));
      const step = (cmd: string, args: string[]) => {
        const run = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", timeout: 300_000 });
        expect(run.status, `${cmd} ${args.join(" ")}: ${run.stderr}`).toBe(0);
      };
      step("python3", [
        "design/tools/build-webfonts.py",
        "--fonts",
        join(COPY, "design/fonts"),
        "--out",
        join(COPY, "public/static/fonts"),
        "--css",
        join(COPY, "src/web/styles/fonts.css"),
      ]);
      // A stylesheet build that fails after the fonts changed: the previous set must still be whole and named.
      const before = readFileSync(join(COPY, "src/web/assets.ts"), "utf-8");
      const failed = spawnSync(
        process.execPath,
        ["scripts/build-css.ts", "--no-tokens", "--input", join(COPY, "missing.css"), "--out", join(COPY, "app.css")],
        { cwd: ROOT, encoding: "utf-8" },
      );
      expect(failed.status).not.toBe(0);
      expect(readFileSync(join(COPY, "src/web/assets.ts"), "utf-8")).toBe(before);
      for (const path of [APP_CSS, ...Object.values(FONTS)])
        expect(existsSync(join(COPY, "public", path)), path).toBe(true);
      // The retry:
      step(process.execPath, [
        "scripts/build-css.ts",
        "--no-tokens",
        "--input",
        join(COPY, "src/web/styles/app.css"),
        "--out",
        join(COPY, "app.css"),
      ]);
      step(process.execPath, [
        "scripts/hash-asset.ts",
        "--css",
        join(COPY, "app.css"),
        "--public",
        join(COPY, "public"),
        "--fonts-css",
        join(COPY, "src/web/styles/fonts.css"),
        "--module",
        join(COPY, "src/web/assets.ts"),
      ]);
      const module = readFileSync(join(COPY, "src/web/assets.ts"), "utf-8");
      const exo = /"Exo":"(\/static\/fonts\/exo\.[0-9a-f]{12}\.woff2)"/.exec(module)?.[1];
      const css = /APP_CSS = "([^"]+)"/.exec(module)?.[1];
      expect(exo).toBeDefined();
      expect(exo).not.toBe(FONTS.Exo);
      expect(css).not.toBe(APP_CSS);
      expect(readFileSync(join(COPY, "public", css as string), "utf-8")).toContain(exo);
      expect(
        existsSync(join(COPY, "public", FONTS.Exo as string)),
        "the old font is pruned once the new set is named",
      ).toBe(false);
      expect(existsSync(join(COPY, "public", APP_CSS)), "the old stylesheet is pruned").toBe(false);
    },
    // A real fonttools conversion and two builds: about 4 s locally, 7.5 s on the runner (run 40449236082), over Vitest's
    // 5 s default; each step is itself bounded at 300 s.
    120_000,
  );
});
