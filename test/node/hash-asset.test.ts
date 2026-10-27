import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashAssets, parseFonts } from "../../scripts/hash-asset.ts";

const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-hash-asset-${process.pid}`);
const EXO = "/static/fonts/exo.aaaaaaaaaaaa.woff2";
const EXO2 = "/static/fonts/exo2.cccccccccccc.woff2";
const FONTS_CSS =
  `@font-face {\n  font-family: "Exo";\n  src: url("${EXO}") format("woff2");\n}\n` +
  `@font-face {\n  font-family: "Exo 2";\n  src: url("${EXO2}") format("woff2");\n}\n` +
  '@font-face {\n  font-family: "Exo Fallback";\n  src: local("Arial");\n}\n';
const FAMILIES = ["Exo", "Exo 2"];
const args = () => [
  "node",
  "hash-asset",
  "--css",
  join(DIR, "app.css"),
  "--public",
  join(DIR, "public"),
  "--fonts-css",
  join(DIR, "fonts.css"),
  "--module",
  join(DIR, "assets.ts"),
];

// The two served fonts every fixture keeps, so the set always names files that exist.
function keepFonts(): void {
  mkdirSync(join(DIR, "public/static/fonts"), { recursive: true });
  writeFileSync(join(DIR, "public", EXO), "exo");
  writeFileSync(join(DIR, "public", EXO2), "exo2");
}

beforeAll(() => {
  mkdirSync(join(DIR, "public/static"), { recursive: true });
  keepFonts();
  writeFileSync(join(DIR, "fonts.css"), FONTS_CSS);
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("hash-asset", () => {
  it("names the stylesheet by its content and exports it with the fonts", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const { css, fonts } = hashAssets(args());
    expect(css).toMatch(/^\/static\/app\.[0-9a-f]{12}\.css$/);
    expect(fonts).toEqual({ Exo: EXO, "Exo 2": EXO2 });
    expect(readFileSync(join(DIR, "public", css), "utf-8")).toBe("a{}");
    expect(readFileSync(join(DIR, "assets.ts"), "utf-8")).toContain(`export const APP_CSS = "${css}";`);
  });

  it("leaves every file byte-identical and untouched when nothing changed", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const first = hashAssets(args()).css;
    const times = [join(DIR, "public", first), join(DIR, "assets.ts")].map((p) => statSync(p).mtimeMs);
    expect(hashAssets(args()).css).toBe(first);
    expect([join(DIR, "public", first), join(DIR, "assets.ts")].map((p) => statSync(p).mtimeMs)).toEqual(times);
  });

  it("removes a font the new set no longer names, and leaves other files alone", () => {
    keepFonts();
    writeFileSync(join(DIR, "public/static/fonts/exo.bbbbbbbbbbbb.woff2"), "old");
    writeFileSync(join(DIR, "public/static/robots.txt"), "kept");
    writeFileSync(join(DIR, "app.css"), "a{}");
    hashAssets(args());
    expect(readdirSync(join(DIR, "public/static/fonts")).sort()).toEqual([
      "exo.aaaaaaaaaaaa.woff2",
      "exo2.cccccccccccc.woff2",
    ]);
    expect(readFileSync(join(DIR, "public/static/robots.txt"), "utf-8")).toBe("kept");
    rmSync(join(DIR, "public/static/robots.txt"));
  });

  it("removes temporary files an interrupted earlier build left, and leaves none of its own on a failed write", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    writeFileSync(join(DIR, "public/static/app.123456789abc.css.4242.tmp"), "half a stylesheet");
    hashAssets(args());
    expect(readdirSync(join(DIR, "public/static")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // A module path that is a non-empty folder: the temporary file is written, the rename over the folder fails, and
    // the temporary file must not survive.
    mkdirSync(join(DIR, "assets-folder"), { recursive: true });
    writeFileSync(join(DIR, "assets-folder/keep"), "");
    const failing = [...args().slice(0, -2), "--module", join(DIR, "assets-folder")];
    expect(() => hashAssets(failing)).toThrow();
    expect(readdirSync(DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    rmSync(join(DIR, "assets-folder"), { recursive: true });
  });

  it("gives changed content a new name and removes the old file", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const before = hashAssets(args()).css;
    writeFileSync(join(DIR, "app.css"), "b{}");
    const after = hashAssets(args()).css;
    expect(after).not.toBe(before);
    expect(readdirSync(join(DIR, "public/static")).filter((name) => name.endsWith(".css"))).toEqual([
      after.split("/").pop(),
    ]);
  });
});

describe("the font set hash-asset reads", () => {
  it("reads faces quoted either way, in any declaration order, and skips local() fallbacks", () => {
    const css =
      `@font-face{src:url('${EXO}') format('woff2');font-weight:100 900;font-family:'Exo'}` +
      `/* note */@font-face { font-display: swap; font-family: Exo 2 ; src: url(${EXO2}) }` +
      "@font-face{font-family:'Exo 2 Fallback';src:local('Arial')}";
    expect(parseFonts(css, join(DIR, "public"), FAMILIES)).toEqual({ Exo: EXO, "Exo 2": EXO2 });
  });

  it("refuses a set missing a brand family, naming a missing file, or naming a family twice", () => {
    const pub = join(DIR, "public");
    expect(() => parseFonts("", pub, FAMILIES)).toThrow("no web-font face for Exo, Exo 2");
    expect(() => parseFonts(`@font-face{font-family:"Exo";src:url("${EXO}")}`, pub, FAMILIES)).toThrow("Exo 2");
    expect(() =>
      parseFonts(`@font-face{font-family:"Exo";src:url("/static/fonts/gone.000000000000.woff2")}`, pub, ["Exo"]),
    ).toThrow("not under public/");
    expect(() =>
      parseFonts(
        `@font-face{font-family:"Exo";src:url("${EXO}")}@font-face{font-family:"Exo";src:url("${EXO}")}`,
        pub,
        ["Exo"],
      ),
    ).toThrow("twice");
  });

  it("writes and prunes nothing when fonts.css cannot be read as the brand set", () => {
    keepFonts();
    writeFileSync(join(DIR, "app.css"), "z{}");
    const before = readdirSync(join(DIR, "public/static/fonts")).sort();
    const moduleBefore = readFileSync(join(DIR, "assets.ts"), "utf-8");
    writeFileSync(join(DIR, "fonts.css"), "/* emptied */");
    expect(() => hashAssets(args())).toThrow("no web-font face");
    expect(readdirSync(join(DIR, "public/static/fonts")).sort()).toEqual(before);
    expect(readFileSync(join(DIR, "assets.ts"), "utf-8")).toBe(moduleBefore);
    writeFileSync(join(DIR, "fonts.css"), FONTS_CSS);
  });

  it("removes temporary files a killed build left beside assets.ts and fonts.css", () => {
    writeFileSync(join(DIR, "assets.ts.4242.tmp"), "half");
    writeFileSync(join(DIR, "app.css"), "a{}");
    hashAssets(args());
    expect(readdirSync(DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
