// Dedicated experiment bindings; shared test configuration and production limits remain owned by their lanes.
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url));
export default defineConfig({
  root,
  plugins: [
    {
      name: "fixture-html-text",
      enforce: "pre",
      transform(code, id) {
        if (id.endsWith(".html")) return { code: `export default ${JSON.stringify(code)}` };
      },
    },
    cloudflareTest({
      wrangler: { configPath: `${root}/wrangler.jsonc` },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(`${root}/src/db/migrations`),
          MULTISTEP_LIVE: process.env.MULTISTEP_LIVE ?? "",
          MULTISTEP_URL: process.env.MULTISTEP_URL ?? "",
          MULTISTEP_ORDINAL: process.env.MULTISTEP_ORDINAL ?? "",
          MULTISTEP_RESERVATION: process.env.MULTISTEP_RESERVATION ?? "",
          WALK_META_API_KEY: process.env.WALK_META_API_KEY ?? "",
          WALK_CF_AIG_TOKEN: process.env.WALK_CF_AIG_TOKEN ?? "",
          WALK_GATEWAY_URL: process.env.WALK_GATEWAY_URL ?? "",
          WALK_ALLOWANCE_USD: process.env.WALK_ALLOWANCE_USD ?? "0",
        },
      },
    }),
  ],
  resolve: { alias: { "@eshaz/web-worker": `${root}/src/voice/no-web-worker.ts` } },
  test: {
    name: "multistep",
    include: ["test/eval/frontier-multistep-live.test.ts"],
    setupFiles: ["test/apply-migrations.ts", "test/end-workflows.ts"],
    testTimeout: 120000,
  },
});
