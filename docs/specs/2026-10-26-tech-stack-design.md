# Tech stack: phishing and invoice-fraud analyser

Status: decided 2026-10-26, before the first commit. Companion to `2026-10-26-phishing-invoice-analyser-design.md`. Versions checked against npm and the Cloudflare docs on 2026-10-26; pin exact versions at scaffold time.

## Principles

- One Cloudflare account (Rizonetech's), one Worker, managed services only. Solo build: no servers, no containers, nothing to patch.
- Every external input and every model output passes a zod schema before use.
- Requires the **Workers Paid** plan (Browser Run hours, Workflows limits).

## Platform services

| Concern | Choice | Why | Limits that shape the design |
|---|---|---|---|
| Compute | Cloudflare Workers (one Worker: `fetch`, `email` and `scheduled` handlers and a Workflow class; a daily Cron Trigger runs the impersonation monitor) | Single deploy unit, global, already on the account | CPU limits per invocation; long work goes into Workflow steps |
| Pipeline orchestration | **Cloudflare Workflows** (replaces the Queue in the spec) | Durable steps with per-step retries, resumes after failure without repeating paid model calls, saga rollback, instance history for the report timeline | Step output 1 MiB (store artefacts in R2, pass keys); 10,000 steps; retained 30 days |
| Relational data | D1 | Tenants, cases, evidence, suppliers, feedback, eval runs; SQL for the dashboard | Single-region writes are fine at our volume |
| Blobs | R2 | Raw messages, attachments, screenshots, logo crops, page renders | Lifecycle rule deletes `raw/` after 30 days (POPIA) |
| Caches | KV | RDAP lookups, brand-domain table, model results by artefact hash | Eventual consistency is fine for caches |
| Inbound mail | Email Routing to the `email()` handler on the product's own domain: `check@isitlegit.co.za` | Dedicated zone on Cloudflare; no impact on Rizonetech's Microsoft 365 mail | 25 MiB message limit |
| Open-weight model | **Muse Glimmer** through a hosted inference provider (Fireworks AI first, OpenRouter or Together AI as fallback), OpenAI-compatible | Cheap bulk screening for the impersonation monitor | Model ID per provider recorded at setup; provider key as a Worker secret |
| Reputation signals | Google Web Risk Lookup API (`uris.search` only; never `threatLists.computeDiff` or `hashes.search`: Google bills `hashes.search` at US$50 per 1,000, and one `computeDiff` call anywhere in the project moves every `uris.search` call to that price, per cloud.google.com/web-risk/pricing, read 2026-10-27), Cloudflare 1.1.1.2 over DoH, Tranco or Majestic Million top-sites list in KV | Spec 4.3a; free tiers that allow commercial use | Web Risk API key restricted to the Web Risk API; results cached in KV 24 h (6 h for not listed); daily caps |
| Outbound mail | **SMTP2GO** HTTP API (`POST https://api.smtp2go.com/v3/email/send`) called with `fetch` from the Worker; replies threaded with `In-Reply-To` and `References` custom headers | Rizonetech's existing provider (credential "Rizonetech SMTP2GO" in the Conclave vault), delivery logs and bounce handling already familiar | Verify `isitlegit.co.za` as a sender domain in SMTP2GO (DKIM and return-path CNAMEs added in Cloudflare DNS); API key as a Worker secret |
| Headless browser | **Browser Run** (formerly Browser Rendering) with `@cloudflare/puppeteer` | Email and landing-page screenshots, redirect expansion, PDF page rasterisation (pdf.js loaded in the page), QR decoding (jsQR injected in the page), and the driver for the Muse Wonder computer-use agent | 3 new browsers per second, 60 s inactivity timeout (`keep_alive` up to 20 min), 10 browser-hours a month included then $0.09 per hour |
| Model traffic | **AI Gateway custom provider** in front of `https://api.meta.ai/v1` | Per-request logs, cost and latency analytics, caching, rate limiting, fallback; feeds the cost-per-case and latency numbers for the "holds up in production" story | Send `cf-aig-collect-log-payload: false` so prompts and email content are not stored in gateway logs; metadata still logged |
| Client accounts and sign-in | **Better Auth** on Workers with D1: email magic link and passkeys, organisation plugin (one organisation per client company), invites and roles (owner, admin, member) | Self-serve signup and team management that Access cannot do; open source, data stays in our D1 | Sessions in D1; rate-limit sign-in routes |
| Rizonetech admin console | **Cloudflare Access** (email one-time PIN) in front of `/admin`; the Worker also verifies the `Cf-Access-Jwt-Assertion` JWT | Second, independent lock on the cross-tenant MSP view | Free tier covers 50 users |
| Marketing site | **Astro 7** static site in `site/`, deployed as Workers static assets on `isitlegit.co.za`; the app runs on `app.isitlegit.co.za` | Same repo, same design tokens, fastest pages, signup links straight into the app | Copy follows the global writing rules for marketing pages |
| Report links in replies | HMAC-signed, expiring URLs (WebCrypto) | Lets a recipient open their report from the reply without an Access session | Short expiry (7 days), single tenant scope |
| Observability | Workers Logs and traces, AI Gateway analytics, per-case cost and timings in D1 | Dashboard numbers come from our own tables | |

## Libraries (Worker)

| Purpose | Package | Version on 2026-10-26 | Note |
|---|---|---|---|
| HTTP routes and server-rendered pages | `hono` (with `hono/jsx`) | 4.13.14 | Report page, upload, admin, dashboard; no SPA build step |
| Styling | `tailwindcss` + `@tailwindcss/cli` | 4.3.3 | Compiled to a static CSS asset; Rizonetech tokens (Exo / Exo 2, `#FF4A14`) |
| Authentication | `better-auth` | 1.7.13 | D1 adapter, organisation and magic-link plugins, passkeys |
| Dashboard interactivity | `htmx.org` | pin at scaffold | Partial page updates (filters, live case status) on server-rendered pages; no SPA |
| Dashboard charts | `uplot` | pin at scaffold | Small, fast time-series charts for verdict and volume trends |
| Marketing site | `astro` | 7.4.2 | Static output; no server adapter needed |
| MIME parsing | `postal-mime` | 4.1.4 | Works in Workers |
| Outlook `.msg` parsing | `@kenjiuno/msgreader` | 1.29.0 | Day 1: prove it runs under `nodejs_compat`; cut to `.eml`-only if not |
| Audio decoding | `ogg-opus-decoder` | 1.7.5 | Uploaded voice notes (Ogg Opus, as WhatsApp saves them) to PCM, then 16 kHz mono WAV for Muse Voice Transcribe; day 1 spike in Workers |
| Domain parsing | `tldts` | 7.4.19 | Registrable domain, public suffix |
| Lookalike detection | own module over the Unicode confusables table | n/a | `confusables` on npm is from 2022; a small skeleton function plus edit distance is easier to test |
| QR decoding | `jsqr` | 1.4.0 | Runs inside the Browser Run page, not in the Worker |
| PDF rendering | `pdfjs-dist` | 6.4.299 | Loaded in the Browser Run page to rasterise pages for SAM and screenshots; the model reads PDFs natively |
| Meta Model API client | `openai` | 7.43.0 | `baseURL` set to the AI Gateway custom-provider URL; Responses API; `store: false` |
| SAM output parsing | `@meta-sam/parser` | 0.1.0 | Boxes and masks from `sam-3.1` |
| Schemas | `zod` | 4.6.7 | `z.toJSONSchema()` for structured outputs and tool definitions |
| Browser driver | `@cloudflare/puppeteer` | 1.4.0 | Browser Run binding |

## Tooling

| Purpose | Choice | Version | Note |
|---|---|---|---|
| Runtime and package manager (local) | Node 24, pnpm 11 | 24.18.0 / 11.16.0 | Both already installed |
| Language | TypeScript, strict | **7.0.2** (Worker, scripts, eval) | Decided 15:55: stable since 2026-07-08, native compiler, much faster `tsc --noEmit`. Safe here because nothing in the Worker toolchain uses the TypeScript API: Wrangler bundles with esbuild, Vitest transforms with Vite, neither has a TypeScript peer. Day 0 check: `tsc` 7 passes on the scaffold with workers-types and Better Auth types. Result 2026-10-27 (D00 T01 §2): passed; `tsc` 7.0.2 type-checks the scaffold against the `wrangler types` runtime types with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, and fails on a planted type error. The Better Auth half is checked when `better-auth` enters (D07 T02 §1) |
| Language (marketing site) | TypeScript 6.0.3 in `site/` only | 6.0.3 | `@astrojs/check` 0.9.12 requires TypeScript ^5 or ^6; the site is its own pnpm workspace package, so it pins 6 without affecting the Worker |
| Lint and format | **Biome** | 2.6.3 | `typescript-eslint` 8.72 requires TypeScript below 6.1, so it cannot run on 7; Biome needs no TypeScript install. Pinned at scaffold 2026-10-27 (D00 T01 §3), over the Worker's own files only |
| Workers types | Generated by `wrangler types --strict-vars=false` into `worker-configuration.d.ts` | Matches `compatibility_date` | Corrected 2026-10-27 (D00 T01 §2): was `@cloudflare/workers-types` 5.20261026.1, called a required peer of Wrangler 4.152; it is an optional peer, and the generated runtime types follow the configured compatibility date, so the package is not installed (both together declare the Workers globals twice) |
| CLI and deploy | `wrangler` | 4.152.0 | Project dev dependency, not global |
| Tests | `vitest` **4.1.12** + `@cloudflare/vitest-plugin` 1.4.7 | | Corrected 2026-10-27 (D00 T01 §3): `@cloudflare/vitest-pool-workers` was renamed `@cloudflare/vitest-plugin` (Cloudflare changelog 2026-08-19) and 0.23.0 is deprecated. 1.4.7 is the newest release past pnpm's minimum release age and depends on the Worker's Wrangler 4.152.0. It accepts Vitest ^4.1 or ^5; 4.1.12 stays |
| Eval runner | `tsx` | 4.23.15 | Node script that submits labelled `.eml` files to the upload API and records results |
| Demo video | `remotion` + `@remotion/cli` | 4.0.539 (pin 4.x) | Free License: Rizonetech has 3 people (eligible up to 3, commercial use allowed; checked 2026-10-26). Stay on 4.x: the 5.0 licence counts all contractors. List in the README's third-party section |
| CI | GitHub Actions: typecheck, lint, tests and the TODO gates on every push; never deploys | | Deploys run from the build session with the local Wrangler login after the same gates pass (design spec section 11); no Cloudflare API token in GitHub; secrets only through `wrangler secret` |

## Secrets and configuration

- `META_API_KEY` (Meta Model API, Standard mode), `GLIMMER_PROVIDER_API_KEY`, `WEB_RISK_API_KEY`, `SMTP2GO_API_KEY` (sender restricted to isitlegit.co.za), `REPORT_LINK_SECRET` (HMAC), `CF_ACCESS_AUD` and team domain: `wrangler secret put`, source of truth in the Conclave vault.
- No secrets in `wrangler.jsonc`, fixtures or tests; tests use stubbed model responses.

## Repository layout

```
src/
  index.ts            Worker entry: fetch (Hono), email, Workflow export
  intake/             email handler, upload route, forward-as-attachment detection
  pipeline/           AnalysisWorkflow and its steps
  checks/             deterministic evidence producers (one file per check, pure functions)
  vision/             render, Muse Spark extraction, SAM logo crops, brand compare
  agent/              verdict agent, tools, citation validator, deterministic floor
  walkthrough/        Muse Wonder computer-use driver and hard limits
  invoice/            extraction, supplier ledger, bank-change rules
  meta/               model client (AI Gateway, store:false, Standard IDs only), cost logging
  web/                Hono pages: report, upload, admin, dashboard
  db/                 D1 schema, migrations, queries
  auth/               Better Auth config, organisations, domain verification
site/                 Astro marketing site (isitlegit.co.za)
test/                 vitest (workers pool), fixtures (synthetic only)
eval/                 runner, DATASETS.md, RESULTS.md (public data and synthetic only)
docs/                 specs, plans, review prompts, todo-workflow.md, reviews/ (receipts)
todo/                 TODO execution plan (Conclave todo kit, as in Recto)
scripts/              todo-graph.py, review-dispatch.py, campaign_guard.py, hooks/pre-commit
tests/scripts/        tests for the tooling in scripts/
.conclave/            reviewers.toml (GPT-6 Astra through Codex), ci.json
.claude/              skills, rules, read-only subagents
sources/              research captures
samples/              real mail, git-ignored
competitors/          competitor profiles
video/                Remotion project for the demo video (titles, architecture animation)
```

## Rejected options

- **Queues for the pipeline**: works, but a failure mid-pipeline re-runs paid model calls; Workflows checkpoints each step.
- **React SPA (Vite)**: nicer interactivity, but a second build and state layer for a solo 10-day build; server-rendered Hono pages are enough for reports and a dashboard.
- **Magic-link login written by us**: Better Auth provides it, tested and maintained.
- **Cloudflare Access for client users**: no self-serve signup, organisations or invites; kept only for the admin console.
- **WordPress on Pressable for the marketing site**: easy to edit, but a second platform outside the repo; revisit after the event if the team needs a CMS.
- **Calling `api.meta.ai` directly**: loses gateway analytics and caching we need for cost and latency evidence; direct calls stay as a fallback if the custom provider misbehaves.
- **Agents SDK email agent**: adds Durable Object state we do not need; the plain `email()` handler plus Workflows covers the flow.

## Open items

1. Registered 2026-10-26. Add the zone to Cloudflare once the registry publishes it, point nameservers to Cloudflare. Hostnames: `isitlegit.co.za` (marketing), `app.isitlegit.co.za` (app), `check@isitlegit.co.za` (intake).
2. Confirm the account is on Workers Paid; verify `isitlegit.co.za` as a sender domain in SMTP2GO (senders `check@`, `verify@`, `alerts@`, and `no-reply@` for sign-in and invitation mail, D07 T08 §6).
3. Day 1 spikes: `msgreader` in Workers; AI Gateway custom provider passes the Responses API and image payloads through unchanged; SAM 3.1 logo recall; whether Llama Prompt Guard runs on Workers AI (optional second injection check, spec 4.6a).
