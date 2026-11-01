import { describe, expect, it } from "vitest";

// Vite's `import.meta.glob`, which the Worker test build resolves at build time.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: string; import: string; eager: true }): Record<string, string>;
  }
}

// D02 T06 §1: one call to Web Risk's Update API (`threatLists`, `computeDiff`, `hashes:search`) reprices every lookup to
// US$50 per 1,000 (cloud.google.com/web-risk/pricing, read 2026-10-27). Only `uris:search` is used; nothing in `src/` may
// name the others.
const FORBIDDEN = /threatLists|computeDiff|hashes:search/;
const sources = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

const offenders = (files: Record<string, string>) =>
  Object.entries(files)
    .filter(([, text]) => FORBIDDEN.test(text))
    .map(([path]) => path);

describe("Web Risk's Update API", () => {
  it("is named nowhere in src/", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(offenders(sources)).toEqual([]);
  });

  it("is caught when planted", () => {
    expect(
      offenders({
        ...sources,
        "../../src/planted.ts": "fetch('https://webrisk.googleapis.com/v1/threatLists:computeDiff')",
      }),
    ).toEqual(["../../src/planted.ts"]);
    expect(offenders({ a: "hashes:search" })).toEqual(["a"]);
  });
});
