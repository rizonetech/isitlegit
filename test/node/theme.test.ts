import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTokens } from "../../scripts/build-tokens.ts";

type Box = { backgroundColor: string; color: string; borderTopColor: string };
type Snapshot = { dark: boolean; box: Box };
type TypeStyle = {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  fontWeight: string;
  letterSpacing: string;
  textTransform: string;
  fontVariantNumeric: string;
};
type Page = {
  unset: Snapshot;
  light: Snapshot;
  darkTheme: Snapshot;
  removed: Snapshot;
  layout: { paddingTop: string; height: string; borderTopLeftRadius: string; boxShadow: string };
  type: Record<string, TypeStyle>;
  defaults: { backgroundColor: string; fontFamily: string; fontSize: string; fontWeight: string };
  weights: Record<string, string>;
  responsive: Partial<TypeStyle>;
  nested: Partial<TypeStyle>;
  base: { fontFamily: string; fontSize: string };
};
type Role = {
  family: string;
  size: number;
  line: number;
  weight: number;
  tracking?: string;
  case?: string;
  numeric?: string;
};

// Compiles a fixture page with the token stylesheet and measures it in headless Chromium: token classes must give the
// token values under each OS colour preference, data-theme must override the preference, and removing it must restore
// the preference. Chromium is the browser design/tools/export-mockups.py uses (MOCKUP_CHROMIUM, else Playwright's
// headless shell, else chromium or google-chrome on PATH); CI names Google Chrome, whose sandbox works on the runner.
const ROOT = join(import.meta.dirname, "../..");
const tokens = (name: string) => JSON.parse(readFileSync(join(ROOT, "design/tokens", name), "utf-8"));
const colors = tokens("colors.json");
const spacing = tokens("spacing.json");
const type = tokens("typography.json");
const DIR = join(ROOT, `build/test-theme-${process.pid}`);

function chromium(): string | undefined {
  if (process.env.MOCKUP_CHROMIUM) return process.env.MOCKUP_CHROMIUM;
  const cache = join(process.env.HOME ?? "", ".cache/ms-playwright");
  if (existsSync(cache)) {
    const shells = execFileSync("ls", [cache], { encoding: "utf-8" })
      .split("\n")
      .filter((d) => d.startsWith("chromium_headless_shell-"))
      .sort();
    const shell = shells.length
      ? join(cache, shells[shells.length - 1] as string, "chrome-headless-shell-linux64/chrome-headless-shell")
      : "";
    if (shell && existsSync(shell)) return shell;
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const found = spawnSync("which", [name], { encoding: "utf-8" }).stdout.trim();
    if (found) return found;
  }
  return undefined;
}

