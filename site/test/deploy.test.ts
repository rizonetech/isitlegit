// The site's deploy (D07 T06 §6): the gates run in order, a failing gate stops the deploy before Wrangler, Wrangler gets
// the site's own config and --dry-run only when asked, and its failure is the deploy's failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deploy, parse, type Step, steps, USAGE } from "../scripts/deploy.ts";

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
  it("runs the claims gate first, then build, check, test and links, then Wrangler against the site's own config", () => {
    const r = runner();
    assert.equal(quiet(() => deploy(ROOT, false, r.run)), 0);
    assert.deepEqual(r.ran.map((s) => s.name), ["claims", "build", "check", "test", "links", "wrangler"]);
    const wrangler = r.ran.at(-1) as Step;
    assert.deepEqual(wrangler.args, ["exec", "wrangler", "deploy", "--config", "site/wrangler.jsonc"]);
    assert.equal(wrangler.cwd, ROOT);
  });

  it("adds --dry-run to Wrangler only when asked", () => {
    assert.ok(steps(ROOT, true).wrangler.args.includes("--dry-run"));
    assert.ok(!steps(ROOT, false).wrangler.args.includes("--dry-run"));
  });

  for (const gate of ["claims", "build", "check", "test", "links"]) {
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
  it("checks its arguments before any step: help prints usage, an unknown or mistyped option is refused", () => {
    assert.deepEqual(parse([]), { dryRun: false });
    assert.deepEqual(parse(["--dry-run"]), { dryRun: true });
    assert.deepEqual(parse(["--help"]), { help: true });
    for (const bad of [["--dryrun"], ["-h"], ["--dry-run", "now"], ["--dry-run", "--live"]]) {
      const parsed = parse(bad);
      assert.ok("error" in parsed, `${bad.join(" ")} was accepted`);
    }
    // Through the real entry point: help and a typo start no build and no deploy.
    const script = join(ROOT, "site/scripts/deploy.ts");
    const help = spawnSync("node", [script, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, new RegExp(USAGE.slice(0, 20)));
    const typo = spawnSync("node", [script, "--dryrun"], { encoding: "utf8" });
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /unknown argument "--dryrun"/);
    assert.doesNotMatch(typo.stdout, /deploy: (claims|build|wrangler)/);
  });

  describe("the composed chain on a fixture site (real gates, real Wrangler dry run)", () => {
    const made: string[] = [];
    const fixture = (owner: string, stamped: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "deploy-chain-"));
      made.push(dir);
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "index.html"), '<a href="/about">about</a>');
      mkdirSync(join(dir, "dist", "about"));
      writeFileSync(join(dir, "dist", "about", "index.html"), "about");
      writeFileSync(join(dir, "wrangler.jsonc"), JSON.stringify({ name: "fixture-site", compatibility_date: "2026-10-26", assets: { directory: `${dir}/dist` } }));
      writeFileSync(join(dir, "claims.ts"), `export const claims = { "a.one": { text: "t", owners: ["${owner}"] } };\n`);
      writeFileSync(join(dir, "plan.md"), `| [${stamped ? "x" : " "}]    | ${owner}  | A section | none | 1 |\n`);
      const nothing = (name: string): Step => ({ name, command: "node", args: ["-e", "0"], cwd: dir });
      return {
        dir,
        options: {
          claimsArgs: ["--plan", join(dir, "plan.md"), "--claims", join(dir, "claims.ts")],
          linksArgs: [join(dir, "dist")],
          wranglerConfig: join(dir, "wrangler.jsonc"),
          heavy: [nothing("build"), nothing("check"), nothing("test")],
        },
      };
    };
    const real = (ran: string[]) => (step: Step) => (ran.push(step.name), spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "ignore" }).status ?? 1);

    it("passes the dry run end to end when every owner is stamped and every link resolves", () => {
      const f = fixture("D01 T01 §1", true);
      const ran: string[] = [];
      assert.equal(quiet(() => deploy(ROOT, true, real(ran), f.options)), 0);
      assert.deepEqual(ran, ["claims", "build", "check", "test", "links", "wrangler"]);
    });

    it("refuses before the build when an owner is not stamped, and never reaches Wrangler", () => {
      const f = fixture("D01 T01 §1", false);
      const ran: string[] = [];
      assert.equal(quiet(() => deploy(ROOT, true, real(ran), f.options)), 1);
      assert.deepEqual(ran, ["claims"]);
    });

    it("refuses a broken link after the build, before Wrangler", () => {
      const f = fixture("D01 T01 §1", true);
      writeFileSync(join(f.dir, "dist", "index.html"), '<a href="/missing">x</a>');
      const ran: string[] = [];
      assert.equal(quiet(() => deploy(ROOT, true, real(ran), f.options)), 1);
      assert.equal(ran.at(-1), "links");
    });

    it("cleans up", () => {
      for (const dir of made) rmSync(dir, { recursive: true, force: true });
    });
  });
});
