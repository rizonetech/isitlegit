// node --test: fixtures take every Fynbos Freight fact from the brand kit, and a wrong path fails loudly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fillBrand } from "./beats.ts";

const brand = { name: "Fynbos Freight", mailboxes: { accounts: "accounts@fynbosfreight.demo.isitlegit.co.za" }, bank: { fictional: true } };

test("fills nested paths from the kit", () => {
  assert.equal(fillBrand("To: {{name}} <{{mailboxes.accounts}}>", brand), "To: Fynbos Freight <accounts@fynbosfreight.demo.isitlegit.co.za>");
});

test("refuses a path the kit lacks or does not hold as text", () => {
  assert.throws(() => fillBrand("{{missing.path}}", brand), /does not hold as text/);
  assert.throws(() => fillBrand("{{bank.fictional}}", brand), /does not hold as text/);
});

test("the real kit fills every fixture with no placeholder left", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("./fixtures/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".eml"));
  assert.ok(files.length >= 6);
  for (const file of files) {
    const out = fillBrand(readFileSync(new URL(file, dir), "utf8"));
    assert.doesNotMatch(out, /\{\{/, `${file} left a placeholder`);
    assert.match(out, /accounts@fynbosfreight\.demo\.isitlegit\.co\.za/, `${file} missing accounts mailbox`);
  }
});
