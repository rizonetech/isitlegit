// Turns design/tokens/*.json into src/web/styles/tokens.css, the only source of colour, type and spacing for the app
// (D07 T01 §2). Node 24 runs it directly: `node scripts/build-tokens.ts [--out <file>] [--tokens <dir>]`.
//
// One `@theme static` block removes Tailwind's whole default theme (`--*: initial`), then declares every token in the
// namespace its utilities read, so a class that is not a token produces no CSS. The light theme is the default; the
// dark theme follows the operating system unless `data-theme` on <html> says otherwise, and Tailwind's `dark:` variant
// follows the same rule. Every value is validated first: a malformed token stops the build with its name.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Theme = Record<string, string>;
type Role = {
  family: string;
  size: number;
  line: number;
  weight: number;
  tracking?: string;
  case?: string;
  numeric?: string;
};
type Tokens = {
  colors: { themes: { light: Theme; dark: Theme } };
  spacing: {
    scale: number[];
    radius: Record<string, number>;
    "control-height": Record<string, number>;
    shadow: Record<string, string>;
  };
  type: {
    families: Record<string, string>;
    weights: Record<string, number>;
    scale: number[];
    roles: Record<string, Role>;
  };
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "src/web/styles/tokens.css";
const TOKENS = "design/tokens";
// Fallbacks for the self-hosted brand families, so text renders before (or without) the web fonts.
const SANS = "ui-sans-serif, system-ui, sans-serif";
// The tokens name no breakpoints, so Tailwind's own are kept (sm 40rem, md 48rem, lg 64rem, xl 80rem, 2xl 96rem): a
// default taken, recorded in the stack doc; they come back by name after the whole-theme reset.
const BREAKPOINTS = { sm: "40rem", md: "48rem", lg: "64rem", xl: "80rem", "2xl": "96rem" };
const DARK = ':root:not([data-theme="light"])';

export class TokenError extends Error {}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const SHADOW =
  /^(?:-?\d+(?:px)? -?\d+(?:px)? \d+(?:px)?(?: -?\d+(?:px)?)? rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1|0?\.\d+)\)(?:, )?)+$/;
const FAMILY = /^[A-Za-z0-9 ,-]+$/;
const TRACKING = /^-?\d*\.?\d+em$/;

function fail(where: string, value: unknown, rule: string): never {
  throw new TokenError(`design/tokens ${where}: ${JSON.stringify(value)} is not ${rule}`);
}
function names(where: string, record: Record<string, unknown>) {
  for (const key of Object.keys(record)) if (!NAME.test(key)) fail(`${where} key`, key, "a lower-case dashed name");
}
function positive(where: string, value: unknown, max = 10_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max)
    fail(where, value, `a number in 0 to ${max}`);
  return value;
}
function text(where: string, value: unknown, pattern: RegExp, rule: string): string {
  if (typeof value !== "string" || !pattern.test(value)) fail(where, value, rule);
  return value;
}

// Reads and checks the three token files; every value that reaches the CSS has passed a pattern here.
export function readTokens(dir = join(ROOT, TOKENS)): Tokens {
  const read = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf-8"));
  const tokens: Tokens = { colors: read("colors.json"), spacing: read("spacing.json"), type: read("typography.json") };
  const { colors, spacing, type } = tokens;
  for (const theme of ["light", "dark"] as const) {
    const values = colors.themes?.[theme];
    if (!values || typeof values !== "object") fail(`colors.themes.${theme}`, values, "a set of colour roles");
    names(`colors.themes.${theme}`, values);
    for (const [role, value] of Object.entries(values))
      text(`colors.themes.${theme}.${role}`, value, HEX, "a #rrggbb colour");
  }
  const light = Object.keys(colors.themes.light).sort().join();
  if (Object.keys(colors.themes.dark).sort().join() !== light)
    fail("colors.themes", "light and dark", "the same set of roles");
  if (!Array.isArray(spacing.scale)) fail("spacing.scale", spacing.scale, "a list");
  for (const [i, px] of spacing.scale.entries()) positive(`spacing.scale[${i}]`, px, 1000);
  for (const group of ["radius", "control-height"] as const) {
    names(`spacing.${group}`, spacing[group]);
    for (const [key, px] of Object.entries(spacing[group])) positive(`spacing.${group}.${key}`, px);
  }
  names("spacing.shadow", spacing.shadow);
  for (const [key, value] of Object.entries(spacing.shadow))
    text(`spacing.shadow.${key}`, value, SHADOW, "offsets, blur and an rgba() colour per layer");
  names("typography.families", type.families);
  for (const [key, value] of Object.entries(type.families))
    text(`typography.families.${key}`, value, FAMILY, "a font family list");
  names("typography.weights", type.weights);
  for (const [key, value] of Object.entries(type.weights)) positive(`typography.weights.${key}`, value, 1000);
  if (!Array.isArray(type.scale)) fail("typography.scale", type.scale, "a list");
  for (const [i, px] of type.scale.entries()) positive(`typography.scale[${i}]`, px, 1000);
  names("typography.roles", type.roles);
  for (const [name, role] of Object.entries(type.roles)) {
    if (!(role.family in type.families))
      fail(`typography.roles.${name}.family`, role.family, "a family in typography.families");
    positive(`typography.roles.${name}.size`, role.size, 1000);
    positive(`typography.roles.${name}.line`, role.line, 10);
    positive(`typography.roles.${name}.weight`, role.weight, 1000);
    if (role.tracking !== undefined)
      text(`typography.roles.${name}.tracking`, role.tracking, TRACKING, "a length in em");
    if (role.case !== undefined)
      text(`typography.roles.${name}.case`, role.case, /^(?:uppercase|lowercase|capitalize)$/, "a text-transform");
    if (role.numeric !== undefined)
      text(
        `typography.roles.${name}.numeric`,
        role.numeric,
        /^(?:tabular-nums|lining-nums|oldstyle-nums|proportional-nums)$/,
        "a numeric variant",
      );
  }
  return tokens;
}

