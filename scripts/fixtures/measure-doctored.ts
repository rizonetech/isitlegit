// The §4 measurement runner (D06 T02 §4): passes the vault's Meta keys to the live test
// (test/node/doctored-live.test.ts) by environment, never argv, and never prints them. Inside the
// section's stated US$1.00 cap (lane outbox, 2026-11-02), shared with the image edits.
//
//   node scripts/fixtures/measure-doctored.ts --confirm-credit
import { spawn } from "node:child_process";
import { join } from "node:path";
import { GATEWAY_URL, readSecretsFromVault } from "../meta-smoke.ts";

if (!process.argv.includes("--confirm-credit")) {
  console.error("measure-doctored: --confirm-credit is required (the run spends Meta credit)");
  process.exit(2);
}
const secrets = await readSecretsFromVault();
const code = await new Promise<number>((resolve) => {
  const child = spawn("pnpm", ["exec", "vitest", "run", "--project", "node", "test/node/doctored-live.test.ts"], {
    cwd: join(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      DOCTORED_LIVE: "1",
      DOCTORED_META_API_KEY: secrets.meta,
      DOCTORED_CF_AIG_TOKEN: secrets.run,
      DOCTORED_GATEWAY_URL: GATEWAY_URL,
    },
    stdio: "inherit",
  });
  child.on("close", (c) => resolve(c ?? 1));
});
process.exit(code);
