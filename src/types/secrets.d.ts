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
  // The Domain Connect signing key (src/auth/domain-connect.ts, D07 T04 §5): an RSA private key as PKCS8 PEM, kept
  // in the vault and published only as its public half at _domainconnect.isitlegit.co.za. Unset, Connect is never
  // offered and every domain verifies by the manual and emailed ways.
  DOMAIN_CONNECT_PRIVATE_KEY?: string;
  // SMTP2GO's API key for outbound mail (src/mail/smtp2go.ts), sender restricted to isitlegit.co.za; kept in the vault.
  SMTP2GO_API_KEY?: string;
  // Google Web Risk's API key for the link reputation lookup (src/checks/webrisk.ts, D02 T06 §1), restricted to
  // webrisk.googleapis.com; kept in the vault as "IsItLegit Web Risk" and set by the coordinator at deploy. Unset,
  // a lookup answers not checked (no_key), never not listed.
  WEB_RISK_API_KEY?: string;
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
  // The previous pair at a rotation (D05 T01 §4): set by the coordinator from the vault only while a re-key
  // runs, read by the admin action only when present, and removed again straight after (docs/operations.md,
  // Bank keys). Never set through code or an argument.
  BANK_KEY_PREVIOUS?: string;
  BANK_MATCH_KEY_PREVIOUS?: string;
}
