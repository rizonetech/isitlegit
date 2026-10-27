import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashAssets } from "../../scripts/hash-asset.ts";

const ROOT = join(import.meta.dirname, "../..");
const DIR = join(ROOT, `build/test-hash-asset-${process.pid}`);
const FONTS_CSS =
  '@font-face {\n  font-family: "Exo";\n  src: url("/static/fonts/exo.aaaaaaaaaaaa.woff2") format("woff2");\n}\n';
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

beforeAll(() => {
  mkdirSync(join(DIR, "public/static"), { recursive: true });
  writeFileSync(join(DIR, "fonts.css"), FONTS_CSS);
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("hash-asset", () => {
  it("names the stylesheet by its content and exports it with the fonts", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const { css, fonts } = hashAssets(args());
    expect(css).toMatch(/^\/static\/app\.[0-9a-f]{12}\.css$/);
    expect(fonts).toEqual({ Exo: "/static/fonts/exo.aaaaaaaaaaaa.woff2" });
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
    mkdirSync(join(DIR, "public/static/fonts"), { recursive: true });
    writeFileSync(join(DIR, "public/static/fonts/exo.aaaaaaaaaaaa.woff2"), "current");
    writeFileSync(join(DIR, "public/static/fonts/exo.bbbbbbbbbbbb.woff2"), "old");
    writeFileSync(join(DIR, "public/static/robots.txt"), "kept");
    writeFileSync(join(DIR, "app.css"), "a{}");
    hashAssets(args());
    expect(readdirSync(join(DIR, "public/static/fonts"))).toEqual(["exo.aaaaaaaaaaaa.woff2"]);
    expect(readFileSync(join(DIR, "public/static/robots.txt"), "utf-8")).toBe("kept");
    rmSync(join(DIR, "public/static/fonts"), { recursive: true });
    rmSync(join(DIR, "public/static/robots.txt"));
  });

  it("removes temporary files an interrupted earlier build left, and leaves none of its own on a failed write", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    writeFileSync(join(DIR, "public/static/app.123456789abc.css.4242.tmp"), "half a stylesheet");
    hashAssets(args());
    expect(readdirSync(join(DIR, "public/static")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // A module path whose folder is a file: the write fails, and its temporary file must not survive.
    writeFileSync(join(DIR, "not-a-folder"), "");
    const failing = [...args().slice(0, -2), "--module", join(DIR, "not-a-folder/assets.ts")];
    expect(() => hashAssets(failing)).toThrow();
    expect(readdirSync(DIR).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    rmSync(join(DIR, "not-a-folder"));
  });

  it("gives changed content a new name and removes the old file", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const before = hashAssets(args()).css;
    writeFileSync(join(DIR, "app.css"), "b{}");
    const after = hashAssets(args()).css;
    expect(after).not.toBe(before);
    expect(readdirSync(join(DIR, "public/static"))).toEqual([after.split("/").pop()]);
  });
});
