import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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
