// Reading a built page in the site tests: its HTML, one element or region of it, its visible text and its links.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIST = fileURLToPath(new URL("../../dist", import.meta.url));

// The built HTML of a route (`/`, `/how-it-works`).
export function page(route: string): string {
  const file = join(DIST, route === "/" ? "index.html" : `${route.replace(/^\//, "")}/index.html`);
  assert.ok(existsSync(file), `${file} is missing: run \`pnpm --filter site build\` first`);
  return readFileSync(file, "utf8");
}

// The element that opens with `opening` (a regex over its start tag), through its own closing tag.
export function element(source: string, opening: RegExp, label: string): string {
  const start = source.search(opening);
  assert.ok(start >= 0, `no ${label} in the page`);
  const tag = /^<([a-z]+)/.exec(source.slice(start))?.[1] ?? "";
  const pattern = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  pattern.lastIndex = start;
  let depth = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return source.slice(start, match.index + match[0].length);
  }
  throw new Error(`${label} never closes`);
}

export const region = (source: string, name: string) =>
  element(source, new RegExp(`<[a-z]+[^>]*data-region="${name}"`), `region ${name}`);

// Visible text: block ends become spaces, inline tags vanish, entities are decoded, whitespace collapses.
export const text = (fragment: string) =>
  fragment
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|span|figcaption|footer|blockquote|article|a|nav|dt|dd|kbd|th|td)>|<br\s*\/?>/g, (tag) =>
      tag.startsWith("</a") || tag.startsWith("</kbd") ? "" : " ",
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

export const hrefs = (fragment: string) => [...fragment.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)].map((m) => m[1]);

export const has = (fragment: string, words: string, where: string) =>
  assert.ok(text(fragment).includes(words), `${where} lacks "${words}"`);

export const linkTo = (fragment: string, href: string, label: string, where: string) =>
  assert.ok(
    [...fragment.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].some(
      (m) => m[1] === href && text(m[2]).includes(label),
    ),
    `${where} has no "${label}" link to ${href}`,
  );
