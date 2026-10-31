---
schema_version: 1
id: marketing-site
domain: 07-app
status: active
title: "TODO-06 -- Marketing Site at isitlegit.co.za"
track: day-6
---

# TODO-06 -- Marketing Site at isitlegit.co.za

> **Goal:** `isitlegit.co.za` is a fast static Astro site in the IsItLegit brand: home, how it works, invoice fraud, pricing ("Free during launch" with launch prices), privacy and POPIA, and a signup link into the app at `app.isitlegit.co.za`; copy follows the writing rules (answer first, plain words, every figure sourced, named author, review date).

> **Current state:** Measured 2026-10-26 20:00 SAST. No `site/` exists. Pricing decision recorded in design spec section 11. **Corrected 2026-10-31** (site lane): still no `site/`, but `pnpm-workspace.yaml` already lists `site`, and the app host (§9) is live on `app.isitlegit.co.za`.

## Inputs

- -> XREF: D07 T01 §2 -- the token stylesheet the site reuses, and the raw-colour guard this section extends to the site
- -> XREF: D07 T02 §13 -- the signup page whose Read the privacy notice opens the privacy page (§5)
- Design spec 2b (business model), 4.8 (marketing site), 11 (Pricing, Brand); stack doc "Marketing site" (Astro 7.4.2, TypeScript 6.0.3 in `site/` only, Workers static assets, app on `app.isitlegit.co.za`).
- `design/SPEC.md` marketing site section; the global writing rules for articles and marketing copy (no AI phrasing, E-E-A-T, sources).

## Outcome

- Five pages render from `site/` with Lighthouse performance and accessibility at 95 or more on mobile, every figure on them sourced, and the signup link working.

**Adjacency:** all=not-applicable (static marketing pages with no records, settings or user lifecycle)

**Adjacency rationale:** The site informs and links to signup; accounts and data live in the app.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Astro workspace with the design tokens | D07 T01 §2 | [ ] |
| 2 | §2 | Home page | §1 | [ ] |
| 3 | §3 | How it works and invoice fraud pages | §2 | [ ] |
| 4 | §4 | Pricing page with launch prices | §2 | [ ] |
| 5 | §5 | Privacy and POPIA page | §2 | [ ] |
| 6 | §6 | Deploy the site and split the app host | §5, D00 T01 §5 | [ ] |
| 7 | §7 | Protect your business page | §2 | [ ] |
| 8 | §8 | Terms, security and about pages | §2 | [ ] |
| 9 | §9 | Serve the app on app.isitlegit.co.za | D00 T01 §5 | [x] |

## 1. Astro workspace with the design tokens

> **Started:** 2026-10-31T15:04Z

`site/` is its own pnpm workspace package on TypeScript 6.0.3 (Astro check requires 5 or 6), building static output with the same tokens and fonts as the app.

