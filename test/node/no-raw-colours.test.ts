import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Colours come from tokens only (AGENTS.md, design/SPEC.md): no literal colour in the app's sources. The generated
// src/web/styles/tokens.css is the one place literals live. The marketing site's sources join with D07 T06 §1.
const ROOT = join(import.meta.dirname, "../..");
const WEB = join(ROOT, "src/web");
const GENERATED = new Set(["src/web/styles/tokens.css"]);
// A hex literal ends where a name cannot continue, so `#fade-in` (an anchor or id) is not `#fade`.
const LITERAL = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])|\b(?:rgba?|hsla?|oklch)\(/gi;

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

// Every literal colour in the given text, as `line: match`.
function rawColours(text: string): string[] {
  return text.split("\n").flatMap((line, i) => [...line.matchAll(LITERAL)].map((m) => `${i + 1}: ${m[0]}`));
}

describe("raw colours", () => {
  it("finds none in src/web outside the generated tokens", () => {
    const found = files(WEB)
      .map((path) => relative(ROOT, path).replaceAll("\\", "/"))
      .filter((path) => !GENERATED.has(path))
      .flatMap((path) => rawColours(readFileSync(join(ROOT, path), "utf-8")).map((hit) => `${path}:${hit}`));
    expect(found).toEqual([]);
  });

  it("catches every literal form and leaves token references alone", () => {
    const text =
      'a{color:#f00}\nb{color:#ff0000aa}\n<p style="color: rgb(1,2,3)">\nhsl(1 2% 3%) oklch(0.5 0.1 30)\nbg-ink var(--color-ink) #fade-in';
    expect(rawColours(text)).toEqual(["1: #f00", "2: #ff0000aa", "3: rgb(", "4: hsl(", "4: oklch("]);
  });
});
