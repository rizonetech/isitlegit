import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Colours come from tokens only (AGENTS.md, design/SPEC.md). Two checks: the compiled production stylesheet, which is
// what ships (every colour in it must be a token colour, `transparent` or `currentcolor`), and the app's sources, for
// inline styles that never reach the stylesheet. The generated src/web/styles/tokens.css is where the literals live.
// The marketing site's sources join with D07 T06 §1.
const ROOT = join(import.meta.dirname, "../..");
const WEB = join(ROOT, "src/web");
const GENERATED = new Set(["src/web/styles/tokens.css"]);
const DIR = join(ROOT, `build/test-colours-${process.pid}`);

// CSS Color Module Level 4 named colours (and the system colours a page could reach for), lower case.
const NAMED = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood " +
    "cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray " +
    "darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue " +
    "firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
    "hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
    "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue " +
    "mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred " +
    "midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple " +
    "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue " +
    "slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder " +
    "field fieldtext highlight highlighttext mark marktext graytext accentcolor accentcolortext"
  ).split(" "),
);
const FUNCTIONS = "rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark";
// A hex literal ends where a name cannot continue, so `#fade-in` (an anchor or id) is not `#fade`.
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])/gi;
const FUNCTION = new RegExp(`\\b(?:${FUNCTIONS})\\(`, "gi");
// Properties that take a colour; a named colour is a literal only where one of these (or a Tailwind arbitrary value)
// gives it, so words like `tan` or `mark` elsewhere are not colours.
const COLOUR_PROPERTY =
  /\b(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?|fill|stroke|caret-color|accent-color|text-decoration(?:-color)?|column-rule(?:-color)?|box-shadow|text-shadow|stop-color|flood-color|lighting-color)\s*:\s*([^;"'}\n]*)/gi;
const ARBITRARY = /\[([^\]\s]*)\]/g;

function named(value: string): string[] {
  return (value.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => NAMED.has(word));
}

// Every literal colour in source text, as `line: match`.
function rawColours(text: string): string[] {
  return text.split("\n").flatMap((line, i) => {
    const hits = [...line.matchAll(HEX), ...line.matchAll(FUNCTION)].map((m) => m[0]);
    for (const m of line.matchAll(COLOUR_PROPERTY)) hits.push(...named(m[1] ?? ""));
    for (const m of line.matchAll(ARBITRARY)) hits.push(...named(m[1] ?? ""));
    return [...new Set(hits)].map((hit) => `${i + 1}: ${hit}`);
  });
}

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      return []; // a file another process renamed away between the listing and the check
    }
    return isDir ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

// A colour as lower-case #rrggbb or #rrggbbaa, so the minifier's spellings compare with the tokens'.
function hex(colour: string): string {
  const c = colour.toLowerCase().replace(/\s+/g, "");
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(c);
  if (short)
    return `#${short
      .slice(1)
      .filter(Boolean)
      .map((d) => d + d)
      .join("")}`;
  const rgba = /^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/.exec(c);
  if (rgba) {
    const [r, g, b] = rgba.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0"));
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return `#${r}${g}${b}${
      a < 1
        ? Math.round(a * 255)
            .toString(16)
            .padStart(2, "0")
        : ""
    }`;
  }
  return c;
}

const tokens = (name: string) => JSON.parse(readFileSync(join(ROOT, "design/tokens", name), "utf-8"));
function allowedColours(): Set<string> {
  const { themes } = tokens("colors.json");
  // Fully transparent black (`#0000`, Tailwind's default shadow colour) is `transparent`.
  const allowed = new Set<string>(["transparent", "currentcolor", "#00000000"]);
  for (const theme of Object.values<Record<string, string>>(themes))
    for (const v of Object.values(theme)) allowed.add(hex(v));
  for (const shadow of Object.values<string>(tokens("spacing.json").shadow))
    for (const m of shadow.matchAll(/rgba?\([^)]*\)/g)) allowed.add(hex(m[0]));
  return allowed;
}

