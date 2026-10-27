// Test-only bindings vitest.config.ts adds beside the Worker's own: the D1 schema, applied by test/apply-migrations.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
