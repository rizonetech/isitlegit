// The built marketing site (D07 T06 §1): run after `pnpm --filter site build`. Each check fails when the piece it names
// is removed: the token import, the theme overrides, the font copy, the cache rule or the layout's document parts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { fontUrls } from "../src/integrations/app-fonts.ts";

const SITE = fileURLToPath(new URL("..", import.meta.url));
const ROOT = join(SITE, "..");
const DIST = join(SITE, "dist");

assert.ok(existsSync(join(DIST, "index.html")), "site/dist is missing: run `pnpm --filter site build` first");

const html = readFileSync(join(DIST, "index.html"), "utf8");
const stylesheets = readdirSync(join(DIST, "_astro")).filter((name) => name.endsWith(".css"));
const css = stylesheets.map((name) => readFileSync(join(DIST, "_astro", name), "utf8")).join("\n");
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("the site stylesheet", () => {
  it("is linked from the page", () => {
    assert.equal(stylesheets.length, 1);
    assert.match(html, new RegExp(`<link rel="stylesheet" href="/_astro/${stylesheets[0].replace(".", "\\.")}">`));
  });

  it("compiles the token utilities the layout uses", () => {
    for (const rule of [".bg-surface{", ".text-ink{", ".font-text{", ".font-heading{", ".sr-only{"]) {
      assert.ok(css.includes(rule), `no ${rule} rule`);
    }
    assert.match(css, /\.bg-surface\{background-color:var\(--color-surface\)\}/);
  });

  it("carries the token values, light by default", () => {
    assert.match(css, /--color-surface:#fff(fff)?[;}]/i);
    assert.match(css, /--color-orange-text:#cc2e00/i);
  });

  it("switches to dark on the operating-system preference unless the page asks for light", () => {
    const media = css.match(/@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{([^}]*)\}/);
    assert.ok(media, "no prefers-color-scheme dark block with the light opt-out");
    assert.match(media[1], /color-scheme:dark/);
    assert.match(media[1], /--color-surface:#121014/i);
  });

  it("switches to dark when the page asks for it", () => {
    const forced = css.match(/:root\[data-theme=dark\]\{([^}]*)\}/);
    assert.ok(forced, "no data-theme dark block");
    assert.match(forced[1], /--color-surface:#121014/i);
  });

  it("gives every focused link and button the SPEC focus ring", () => {
    assert.match(css, /a:focus-visible,button:focus-visible\{outline:2px solid var\(--color-orange-text\);outline-offset:2px\}/);
  });

  it("declares the app's fonts", () => {
    assert.match(css, /font-family:"?Exo 2"?/);
    assert.match(css, /font-family:"?Exo"?[;,}]/);
  });
});

describe("the site fonts", () => {
  const urls = fontUrls(readFileSync(join(ROOT, "src/web/styles/fonts.css"), "utf8"));

  it("are the files the app's stylesheet names", () => {
    assert.ok(urls.length >= 2, `fonts.css names ${urls.length} fonts`);
    for (const url of urls) assert.ok(css.includes(url), `the site stylesheet does not reference ${url}`);
  });

  it("ship byte for byte with the app's", () => {
    for (const url of urls) {
      const built = join(DIST, url);
      assert.ok(existsSync(built), `${url} is not in site/dist`);
      assert.equal(sha256(built), sha256(join(ROOT, "public", url)), `${url} differs from the app's`);
    }
  });

  it("are cached for a year, as fingerprinted files", () => {
    const headers = readFileSync(join(DIST, "_headers"), "utf8");
    assert.match(headers, /^\/static\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  });
});

describe("the base layout", () => {
  it("declares the language, character set, viewport and title", () => {
    assert.match(html, /^<!DOCTYPE html><html lang="en-ZA">/i);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<title>IsItLegit<\/title>/);
  });

  it("opens the body with a skip link to the main content", () => {
    const body = html.slice(html.indexOf("<body"));
    const firstFocusable = body.match(/<(a|button|input|select|textarea)\b[^>]*>/);
    assert.ok(firstFocusable, "nothing focusable in the body");
    assert.match(firstFocusable[0], /^<a href="#main"/);
    assert.match(firstFocusable[0], /class="sr-only focus:not-sr-only/);
  });

  it("renders the page inside the focusable main landmark", () => {
    assert.match(html, /<main id="main" tabindex="-1"[^>]*><h1[^>]*>IsItLegit<\/h1><\/main>/);
  });

  it("sends visitors no script, as NOTICE.md says", () => {
    assert.doesNotMatch(html, /<script\b/i);
    const scripts = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? scripts(join(dir, entry.name)) : /\.m?js$/.test(entry.name) ? [entry.name] : [],
      );
    assert.deepEqual(scripts(DIST), []);
  });

  it("styles the body in tokens", () => {
    assert.match(html, /<body class="bg-surface text-ink font-text">/);
  });
});
