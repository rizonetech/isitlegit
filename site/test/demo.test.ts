import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { page } from "./lib/page.ts";

const html = page("/demo");
describe("public synthetic judge walkthrough", () => {
  it("labels mock results and requires no form or script", () => {
    assert.match(html, /Synthetic demo: illustrative reports/);
    assert.match(html, /No account, access code or API key/);
    assert.match(html, /No models run on this page/);
    assert.doesNotMatch(html, /<form\b|<input\b|<script\b/i);
    assert.equal((html.match(/data-demo-case=/g) ?? []).length, 3);
    assert.equal((html.match(/<details\b/g) ?? []).length, 3);
    assert.equal((html.match(/<summary\b/g) ?? []).length, 3);
  });
  it("resolves every example evidence citation to a unique target", () => {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
    const cites = [...html.matchAll(/href="#((?:invoice|phishing|ordinary)-E\d+)"/g)];
    assert.equal(cites.length, 3);
    for (const cite of cites) assert.ok(ids.includes(cite[1]), cite[1]);
    for (const id of ["invoice", "phishing", "ordinary"]) {
      assert.ok(ids.includes(id));
      assert.match(html, new RegExp(`id="${id}-E1"`));
    }
    assert.equal((html.match(/Illustrative verdict:/g) ?? []).length, 3);
    assert.equal((html.match(/Recommended action/g) ?? []).length, 3);
  });
  it("documents a public credential-free path in README and judge guide", () => {
    for (const file of ["../../README.md", "../../docs/judge-getting-started.md"]) {
      const doc = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(doc, /https:\/\/isitlegit\.co\.za\/demo\//);
      assert.doesNotMatch(doc, /code provided in our submission|private submission contact/);
      assert.match(doc, /illustrative/i);
    }
  });
});
