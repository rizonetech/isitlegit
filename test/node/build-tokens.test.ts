import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTokens } from "../../scripts/build-tokens.ts";

const ROOT = join(import.meta.dirname, "../..");
const tokens = (name: string) => JSON.parse(readFileSync(join(ROOT, "design/tokens", name), "utf-8"));
const colors = tokens("colors.json");
const spacing = tokens("spacing.json");
const type = tokens("typography.json");

// The generator's output, compiled and minified by Tailwind exactly as `pnpm build:css` does, in a scratch folder inside
// build/ so `@import "tailwindcss"` resolves from the repository.
const DIR = join(ROOT, `build/test-tokens-${process.pid}`);
let css = "";

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "tokens.css"), buildTokens());
  writeFileSync(join(DIR, "app.css"), '@import "tailwindcss";\n@import "./tokens.css";\n');
  const bin = join(ROOT, "node_modules/.bin/tailwindcss");
  execFileSync(bin, ["-i", join(DIR, "app.css"), "-o", join(DIR, "out.css"), "--minify"], { cwd: ROOT, stdio: "pipe" });
  css = readFileSync(join(DIR, "out.css"), "utf-8");
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

// The text of the rule whose selector is `selector`, up to its closing brace (minified CSS, so one line).
function rule(selector: string): string {
  const start = css.indexOf(`${selector}{`);
  expect(start, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

// A token value as Tailwind's minifier writes it: lower case, #aabbcc as #abc where it can, no leading zero before a point.
function minified(value: string | number): string {
  return String(value)
    .toLowerCase()
    .replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3(?:([0-9a-f])\4)?\b/g, (_, r, g, b, a) => `#${r}${g}${b}${a ?? ""}`)
    .replace(/(^|[^\d.])0\.(\d)/g, "$1.$2");
}
const decl = (name: string, value: string | number) => `${name}:${minified(value)}`;
const has = (text: string, name: string, value: string | number) =>
  expect(text.toLowerCase().replaceAll(", ", ","), name).toContain(decl(name, value).replaceAll(", ", ","));

describe("tokens in the minified app stylesheet", () => {
  it("declares every light colour role in the theme", () => {
    for (const [role, value] of Object.entries<string>(colors.themes.light)) has(css, `--color-${role}`, value);
  });

  it("switches every colour role to its dark value with the OS preference and with data-theme=dark", () => {
    const media = css.slice(css.indexOf("@media (prefers-color-scheme:dark)"));
    const auto = media.slice(0, media.indexOf("}") + 1);
    expect(auto).toContain(":root:not([data-theme=light])");
    const forced = rule(":root[data-theme=dark]");
    for (const [role, value] of Object.entries<string>(colors.themes.dark)) {
      has(auto, `--color-${role}`, value);
      has(forced, `--color-${role}`, value);
    }
  });

  it("restores the light values with data-theme=light", () => {
    const forced = rule(":root[data-theme=light]");
    for (const [role, value] of Object.entries<string>(colors.themes.light)) has(forced, `--color-${role}`, value);
  });

  it("declares spacing, control heights, radii, shadows, families, weights and the type scale", () => {
    for (const px of spacing.scale) has(css, `--spacing-${px}`, `${px}px`);
    for (const [key, px] of Object.entries<number>(spacing["control-height"]))
      has(css, `--spacing-control${key === "default" ? "" : `-${key}`}`, `${px}px`);
    for (const [key, px] of Object.entries<number>(spacing.radius)) has(css, `--radius-${key}`, `${px}px`);
    for (const key of Object.keys(spacing.shadow)) expect(css).toContain(`--shadow-${key}:`);
    for (const key of Object.keys(type.families)) expect(css).toContain(`--font-${key}:`);
    for (const [key, weight] of Object.entries<number>(type.weights)) has(css, `--font-weight-${key}`, weight);
    for (const px of type.scale) has(css, `--text-${px}`, `${px / 16}rem`);
    expect(css).toContain("--default-font-family:var(--font-text)");
    expect(css).toContain("--default-mono-font-family:var(--font-mono)");
  });

  it("keeps none of Tailwind's default palette, fonts, type scale or spacing multiplier", () => {
    for (const name of [
      "--color-red-500",
      "--color-blue-600",
      "--font-serif",
      "--text-9xl",
      "--font-weight-thin",
      "--spacing:",
    ])
      expect(css, name).not.toContain(name);
  });
});
