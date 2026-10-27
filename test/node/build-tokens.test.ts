import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTokens, TokenError } from "../../scripts/build-tokens.ts";

const ROOT = join(import.meta.dirname, "../..");
const tokens = (name: string) => JSON.parse(readFileSync(join(ROOT, "design/tokens", name), "utf-8"));
const colors = tokens("colors.json");
const spacing = tokens("spacing.json");
const type = tokens("typography.json");

// The generator's output, compiled and minified by Tailwind exactly as `pnpm build:css` does, in a scratch folder inside
// build/ so `@import "tailwindcss"` resolves from the repository.
const DIR = join(ROOT, `build/test-tokens-${process.pid}`);
const DEFAULTS = [
  "bg-red-500",
  "font-serif",
  "text-9xl",
  "font-thin",
  "animate-spin",
  "ease-in-out",
  "blur-sm",
  "drop-shadow-md",
  "inset-shadow-sm",
  "perspective-near",
  "max-w-prose",
  "tracking-wide",
  "leading-tight",
  "rounded-lg",
  "shadow-lg",
  "p-3",
];
let css = "";

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "tokens.css"), buildTokens());
  // Tailwind defaults a page might reach for: with the whole default theme removed, none of them may produce CSS.
  writeFileSync(join(DIR, "fixture.html"), `<p class="${DEFAULTS.join(" ")} md:p-16">x</p>`);
  writeFileSync(
    join(DIR, "app.css"),
    '@import "tailwindcss" source(none);\n@source "./fixture.html";\n@import "./tokens.css";\n',
  );
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
    for (const [key, weight] of Object.entries<number>(type.weights)) has(rule(":root"), `--weight-${key}`, weight);
    for (const px of type.scale) has(css, `--text-${px}`, `${px / 16}rem`);
    expect(css).toContain("--default-font-family:var(--font-text)");
    expect(css).toContain("--default-mono-font-family:var(--font-mono)");
  });

  it("keeps none of Tailwind's default theme, so a class that is not a token produces nothing", () => {
    for (const name of [
      "--color-red-500",
      "--font-serif",
      "--text-9xl",
      "--font-weight-thin",
      "--spacing:",
      "--animate-",
      "--ease-",
      "--blur-",
      "--drop-shadow-",
      "--inset-shadow-",
      "--perspective-",
      "--container-",
      "@keyframes",
    ])
      expect(css, name).not.toContain(name);
    for (const utility of DEFAULTS) expect(css, utility).not.toContain(`.${utility.replace(":", "\\:")}{`);
  });

  it("keeps Tailwind's breakpoints by name, so responsive token classes still work", () => {
    for (const [key, size] of Object.entries({ sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" }))
      has(css, `--breakpoint-${key}`, size);
    expect(css).toContain(String.raw`@media (min-width:48rem){.md\:p-16{padding:var(--spacing-16)}}`);
  });
});

describe("token validation", () => {
  const BAD = join(ROOT, `build/test-bad-tokens-${process.pid}`);
  afterAll(() => rmSync(BAD, { recursive: true, force: true }));

  // Copies the real tokens, applies one change to a parsed file, and returns what building them throws.
  // The parts of the token files the cases below change.
  type TokenJson = {
    themes: { light: Record<string, string>; dark: Record<string, string> };
    scale: unknown[];
    radius: Record<string, number>;
    shadow: Record<string, string>;
    families: Record<string, string>;
    roles: Record<"h1" | "eyebrow", Record<string, unknown>>;
  };

  function brokenBy(file: string, change: (json: TokenJson) => void): string {
    rmSync(BAD, { recursive: true, force: true });
    mkdirSync(BAD, { recursive: true });
    for (const name of ["colors.json", "spacing.json", "typography.json"])
      writeFileSync(join(BAD, name), readFileSync(join(ROOT, "design/tokens", name)));
    const json = JSON.parse(readFileSync(join(BAD, file), "utf-8"));
    change(json);
    writeFileSync(join(BAD, file), JSON.stringify(json));
    try {
      buildTokens(BAD);
    } catch (error) {
      expect(error).toBeInstanceOf(TokenError);
      return (error as Error).message;
    }
    return "built";
  }

  it("refuses a malformed value and names the token", () => {
    expect(brokenBy("colors.json", (j) => (j.themes.light.ink = "red"))).toContain("colors.themes.light.ink");
    expect(brokenBy("colors.json", (j) => delete j.themes.dark.ink)).toContain("the same set of roles");
    expect(brokenBy("spacing.json", (j) => (j.scale[2] = "8"))).toContain("spacing.scale[2]");
    expect(brokenBy("spacing.json", (j) => (j.radius.card = -1))).toContain("spacing.radius.card");
    expect(brokenBy("typography.json", (j) => (j.roles.h1.family = "serif"))).toContain("typography.roles.h1.family");
    expect(brokenBy("typography.json", (j) => (j.roles.eyebrow.case = "shout"))).toContain(
      "typography.roles.eyebrow.case",
    );
  });

  it("refuses a value that would break out of its declaration", () => {
    expect(brokenBy("spacing.json", (j) => (j.shadow.card = "0 0 1px red;}body{display:none"))).toContain(
      "spacing.shadow.card",
    );
    expect(brokenBy("typography.json", (j) => (j.families.text = "Exo 2;}*{color:red"))).toContain(
      "typography.families.text",
    );
    expect(brokenBy("colors.json", (j) => (j.themes.light["x;}y{"] = "#000000"))).toContain("colors.themes.light key");
  });

  it("builds the real tokens", () => {
    expect(brokenBy("colors.json", () => {})).toBe("built");
  });
});
