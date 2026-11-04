<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="design/brand/logo-svg/isitlegit-logo-on-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="design/brand/logo-svg/isitlegit-logo.svg">
  <img alt="IsItLegit" src="design/brand/logo-svg/isitlegit-logo.svg" width="360">
</picture>

<br>
<br>

<p><strong>Forward a suspicious email. Get a verdict with the evidence.</strong><br>Phishing, invoice-fraud and impersonation checks for small businesses, built on Meta's models.</p>

[![CI](https://github.com/rizonetech/isitlegit/actions/workflows/ci.yml/badge.svg)](https://github.com/rizonetech/isitlegit/actions/workflows/ci.yml)
[![Execution plan](https://img.shields.io/badge/execution%20plan-todo%2F-2EA043)](todo/implementation-plan.md)
[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg)](LICENSE)
[![Meta Model API](https://img.shields.io/badge/Meta%20Model%20API-Muse%20Spark%20%C2%B7%20Wonder%20%C2%B7%20SAM%203.1-0467DF?logo=meta&logoColor=white)](https://dev.meta.ai/docs)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-Web%20framework-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![htmx](https://img.shields.io/badge/htmx-Interactive%20UI-3366CC?logo=htmx&logoColor=white)](https://htmx.org/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare-D1%20database-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Cloudflare R2](https://img.shields.io/badge/Cloudflare-R2%20storage-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/r2/)
<br>
[![Meta Global AI Developer Hackathon](https://img.shields.io/badge/Meta%20Global%20AI%20Developer%20Hackathon-Startup%20track-FF4A14)](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
[![Hugging Face: Loupe](https://img.shields.io/badge/Hugging%20Face-Loupe%20(Muse%20Glimmer%2030B%20LoRA)-FFD21E?logo=huggingface&logoColor=000000)](https://huggingface.co/rizonetech/isitlegit-loupe)
[![Made in South Africa](https://img.shields.io/badge/made%20in-South%20Africa-007749)](https://www.rizonetech.com/)
<br>
<sub><strong>Built &amp; Reviewed With</strong></sub><br>
[![Meta Muse Code](https://img.shields.io/badge/Meta%20Muse%20Code-Wonder%201.0-0467DF?logo=meta&logoColor=white)](CONTRIBUTIONS.md)
[![OpenAI GPT-6 Astra](https://img.shields.io/badge/OpenAI-GPT--6%20Astra-412991?logo=openai&logoColor=white)](CONTRIBUTIONS.md)
[![Anthropic Claude Opus 5.5](https://img.shields.io/badge/Anthropic-Claude%20Opus%205.5-D97757?logo=anthropic&logoColor=white)](CONTRIBUTIONS.md)
[![Google Gemini 4 Argon](https://img.shields.io/badge/Google-Gemini%204%20Argon-4285F4?logo=googlegemini&logoColor=white)](CONTRIBUTIONS.md)

</div>

> [!NOTE]
> **Status, 4 November 2026:** IsItLegit has a deployed Worker and tested signup, sign-in and report-access paths. Deployment checks, local feature verification and detection quality are separate evidence; see [status and limits](#status-and-limits). The remaining work is tracked in [`todo/`](todo/TODO-00-INDEX.md).

## Contents

- [Why IsItLegit](#why-isitlegit)
- [What it does](#what-it-does)
- [Status and limits](#status-and-limits)
- [How it uses Meta's models](#how-it-uses-metas-models)
- [How it is built](#how-it-is-built)
- [Governing documents](#governing-documents)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Why IsItLegit

Phishing and business email compromise get past Microsoft 365 and other filters every day. Staff at a small business cannot tell whether a message is genuine, and the costliest case is an invoice from a real supplier whose bank details were quietly changed. Today the answer comes from a technician reading headers by hand, hours later.

There is a second gap no filter covers: when someone impersonates **your** business to your customers or suppliers, the mail never reaches you, so nothing you own can catch it.

IsItLegit is built by [Rizonetech](https://www.rizonetech.com/), a managed IT provider in George, South Africa, from the cases its clients bring.

## What it does

- **Forward, send or upload.** Forward a suspicious email to `check@isitlegit.co.za`, or upload an email, a document, a screenshot or a voice note. The report presents a plain-language verdict, the top three reasons, and what to do now; checks that did not run remain explicit.
- **Evidence, not vibes.** Every claim in a verdict cites a piece of evidence: a header, a domain, a rendered screenshot, a logo crop, an invoice field. Hard rules set a floor the model cannot lower.
- **Follows the link so you do not have to.** A contained browser opens the landing page, and an agent walks the login form with canary values to show what the page is really after.
- **Invoice and payment checks.** Changed bank details, doctored invoices and fake proofs of payment are compared with what the supplier really uses.
- **A trust network for registered businesses.** A business verifies its real domains, sending addresses, logo and bank accounts. Anyone can then check mail that claims to be from it, and the business is told when someone is impersonating it.

## Status and limits

- **Recorded deployment:** `df1ad981d544af292de9387ad03d9fd3c5bb7e37` passed all 12 CI jobs, both health checks and a five-check authenticated smoke test on 4 November. App health checks confirmed that commit again at 17:03 UTC. This is a dated release observation, not proof that every model-backed path works or that the same version is still serving.
- **Fresh-account access:** on the earlier `245ba0f39d937315e8562a6c1c5791055fba5724` deployment, one authorized synthetic account completed signup, invitation redemption, delivered-link login, five provisioned report reads, foreign-tenant denial, logout and used-link refusal. This access proof does not transfer automatically to later deployments. The phishing example returned suspicious where the fixture expected malicious, and reports included checks-not-run markers; those limitations remain open.
- **Header retrieval and copying:** D07 T03 §54 and §53 have supported local verification receipts, including 14 Worker tests for bounded UTF-8 retrieval and 49 browser tests for complete clipboard readback, visible fallback instructions and cancellation. These sections are integrated into main. On the recorded `df1ad981` deployment, a bounded existing-account check verified five report reads, exact 356-byte header display and clipboard readback, native clipboard-refusal instructions and selection, foreign-tenant denial, logout and consumed-link refusal. Delayed-copy cancellation used injected browser timing; long-header coverage remains local regression evidence. This was not a new signup or a model-quality test. These checks do not establish cross-browser superiority or production latency. A protected-registry baseline sentinel was not exercised, so that private-field coverage remains open.
- **Model measurements:** the [Loupe model card](docs/glimmer/model-card.md) reports version-specific, dataset-specific results and unmet targets. It is not an overall product accuracy guarantee. The current source selection is Loupe 1.0; Loupe 1.1 is not claimed as serving. The model card has no same-page Muse Wonder recall measurement, so it does not establish superiority over Wonder.

## How it uses Meta's models

| Model | Role and execution location | Provider and source |
| ----- | --------------------------- | ------------------- |
| Muse Spark 1.3 | Worker-side verdict reasoning, invoice extraction, reference-logo comparison and page-screening fallback/second look | Meta Model API through Cloudflare AI Gateway; [`src/agent/loop.ts`](src/agent/loop.ts), [`src/invoice/extract.ts`](src/invoice/extract.ts), [`src/vision/logo-compare.ts`](src/vision/logo-compare.ts), [`src/monitor/second-look.ts`](src/monitor/second-look.ts) |
| Muse Wonder 1.0 | Chooses actions for the contained Browser Run walkthrough; the driver enforces canary and navigation limits | Meta Model API through AI Gateway; [`src/walkthrough/wonder.ts`](src/walkthrough/wonder.ts), [`src/walkthrough/driver.ts`](src/walkthrough/driver.ts) |
| SAM 3.1 | Segments image regions used by the vision pipeline; Spark performs the reference-logo comparison | Meta Model API through AI Gateway; [`src/vision/sam.ts`](src/vision/sam.ts) |
| Loupe, a Muse Glimmer 30B LoRA | First-pass impersonation-page screener called by the Worker; current source selects version 1.0 | Dedicated Fireworks inference through AI Gateway; [`src/vision/glimmer-active.json`](src/vision/glimmer-active.json), [`src/vision/glimmer-request.ts`](src/vision/glimmer-request.ts), [training and limits](docs/glimmer/model-card.md) |
| Muse Image 1.0 | Offline synthetic doctored-document fixture generation, not a model call on every investigation | Meta Model API image-edit endpoint through AI Gateway; [`scripts/fixtures/make-doctored.ts`](scripts/fixtures/make-doctored.ts) |
| Muse Voice Transcribe 1.0 | Transcribes decoded voice-note audio for subsequent checks in the Worker workflow | Meta Model API transcription endpoint through AI Gateway; [`src/voice/transcribe.ts`](src/voice/transcribe.ts) |

The [Meta client](src/meta/client.ts) accepts pinned Standard model IDs and forces `store: false` on Responses requests. Gateway request headers disable payload logging. Fireworks uses a separate client and deployment configuration; model-provider inference is not local inference inside the Worker. The full safety contract remains in [AGENTS.md](AGENTS.md), and the intended model map is in section 9 of the [design spec](docs/specs/2026-10-26-phishing-invoice-analyser-design.md).

## How it is built

One Cloudflare Worker in TypeScript: Email Routing for intake, Workflows for the investigation steps, D1, R2 and KV for storage, Browser Run for rendering, and Meta Model API plus Fireworks inference through AI Gateway. Services, versions and secrets are in the [tech stack spec](docs/specs/2026-10-26-tech-stack-design.md).

The build runs through a validated TODO graph. Check it with Python 3.11 or newer:

```bash
python3 scripts/todo-graph.py validate
python3 scripts/todo-graph.py plan --check
python3 -m unittest discover -s tests/scripts
```

### Run the Worker locally

You need Node 24.18.0 or newer (`.nvmrc`; `pnpm install` refuses an older Node) and pnpm 11 (`corepack enable` installs the pinned pnpm from `package.json`) and git. From a clean clone:

```bash
pnpm install --frozen-lockfile   # exact pins from pnpm-lock.yaml
pnpm typecheck                   # checks worker-configuration.d.ts against wrangler.jsonc, then tsc --noEmit
pnpm lint                        # Biome: format and lint the Worker's own files
pnpm build:assets                # self-hosted fonts and the fingerprinted app stylesheet (Python 3.11+; a changed font needs design/tools/requirements.txt)
pnpm test                        # Vitest: the Worker inside workerd, build scripts and style checks in Node
pnpm test:a11y                   # axe-core over the component gallery in Chromium (WCAG 2.2 A and AA)
pnpm build                       # bundles the Worker with a dry-run deploy into build/dry
pnpm db:migrate:local            # creates/updates the local D1 schema; does not migrate production
pnpm dev                         # serves http://localhost:8787 with COMMIT_SHA set to your checkout's commit
```

Setup and validation details are in [CONTRIBUTING.md](CONTRIBUTING.md); external bindings and required secret names are in the [tech stack spec](docs/specs/2026-10-26-tech-stack-design.md). Tests use stubbed model responses. Starting the local Worker does not provision production mail, model providers or Browser Run: those paths require authorized service configuration and private credentials. Never commit credentials, invitation codes, sign-in links or real client mail, and do not treat a local dry build as a live-service check.

Under `pnpm dev`, http://localhost:8787/dev/components is the component gallery: every shared component in every state and every frame of the app shell, each reachable from the page's index and by its own anchor (`#state-button-primary`, `#frame-member-cases`); a frame opens alone at `/dev/components/frame/<name>`. It answers 404 everywhere else, deploys included (`ENV` is `production` in `wrangler.jsonc`). `pnpm test:a11y` checks the gallery with axe-core in headless Chromium: it uses `MOCKUP_CHROMIUM` when set, else Playwright's headless shell (`pnpm exec playwright-core install chromium-headless-shell`), else `chromium` or `google-chrome` on your `PATH`, and skips when it finds none (CI always has one).

While you edit, `pnpm exec vitest --watch` keeps the tests running in workerd and reruns them when a file under `src/` or `test/` changes; press `q` to stop it. `pnpm test` is the one-shot run the gates use.

In a second terminal, `curl -s localhost:8787/health` prints `{"ok":true,"commit":"<the output of git rev-parse HEAD>"}`. The commit is the checkout's `HEAD` when `pnpm dev` started: Wrangler reloads edited code but not the commit, so after a new commit, a checkout of another commit, or with uncommitted edits, the reported commit is not the whole story. Stop the server with `Ctrl+C` (or `x` in the Wrangler prompt) and run `pnpm dev` again after committing. After changing `wrangler.jsonc`, run `pnpm types` and commit `worker-configuration.d.ts`, or `pnpm typecheck` refuses it. Port 8787 already in use means another `pnpm dev` is still running; stop that one first, or run `pnpm dev --port 8788`.

## Governing documents

| Document | Role |
| -------- | ---- |
| [`docs/specs/2026-10-26-phishing-invoice-analyser-design.md`](docs/specs/2026-10-26-phishing-invoice-analyser-design.md) | Product design: the trust network, the checks, the safety contract, the eval targets |
| [`docs/specs/2026-10-26-tech-stack-design.md`](docs/specs/2026-10-26-tech-stack-design.md) | Services, libraries, versions, secrets and repository layout |
| [`docs/plans/2026-10-26-phishing-invoice-analyser.md`](docs/plans/2026-10-26-phishing-invoice-analyser.md) | The day-by-day build plan |
| [`todo/TODO-00-INDEX.md`](todo/TODO-00-INDEX.md) | The live execution plan, projected into [`todo/implementation-plan.md`](todo/implementation-plan.md) |
| [`docs/manifesto.md`](docs/manifesto.md) | The standard every change is held to: principles and checkable standards |
| [`AGENTS.md`](AGENTS.md) | The safety contract and the rules every change follows |
| [`docs/hackathon-criteria.md`](docs/hackathon-criteria.md) | The event rules and judging criteria, written as checks |
| [`CONTRIBUTIONS.md`](CONTRIBUTIONS.md) | What was built during the hackathon and what existed before |

## Contributing

Issues are welcome. Outside pull requests are not merged until judging ends, because the hackathon rules require the entry to be the team's own work. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).

## Security

IsItLegit handles hostile mail by design. Report a vulnerability privately, never in a public issue: see [`SECURITY.md`](SECURITY.md).

## License

IsItLegit is licensed under the **Functional Source License 1.1, Apache 2.0 future license** (`FSL-1.1-ALv2`); see [`LICENSE`](LICENSE). You may read, run, modify and share it for any purpose except a competing commercial service. Two years after each version is released, that version also becomes available under the Apache License 2.0. Decided by the operator on 2026-10-26. Third-party notices are in [`NOTICE.md`](NOTICE.md).

Copyright 2026 Rizonetech (Pty) Ltd.
