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
<br>
[![Meta Global AI Developer Hackathon](https://img.shields.io/badge/Meta%20Global%20AI%20Developer%20Hackathon-Startup%20track-FF4A14)](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
[![Hugging Face: Loupe 1.1](https://img.shields.io/badge/Hugging%20Face-Loupe%20(Muse%20Glimmer%2030B%20LoRA)-FFD21E?logo=huggingface&logoColor=000000)](https://huggingface.co/rizonetech/isitlegit-loupe)
[![Made in South Africa](https://img.shields.io/badge/made%20in-South%20Africa-007749)](https://www.rizonetech.com/)
<br>
<sub><strong>Built &amp; Reviewed With</strong></sub><br>
[![Meta Muse Code](https://img.shields.io/badge/Meta%20Muse%20Code-Wonder%201.0-0467DF?logo=meta&logoColor=white)](CONTRIBUTIONS.md)
[![OpenAI GPT-6 Astra](https://img.shields.io/badge/OpenAI-GPT--6%20Astra-412991?logo=openai&logoColor=white)](CONTRIBUTIONS.md)
[![Anthropic Claude Opus 5.5](https://img.shields.io/badge/Anthropic-Claude%20Opus%205.5-D97757?logo=anthropic&logoColor=white)](CONTRIBUTIONS.md)
[![Google Gemini 4 Argon](https://img.shields.io/badge/Google-Gemini%204%20Argon-4285F4?logo=googlegemini&logoColor=white)](CONTRIBUTIONS.md)

</div>

> [!NOTE]
> **Status: day 0 of the build.** IsItLegit is being built during the Meta Global AI Developer Hackathon, 26 Oct to 4 Nov 2026. This repository holds the design, the build plan and the execution plan; the Worker lands section by section from [`todo/`](todo/TODO-00-INDEX.md). Nothing here is a working service yet.

## Contents

- [Why IsItLegit](#why-isitlegit)
- [What it does](#what-it-does)
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

- **Forward, send or upload.** Forward a suspicious email to `check@isitlegit.co.za`, or upload an email, a document, a screenshot or a voice note. A plain-language verdict comes back in minutes: the verdict, the top three reasons, and what to do now.
- **Evidence, not vibes.** Every claim in a verdict cites a piece of evidence: a header, a domain, a rendered screenshot, a logo crop, an invoice field. Hard rules set a floor the model cannot lower.
- **Follows the link so you do not have to.** A contained browser opens the landing page, and an agent walks the login form with canary values to show what the page is really after.
- **Invoice and payment checks.** Changed bank details, doctored invoices and fake proofs of payment are compared with what the supplier really uses.
- **A trust network for registered businesses.** A business verifies its real domains, sending addresses, logo and bank accounts. Anyone can then check mail that claims to be from it, and the business is told when someone is impersonating it.

## How it uses Meta's models

| Model | What it does in IsItLegit |
| ----- | ------------------------- |
| Muse Spark | Reads the mail, the headers and the evidence, writes the cited verdict, and screens lookalike sites for the impersonation monitor |
| Muse Wonder | Walks a suspicious landing page in a contained browser, with canary values only |
| SAM 3.1 | Finds and compares logos, stamps and signatures with the registered ones |
| Muse Image | Builds the synthetic doctored-document test set |
| Muse Voice Transcribe | Turns voice notes and voicemail lures into text for the same checks |

Every call uses a Standard model ID with `store: false`. The full map is in section 9 of the [design spec](docs/specs/2026-10-26-phishing-invoice-analyser-design.md).

## How it is built

One Cloudflare Worker in TypeScript: Email Routing for intake, Workflows for the investigation steps, D1, R2 and KV for storage, Browser Run for rendering, and the Meta Model API through AI Gateway. Services, versions and secrets are in the [tech stack spec](docs/specs/2026-10-26-tech-stack-design.md).

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
pnpm dev                         # serves http://localhost:8787 with COMMIT_SHA set to your checkout's commit
```

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
