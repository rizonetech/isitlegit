// The site's deploy (D07 T06 §6): the gates run in order, a failing gate stops the deploy before Wrangler, Wrangler gets
// the site's own config and --dry-run only when asked, and its failure is the deploy's failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deploy, type Step, steps } from "../scripts/deploy.ts";

const ROOT = join(import.meta.dirname, "../..");
const quiet = <T>(work: () => T): T => {
  const log = console.log;
  const error = console.error;
  console.log = console.error = () => {};
  try {
    return work();
  } finally {
    console.log = log;
    console.error = error;
  }
};
const runner = (failing = "", code = 1) => {
  const ran: Step[] = [];
  return { ran, run: (step: Step) => (ran.push(step), step.name === failing ? code : 0) };
};

describe("deploy", () => {
  it("runs build, check, test, claims and links, then Wrangler against the site's own config", () => {
    const r = runner();
    assert.equal(quiet(() => deploy(ROOT, false, r.run)), 0);
    assert.deepEqual(r.ran.map((s) => s.name), ["build", "check", "test", "claims", "links", "wrangler"]);
    const wrangler = r.ran.at(-1) as Step;
    assert.deepEqual(wrangler.args, ["exec", "wrangler", "deploy", "--config", "site/wrangler.jsonc"]);
    assert.equal(wrangler.cwd, ROOT);
  });

  it("adds --dry-run to Wrangler only when asked", () => {
    assert.ok(steps(ROOT, true).wrangler.args.includes("--dry-run"));
    assert.ok(!steps(ROOT, false).wrangler.args.includes("--dry-run"));
  });

  for (const gate of ["build", "check", "test", "claims", "links"]) {
    it(`refuses when ${gate} fails and never reaches Wrangler`, () => {
      const r = runner(gate, 2);
      assert.equal(quiet(() => deploy(ROOT, false, r.run)), 1);
      assert.ok(!r.ran.some((s) => s.name === "wrangler"));
      assert.equal(r.ran.at(-1)?.name, gate);
    });
  }

  it("fails when Wrangler fails, never reporting success", () => {
    const r = runner("wrangler", 7);
    assert.equal(quiet(() => deploy(ROOT, false, r.run)), 1);
  });

  it("names a config that serves site/dist as assets and does not touch the app's routes", () => {
    const config = readFileSync(join(ROOT, "site/wrangler.jsonc"), "utf8");
    assert.match(config, /"name": "isitlegit-site"/);
    assert.match(config, /"directory": "\.\/dist"/);
    assert.match(config, /"pattern": "isitlegit\.co\.za"/);
    assert.doesNotMatch(config, /app\.isitlegit\.co\.za"/);
  });
});
