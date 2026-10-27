import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A fixed test SHA, not the "dev" default in wrangler.jsonc, so a route that drops or hard-codes the commit fails.
const TEST_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

export default defineConfig({
  test: {
    projects: [
      {
        // The Worker's own tests, inside workerd.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: { bindings: { COMMIT_SHA: TEST_COMMIT_SHA } },
          }),
        ],
        test: { name: "worker", include: ["test/**/*.test.ts"], exclude: ["test/node/**"] },
      },
      {
        // Build scripts and source checks, which read the repository, in Node.
        test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