const BROWSER = chromium();
const ROLES = Object.keys(type.roles);
const WEIGHTS = Object.keys(type.weights);
// Elements the fixture measures: token classes, then Tailwind defaults that must produce nothing.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="out.css"></head><body>
<div id="box" class="bg-surface text-ink border border-line rounded-card shadow-card p-16 h-control">box</div>
${ROLES.map((r) => `<p id="type-${r}" class="type-${r}">x</p>`).join("\n")}
${WEIGHTS.map((w) => `<b id="weight-${w}" class="weight-${w}">w</b>`).join("\n")}
<p id="responsive" class="type-eyebrow md:type-body">r</p>
<div class="type-eyebrow"><span id="nested" class="type-body">n</span></div>
<p id="defaults" class="bg-red-500 font-serif text-9xl font-bold">d</p>
<p id="plain">p</p>
<pre id="out"></pre>
<script>
const read = (id, props) => Object.fromEntries(props.map((p) => [p, getComputedStyle(document.getElementById(id))[p]]));
const snap = () => ({ dark: matchMedia("(prefers-color-scheme: dark)").matches, box: read("box", ["backgroundColor", "color", "borderTopColor"]) });
const out = { unset: snap() };
document.documentElement.dataset.theme = "light"; out.light = snap();
document.documentElement.dataset.theme = "dark"; out.darkTheme = snap();
delete document.documentElement.dataset.theme; out.removed = snap();
out.layout = read("box", ["paddingTop", "height", "borderTopLeftRadius", "boxShadow"]);
out.type = Object.fromEntries(${JSON.stringify(ROLES)}.map((r) => [r, read("type-" + r, ["fontFamily", "fontSize", "lineHeight", "fontWeight", "letterSpacing", "textTransform", "fontVariantNumeric"])]));
out.defaults = read("defaults", ["backgroundColor", "fontFamily", "fontSize", "fontWeight"]);
out.weights = Object.fromEntries(${JSON.stringify(WEIGHTS)}.map((w) => [w, read("weight-" + w, ["fontWeight"]).fontWeight]));
out.responsive = read("responsive", ["fontSize", "fontWeight", "letterSpacing", "textTransform", "fontVariantNumeric"]);
out.nested = read("nested", ["fontSize", "fontWeight", "letterSpacing", "textTransform", "fontVariantNumeric"]);
out.base = read("plain", ["fontFamily", "fontSize"]);
document.getElementById("out").textContent = JSON.stringify(out);
</script></body></html>`;

function rgb(hex: string): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

// Opens the fixture with the given OS preference (Blink: 0 dark, 1 light) and returns what the page measured.
function measure(preference: 0 | 1): Page {
  const profile = mkdtempSync(join(tmpdir(), "theme-profile-"));
  try {
    const run = spawnSync(
      BROWSER as string,
      [
        "--headless",
        "--proxy-server=127.0.0.1:9",
        "--proxy-bypass-list=<-loopback>",
        "--no-first-run",
        `--user-data-dir=${profile}`,
        "--window-size=1200,900",
        `--blink-settings=preferredColorScheme=${preference}`,
        "--virtual-time-budget=3000",
        "--dump-dom",
        pathToFileURL(join(DIR, "fixture.html")).href,
      ],
      { encoding: "utf-8", timeout: 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: profile } },
    );
    const json = /<pre id="out">([^<]*)<\/pre>/.exec(run.stdout)?.[1];
    if (!json)
      throw new Error(
        `Chromium measured nothing (exit ${run.status}): ${run.stderr
          .split("\n")
          .filter((l) => !l.includes("dbus"))
          .slice(-3)
          .join(" | ")}`,
      );
    return JSON.parse(json.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

// A shadow token as Chrome reports it: each layer's colour first, then offsets, blur and spread, all in px.
function computedShadow(token: string): string {
  return token
    .split(/,(?![^(]*\))/)
    .map((layer) => {
      const colour = /rgba?\([^)]*\)/.exec(layer)?.[0] ?? "";
      const lengths = layer
        .replace(colour, "")
        .trim()
        .split(/\s+/)
        .map((n) => (n === "0" ? "0px" : n));
      while (lengths.length < 4) lengths.push("0px");
      return `${colour.replace(/\s*,\s*/g, ", ")} ${lengths.join(" ")}`;
    })
    .join(", ");
}

// The first family in a computed font-family list, unquoted (Chrome quotes only names that need it).
const firstFamily = (list: string) => (list.split(",")[0] as string).trim().replaceAll('"', "");

const boxIn = (theme: Record<string, string>): Box => ({
  backgroundColor: rgb(theme.surface as string),
  color: rgb(theme.ink as string),
  borderTopColor: rgb(theme.line as string),
});

describe.skipIf(!BROWSER && !process.env.CI)("token classes measured in Chromium", () => {
  let light: Page;
  let dark: Page;

  beforeAll(() => {
    expect(BROWSER, "CI must have a Chromium (set MOCKUP_CHROMIUM)").toBeTruthy();
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "tokens.css"), buildTokens());
    writeFileSync(
      join(DIR, "app.css"),
      `@import "tailwindcss" source(none);\n@source "./fixture.html";\n@import "./tokens.css";\n`,
    );
    writeFileSync(join(DIR, "fixture.html"), FIXTURE);
    execFileSync(
      join(ROOT, "node_modules/.bin/tailwindcss"),
      ["-i", join(DIR, "app.css"), "-o", join(DIR, "out.css"), "--minify"],
      { cwd: ROOT, stdio: "pipe" },
    );
    light = measure(1);
    dark = measure(0);
    // A Tailwind compile and two Chromium launches took about 8 s on the GitHub runner (run 40435635613) and passed
    // Vitest's 10 s hook default by a little on the next run (40437530949); each launch is itself bounded at 60 s.
  }, 150_000);
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("follows the OS preference when data-theme is unset", () => {
    expect([light.unset.dark, dark.unset.dark]).toEqual([false, true]);
    expect(light.unset.box).toEqual(boxIn(colors.themes.light));
    expect(dark.unset.box).toEqual(boxIn(colors.themes.dark));
  });

  it("lets data-theme override the OS preference both ways", () => {
    for (const page of [light, dark]) {
      expect(page.light.box).toEqual(boxIn(colors.themes.light));
      expect(page.darkTheme.box).toEqual(boxIn(colors.themes.dark));
    }
  });

  it("returns to the OS preference when data-theme is removed", () => {
    expect(light.removed.box).toEqual(boxIn(colors.themes.light));
    expect(dark.removed.box).toEqual(boxIn(colors.themes.dark));
  });

  it("gives spacing, control height, radius and shadow their token values", () => {
    expect(light.layout.paddingTop).toBe("16px");
    expect(light.layout.height).toBe(`${spacing["control-height"].default}px`);
    expect(light.layout.borderTopLeftRadius).toBe(`${spacing.radius.card}px`);
    // Tailwind composes inset, ring and ring-offset layers ahead of the shadow; unused, each is transparent and empty.
    const expected = computedShadow(spacing.shadow.card);
    const layers = light.layout.boxShadow
      .slice(0, -expected.length)
      .split(/,(?![^(]*\))/)
      .filter((l) => l.trim());
    expect(light.layout.boxShadow.endsWith(expected), light.layout.boxShadow).toBe(true);
    for (const layer of layers) expect(layer.trim()).toBe("rgba(0, 0, 0, 0) 0px 0px 0px 0px");
  });

  it("gives every typography role its family, size, line height, weight, tracking, case and numerals", () => {
    for (const [name, role] of Object.entries<Role>(type.roles)) {
      const got = light.type[name] as TypeStyle;
      const family = (type.families[role.family] as string).split(",")[0] as string;
      expect(firstFamily(got.fontFamily), name).toBe(family);
      expect(got.fontSize, name).toBe(`${role.size}px`);
      expect(Number.parseFloat(got.lineHeight), name).toBeCloseTo(role.size * role.line, 1);
      expect(got.fontWeight, name).toBe(String(role.weight));
      if (role.tracking)
        expect(Number.parseFloat(got.letterSpacing), name).toBeCloseTo(role.size * Number.parseFloat(role.tracking), 1);
      expect(got.textTransform, name).toBe(role.case ?? "none");
      expect(got.fontVariantNumeric, name).toBe(role.numeric ?? "normal");
    }
  });

  it("sets unstyled text in the text family", () => {
    expect(firstFamily(light.base.fontFamily)).toBe(type.families.text);
  });

  it("gives every weight token its own class, which also undoes inherited bold", () => {
    for (const [key, weight] of Object.entries<number>(type.weights))
      expect(light.weights[key], key).toBe(String(weight));
  });

  it("lets one role replace another at a breakpoint and inside nested text", () => {
    const body = type.roles.body as Role;
    for (const [where, got] of [
      ["md:type-body at 1200px", light.responsive],
      ["type-body inside type-eyebrow", light.nested],
    ] as const) {
      expect(got.fontSize, where).toBe(`${body.size}px`);
      expect(got.fontWeight, where).toBe(String(body.weight));
      expect(got.letterSpacing, where).toBe("normal");
      expect(got.textTransform, where).toBe("none");
      expect(got.fontVariantNumeric, where).toBe("normal");
    }
  });

  it("produces nothing for Tailwind's default palette, fonts and type scale", () => {
    expect(light.defaults.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(light.defaults.fontFamily).toBe(light.base.fontFamily);
    expect(light.defaults.fontSize).toBe(light.base.fontSize);
    expect(light.defaults.fontWeight).toBe("400");
  });
});