// Every colour in compiled CSS that is not a token colour. Feature queries (`@supports (color:color-mix(...))`),
// comments and strings are not styles; color-mix() is allowed only over allowed colours and var() references.
function strayColours(css: string, allowed: Set<string>): string[] {
  const body = css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/@supports[^{]*\{/g, "@supports{");
  const stray: string[] = [];
  for (const m of body.matchAll(HEX)) if (!allowed.has(hex(m[0]))) stray.push(m[0]);
  for (const m of body.matchAll(new RegExp(`\\b(${FUNCTIONS})\\(((?:[^()]|\\([^()]*\\))*)\\)`, "gi"))) {
    const [whole, name = "", args = ""] = m;
    if (/^color-mix$/i.test(name)) {
      const parts = args
        .replace(/^in [a-z]+,/i, "")
        .split(",")
        .map((p) => p.trim().replace(/\s+\d+%$/, ""));
      if (parts.some((p) => !allowed.has(hex(p)) && !p.startsWith("var("))) stray.push(whole);
    } else if (!allowed.has(hex(whole))) stray.push(whole);
  }
  for (const m of body.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]*)/gi))
    if (!(m[1] ?? "").startsWith("--")) for (const word of named(m[2] ?? "")) stray.push(`${m[1]}:${word}`);
  return stray;
}

describe("raw colours", () => {
  let production = "";

  beforeAll(() => {
    mkdirSync(DIR, { recursive: true });
    const run = spawnSync(
      process.execPath,
      [join(ROOT, "scripts/build-css.ts"), "--no-tokens", "--out", join(DIR, "app.css")],
      { cwd: ROOT, encoding: "utf-8" },
    );
    expect(run.status, run.stderr).toBe(0);
    production = readFileSync(join(DIR, "app.css"), "utf-8");
  }, 120_000);
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("ships no colour in the production stylesheet that is not a token", () => {
    expect(strayColours(production, allowedColours())).toEqual([]);
  });

  it("finds none in src/web sources outside the generated tokens", () => {
    const found = files(WEB)
      .map((path) => relative(ROOT, path).replaceAll("\\", "/"))
      .filter((path) => !GENERATED.has(path))
      .flatMap((path) => rawColours(readFileSync(join(ROOT, path), "utf-8")).map((hit) => `${path}:${hit}`));
    expect(found).toEqual([]);
  });

  it("catches every literal form in sources and leaves token references and names alone", () => {
    const text = [
      "a{color:#f00}",
      "b{color:#ff0000aa}",
      '<p style="color: rgb(1,2,3)">',
      "hsl(1 2% 3%) oklch(0.5 0.1 30) lab(5 1 2) hwb(1 2% 3%) oklab(1 0 0) color-mix(in srgb, x, y)",
      "a{color:red} b{background:navy none}",
      '<p class="bg-[red] [color:tomato] text-[#abc]">',
      "bg-ink var(--color-ink) #fade-in tan-line mark",
    ].join("\n");
    expect(rawColours(text)).toEqual([
      "1: #f00",
      "2: #ff0000aa",
      "3: rgb(",
      "4: hsl(",
      "4: oklch(",
      "4: lab(",
      "4: hwb(",
      "4: oklab(",
      "4: color-mix(",
      "5: red",
      "5: navy",
      "6: #abc",
      "6: tomato",
      "6: red",
    ]);
  });

  it("catches every non-token colour in compiled CSS and allows tokens, transparent, currentcolor and feature queries", () => {
    const allowed = allowedColours();
    const css =
      ".a{color:#181519}.b{color:#fff}.c{color:red}.d{background:color-mix(in oklab,currentcolor 50%,transparent)}" +
      "@supports (color:color-mix(in lab, red, red)){.e{color:currentColor}}.f{color:oklch(.5 .1 30)}" +
      ".g{box-shadow:0 1px 2px #1815190f}.h{color:#123456}.i{color:color-mix(in srgb,red 50%,#fff)}";
    expect(strayColours(css, allowed)).toEqual([
      "#123456",
      "oklch(.5 .1 30)",
      "color-mix(in srgb,red 50%,#fff)",
      "color:red",
      "color:red",
    ]);
  });
});
