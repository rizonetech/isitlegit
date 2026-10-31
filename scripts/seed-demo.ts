// Seeds the fictional demo businesses (D07 T07 §1; src/demo/seed.ts) into a local database for rehearsal, or into the
// production bindings with --remote (the coordinator's run, from gated main; the site lane never runs it).
//
//   node scripts/seed-demo.ts --local-bootstrap   local only: makes the Fynbos Freight organisation at its fixed id
//   node scripts/seed-demo.ts                     seeds the local database (migrations applied first)
//   node scripts/seed-demo.ts --check             read-only: each business and its parts, exit 1 on anything missing
//   node scripts/seed-demo.ts --remote [--check]  production: BANK_KEY and BANK_MATCH_KEY from the environment
//
// --state-dir <path> chooses the local database (default build/seed-demo-state). The bank keys are never arguments.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

register("./lib/ts-resolve.mjs", import.meta.url);

// The slice of D1 the bootstrap uses; the Worker code gets the real binding.
type Db = {
  batch(statements: unknown[]): Promise<unknown>;
  prepare(sql: string): { bind(...values: unknown[]): unknown };
};

const root = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, "data/demo", path), "utf8");
// The repository's test-only bank keys (vitest.config.ts): public, used only to rehearse on a local database.
const REHEARSAL_KEYS = {
  BANK_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  BANK_MATCH_KEY: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=",
};

export async function main(argv: string[], environ: Record<string, string | undefined> = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean" },
      remote: { type: "boolean" },
      "local-bootstrap": { type: "boolean" },
      "state-dir": { type: "string" },
    },
  });
  const say = (line: string) => console.log(line);
  const remote = values.remote === true;
  if (remote && values["local-bootstrap"]) return fail("--local-bootstrap is for a local database only");
  const keys = remote
    ? { BANK_KEY: environ.BANK_KEY, BANK_MATCH_KEY: environ.BANK_MATCH_KEY }
    : {
        BANK_KEY: environ.BANK_KEY || REHEARSAL_KEYS.BANK_KEY,
        BANK_MATCH_KEY: environ.BANK_MATCH_KEY || REHEARSAL_KEYS.BANK_MATCH_KEY,
      };
  if (!keys.BANK_KEY || !keys.BANK_MATCH_KEY)
    return fail(
      '--remote needs BANK_KEY and BANK_MATCH_KEY in the environment (vault item "IsItLegit bank key", never an argument)',
    );

  // WORKAROUND: the scripts project (test/node/tsconfig.json) has no Worker types (D1Database, R2Bucket), so a static or
  // literal import of src/demo would fail its type check; the specifiers are variables so the compiler does not follow
  // them. The Worker project and test/demo/seed.test.ts type-check and test the same modules.
  const businessesPath = "../src/demo/businesses.ts";
  const seedPath = "../src/demo/seed.ts";
  const { demoBusinesses } = await import(businessesPath);
  const { checkDemo, seedDemo, FYNBOS_ORG_ID } = await import(seedPath);
  const brand = JSON.parse(read("fynbos-freight/brand.json"));
  const others = JSON.parse(read("businesses/businesses.json"));
  const byPath: Record<string, string> = {};
  for (const b of others.businesses) byPath[b.logo] = read(`businesses/${b.logo}`);
  const businesses = demoBusinesses(brand, others, { fynbos: read("fynbos-freight/logo/mark.svg"), byPath });

  const stateDir = values["state-dir"] ?? join(root, "build/seed-demo-state");
  const { getPlatformProxy, unstable_readConfig } = await import("wrangler");
  const real = unstable_readConfig({ config: join(root, "wrangler.jsonc") });
  const scratch = mkdtempSync(join(tmpdir(), "seed-demo-"));
  const configPath = join(scratch, "wrangler.jsonc");
  writeFileSync(
    configPath,
    JSON.stringify({
      name: "seed-demo",
      compatibility_date: real.compatibility_date,
      compatibility_flags: real.compatibility_flags,
      d1_databases: real.d1_databases.map((d: { binding: string; database_name?: string; database_id?: string }) => ({
        binding: d.binding,
        database_name: d.database_name,
        database_id: d.database_id,
        remote: remote,
      })),
      r2_buckets: real.r2_buckets.map((r: { binding: string; bucket_name?: string }) => ({
        binding: r.binding,
        bucket_name: r.bucket_name,
        remote: remote,
      })),
    }),
  );
  if (!remote) {
    mkdirSync(stateDir, { recursive: true });
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--persist-to",
        stateDir,
        "--config",
        join(root, "wrangler.jsonc"),
      ],
      { cwd: root, stdio: "ignore" },
    );
  }
  const proxy = await getPlatformProxy<{ DB: Db; ARTEFACTS: unknown }>({
    configPath,
    persist: remote ? false : { path: join(stateDir, "v3") },
    remoteBindings: remote,
  });
  try {
    const env = {
      DB: proxy.env.DB,
      ARTEFACTS: proxy.env.ARTEFACTS,
      BANK_KEY: keys.BANK_KEY,
      BANK_MATCH_KEY: keys.BANK_MATCH_KEY,
    };
    if (values["local-bootstrap"]) {
      const at = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('local-demo-owner', 'Demo', 'demo@rizonetech.com', 1, ?, ?)`,
        ).bind(at, at),
        env.DB.prepare(
          `INSERT OR IGNORE INTO "organization" (id, name, slug, "createdAt") VALUES (?, 'Fynbos Freight', 'fynbos-freight', ?)`,
        ).bind(FYNBOS_ORG_ID, at),
        env.DB.prepare(
          `INSERT OR IGNORE INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('local-demo-member', ?, 'local-demo-owner', 'owner', ?)`,
        ).bind(FYNBOS_ORG_ID, at),
      ]);
      say("seed-demo: local Fynbos Freight organisation ready");
      return 0;
    }
    if (values.check) {
      let bad = 0;
      for (const c of await checkDemo(env, businesses)) {
        say(`${c.slug}: protected: ${c.protected}${c.problems.length ? ` | ${c.problems.join("; ")}` : ""}`);
        bad += c.problems.length;
      }
      return bad === 0 ? 0 : 1;
    }
    for (const r of await seedDemo(env, businesses))
      say(
        `${r.slug}: ${Object.entries(r.steps)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}`,
      );
    return 0;
  } catch (error) {
    if (["SeedFailed", "FynbosMissing", "ProtectedTarget"].includes((error as Error).name))
      return fail((error as Error).message);
    throw error;
  } finally {
    await proxy.dispose();
  }
}

function fail(message: string): number {
  console.error(`seed-demo: ${message}`);
  return 1;
}

if (import.meta.filename === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`seed-demo: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
