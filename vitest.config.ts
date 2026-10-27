import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The voice decoder's Web Worker stub, as wrangler.jsonc's `alias` names it (relative to the project root).
export const VOICE_ALIASES = { "@eshaz/web-worker": "./src/voice/no-web-worker.ts" };
// A fixed test SHA, not the "dev" default in wrangler.jsonc, so a route that drops or hard-codes the commit fails.
const TEST_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
// The schema, read here in Node and applied inside workerd before each test file (test/apply-migrations.ts).
const TEST_MIGRATIONS = await readD1Migrations("src/db/migrations");

export default defineConfig({
  test: {
    projects: [
      {
        // The Worker's own tests, inside workerd.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Local simulations only: the AI binding has none and would open a remote session, which needs a Cloudflare
            // login CI does not have; no test calls env.AI.
            remoteBindings: false,
            // A test-only smoke token; the deployed one is long-lived in the vault (scripts/smoke.ts).
            miniflare: { bindings: { COMMIT_SHA: TEST_COMMIT_SHA, SMOKE_TOKEN: "test-smoke-token", TEST_MIGRATIONS } },
          }),
        ],
        // WORKAROUND: the test plugin does not read wrangler.jsonc's `alias`, so the voice decoder's Web Worker stub is
        // named here too (src/voice/no-web-worker.ts; test/node/opus-wasm.test.ts checks the two agree).
        resolve: {
          alias: Object.fromEntries(
            Object.entries(VOICE_ALIASES).map(([name, stub]) => [name, fileURLToPath(new URL(stub, import.meta.url))]),
          ),
        },
        test: {
          name: "worker",
          include: ["test/**/*.test.ts"],
          exclude: ["test/node/**"],
          setupFiles: ["./test/apply-migrations.ts"],
        },
      },
      {
        // Build scripts and source checks, which read the repository, in Node.
        test: { name: "node", include: ["test/node/**/*.test.{ts,tsx}"], environment: "node" },
      },
    ],
  },
});
