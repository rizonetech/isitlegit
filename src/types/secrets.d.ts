// Secrets the Worker reads, set with `wrangler secret put` and never in wrangler.jsonc, so `wrangler types` cannot see
// them. Each is optional: the code that reads one treats it as absent until it is set.
interface Env {
  // The smoke route's bearer token (src/smoke.ts): long-lived, kept in the vault, replaced with `scripts/smoke.ts --rotate`.
  SMOKE_TOKEN?: string;
}
