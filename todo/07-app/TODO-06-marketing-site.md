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

> **Current state:** Measured 2026-10-26 20:00 SAST. No `site/` exists. Pricing decision recorded in design spec section 11.

## Inputs

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

## 1. Astro workspace with the design tokens

`site/` is its own pnpm workspace package on TypeScript 6.0.3 (Astro check requires 5 or 6), building static output with the same tokens and fonts as the app.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Scaffold `site/`. Done when: `pnpm --filter site build` writes `site/dist/`.

- [ ] Create `site/package.json` with exact `astro` 7.4.2, `@astrojs/check` 0.9.12 and `typescript` 6.0.3, and add `site` to `pnpm-workspace.yaml`. Done when: `pnpm install` resolves the workspace.
- [ ] Import the generated token CSS and self-hosted fonts from the app build. Done when: the built CSS contains the token variables.
- [ ] Add `pnpm --filter site check` (Astro check) to CI. Done when: CI runs it.
- [ ] Commit: `site: Astro workspace with the design tokens`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site check` exits 0.

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

What data IsItLegit processes, why, for how long (raw mail and attachments deleted after 30 days; case summaries kept), who processes it (Cloudflare, Meta Model API in Standard mode with `store: false`, SMTP2GO, Google Web Risk with URLs stripped of query strings), the information officer, and members' rights under POPIA.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` marketing site, privacy
**Job:** a business owner or their client trusts what happens to forwarded mail
**Treatment:** plain words, every processor named, retention stated
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Build `site/src/pages/privacy.astro`. Done when: the page lists each processor, purpose and retention.

- [ ] Write the page from spec 4.8 and 4.3a facts, naming Rizonetech (Pty) Ltd as responsible party and the information officer contact. Done when: the page builds with each processor listed.
- [ ] Link it from the signup page's POPIA notice and the site footer. Done when: both links resolve.
- [ ] Commit: `site: privacy and POPIA page`

**Test checkpoint:** `pnpm --filter site build && grep -c '30 days' site/dist/privacy/index.html` prints at least `1`.

## 6. Deploy the site and split the app host

The site deploys as Workers static assets on `isitlegit.co.za`; the app answers on `app.isitlegit.co.za`; DNS and routes are set under the standing authorisation.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Route both hosts. Done when: `https://isitlegit.co.za` serves the home page and `https://app.isitlegit.co.za/health` the app.

- [ ] Configure Workers static assets for `site/dist` on `isitlegit.co.za` and `www` (redirect to the apex), and the app Worker route on `app.isitlegit.co.za`. Done when: both hosts answer over HTTPS.
- [ ] Add a deploy script running the site build and checks before `wrangler deploy`. Done when: `pnpm deploy:site` refuses to deploy on a failed check.
- [ ] Run Lighthouse (mobile) on the five pages and record performance and accessibility scores in `docs/live-checks.md`. Done when: each page scores 95 or more, or the shortfall is fixed.
- [ ] Commit: `site: deploy to isitlegit.co.za with the app on its own host`

**Test checkpoint:** `curl -s -o /dev/null -w '%{http_code}' https://isitlegit.co.za/` prints `200` and `curl -s https://app.isitlegit.co.za/health` returns `"ok":true`.

## Verification

- The five pages are live, fast and accessible, with sourced copy and a working signup link.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
