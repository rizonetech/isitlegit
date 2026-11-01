// The redirect fixtures host (D02 T07 §2): sets the path prefix the Worker serves them under and proves the live host
// answers. The Worker itself serves `fixtures.isitlegit.co.za` (src/fixtures/redirects.ts); its route (a custom domain,
// which makes the DNS record) ships with the Worker's own deploy from main after the gates, as every deploy does.
//
//   node scripts/deploy-fixtures.ts --verify    prove the host answers: noindex, the chain, the prefix required
//   node scripts/deploy-fixtures.ts --set       put the prefix on the Worker as the secret FIXTURES_PREFIX, then verify
//   node scripts/deploy-fixtures.ts --create    make a new prefix in the vault, then --set
//
// The prefix is read from the vault item "IsItLegit fixtures prefix" (field "password") through the service account, or
// from the environment variable FIXTURES_PREFIX; it reaches `wrangler secret put` on stdin and is never printed or put
// in an argument. Only booleans and counts are reported.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { verifyFixtures } from "../src/fixtures/verify.ts";

const ITEM = "IsItLegit fixtures prefix";
const VAULT = "Conclave";

function token(): string {
  const file = join(homedir(), ".conclave/secrets/op-service-account-token.env");
  const line = readFileSync(file, "utf-8")
    .split("\n")
    .find((l) => l.startsWith("OP_SERVICE_ACCOUNT_TOKEN="));
  if (!line) throw new Error("no service account token file");
  return line.slice("OP_SERVICE_ACCOUNT_TOKEN=".length).trim();
}
const opEnv = () => ({ ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token() });

function readPrefix(): string | null {
  if (process.env.FIXTURES_PREFIX) return process.env.FIXTURES_PREFIX;
  try {
    return execFileSync("/usr/bin/op", ["read", `op://${VAULT}/${ITEM}/password`], {
      env: opEnv(),
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

function createPrefix(): void {
  const value = randomBytes(18)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "x");
  // The template goes in on stdin, so the value is never an argument.
  const template = JSON.stringify({
    title: ITEM,
    category: "PASSWORD",
    fields: [{ id: "password", type: "CONCEALED", purpose: "PASSWORD", value }],
  });
  const made = spawnSync("/usr/bin/op", ["item", "create", "--vault", VAULT, "-"], {
    env: opEnv(),
    input: template,
    encoding: "utf-8",
  });
  if (made.status !== 0) throw new Error("the vault did not take the prefix");
}

function setSecret(prefix: string): void {
  const put = spawnSync("pnpm", ["exec", "wrangler", "secret", "put", "FIXTURES_PREFIX"], {
    input: prefix,
    encoding: "utf-8",
  });
  if (put.status !== 0) throw new Error("wrangler secret put failed");
}

async function main(argv: string[]) {
  const mode = argv.includes("--create") ? "create" : argv.includes("--set") ? "set" : "verify";
  if (mode === "create") {
    if (readPrefix()) throw new Error("a prefix already exists; --create never replaces one");
    createPrefix();
  }
  const prefix = readPrefix();
  if (!prefix || prefix.length < 16)
    throw new Error("no prefix of at least 16 characters (vault item or FIXTURES_PREFIX)");
  if (mode !== "verify") setSecret(prefix);
  const results = await verifyFixtures(prefix);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

if (import.meta.filename === process.argv[1])
  main(process.argv.slice(2)).catch((error) => {
    console.error(`deploy-fixtures: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
