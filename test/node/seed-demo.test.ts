// The demo seed's script (D07 T07 §1, scripts/seed-demo.ts): the documented sequence from an empty local directory,
// its refusals, and the data and code it reads staying fictional. The Worker-side behaviour (idempotency, resuming,
// the protected-target guard) is test/demo/seed.test.ts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const dir = mkdtempSync(join(tmpdir(), "seed-demo-test-"));
// The script's scratch config goes to TMPDIR; a private one proves it is removed after every run.
const tmp = mkdtempSync(join(tmpdir(), "seed-demo-tmp-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});
const leftovers = () => readdirSync(tmp).filter((name) => name.startsWith("seed-demo-"));
const runIn = (state: string, ...args: string[]) => {
  const out = spawnSync("node", ["scripts/seed-demo.ts", "--state-dir", state, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, BANK_KEY: "", BANK_MATCH_KEY: "", TMPDIR: tmp },
  });
  return { code: out.status, text: `${out.stdout}${out.stderr}` };
};
const run = (...args: string[]) => runIn(dir, ...args);

describe("scripts/seed-demo.ts", () => {
  it("rehearses from an empty directory: refuses without Fynbos Freight, bootstraps, seeds, reseeds, checks", () => {
    const missing = run();
    expect(missing.code).toBe(1);
    expect(missing.text).toMatch(/Fynbos Freight is not in this database/);
    expect(run("--check").code).toBe(1);
    expect(run("--local-bootstrap").code).toBe(0);
    const first = run();
    expect(first.code).toBe(0);
    expect(first.text.match(/organisation created/g)).toHaveLength(4);
    const second = run();
    expect(second.code).toBe(0);
    expect(second.text).not.toMatch(/created/);
    const check = run("--check");
    expect(check.code).toBe(0);
    for (const slug of [
      "fynbos-freight",
      "hadeda-couriers",
      "kestrel-packaging",
      "marula-office-supplies",
      "quagga-tyres",
    ])
      expect(check.text).toContain(`${slug}: protected: true`);
  }, 300_000);

  it("keeps --check read only: it makes no database, runs no migration, and refuses to mix with --local-bootstrap", () => {
    const fresh = join(dir, "never-made");
    const check = runIn(fresh, "--check");
    expect(check.code).toBe(1);
    expect(check.text).toMatch(/no local database in .*never-made; --check reads only/);
    expect(existsSync(fresh)).toBe(false);
    const mixed = runIn(fresh, "--check", "--local-bootstrap");
    expect(mixed.code).toBe(1);
    expect(mixed.text).toMatch(/--check reads only; it cannot be combined with --local-bootstrap/);
    expect(existsSync(fresh)).toBe(false);
    // A database directory without a schema: the check says so and applies no migration.
    const empty = join(dir, "empty-schema");
    mkdirSync(join(empty, "v3", "d1"), { recursive: true });
    const unread = runIn(empty, "--check");
    expect(unread.code).toBe(1);
    expect(unread.text).toMatch(/the database could not be read/);
    expect(unread.text).not.toMatch(/Migrations to be applied|Executing/);
  }, 300_000);

  it("names the operation, the directory and the cause when the local database cannot be prepared, and leaves no scratch files", () => {
    const file = join(dir, "a-file");
    writeFileSync(file, "not a directory");
    const out = runIn(file);
    expect(out.code).toBe(1);
    expect(out.text).toMatch(/could not prepare the local database in .*a-file: /);
    expect(out.text).not.toMatch(/BANK_KEY|BANK_MATCH_KEY|AAECAwQF/);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it("refuses --remote without the bank keys, and --local-bootstrap with --remote, before touching anything", () => {
    const noKeys = run("--remote");
    expect(noKeys.code).toBe(1);
    expect(noKeys.text).toMatch(/BANK_KEY and BANK_MATCH_KEY/);
    const both = run("--remote", "--local-bootstrap");
    expect(both.code).toBe(1);
    expect(both.text).toMatch(/local database only/);
  }, 60_000);
});

describe("the demo businesses stay fictional", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "data/demo/businesses/businesses.json"), "utf8"));
  // Real South African banks and well-known suppliers: none may appear in the data, the seed or its script.
  const REAL =
    /\b(absa|fnb|first national bank|standard bank|nedbank|capitec|discovery bank|investec|tymebank|african bank|makro|builders warehouse|takealot)\b/i;

  it("uses the fictional bank, the 2099 registry year, postcode 0000, the 0000 account range and the demo suffix", () => {
    expect(data.fictional).toBe(true);
    expect(data.businesses).toHaveLength(4);
    expect(data.bank).toEqual({ name: "Protea Bank", branch_code: "000000" });
    for (const b of data.businesses) {
      expect(b.registration_number).toMatch(/^2099\//);
      expect(b.address.postcode).toBe("0000");
      expect(b.account_number).toMatch(/^0000\d{6}$/);
      expect(b.domain).toMatch(/^[a-z]+\.demo\.isitlegit\.co\.za$/);
      expect(b.accounts).toBe(`accounts@${b.domain}`);
      const logo = readFileSync(join(ROOT, "data/demo/businesses", b.logo), "utf8");
      expect(logo).not.toMatch(/<script|\son\w+=|href=|<!DOCTYPE|<!ENTITY/i);
    }
  });

  it("names no real bank or supplier in the data, the seed or its script", () => {
    for (const file of [
      "data/demo/businesses/businesses.json",
      "src/demo/seed.ts",
      "src/demo/businesses.ts",
      "scripts/seed-demo.ts",
    ])
      expect(readFileSync(join(ROOT, file), "utf8"), file).not.toMatch(REAL);
  });
});
