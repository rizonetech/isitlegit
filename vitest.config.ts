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
    // In CI, a line as each test file starts and ends and a heartbeat naming the files still running, so a shard that
    // stalls names its file (scripts/lib/vitest-file-reporter.ts). Local runs keep the default output.
    reporters: process.env.CI ? ["default", "./scripts/lib/vitest-file-reporter.ts"] : ["default"],
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
            // VOICE_BENCH turns on the voice decoder's timings (test/voice/bench.test.ts), set by scripts/voice-bench.ts.
            miniflare: {
              bindings: {
                COMMIT_SHA: TEST_COMMIT_SHA,
                SMOKE_TOKEN: "test-smoke-token",
                TEST_MIGRATIONS,
                VOICE_BENCH: process.env.VOICE_BENCH ?? "",
                // BANK_BENCH turns on the bank-matching timings (test/trust/bank-bench.test.ts, D05 T01 §2).
                BANK_BENCH: process.env.BANK_BENCH ?? "",
                // IDENTITY_BENCH turns on the identity page's timings (test/web/identity-page.test.ts, D05 T01 §3).
                IDENTITY_BENCH: process.env.IDENTITY_BENCH ?? "",
                // A test-only Better Auth secret and the app's origin as the tests reach it (D07 T02 §1).
                BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789abcdef",
                APP_URL: "http://localhost",
                // The reply's test settings (D01 T02 §3): an https report origin, a test link secret and a test SMTP2GO
                // key; SMTP2GO itself is stubbed in every test that sends.
                PUBLIC_ORIGIN: "https://isitlegit.test",
                REPORT_LINK_SECRET: "test-report-link-secret-0123456789abcdef",
                // Test-only bank keys (D05 T01 §2): 32 fixed bytes each as base64, never the vault's.
                BANK_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
                BANK_MATCH_KEY: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=",
                SMTP2GO_API_KEY: `api-${"t".repeat(32)}`,
              },
            },
          }),
        ],
        // Outlook .msg fixtures (D01 T01 §6) are binary, imported with `?inline` like the audio ones; Vite does not know
        // the extension as an asset until told.
        assetsInclude: ["**/*.msg"],
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
          // The Worker tests make real D1, R2 and Better Auth calls in sequence (twenty claims, a sign-in per step), so
          // the 5-second default fails them on a loaded machine (a full run also starts Node processes under a 128 MiB
          // heap, test/node/forward-memory.test.ts), not because anything is wrong.
          testTimeout: 15_000,
        },
      },
      {
        // Build scripts and source checks, which read the repository, in Node.
        // 15 seconds as for the Worker tests: the memory tests start Node processes that load the machine meanwhile.
        test: {
          name: "node",
          include: ["test/node/**/*.test.{ts,tsx}"],
          // The accessibility run is its own gate, `pnpm test:a11y` (D07 T01 §10), so a full run does not repeat it.
          exclude: ["test/node/a11y.test.tsx"],
          environment: "node",
          testTimeout: 15_000,
        },
      },
      // `pnpm test:a11y`: axe-core over the component gallery in Chromium (D07 T01 §10), only when asked for by name.
      ...(process.env.A11Y
        ? [{ test: { name: "a11y", include: ["test/node/a11y.test.tsx"], environment: "node", testTimeout: 120_000 } }]
        : []),
    ],
  },
});
