// The §4 measurement runner (D06 T02 §4): passes the vault's Meta keys to the live test
// (test/invoice/doctored-live.test.ts) by environment, never argv, and never prints them. The
// test keeps its rows in task meta; this runner reads the JSON report and writes
// eval/sets/payment-docs/measurement.json. Inside the section's stated US$1.00 allowance.
//
//   node scripts/fixtures/measure-doctored.ts --confirm-credit
import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_URL, readSecretsFromVault } from "../meta-smoke.ts";

if (!process.argv.includes("--confirm-credit")) {
  console.error("measure-doctored: --confirm-credit is required (the run spends Meta credit)");
  process.exit(2);
}
const root = join(import.meta.dirname, "../..");
const report = join(root, "eval/sets/payment-docs/.report.json");
const secrets = await readSecretsFromVault();
const code = await new Promise<number>((resolve) => {
  const child = spawn(
    "pnpm",
    ["exec", "vitest", "run", "test/invoice/doctored-live.test.ts", "--reporter=json", `--outputFile=${report}`],
    {
      cwd: root,
      env: {
        ...process.env,
        DOCTORED_LIVE: "1",
        DOCTORED_META_API_KEY: secrets.meta,
        DOCTORED_CF_AIG_TOKEN: secrets.run,
        DOCTORED_GATEWAY_URL: GATEWAY_URL,
      },
      stdio: "inherit",
    },
  );
  child.on("close", (c) => resolve(c ?? 1));
});
if (code === 0) {
  const parsed = JSON.parse(readFileSync(report, "utf-8")) as {
    testResults?: { assertionResults?: { meta?: Record<string, unknown> }[] }[];
  };
  for (const file of parsed.testResults ?? [])
    for (const test of file.assertionResults ?? []) {
      const kept = test.meta?.["doctored-measurement"] as { rows?: unknown } | undefined;
      if (kept?.rows) {
        const tmp = join(root, "eval/sets/payment-docs/.measurement.json.tmp");
        writeFileSync(tmp, `${JSON.stringify(kept.rows, null, 2)}\n`);
        renameSync(tmp, join(root, "eval/sets/payment-docs/measurement.json"));
        console.log("measure-doctored: measurement.json written");
      }
    }
}
process.exit(code);