const rem = (px: number) => `${px / 16}rem`;
const family = (name: string) => (name.includes(",") ? name : `"${name}", ${SANS}`);
const block = (selector: string, lines: string[]) => `${selector} {\n${lines.map((l) => `  ${l}`).join("\n")}\n}`;
const indent = (css: string) => css.replaceAll("\n", "\n  ");
const colours = (theme: Theme) => Object.entries(theme).map(([role, value]) => `--color-${role}: ${value};`);

export function buildTokens(dir?: string): string {
  const { colors, spacing, type } = readTokens(dir);
  const theme = [
    "--*: initial;",
    ...Object.entries(BREAKPOINTS).map(([key, size]) => `--breakpoint-${key}: ${size};`),
    ...colours(colors.themes.light),
    ...spacing.scale.map((px) => `--spacing-${px}: ${px}px;`),
    ...Object.entries(spacing["control-height"]).map(
      ([key, px]) => `--spacing-control${key === "default" ? "" : `-${key}`}: ${px}px;`,
    ),
    ...Object.entries(spacing.radius).map(([key, px]) => `--radius-${key}: ${px}px;`),
    ...Object.entries(spacing.shadow).map(([key, value]) => `--shadow-${key}: ${value};`),
    ...Object.entries(type.families).map(([key, name]) => `--font-${key}: ${family(name)};`),
    // Tailwind's base layer reads these for unstyled text and code; the reset above removed their defaults.
    "--default-font-family: var(--font-text);",
    "--default-mono-font-family: var(--font-mono);",
    ...type.scale.map((px) => `--text-${px}: ${rem(px)};`),
  ];
  // Weight tokens share names with families (`text`, `heading`), and Tailwind reads `font-<name>` as a family first, so
  // weights get their own `weight-<name>` utilities over plain custom properties instead of the `--font-weight-*` theme.
  const weights = Object.entries(type.weights);
  const roles = Object.entries(type.roles).map(([name, role]) =>
    block(`@utility type-${name}`, [
      `font-family: var(--font-${role.family});`,
      `font-size: ${rem(role.size)};`,
      `line-height: ${role.line};`,
      `font-weight: ${role.weight};`,
      // Every role sets every property, so a role replaces another (`type-eyebrow md:type-body`) and nested text does
      // not inherit an outer role's tracking, case or numerals.
      `letter-spacing: ${role.tracking ?? "normal"};`,
      `text-transform: ${role.case ?? "none"};`,
      `font-variant-numeric: ${role.numeric ?? "normal"};`,
    ]),
  );
  const dark = ["color-scheme: dark;", ...colours(colors.themes.dark)];
  const light = ["color-scheme: light;", ...colours(colors.themes.light)];
  return [
    "/* Generated by scripts/build-tokens.ts from design/tokens/*.json. Do not edit: run pnpm build:css. */",
    block("@theme static", theme),
    // `dark:` means what the colour variables mean: data-theme first, else the operating-system preference.
    block("@custom-variant dark", [
      indent(block('&:where([data-theme="dark"], [data-theme="dark"] *)', ["@slot;"])),
      indent(block("@media (prefers-color-scheme: dark)", [indent(block(`&:where(${DARK}, ${DARK} *)`, ["@slot;"]))])),
    ]),
    block(":root", ["color-scheme: light;", ...weights.map(([key, weight]) => `--weight-${key}: ${weight};`)]),
    block("@media (prefers-color-scheme: dark)", [indent(block(DARK, dark))]),
    block(':root[data-theme="dark"]', dark),
    block(':root[data-theme="light"]', light),
    ...weights.map(([key]) => block(`@utility weight-${key}`, [`font-weight: var(--weight-${key});`])),
    ...roles,
    "",
  ].join("\n\n");
}

// The value after a flag, resolved against the repository unless absolute; a flag with no value is an error.
export function option(argv: string[], flag: string, fallback: string): string {
  const at = argv.indexOf(flag);
  if (at < 0) return resolve(ROOT, fallback);
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a path`);
  return resolve(ROOT, value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const out = option(process.argv, "--out", OUT);
    const css = buildTokens(option(process.argv, "--tokens", TOKENS));
    const tmp = `${out}.${process.pid}.tmp`;
    writeFileSync(tmp, css, "utf-8");
    renameSync(tmp, out);
  } catch (error) {
    console.error(`build-tokens: ${(error as Error).message}`);
    process.exit(1);
  }
}
