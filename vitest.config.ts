import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// A fixed test SHA, not the "dev" default in wrangler.jsonc, so a route that drops or hard-codes the commit fails.
const TEST_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { COMMIT_SHA: TEST_COMMIT_SHA } },
    }),
  ],
  // Only the Worker's tests: design tools and kit fixtures elsewhere in the tree have their own runners.
  test: { include: ["test/**/*.test.ts"] },
});
