import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDomain } from "tldts";
import { describe, expect, it } from "vitest";
import { parseCommand, saList } from "../../scripts/glimmer/render.ts";

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

  it("lists pages of their kind, not home pages under a kind's name", () => {
    // A site's root, or a home page under another name (`/home/`, `/za-en/home.html`).
    const root = (url: string) =>
      /^\/([a-z]{2}([-_][a-z]{2})?\/?)?(index\.html?)?$/i.test(new URL(url).pathname) ||
      /(^|\/)(home|index)(\.html?)?\/?$/i.test(new URL(url).pathname);
    for (const entry of list.entries) {
      // A product, cart, about or contact page is never a site's root.
      if (["shop", "company", "checkout"].includes(entry.kind)) expect(root(entry.url), entry.url).toBe(false);
      if (
        ["login", "account"].includes(entry.kind) &&
        /(^|\/)(home|index)(\.html?)?\/?$/i.test(new URL(entry.url).pathname)
      )
        expect.fail(`${entry.url}: a home page under a sign-in kind`);
      // A sign-in or account page at a root lives on the site's own sign-in host, not its main one.
      if (["login", "account"].includes(entry.kind) && root(entry.url)) {
        const host = new URL(entry.url).hostname;
        const site = getDomain(host);
        expect([site, `www.${site}`], entry.url).not.toContain(host);
      }
    }
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

describe("the render command line", () => {
  it("takes --concurrency from 1 to 16, 4 by default, and refuses anything else", () => {
    expect(parseCommand(["run"])).toEqual({ command: "run", concurrency: 4 });
    expect(parseCommand(["run", "majestic", "--concurrency", "8"])).toEqual({
      command: "run",
      only: "majestic",
      concurrency: 8,
    });
    expect(parseCommand(["--concurrency", "2", "run"])).toEqual({ command: "run", concurrency: 2 });
    expect(parseCommand(["--coverage"])).toEqual({ command: "coverage", concurrency: 4 });
    expect(parseCommand(["reopen", "--matching", "TypeError"])).toEqual({
      command: "reopen",
      concurrency: 4,
      matching: /TypeError/,
    });
    for (const bad of [
      ["run", "--concurrency", "0"],
      ["run", "--concurrency", "17"],
      ["run", "--concurrency", "x"],
      ["run", "--concurrency"],
      ["run", "elsewhere"],
      ["run", "majestic", "extra"],
      ["nothing"],
      ["reopen"],
      ["reopen", "--matching"],
      ["reopen", "--matching", "("],
      ["reopen", "TypeError"],
    ])
      expect(typeof parseCommand(bad)).toBe("string");
  });
});
