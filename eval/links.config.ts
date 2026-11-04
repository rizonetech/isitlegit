import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { loadCorpus } from "./links-measure.ts";
export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      miniflare: {
        compatibilityDate: "2026-10-26",
        compatibilityFlags: ["nodejs_compat"],
        bindings: { LINK_CORPUS: JSON.stringify(loadCorpus("eval/components/links")), LINK_REPEATS: 5 },
      },
    }),
  ],
  test: {
    reporters: ["default", "./eval/links-reporter.ts"],
    include: ["eval/links-worker.test.ts", "test/checks/link-quality.test.ts"],
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
