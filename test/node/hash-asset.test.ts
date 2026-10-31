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
  "--brand",
  join(DIR, "brand"),
  "--motion",
  join(DIR, "motion"),
  "--email",
  join(DIR, "email"),
  "--htmx",
  join(DIR, "htmx.min.js"),
  "--app-script",
  join(DIR, "app.ts"),
];
const APP_TS =
  'const greeting: string = "hi";\nfunction say(name: string): void {\n  console.log(greeting, name);\n}\nsay("x");\nexport {};\n';
const MOTION_FILES = ["malicious.svg", "suspicious.svg", "safe.svg", "question.svg", "checking-animated.svg"];
const LOGO_FILES = [
  "isitlegit-logo.svg",
  "isitlegit-logo-on-dark.svg",
  "isitlegit-mark.svg",
  "isitlegit-mark-on-dark.svg",
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
  mkdirSync(join(DIR, "brand"), { recursive: true });
  for (const name of LOGO_FILES) writeFileSync(join(DIR, "brand", name), `<svg>${name}</svg>`);
  mkdirSync(join(DIR, "motion"), { recursive: true });
  for (const name of MOTION_FILES) writeFileSync(join(DIR, "motion", name), `<svg>${name}</svg>`);
  mkdirSync(join(DIR, "email"), { recursive: true });
  for (const name of ["logo", "malicious", "suspicious", "safe", "question"])
    writeFileSync(join(DIR, "email", `${name}.png`), `png ${name}`);
  writeFileSync(join(DIR, "htmx.min.js"), "var htmx={version:'2.0.11'};");
  writeFileSync(join(DIR, "app.ts"), APP_TS);
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("hash-asset", () => {
  it("fingerprints htmx as published and the app script with its types stripped, exports both, and keeps them (D07 T01 §9)", () => {
    writeFileSync(join(DIR, "app.css"), "body{color:var(--color-ink)}");
    const { scripts } = hashAssets(args());
    expect(scripts.htmx).toMatch(/^\/static\/htmx\.[0-9a-f]{12}\.js$/);
    expect(scripts.app).toMatch(/^\/static\/app\.[0-9a-f]{12}\.js$/);
    expect(readFileSync(join(DIR, "public", scripts.htmx), "utf-8")).toBe("var htmx={version:'2.0.11'};");
    const built = readFileSync(join(DIR, "public", scripts.app), "utf-8");
    expect(built).not.toMatch(/:\s*(string|void)\b/);
    expect(built).toContain("const greeting");
    expect(built).toContain('say("x");');
    const module = readFileSync(join(DIR, "assets.ts"), "utf-8");
    expect(module).toContain(`export const HTMX = "${scripts.htmx}";`);
    expect(module).toContain(`export const APP_JS = "${scripts.app}";`);
    // A changed script gets a new name, the old file goes, and the unchanged one stays.
    writeFileSync(join(DIR, "app.ts"), APP_TS.replace('"hi"', '"hello"'));
    const next = hashAssets(args()).scripts;
    expect(next.app).not.toBe(scripts.app);
    expect(next.htmx).toBe(scripts.htmx);
    const left = readdirSync(join(DIR, "public/static")).filter((name) => name.endsWith(".js"));
    expect(left.sort()).toEqual([next.app, next.htmx].map((url) => url.split("/").pop()).sort());
    writeFileSync(join(DIR, "app.ts"), APP_TS);
  });

  it("writes nothing when the app script cannot be built", () => {
    writeFileSync(join(DIR, "app.css"), "body{color:var(--color-ink)}");
    hashAssets(args());
    const before = readdirSync(join(DIR, "public/static")).sort();
    writeFileSync(join(DIR, "app.ts"), "enum Mode { A }\n");
    expect(() => hashAssets(args())).toThrow();
    expect(readdirSync(join(DIR, "public/static")).sort()).toEqual(before);
    writeFileSync(join(DIR, "app.ts"), APP_TS);
  });

  it("names the stylesheet by its content and exports it with the fonts", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const { css, fonts } = hashAssets(args());
    expect(css).toMatch(/^\/static\/app\.[0-9a-f]{12}\.css$/);
    expect(fonts).toEqual({ Exo: EXO, "Exo 2": EXO2 });
    expect(readFileSync(join(DIR, "public", css), "utf-8")).toBe("a{}");
    expect(readFileSync(join(DIR, "assets.ts"), "utf-8")).toContain(`export const APP_CSS = "${css}";`);
  });

  it("names the four logos by their content, exports them, and replaces a changed one", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const { logos } = hashAssets(args());
    expect(Object.keys(logos).sort()).toEqual(["LOGO", "LOGO_MARK", "LOGO_MARK_ON_DARK", "LOGO_ON_DARK"]);
    expect(logos.LOGO_MARK_ON_DARK).toMatch(/^\/static\/brand\/mark-on-dark\.[0-9a-f]{12}\.svg$/);
    expect(logos.LOGO).toMatch(/^\/static\/brand\/logo\.[0-9a-f]{12}\.svg$/);
    expect(logos.LOGO_ON_DARK).toMatch(/^\/static\/brand\/logo-on-dark\.[0-9a-f]{12}\.svg$/);
    expect(logos.LOGO_MARK).toMatch(/^\/static\/brand\/mark\.[0-9a-f]{12}\.svg$/);
    expect(readFileSync(join(DIR, "public", logos.LOGO), "utf-8")).toBe("<svg>isitlegit-logo.svg</svg>");
    for (const [key, url] of Object.entries(logos))
      expect(readFileSync(join(DIR, "assets.ts"), "utf-8")).toContain(`export const ${key} = "${url}";`);
    writeFileSync(join(DIR, "brand/isitlegit-mark.svg"), "<svg>new mark</svg>");
    const next = hashAssets(args()).logos;
    expect(next.LOGO_MARK).not.toBe(logos.LOGO_MARK);
    expect(readdirSync(join(DIR, "public/static/brand")).filter((f) => f.startsWith("mark."))).toEqual([
      next.LOGO_MARK.split("/").pop(),
    ]);
    writeFileSync(join(DIR, "brand/isitlegit-mark.svg"), "<svg>isitlegit-mark.svg</svg>");
  });

  it("names the verdict art by its content, exports it as MOTION, keeps it, and replaces a changed one (D07 T01 §7)", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const { motion } = hashAssets(args());
    expect(Object.keys(motion).sort()).toEqual(["checking", "malicious", "question", "safe", "suspicious"]);
    for (const [key, url] of Object.entries(motion))
      expect(url).toMatch(new RegExp(`^/static/brand/motion/${key}\\.[0-9a-f]{12}\\.svg$`));
    // The checking art is the animated one.
    expect(readFileSync(join(DIR, "public", motion.checking), "utf-8")).toBe("<svg>checking-animated.svg</svg>");
    expect(readFileSync(join(DIR, "assets.ts"), "utf-8")).toContain(
      `export const MOTION = ${JSON.stringify(motion)} as const;`,
    );
    writeFileSync(join(DIR, "motion/safe.svg"), "<svg>new safe</svg>");
    const next = hashAssets(args()).motion;
    expect(next.safe).not.toBe(motion.safe);
    expect(readdirSync(join(DIR, "public/static/brand/motion")).sort()).toEqual(
      Object.values(next)
        .map((url) => url.split("/").pop())
        .sort(),
    );
    writeFileSync(join(DIR, "motion/safe.svg"), "<svg>safe.svg</svg>");
    // A missing art file stops the build with the old set in place.
    const before = readFileSync(join(DIR, "assets.ts"), "utf-8");
    rmSync(join(DIR, "motion/question.svg"));
    writeFileSync(join(DIR, "app.css"), "c{}");
    expect(() => hashAssets(args())).toThrow("question.svg");
    expect(readFileSync(join(DIR, "assets.ts"), "utf-8")).toBe(before);
    writeFileSync(join(DIR, "motion/question.svg"), "<svg>question.svg</svg>");
  });

  it("writes and prunes nothing when a logo is missing", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    hashAssets(args());
    const before = readFileSync(join(DIR, "assets.ts"), "utf-8");
    const served = readdirSync(join(DIR, "public/static/brand")).sort();
    rmSync(join(DIR, "brand/isitlegit-logo-on-dark.svg"));
    writeFileSync(join(DIR, "app.css"), "b{}");
    expect(() => hashAssets(args())).toThrow("isitlegit-logo-on-dark.svg");
    expect(readFileSync(join(DIR, "assets.ts"), "utf-8")).toBe(before);
    expect(readdirSync(join(DIR, "public/static/brand")).sort()).toEqual(served);
    writeFileSync(join(DIR, "brand/isitlegit-logo-on-dark.svg"), "<svg>isitlegit-logo-on-dark.svg</svg>");
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
    const failing = args();
    failing[failing.indexOf("--module") + 1] = join(DIR, "assets-folder");
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

  it("names the reply email's PNGs by their content, exports them, keeps them, and replaces a changed one (D07 T03 §7)", () => {
    writeFileSync(join(DIR, "app.css"), "a{}");
    const { email } = hashAssets(args());
    expect(email.logo).toMatch(/^\/static\/brand\/email\/logo\.[0-9a-f]{12}\.png$/);
    expect(Object.keys(email.art).sort()).toEqual(["malicious", "question", "safe", "suspicious"]);
    for (const [key, url] of Object.entries(email.art))
      expect(url).toMatch(new RegExp(`^/static/brand/email/${key}\\.[0-9a-f]{12}\\.png$`));
    expect(readFileSync(join(DIR, "public", email.art.safe), "utf-8")).toBe("png safe");
    const module = readFileSync(join(DIR, "assets.ts"), "utf-8");
    expect(module).toContain(`export const EMAIL_LOGO = "${email.logo}";`);
    expect(module).toContain(`export const EMAIL_ART = ${JSON.stringify(email.art)} as const;`);
    writeFileSync(join(DIR, "email/safe.png"), "png new safe");
    const next = hashAssets(args()).email;
    expect(next.art.safe).not.toBe(email.art.safe);
    expect(readdirSync(join(DIR, "public/static/brand/email")).sort()).toEqual(
      [next.logo, ...Object.values(next.art)].map((url) => url.split("/").pop()).sort(),
    );
    writeFileSync(join(DIR, "email/safe.png"), "png safe");
    // A missing PNG stops the build before anything is written.
    rmSync(join(DIR, "email/question.png"));
    expect(() => hashAssets(args())).toThrow();
    writeFileSync(join(DIR, "email/question.png"), "png question");
  });
});
