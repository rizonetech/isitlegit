// Secrets the Worker reads, set with `wrangler secret put` and never in wrangler.jsonc, so `wrangler types` cannot see
// them. Each is optional: the code that reads one treats it as absent until it is set.
interface Env {
  // The random path prefix of the redirect fixtures on fixtures.isitlegit.co.za (src/fixtures/redirects.ts): at least 16
  // characters, kept in the vault as "IsItLegit fixtures prefix" and set by scripts/deploy-fixtures.ts. Unset, the fixtures
  // host answers only robots.txt and 404.
  FIXTURES_PREFIX?: string;
  // The smoke route's bearer token (src/smoke.ts): long-lived, kept in the vault, replaced with `scripts/smoke.ts --rotate`.
  SMOKE_TOKEN?: string;
  // The HMAC key of the reply's report links (src/web/report-link.ts): 32 random bytes as base64url, kept in the vault
  // as "IsItLegit report link secret". Replacing it invalidates every link already sent.
  REPORT_LINK_SECRET?: string;
  // SMTP2GO's API key for outbound mail (src/mail/smtp2go.ts), sender restricted to isitlegit.co.za; kept in the vault.
  SMTP2GO_API_KEY?: string;
  // Cloudflare's Zone Analytics Read token for isitlegit.co.za (src/mail/forwarding.ts), kept in the vault as "IsItLegit
  // Cloudflare analytics token": reads Email Routing's events for forwarding failures (D01 T02 §6).
  CF_ANALYTICS_TOKEN?: string;
  // Better Auth's secret for signing session cookies (src/auth/auth.ts): 32 random bytes as base64url, kept in the vault
  // as "IsItLegit Better Auth secret". Replacing it signs every member out but leaves sent magic links valid; voiding
  // those is a D1 delete (docs/operations.md, Better Auth secret).
  BETTER_AUTH_SECRET?: string;
  // Meta's Model API key (src/meta/client.ts), kept in the vault as "IsItLegit Meta Model API"; sent to AI Gateway as
  // the bearer token, which the gateway passes on to Meta.
  META_API_KEY?: string;
  // AI Gateway `isitlegit`'s Run token (src/meta/client.ts), kept in the vault as "IsItLegit AI Gateway token"; sent as
  // `cf-aig-authorization`, since the gateway requires authentication (D00 T01 §6).
  CF_AIG_TOKEN?: string;
  // The trust network's bank keys (src/trust/bank.ts, D05 T01 §2): each 32 random bytes as base64, kept in the vault as
  // "IsItLegit bank key" (fields BANK_KEY and BANK_MATCH_KEY). BANK_KEY encrypts registered account numbers with
  // AES-GCM; BANK_MATCH_KEY keys the HMAC they are matched by. Replacing either needs `rekeyAccounts` first
  // (docs/operations.md, Bank keys); without it, matching refuses rather than reporting mismatches.
  BANK_KEY?: string;
  BANK_MATCH_KEY?: string;
}
