import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saList } from "../../scripts/glimmer/render.ts";

// eval/glimmer/benign-sa-urls.txt (D03 T04 §6): the South African pages lures copy, by kind, each https and listed once.
const list = saList(readFileSync(join(import.meta.dirname, "../../eval/glimmer/benign-sa-urls.txt"), "utf-8"));
const count = (...kinds: string[]) => list.entries.filter((entry) => kinds.includes(entry.kind)).length;

describe("the South African benign URL list", () => {
  it("holds each kind at its minimum", () => {
    expect(count("login", "checkout", "account")).toBeGreaterThanOrEqual(150);
    expect(count("shop")).toBeGreaterThanOrEqual(50);
    expect(count("company")).toBeGreaterThanOrEqual(50);
    expect(count("social")).toBeGreaterThanOrEqual(30);
  });

  it("lists every URL once, over https, with its brand", () => {
    const urls = list.entries.map((entry) => entry.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const entry of list.entries) {
      expect(entry.url, entry.url).toMatch(/^https:\/\//);
      expect(entry.brand, entry.url).toBeTruthy();
    }
  });
});
