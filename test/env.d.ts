// Test-only bindings vitest.config.ts adds beside the Worker's own: the D1 schema, applied by test/apply-migrations.ts,
// and test values of two of the Worker's secrets.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    // The reply's test secrets (D01 T02 §3), set in vitest.config.ts; the Worker's own are secrets (src/types/secrets.d.ts).
    REPORT_LINK_SECRET: string;
    SMTP2GO_API_KEY: string;
    // The bank registry's test keys (D05 T01 §2), set in vitest.config.ts.
    BANK_KEY: string;
    BANK_MATCH_KEY: string;
  }
}
