// The internal-link gate (D07 T06 §6): refuses a route nothing serves, accepts built pages, files, redirects and exactly
// the Worker-owned prefixes, and passes the real build.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { brokenLinks } from "../scripts/check-links.ts";
import { DIST } from "./lib/page.ts";

const made: string[] = [];
function site(links: string[], redirects = "") {
  const dir = mkdtempSync(join(tmpdir(), "check-links-"));
  made.push(dir);
  mkdirSync(join(dir, "about"));
  writeFileSync(join(dir, "about", "index.html"), "<p>about</p>");
  mkdirSync(join(dir, "static"));
  writeFileSync(join(dir, "static", "app.css"), "a{}");
  writeFileSync(join(dir, "index.html"), `<body>${links.map((l) => `<a href="${l}">x</a>`).join("")}</body>`);
  if (redirects) writeFileSync(join(dir, "_redirects"), redirects);
  return dir;
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("check-links", () => {
  it("accepts built pages, files, anchors, external links, a redirect and the Worker-owned prefixes", () => {
    const dir = site(["/about", "/about/", "/about#x", "/static/app.css", "https://example.com/x", "#top", "/eval", "/v/fynbos-freight", "/s/x", "/b/x.png"], "/eval https://app.isitlegit.co.za/eval 302\n");
    assert.deepEqual(brokenLinks(dir), []);
  });

  it("refuses a route that does not exist and exempts nothing else", () => {
    const dir = site(["/nope", "/w/x", "/v", "/eval"]);
    assert.deepEqual(brokenLinks(dir).map((b) => b.split(": ")[1]), ["/nope", "/w/x", "/v", "/eval"]);
  });

  it("passes the real build", () => {
    assert.deepEqual(brokenLinks(DIST), []);
  });
});