**Corrected 2026-10-31** (site lane, at start): `pnpm-workspace.yaml` already lists `site` (it joined with the workspace scaffold), so item 1 no longer edits it. The token stylesheet `src/web/styles/tokens.css` is a Tailwind 4 `@theme static` block, not plain CSS, so the site compiles it with Tailwind 4.3.3 (the app's pin) through `@tailwindcss/vite` 4.3.3, the stack doc's Tailwind row; and `src/web/styles/fonts.css` names fingerprinted files under `/static/fonts/`, so the site build must ship those same files. The coordinator approved the shared-file edits (`.github/workflows/ci.yml`, `test/node/no-raw-colours.test.ts`, the `site` importer of `pnpm-lock.yaml`) on 2026-10-31 17:03 SAST, made in this section's own commits; the colour test is the app lane's and is told. The checkpoint could not fail on a missing token import, so it now reads the built CSS and fonts.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Scaffold `site/`. Done when: `pnpm --filter site build` writes `site/dist/`.

- [ ] Create `site/package.json` (name `site`, private, `"type": "module"`) with exact `astro` 7.4.2, `@astrojs/check` 0.9.12, `typescript` 6.0.3, `tailwindcss` 4.3.3 and `@tailwindcss/vite` 4.3.3, with `build` (`astro build`) and `check` (`astro check`) scripts, and `site/tsconfig.json` extending `astro/tsconfigs/strict`. Done when: `pnpm install` from the root resolves the workspace and `git diff pnpm-lock.yaml` changes no version outside the `site` importer.
- [ ] Write `site/astro.config.ts` with `output: "static"`, `site: "https://isitlegit.co.za"` and the `@tailwindcss/vite` plugin. Done when: `pnpm --filter site build` writes `site/dist/index.html`.
- [ ] Write `site/src/styles/site.css` importing Tailwind with `source(none)`, `../../../src/web/styles/tokens.css` and `../../../src/web/styles/fonts.css`, with `@source "../"` so only the site's own sources pick utilities. Done when: the built CSS under `site/dist/_astro/` contains `--color-orange` and the `Exo 2` `@font-face`. Cheaper substitute: a copied token file that drifts from `design/tokens/`; refused because the site imports the generated file itself.
- [ ] Ship the fonts `fonts.css` names: an integration in `site/astro.config.ts` (`site/src/integrations/app-fonts.ts`) reads every `/static/fonts/<file>` URL in `src/web/styles/fonts.css`, copies each from `public/static/fonts/` into `site/dist/static/fonts/` after the build, serves them in `astro dev`, and fails the build naming any file that is missing. Done when: `site/dist/static/fonts/` holds both `.woff2` files, and renaming one in `public/static/fonts/` fails `pnpm --filter site build` with its name. Cheaper substitute: a second copy of the fonts committed under `site/public/`; refused because it drifts from the app's fingerprinted files.
- [ ] Write the shared layout `site/src/layouts/Base.astro`: `<html lang="en-ZA">`, charset, viewport `width=device-width, initial-scale=1`, a required `title` prop and optional `description` meta, the stylesheet, body in token classes (`bg-surface text-ink font-text`, with a `dark:` utility so the theme variant ships), a skip link to `#main` as the first focusable element (visually hidden until focused, the app's `SKIP` treatment in `src/web/components/AppShell.tsx`), `<main id="main" tabindex="-1">` around a `<slot />`, and the SPEC focus treatment (solid 2 px `orange-text` outline 2 px outside every focused control, `design/SPEC.md` line 128, the app's `FOCUS` in `src/web/components/attrs.ts`) applied to links and buttons through the layout's CSS. Header and footer stay with §2. Done when: the build test below finds them in `site/dist/index.html`. Cheaper substitute: a bare `<html><body><slot/>` shell; refused by the build test's document checks.
- [ ] Write a placeholder `site/src/pages/index.astro` on `Base.astro` with a heading that §2 replaces. Done when: `site/dist/index.html` holds the heading inside `<main id="main">`.
- [ ] Add `site/public/_headers` giving `/static/*` `Cache-Control: public, max-age=31536000, immutable` (the app's `public/_headers` rule for its fingerprinted fonts), so Workers static assets in §6 serves the fonts with it. Done when: `site/dist/_headers` holds the rule; its HTTP read-back belongs to §6.
- [ ] Write `site/test/build.test.ts` (Node's built-in runner, `node --test`, run by a `test` script in `site/package.json`) over `site/dist/`: the stylesheet holds rules for `.bg-surface`, `.text-ink` and `.font-text`, the `dark:` utility under both `[data-theme="dark"]` and `prefers-color-scheme: dark` with the `:not([data-theme="light"])` opt-out, and the tokens' dark overrides; `index.html` has `lang="en-ZA"`, the viewport, the title, the skip link first and pointing at `<main id="main">`, the placeholder heading inside `main`, and the stylesheet link; every font URL in `src/web/styles/fonts.css` exists under `site/dist/` with the same SHA-256 as `public/static/fonts/`; `site/dist/_headers` holds the immutable rule. Done when: each assertion fails when its piece is removed (recorded once by deleting the import, the font copy, the skip link and the `dark:` class in turn).
- [ ] Write `site/test/app-fonts.test.ts` over `site/src/integrations/app-fonts.ts` in temporary fixture folders (never the shared `public/`): `fontUrls` lists every `/static/fonts/` URL of a sample `fonts.css`; the copy writes each file with matching bytes through a temporary file then rename; a missing source file throws naming it; the dev middleware answers a font URL with the file's bytes, `font/woff2` and the immutable cache header, and passes any other URL on. Done when: `pnpm --filter site test` passes and each case fails against a stub.
- [ ] Add `pnpm --filter site build`, `pnpm --filter site check` and `pnpm --filter site test` to the `worker` job of `.github/workflows/ci.yml`, after `pnpm build`, with no new job and no root script. Done when: the workflow runs the three commands in that job.
- [ ] Extend `tests/scripts/test_ci_workflow.py` to require the three site commands in the `worker` job after `pnpm build`, with a negative case per command. Done when: `python3 -m unittest tests.scripts.test_ci_workflow` passes, and fails with a site step removed. (Coordinator approved 2026-10-31 17:08 SAST; existing assertions unchanged.)
- [ ] Extend the raw-colour guard to `site/**/*.astro` and `site/src/**/*.{ts,css}` (the token stylesheet from D07 T01 §2 is the only colour source), in `test/node/no-raw-colours.test.ts`. Done when: a planted `#ff0000` in a `site/` page fails `pnpm test`. (Assigned from D07 T01 §2's plan review, 2026-10-27.)
- [ ] Keep the site out of the Worker gates: `site/` stays outside `tsconfig.json`, `biome.json` and the Vitest projects' includes. Done when: `pnpm typecheck` and `pnpm lint` pass with `site/` present.
- [ ] Record `astro` 7.4.2, `@astrojs/check` 0.9.12, `@tailwindcss/vite` 4.3.3 and the site's `typescript` 6.0.3 in `NOTICE.md`'s dependency table, each licence read from its installed package. Done when: the four rows name version, licence and that none ships code to visitors (static HTML and CSS only). (Coordinator approved 2026-10-31 17:08 SAST; licence read from each package at the locked version.)
- [ ] Verify the lockfile: Astro is new to it, so the change adds `packages:` and `snapshots:` entries and the `site` importer; no existing importer's specifiers or resolved versions change. Done when: `git diff pnpm-lock.yaml` shows no changed line under the root importer and `pnpm install --frozen-lockfile` passes.
- [ ] Commit: `site: Astro workspace with the design tokens`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site check && pnpm --filter site test` exits 0, with the build test's assertions over the built CSS, fonts, headers and layout; it fails when the token import, the font copy, the skip link or the theme variant is removed.

**Corrected 2026-10-31** (plan review, 6 P2): the checkpoint grepped for a token name that the theme override blocks also contain, and listed fonts without comparing bytes; the layout could pass as an empty shell; the CI proof passed without the site steps; the lockfile scope named only the importer; `NOTICE.md` rows were missing. Each is now an item above.

## 2. Home page

The answer first: what IsItLegit does in one sentence, the forward-to-check@ action, the three things it catches (phishing, invoice fraud, impersonation), the Meta models doing the work, and the signup link. Written to the global rules for marketing copy.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` marketing site, home
**Job:** a small business owner understands what this is and tries it
**Treatment:** answer first, one action, real-looking demo visuals from synthetic cases
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Build `site/src/pages/index.astro` against the SPEC. Done when: the page builds and the signup link points to `https://app.isitlegit.co.za/signup`.

- [ ] Write the home page copy (named author Derick Payne, Rizonetech; review date) with no unsourced figure. Done when: every number on the page has a source link or is our own measured eval number with its date.
- [ ] Build the layout and page with screenshots of synthetic report cases. Done when: the page builds and the images have alt text.
- [ ] Run `article-check` on the copy if installed and fix every FAIL. Done when: its output has no FAIL.
- [ ] Commit: `site: home page`

**Test checkpoint:** `pnpm --filter site build && grep -c 'app.isitlegit.co.za/signup' site/dist/index.html` prints at least `1`.

## 3. How it works and invoice fraud pages

How forwarding as an attachment works (Outlook and Gmail steps), what happens to the mail (checks, models, retention), and the invoice-fraud story with the bank-change catch and what to do.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` marketing site, how it works and invoice fraud
**Job:** a reader learns exactly how to use it and why invoice fraud matters
**Treatment:** steps with screenshots, plain words, sources for every claim
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Build both pages. Done when: they build with sourced copy.

- [ ] Write `site/src/pages/how-it-works.astro` with forwarding steps for Outlook desktop, Outlook web and Gmail, and the data handling summary (30-day raw retention, Standard model IDs, `store: false`). Done when: the page builds.
- [ ] Write `site/src/pages/invoice-fraud.astro` with the bank-change scenario (fictional names), the fixed action, and sourced South African fraud figures (SABRIC or similar primary sources, cited with dates). Done when: every figure has a citation.
- [ ] Commit: `site: how it works and invoice fraud pages`

**Test checkpoint:** `pnpm --filter site build` exits 0 and `grep -c 'href="https' site/dist/invoice-fraud/index.html` prints at least `1`.

## 4. Pricing page with launch prices

"Free during launch" with the tiers shown as launch prices and no billing (design spec section 11): Free check; Protect from R499 per month; MSP from R199 per client per month; what each includes from spec 2b.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` marketing site, pricing
**Job:** a buyer sees what it will cost after launch and that it is free now
**Treatment:** three tiers, clear inclusions, no checkout
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Build `site/src/pages/pricing.astro`. Done when: the three tiers and the launch banner render.

- [ ] Build the page with the banner and three tiers from spec 2b and the decided prices. Done when: the built page contains "R499" and "R199" and no checkout link.
- [ ] Commit: `site: pricing page with launch prices`

**Test checkpoint:** `pnpm --filter site build && grep -c 'Free during launch' site/dist/pricing/index.html` prints `1` or more.

## 5. Privacy and POPIA page

What data IsItLegit processes, why, for how long (raw mail and attachments deleted after 30 days; case summaries kept), who processes it (Cloudflare, Meta Model API in Standard mode with `store: false`, Fireworks AI for screening public lookalike pages with Loupe, our tuned Glimmer, on a dedicated deployment (Fireworks keeps no prompt or output of open models without opt-in; Loupe is trained through Fireworks' Training API, which stores no dataset file, on public pages, synthetic lures and redacted sample mail under the pilot client's consent, its checkpoints kept 30 days), SMTP2GO, Google Web Risk with URLs stripped of query strings; **Corrected 2026-10-28** (20:45 SAST): Loupe replaces base Glimmer on serverless, and its training on Fireworks is disclosed; whether the no-logging terms cover the dedicated deployment is confirmed in D03 T04 §12 before this page ships. **Corrected 2026-10-28** (operator decision, 09:05 SAST): Fireworks AI returns as the monitor's screener (Muse Glimmer), matching the Privacy board again; **Corrected 2026-10-27:** Baseten (earlier Fireworks AI) for Muse Glimmer is removed by operator decision, and public lookalike pages are screened by Muse Spark on the Meta Model API in Standard mode; the Privacy board's copy still names Fireworks AI and is superseded by design/SPEC.md), the information officer, and members' rights under POPIA. **Corrected 2026-10-26:** Fireworks was missing from the processors; case summary retention and the information officer now come from spec section 4.8 (POPIA bullet).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` marketing site, privacy
**Job:** a business owner or their client trusts what happens to forwarded mail
**Treatment:** plain words, every processor named, retention stated
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Build `site/src/pages/privacy.astro`. Done when: the page lists each processor, purpose and retention.

- [ ] Write the page from spec 4.8 and 4.3a facts, naming Rizonetech (Pty) Ltd as responsible party, Derick Payne as information officer and `hello@isitlegit.co.za` as the contact. Done when: the page builds with each of the five processors listed and both retention periods stated.
- [ ] Link it from the signup page's POPIA notice and the site footer. Done when: both links resolve.
- [ ] Commit: `site: privacy and POPIA page`

**Test checkpoint:** `pnpm --filter site build && grep -c '30 days' site/dist/privacy/index.html` prints at least `1`.

## 6. Deploy the site and split the app host

The site deploys as Workers static assets on `isitlegit.co.za`; the app answers on `app.isitlegit.co.za`; DNS and routes are set under the standing authorisation. **Corrected 2026-10-29** (D01 T01 §9 plan review): the app host moved to §9 in Phase 1, since every link the app mails (sign-in, claim codes, report links) points at it; this section keeps the site on the apex and `www`.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Route both hosts. Done when: `https://isitlegit.co.za` serves the home page and `https://app.isitlegit.co.za/health` the app.

- [ ] Configure Workers static assets for `site/dist` on `isitlegit.co.za` and `www` (redirect to the apex), with the app on `app.isitlegit.co.za` from §9 kept. Done when: both hosts answer over HTTPS.
- [ ] Add a deploy script running the site build and checks before `wrangler deploy`. Done when: `pnpm deploy:site` refuses to deploy on a failed check.
- [ ] Run Lighthouse (mobile) on the five pages and record performance and accessibility scores in `docs/live-checks.md`. Done when: each page scores 95 or more, or the shortfall is fixed.
- [ ] Commit: `site: deploy to isitlegit.co.za with the app on its own host`

**Test checkpoint:** `curl -s -o /dev/null -w '%{http_code}' https://isitlegit.co.za/` prints `200` and `curl -s https://app.isitlegit.co.za/health` returns `"ok":true`.

## 7. Protect your business page

`/protect` sells the trust network (`design/SPEC.md` S4): the protected identity, the domain-locked website seal, the signature badge, the impersonation monitor and closed-loop bank verification, each shown with the real artwork from `design/brand/` and a real (synthetic) example.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S4 and its board in `design/mockups/`
**Job:** a business owner understands how IsItLegit protects their name and signs up for it
**Treatment:** one idea per block, the real seal and badge, a clear call to protect
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Build `site/src/pages/protect.astro` against the SPEC board. Done when: each of the five protections has its block with artwork and a sourced or measured claim only.

- [ ] Build the page with the five blocks and a signup call to action. Done when: the built page links to the signup and shows the seal and badge images. Cheaper substitute: a bullet list without the artwork.
- [ ] Commit: `site: protect your business page`

**Test checkpoint:** `pnpm --filter site build && grep -c 'isitlegit-seal-protected' site/dist/protect/index.html` prints at least `1`.

## 8. Terms, security and about pages

`/terms` (plain-language terms for the free launch period, reviewed by the operator before launch), `/security` (how hostile mail is handled and the disclosure policy from `SECURITY.md`), and `/about` (Rizonetech, the named author, a contact address, and that IsItLegit was built for the Meta Global AI Developer Hackathon) (`design/SPEC.md` S7 to S9).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S7 to S9 and their boards in `design/mockups/`
**Job:** a careful buyer finds who is behind the service, the rules, and how to report a problem
**Treatment:** plain words, dated, the same layout as the privacy page
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Build the three pages. Done when: each builds with its date and is linked from the footer.

- [ ] Write `site/src/pages/terms.astro` marked "Draft for the launch period; reviewed by Rizonetech on <date>" until the operator records approval. Done when: the page builds with the draft marker.
- [ ] Write `site/src/pages/security.astro` from `SECURITY.md` and design spec 4.6a. Done when: it links the GitHub advisory form.
- [ ] Write `site/src/pages/about.astro` naming Derick Payne and Rizonetech (Pty) Ltd, George, with `hello@isitlegit.co.za` routed to the operator (D99 T01 §2). Done when: the page builds and the footer links all three pages.
- [ ] Commit: `site: terms, security and about pages`

**Test checkpoint:** `pnpm --filter site build && ls site/dist/terms/index.html site/dist/security/index.html site/dist/about/index.html` lists all three.


## 9. Serve the app on app.isitlegit.co.za

> **Started:** 2026-10-28T23:18Z

Every link the app mails names `https://app.isitlegit.co.za` (`wrangler.jsonc`): sign-in and invitation links through `APP_URL` (`src/auth/auth.ts`), report links through `PUBLIC_ORIGIN` (`src/mail/reply.ts`); a claim code is a plain code with no link. **Corrected 2026-10-29** (final review): said every link used `PUBLIC_ORIGIN`, claim codes included. The Worker serves only at `isitlegit.derick-f5a.workers.dev` today, so each of those links is dead until the app host answers. Moved forward from §6 by D01 T01 §9's plan review (2026-10-29).

**Phase:** 1
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Attach the app host to the Worker. Done when: `https://app.isitlegit.co.za/health` answers with the deployed SHA.

- [x] Add `app.isitlegit.co.za` as a Workers custom domain of `isitlegit` in `wrangler.jsonc` (`routes`, `custom_domain: true`), keeping `workers_dev` so `scripts/smoke.ts` still reaches its pinned host, and run `pnpm types`; `APP_URL` (Better Auth's base URL and origin check) and `PUBLIC_ORIGIN` (report links) already name this host and stay as they are. Done when: `pnpm typecheck` passes. Done 2026-10-29: `routes` and `workers_dev` in `wrangler.jsonc`; `pnpm types` left `worker-configuration.d.ts` unchanged; typecheck, Biome, the full suite (1027 passed, 2 skipped), `pnpm build` and `check-publication` pass.
- [x] Commit the configuration as `infra: the app on app.isitlegit.co.za` and push it before deploying, so the deploy runs from a clean checkout of a pushed commit (D00 T01 §5). Done when: `git status --porcelain` prints nothing and `HEAD` equals `origin/main`.
- [x] Deploy with `wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)` (`AGENTS.md` deploy rule, migrations first) and read the host back: the deploy lists the custom domain, DNS answers through Cloudflare, the certificate is valid, `/health` returns the deployed SHA, and `PUBLIC_ORIGIN` matches the host serving it. Done when: `curl -s https://app.isitlegit.co.za/health` returns `"ok":true` with `git rev-parse HEAD`. Done 2026-10-28 23:30 UTC: `24e43d6` deployed from a clean pushed checkout (no migrations pending), version `261facf8-7495-4d27-b731-ab869cd66a24`; the deploy lists `app.isitlegit.co.za (custom domain)` and the workers.dev host; `app.isitlegit.co.za` resolves through Cloudflare (104.21.47.191, 172.67.172.34), its certificate (Let's Encrypt YE1, valid to 2027-01-24) verifies, and both hosts' `/health` answer 200 with `24e43d6`; `scripts/smoke.ts` passes every binding.
- [x] Record the host in `docs/live-checks.md` with the date, the deployed SHA tested, and that the apex and `www` stay with §6, after the deploy. Done when: the file holds it.
- [x] Guard the two hosts and the smoke token's destinations (final review, 2026-10-29): `test/node/wrangler-hosts.test.ts` asserts the custom domain and `workers_dev: true` in the parsed config, and `scripts/smoke.ts` sends its token only to `isitlegit.derick-f5a.workers.dev` or `app.isitlegit.co.za` (it accepted the apex and every subdomain, which are the marketing site or could point elsewhere). Done when: both tests fail on the broken config and the old check, and pass.
- [x] Commit: `todo: D07 T06 §9 records the app host's live read-back` (landed as `9b3fcf4`, with the final review's fixes in `ef6a58b`)

**Test checkpoint:** for each of `https://app.isitlegit.co.za/health` and `https://isitlegit.derick-f5a.workers.dev/health`, `curl -sf` answers HTTP 200 with JSON `ok: true` and `commit` equal to the deployed SHA (the configuration commit), and any other status or SHA fails. **Corrected 2026-10-29** (plan review): the commit comes before the deploy, and the workers.dev host must answer 200 with the SHA, not merely answer.

> **Verified:** 2026-10-29 | §9 | 4813b1383186c3060a613247baecab22d9942581
> **Review:** `docs/reviews/d07-t06-s9.json`

## Verification

- The five pages are live, fast and accessible, with sourced copy and a working signup link.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
