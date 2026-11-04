# Tech stack: phishing and invoice-fraud analyser

**Operating decision, 4 November 2026:** Loupe is disabled for production calls and decisions in this release. The existing validated Muse Spark Standard page-screening path runs directly; no automatic Fireworks Spark Open fallback is implemented. All Loupe hosting is shut down; its training artifacts and failed experiment evidence remain archived. Application deployment verification is recorded separately in `docs/glimmer/release-status.md`. Historical Loupe design and cost decisions below are retained as history and superseded for current operation. Deterministic safety floors and evidence/schema validation remain unchanged. Reversal requires explicit enablement, redeployment and new quality qualification, not merely starting a deployment.


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
| Bulk screening model | **Loupe**, a Muse Glimmer 30B LoRA fine-tuned on Fireworks AI through its Training API (no dataset upload), served from a dedicated deployment that scales to zero after 5 idle minutes, 30 minutes a day on average (a day may borrow one day ahead, and unused minutes roll over; operator, 2026-10-31 22:16 SAST, D03 T04 §34) (chat completions, never the Responses API, which keeps conversations 30 days); **Muse Spark** (Standard mode) on the Meta Model API while Loupe warms past its limit, is out of minutes, fails, times out or reaches its cap | First pass for the impersonation monitor: the deployment billed by the hour while up (US$8.00 an hour, held to US$5 a day on average and US$90 in total), Spark about US$0.005 a page | Corrected 2026-10-28 20:45 SAST: Loupe replaces base Glimmer on serverless (Glimmer is not served pay-per-token, and tuned LoRAs never run serverless; operator decisions 15:01 to 15:16 SAST; D03 T04). Corrected 2026-10-28 (operator decision, 09:05 SAST): the 2026-10-27 removal of Fireworks is reversed now that Fireworks' US$100 partner credit is loaded; Muse Spark becomes the failover. Earlier: Muse Glimmer through Baseten or Fireworks, both removed 2026-10-27; a Muse Spark 1.3 Contributor plan was withdrawn because lure pages carry personal data (Fireworks' serverless keeps none of it) |
| Reputation signals | Google Web Risk Lookup API (`uris.search` only; never `threatLists.computeDiff` or `hashes.search`: Google bills `hashes.search` at US$50 per 1,000, and one `computeDiff` call anywhere in the project moves every `uris.search` call to that price, per cloud.google.com/web-risk/pricing, read 2026-10-27), Cloudflare 1.1.1.2 over DoH, Tranco or Majestic Million top-sites list in KV | Spec 4.3a; free tiers that allow commercial use | Web Risk API key restricted to the Web Risk API; results cached in KV 24 h (6 h for not listed); daily caps |
| Outbound mail | **SMTP2GO** HTTP API (`POST https://api.smtp2go.com/v3/email/send`) called with `fetch` from the Worker; replies threaded with `In-Reply-To` and `References` custom headers | Rizonetech's existing provider (credential "Rizonetech SMTP2GO" in the Conclave vault), delivery logs and bounce handling already familiar | Verify `isitlegit.co.za` as a sender domain in SMTP2GO (DKIM and return-path CNAMEs added in Cloudflare DNS); API key as a Worker secret |
| Headless browser | **Browser Run** (formerly Browser Rendering) with `@cloudflare/puppeteer` | Email and landing-page screenshots, redirect expansion, PDF page rasterisation (pdf.js loaded in the page), QR decoding (jsQR injected in the page), and the driver for the Muse Wonder computer-use agent | 3 new browsers per second, 60 s inactivity timeout (`keep_alive` up to 20 min), 10 browser-hours a month included then $0.09 per hour |
| Model traffic | **AI Gateway** `isitlegit` (authenticated) with the account custom provider `meta` in front of `https://api.meta.ai` (the client's base URL is `.../isitlegit/custom-meta/v1`, `META_GATEWAY_URL`) | Per-request logs, cost and latency analytics, caching, rate limiting, fallback; feeds the cost-per-case and latency numbers for the "holds up in production" story | The gateway collects no logs by default (`collect_logs: false`), so a caller that forgets its headers leaves no log at all, never a body; each request opts in with `cf-aig-collect-log: true` and `cf-aig-collect-log-payload: false`, which logs its metadata without bodies (AI Gateway has no gateway-wide switch for bodies alone). D00 T01 §7 sends both headers and proves them on the first real calls by reading back their logs; D03 T01 §1's `metaResponses` owns them in the Worker. The Worker is meant to reach the gateway through its pre-authenticated `AI` binding (`env.AI.gateway("isitlegit").run(...)` on the `custom-meta` provider), which D03 T01 §1 proves with a live call, falling back to a gateway token as a Worker secret if `run` cannot route the custom provider; the operator's scripts use a gateway token from the vault. Pricing rules on the provider cost `muse-spark-1.3` and `muse-wonder-1.0` per token; SAM 3.1, Muse Image and Muse Voice Transcribe (priced per image, per generated image and per hour of audio) are costed by D03 T01's D1 events only. Corrected 2026-10-27 (D00 T01 §6) |
| Client accounts and sign-in | **Better Auth** on Workers with D1: email magic link and passkeys, organisation plugin (one organisation per client company), invites and roles (owner, admin, member) | Self-serve signup and team management that Access cannot do; open source, data stays in our D1 | Sessions in D1; rate-limit sign-in routes |
| Rizonetech admin console | **Cloudflare Access** (email one-time PIN) in front of `/admin`; the Worker also verifies the `Cf-Access-Jwt-Assertion` JWT | Second, independent lock on the cross-tenant MSP view | Free tier covers 50 users |
| Marketing site | **Astro 7** static site in `site/`, deployed as Workers static assets on `isitlegit.co.za`; the app runs on `app.isitlegit.co.za` | Same repo, same design tokens, fastest pages, signup links straight into the app | Copy follows the global writing rules for marketing pages |
| Report links in replies | HMAC-signed, expiring URLs (WebCrypto) | Lets a recipient open their report from the reply without an Access session | Short expiry (7 days), single tenant scope |
| Observability | Workers Logs and traces, AI Gateway analytics, per-case cost and timings in D1 | Dashboard numbers come from our own tables | |

## Libraries (Worker)

| Purpose | Package | Version on 2026-10-26 | Note |
|---|---|---|---|
| HTTP routes and server-rendered pages | `hono` (with `hono/jsx`) | 4.13.14 | Report page, upload, admin, dashboard; no SPA build step |
| Styling | `tailwindcss` + `@tailwindcss/cli` | 4.3.3 | Compiled to a static CSS asset; Rizonetech tokens (Exo / Exo 2, `#FF4A14`). `scripts/build-tokens.ts` validates the token files and writes them as one `@theme static` block that removes Tailwind's whole default theme (`--*: initial`), so only token classes exist, keeping Tailwind's breakpoints by name (sm 40rem to 2xl 96rem, a default taken because the tokens name none), plus `weight-<key>` and `type-<role>` utilities and a `dark:` variant that follows the same theme rule (D07 T01 §2, 2026-10-27). Theme: the operating-system preference (`prefers-color-scheme`), overridden by `data-theme` on `<html>`; a default taken because the design SPEC does not choose, and a visible switch would be a SPEC change first |
| Authentication | `better-auth` | 1.7.13 | D1 adapter, organisation and magic-link plugins, passkeys |
| Dashboard interactivity | `htmx.org` | pin at scaffold | Partial page updates (filters, live case status) on server-rendered pages; no SPA |
| Dashboard charts | `uplot` | pin at scaffold | Small, fast time-series charts for verdict and volume trends |
| Marketing site | `astro` | 7.4.2 | Static output; no server adapter needed |
| MIME parsing | `postal-mime` | 4.1.4 | Works in Workers |
| Outlook `.msg` parsing | `@kenjiuno/msgreader` | 1.29.0 | Day 1: prove it runs under `nodejs_compat`; cut to `.eml`-only if not |
| Audio decoding | `opus-decoder` | 0.7.12 | Uploaded voice notes (Ogg Opus, as WhatsApp saves them) decoded by libopus straight to 16 kHz, then mono WAV for Muse Voice Transcribe. **Corrected 2026-10-27** (D01 T03 §2; was `ogg-opus-decoder` 1.7.5): that package's Ogg demuxer, `codec-parser`, is LGPL-3.0-or-later and decodes a whole 64 KiB slice at once, which a dense stream can make exceed a Worker's 128 MB; the Worker now demuxes Ogg itself (`src/voice/decode.ts`) and gives `opus-decoder` packets in 5-second batches, with its WebAssembly precompiled (`src/voice/opus-decoder.wasm`) |
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
| CLI and deploy | `wrangler` | 4.153.0 | Project dev dependency, not global. Corrected 2026-10-27 (D00 T01 §5): was 4.152.0; 4.153.0 and its Miniflare carry undici 7.30.1 (GHSA-xjj6-f33q-929c), installed under a recorded release-age exception (`pnpm-workspace.yaml`), removed 2026-10-27 14:35 UTC once the releases were past pnpm's 24-hour minimum age |
| Tests | `vitest` **4.1.12** + `@cloudflare/vitest-plugin` 1.4.8 | | Corrected 2026-10-27 (D00 T01 §3): Cloudflare renamed the Workers Vitest pool package to `@cloudflare/vitest-plugin` for version 1 (changelog 2026-08-19), and the old package's 0.23.0 is deprecated. 1.4.7 is the newest release past pnpm's minimum release age and depends on the Worker's Wrangler 4.152.0. It accepts Vitest ^4.1 or ^5; 4.1.12 stays Corrected again 2026-10-27 (D00 T01 §5): 1.4.8, the release paired with Wrangler 4.153.0. |
| Eval runner | `tsx` | 4.23.15 | Node script that submits labelled `.eml` files to the upload API and records results |
| Demo video | `remotion` + `@remotion/cli` | 4.0.539 (pin 4.x) | Free License: Rizonetech has 3 people (eligible up to 3, commercial use allowed; checked 2026-10-26). Stay on 4.x: the 5.0 licence counts all contractors. List in the README's third-party section |
| CI | GitHub Actions: typecheck, lint, tests and the TODO gates on every push; never deploys | | Deploys run from the build session with the local Wrangler login after the same gates pass (design spec section 11); no Cloudflare API token in GitHub; secrets only through `wrangler secret` |

## Secrets and configuration

- `META_API_KEY` (Meta Model API, Standard mode), `FIREWORKS_API_KEY` (Fireworks AI, an inference-only service account's key for Loupe's deployment, vault item "IsItLegit Fireworks"; the admin key in "IsItLegit Fireworks Admin" and the operator's own key in "IsItLegit Fireworks Owner", which Loupe's training uses, are for local scripts only and never Worker secrets; added 2026-10-28, the owner key at 20:45 SAST), `WEB_RISK_API_KEY`, `SMTP2GO_API_KEY` (sender restricted to isitlegit.co.za), `REPORT_LINK_SECRET` (HMAC), `CF_ACCESS_AUD` and team domain: `wrangler secret put`, source of truth in the Conclave vault.
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
test/                 vitest in workerd (@cloudflare/vitest-plugin), fixtures (synthetic only)
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
2. Confirm the account is on Workers Paid; verify `isitlegit.co.za` as a sender domain in SMTP2GO (senders `check@`, `verify@`, `alerts@`, and `signin@` for sign-in and invitation mail, D07 T08 §6; corrected 2026-10-29: was `no-reply@`, which the code never used, `src/auth/auth.ts`; `sendMail` refuses any sender outside isitlegit.co.za, no subdomain either).
3. Day 1 spikes: `msgreader` in Workers; AI Gateway custom provider passes the Responses API and image payloads through unchanged; SAM 3.1 logo recall; whether Llama Prompt Guard runs on Workers AI (optional second injection check, spec 4.6a).
