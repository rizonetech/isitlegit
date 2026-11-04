import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The voice decoder's Web Worker stub, as wrangler.jsonc's `alias` names it (relative to the project root).
export const VOICE_ALIASES = { "@eshaz/web-worker": "./src/voice/no-web-worker.ts" };
// A fixed test SHA, not the "dev" default in wrangler.jsonc, so a route that drops or hard-codes the commit fails.
const TEST_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";
// The schema, read here in Node and applied inside workerd before each test file (test/apply-migrations.ts).
const TEST_MIGRATIONS = await readD1Migrations("src/db/migrations");

// The Node tests that drive a real Chromium: every file that imports Playwright, the shared browser helper
// (test/node/browser.ts) or a script that launches one (Glimmer's renderer and page source, the reference logos), and every file that starts
// Chrome itself at MOCKUP_CHROMIUM. They
// run as their own project, one file at a time (`--no-file-parallelism` in CI's browser-tests job): side by side on a
// two-CPU runner their browsers starved each other and their own waits timed out (2026-11-01: 19 red runs in an hour
// across every lane, each test green on its own). Found by what a file imports, so a new browser test joins on its own;
// test/node/vitest-projects.test.ts checks the split.
const BROWSER_IMPORT =
  /from\s+["'](?:playwright-core|playwright|\.\/browser(?:\.ts)?|[^"']*scripts\/glimmer\/(?:render|source-pages)\.ts|[^"']*scripts\/load-reference-logos\.ts)["']/;
// A test that starts Chrome itself, at the path the mockup tools use (fonts.test.ts and theme.test.ts).
const BROWSER_LAUNCH = /\bMOCKUP_CHROMIUM\b/;
const A11Y_TEST = "test/node/a11y.test.tsx";
export function browserTestFiles(root = fileURLToPath(new URL(".", import.meta.url))): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.test\.tsx?$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        if (BROWSER_IMPORT.test(source) || BROWSER_LAUNCH.test(source)) found.push(path);
      }
    }
  };
  walk(join(root, "test/node"));
  return found
    .map((path) => relative(root, path).split("\\").join("/"))
    .filter((path) => path !== A11Y_TEST)
    .sort();
}
const BROWSER_TESTS = browserTestFiles();

export default defineConfig({
  test: {
    // In CI, a line as each test file starts and ends and a heartbeat naming the files still running, so a shard that
    // stalls names its file (scripts/lib/vitest-file-reporter.ts). Local runs keep the default output.
    reporters: process.env.CI ? ["default", "./scripts/lib/vitest-file-reporter.ts"] : ["default"],
    projects: [
      {
        // The Worker's own tests, inside workerd.
        plugins: [
          // Fixture pages (D04 T02 §1) are imported as text, as wrangler.jsonc's Text rule serves
          // them in the real build; Vite would otherwise parse the HTML as JavaScript.
          {
            name: "fixture-html-text",
            enforce: "pre" as const,
            transform(code: string, id: string) {
              if (id.endsWith(".html")) return { code: `export default ${JSON.stringify(code)}` };
            },
          },
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
                // Existing transport fixtures exercise the enabled path; disable tests set false explicitly.
                LOUPE_ENABLED: "true",
                // Synthetic monitor experiments exercise the actual Workflow binding, never a live population.
                EVAL_ORG_ID: "monitor-experiment-fixture",
                SMOKE_TOKEN: "test-smoke-token",
                TEST_MIGRATIONS,
                VOICE_BENCH: process.env.VOICE_BENCH ?? "",
                // The live walkthrough (D04 T02 §4), set only by scripts/walkthrough-live.ts: off (and empty) otherwise.
                WALK_LIVE: process.env.WALK_LIVE ?? "",
                WALK_META_API_KEY: process.env.WALK_META_API_KEY ?? "",
                WALK_CF_AIG_TOKEN: process.env.WALK_CF_AIG_TOKEN ?? "",
                WALK_GATEWAY_URL: process.env.WALK_GATEWAY_URL ?? "",
                WALK_ALLOWANCE_USD: process.env.WALK_ALLOWANCE_USD ?? "0",
                // The live verdict agent (D04 T01 §4), set only by scripts/agent-live.ts: off otherwise.
                AGENT_LIVE: process.env.AGENT_LIVE ?? "",
                AGENT_META_API_KEY: process.env.AGENT_META_API_KEY ?? "",
                AGENT_CF_AIG_TOKEN: process.env.AGENT_CF_AIG_TOKEN ?? "",
                AGENT_GATEWAY_URL: process.env.AGENT_GATEWAY_URL ?? "",
                AGENT_ALLOWANCE_USD: process.env.AGENT_ALLOWANCE_USD ?? "0",
                // The live vision reading (D03 T02 §3), set only by scripts/vision-live.ts: off otherwise.
                VISION_LIVE: process.env.VISION_LIVE ?? "",
                VISION_META_API_KEY: process.env.VISION_META_API_KEY ?? "",
                VISION_CF_AIG_TOKEN: process.env.VISION_CF_AIG_TOKEN ?? "",
                VISION_GATEWAY_URL: process.env.VISION_GATEWAY_URL ?? "",
                VISION_ALLOWANCE_USD: process.env.VISION_ALLOWANCE_USD ?? "0",
                // The live invoice extraction (D06 T01 §1), set only by scripts/invoice-live.ts: off otherwise.
                INVOICE_LIVE: process.env.INVOICE_LIVE ?? "",
                INVOICE_META_API_KEY: process.env.INVOICE_META_API_KEY ?? "",
                INVOICE_CF_AIG_TOKEN: process.env.INVOICE_CF_AIG_TOKEN ?? "",
                INVOICE_GATEWAY_URL: process.env.INVOICE_GATEWAY_URL ?? "",
                INVOICE_ALLOWANCE_USD: process.env.INVOICE_ALLOWANCE_USD ?? "0",
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
                // Test-only Meta credentials, so a Workflow step that calls a model (D01 T03 §3) reaches the gateway
                // URL, which every such test stubs; no test reaches Meta.
                META_API_KEY: "LLM_test_key_workflow_0123456789",
                CF_AIG_TOKEN: "aig-test-token-workflow-0123456789",
              },
            },
          }),
        ],
        // Outlook .msg fixtures (D01 T01 §6) are binary, imported with `?inline` like the audio ones; Vite does not know
        // the extension as an asset until told; so are the encoded PDF stream fixtures (D06 T02 §5, `.bin`).
        assetsInclude: ["**/*.msg", "test/fixtures/pdf-encodings/*.bin"],
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
          // Migrations first; then each test ends the Workflow instances it starts (test/end-workflows.ts).
          setupFiles: ["./test/apply-migrations.ts", "./test/end-workflows.ts"],
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
          // The accessibility run is its own gate, `pnpm test:a11y` (D07 T01 §10), so a full run does not repeat it; the
          // browser tests are the next project's.
          exclude: [A11Y_TEST, ...BROWSER_TESTS],
          environment: "node",
          testTimeout: 15_000,
        },
      },
      {
        // The Node tests that drive Chromium (BROWSER_TESTS above), one file at a time in CI.
        test: {
          name: "browser",
          include: BROWSER_TESTS,
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
