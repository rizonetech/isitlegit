// Secrets the Worker reads, set with `wrangler secret put` and never in wrangler.jsonc, so `wrangler types` cannot see
// them. Each is optional: the code that reads one treats it as absent until it is set.
interface Env {
  // The smoke route's bearer token (src/smoke.ts); scripts/smoke.ts mints and sets a new one for each run.
  SMOKE_TOKEN?: string;
}
