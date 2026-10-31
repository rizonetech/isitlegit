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
| 1 | §1 | Astro workspace with the design tokens | D07 T01 §2 | [x] |
| 2 | §2 | Home page | §1 | [x] |
| 3 | §3 | How it works and invoice fraud pages | §2 | [x] |
| 4 | §4 | Pricing page with launch prices | §2 | [x] |
| 5 | §5 | Privacy and POPIA page | §2 | [ ] |
| 6 | §6 | Deploy the site and split the app host | §5, D00 T01 §5 | [ ] |
| 7 | §7 | Protect your business page | §2 | [ ] |
| 8 | §8 | Terms, security and about pages | §2 | [ ] |
| 9 | §9 | Serve the app on app.isitlegit.co.za | D00 T01 §5 | [x] |
| 10 | §10 | One-step demo check on the home page | §2 | [ ] |
| 11 | §11 | Already paid: what to do now | §3 | [ ] |
| 12 | §12 | Pricing terms: VAT and commitment | §4 | [ ] |
| 13 | §13 | On-site invite request | §4 | [ ] |

## 1. Astro workspace with the design tokens

> **Started:** 2026-10-31T15:04Z

`site/` is its own pnpm workspace package on TypeScript 6.0.3 (Astro check requires 5 or 6), building static output with the same tokens and fonts as the app.

**Corrected 2026-10-31** (site lane, at start): `pnpm-workspace.yaml` already lists `site` (it joined with the workspace scaffold), so item 1 no longer edits it. The token stylesheet `src/web/styles/tokens.css` is a Tailwind 4 `@theme static` block, not plain CSS, so the site compiles it with Tailwind 4.3.3 (the app's pin) through `@tailwindcss/vite` 4.3.3, the stack doc's Tailwind row; and `src/web/styles/fonts.css` names fingerprinted files under `/static/fonts/`, so the site build must ship those same files. The coordinator approved the shared-file edits (`.github/workflows/ci.yml`, `test/node/no-raw-colours.test.ts`, the `site` importer of `pnpm-lock.yaml`) on 2026-10-31 17:03 SAST, made in this section's own commits; the colour test is the app lane's and is told. The checkpoint could not fail on a missing token import, so it now reads the built CSS and fonts.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Scaffold `site/`. Done when: `pnpm --filter site build` writes `site/dist/`.

- [x] Create `site/package.json` (name `site`, private, `"type": "module"`) with exact `astro` 7.4.2, `@astrojs/check` 0.9.12, `typescript` 6.0.3, `tailwindcss` 4.3.3 and `@tailwindcss/vite` 4.3.3, with `build` (`astro build`) and `check` (`astro check`) scripts, and `site/tsconfig.json` extending `astro/tsconfigs/strict`. Done when: `pnpm install` from the root resolves the workspace and `git diff pnpm-lock.yaml` changes no version outside the `site` importer.
- [x] Write `site/astro.config.ts` with `output: "static"`, `site: "https://isitlegit.co.za"` and the `@tailwindcss/vite` plugin. Done when: `pnpm --filter site build` writes `site/dist/index.html`.
- [x] Write `site/src/styles/site.css` importing Tailwind with `source(none)`, `../../../src/web/styles/tokens.css` and `../../../src/web/styles/fonts.css`, with `@source "../"` so only the site's own sources pick utilities. Done when: the built CSS under `site/dist/_astro/` contains `--color-orange` and the `Exo 2` `@font-face`. Cheaper substitute: a copied token file that drifts from `design/tokens/`; refused because the site imports the generated file itself.
- [x] Ship the fonts `fonts.css` names: an integration in `site/astro.config.ts` (`site/src/integrations/app-fonts.ts`) reads every `/static/fonts/<file>` URL in `src/web/styles/fonts.css`, copies each from `public/static/fonts/` into `site/dist/static/fonts/` after the build, serves them in `astro dev`, and fails the build naming any file that is missing. Done when: `site/dist/static/fonts/` holds both `.woff2` files, and renaming one in `public/static/fonts/` fails `pnpm --filter site build` with its name. Cheaper substitute: a second copy of the fonts committed under `site/public/`; refused because it drifts from the app's fingerprinted files.
- [x] Write the shared layout `site/src/layouts/Base.astro`: `<html lang="en-ZA">`, charset, viewport `width=device-width, initial-scale=1`, a required `title` prop and optional `description` meta, the stylesheet, body in token classes (`bg-surface text-ink font-text`; **Corrected 2026-10-31** (build): no `dark:` utility, since the tokens' own dark overrides swap every colour variable and a `dark:` class would repeat them; the build test checks those overrides instead), a skip link to `#main` as the first focusable element (visually hidden until focused, the app's `SKIP` treatment in `src/web/components/AppShell.tsx`), `<main id="main" tabindex="-1">` around a `<slot />`, and the SPEC focus treatment (solid 2 px `orange-text` outline 2 px outside every focused control, `design/SPEC.md` line 128, the app's `FOCUS` in `src/web/components/attrs.ts`) applied to links and buttons through the layout's CSS. Header and footer stay with §2. Done when: the build test below finds them in `site/dist/index.html`. Cheaper substitute: a bare `<html><body><slot/>` shell; refused by the build test's document checks.
- [x] Write a placeholder `site/src/pages/index.astro` on `Base.astro` with a heading that §2 replaces. Done when: `site/dist/index.html` holds the heading inside `<main id="main">`.
- [x] Add `site/public/_headers` giving `/static/*` `Cache-Control: public, max-age=31536000, immutable` (the app's `public/_headers` rule for its fingerprinted fonts), so Workers static assets in §6 serves the fonts with it. Done when: `site/dist/_headers` holds the rule; its HTTP read-back belongs to §6.
- [x] Write `site/test/build.test.ts` (Node's built-in runner, `node --test`, run by a `test` script in `site/package.json`) over `site/dist/`: the stylesheet holds rules for `.bg-surface`, `.text-ink` and `.font-text`, the tokens' dark overrides under both `:root[data-theme="dark"]` and `prefers-color-scheme: dark` with the `:not([data-theme="light"])` opt-out (**Corrected 2026-10-31**: was a `dark:` utility, see the layout item), the SPEC focus ring rule, and no script in the output; `index.html` has `lang="en-ZA"`, the viewport, the title, the skip link first and pointing at `<main id="main">`, the placeholder heading inside `main`, and the stylesheet link; every font URL in `src/web/styles/fonts.css` exists under `site/dist/` with the same SHA-256 as `public/static/fonts/`; `site/dist/_headers` holds the immutable rule. Done when: each assertion fails when its piece is removed (recorded once by deleting the import, the font copy, the skip link and the `dark:` class in turn).
- [x] Write `site/test/app-fonts.test.ts` over `site/src/integrations/app-fonts.ts` in temporary fixture folders (never the shared `public/`): `fontUrls` lists every `/static/fonts/` URL of a sample `fonts.css`; the copy writes each file with matching bytes through a temporary file then rename; a missing source file throws naming it; the dev middleware answers a font URL with the file's bytes, `font/woff2` and the immutable cache header, and passes any other URL on. Done when: `pnpm --filter site test` passes and each case fails against a stub.
- [x] Add `pnpm --filter site build`, `pnpm --filter site check` and `pnpm --filter site test` to the `worker` job of `.github/workflows/ci.yml`, after `pnpm build`, with no new job and no root script. Done when: the workflow runs the three commands in that job.
- [x] Extend `tests/scripts/test_ci_workflow.py` to require the three site commands in the `worker` job after `pnpm build`, with a negative case per command. Done when: `python3 -m unittest tests.scripts.test_ci_workflow` passes, and fails with a site step removed. (Coordinator approved 2026-10-31 17:08 SAST; existing assertions unchanged.)
- [x] Extend the raw-colour guard to `site/**/*.astro` and `site/src/**/*.{ts,css}` (the token stylesheet from D07 T01 §2 is the only colour source), in `test/node/no-raw-colours.test.ts`. Done when: a planted `#ff0000` in a `site/` page fails `pnpm test`. (Assigned from D07 T01 §2's plan review, 2026-10-27.)
- [x] Keep the site out of the Worker gates: `site/` stays outside `tsconfig.json`, `biome.json` and the Vitest projects' includes. Done when: `pnpm typecheck` and `pnpm lint` pass with `site/` present.
- [x] Record `astro` 7.4.2, `@astrojs/check` 0.9.12, `@tailwindcss/vite` 4.3.3 and the site's `typescript` 6.0.3 in `NOTICE.md`'s dependency table, each licence read from its installed package. Done when: the four rows name version, licence and that none ships code to visitors (static HTML and CSS only). (Coordinator approved 2026-10-31 17:08 SAST; licence read from each package at the locked version.)
- [x] Verify the lockfile: Astro is new to it, so the change adds `packages:` and `snapshots:` entries and the `site` importer; no existing importer's specifiers or resolved versions change. Done when: no specifier or resolved version changes under the root importer and `pnpm install --frozen-lockfile` passes. **Corrected 2026-10-31** (build): was "no changed line"; four root entries (`better-auth`, `@better-auth/passkey`, `@cloudflare/vitest-plugin`, `vitest`) keep their versions but their peer suffix gains `(yaml@2.9.1)`, vite's optional peer that Astro brings into the workspace.
- [x] Commit: `site: Astro workspace with the design tokens`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site check && pnpm --filter site test` exits 0, with the build test's assertions over the built CSS, fonts, headers and layout; it fails when the token import, the font copy, the skip link or the theme variant is removed.

**Corrected 2026-10-31** (plan review, 6 P2): the checkpoint grepped for a token name that the theme override blocks also contain, and listed fonts without comparing bytes; the layout could pass as an empty shell; the CI proof passed without the site steps; the lockfile scope named only the importer; `NOTICE.md` rows were missing. Each is now an item above.

> **Verified:** 2026-10-31 | §1 | 672cbb1d84e9331c924b1562962d95980b75ab7f
> **Review:** `docs/reviews/d07-t06-s1.json`

## 2. Home page

The answer first: what IsItLegit does in one sentence, the forward-to-check@ action, the three things it catches (phishing, invoice fraud, impersonation), the Meta models doing the work, and the signup link. Written to the global rules for marketing copy.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` marketing site, home
**Job:** a small business owner understands what this is and tries it
**Treatment:** answer first, one action, real-looking demo visuals from synthetic cases
**Chrome:** the site layout in `site/src/layouts/Base.astro`

> **Started:** 2026-10-31T15:36Z

**Corrected 2026-10-31** (site lane, at start): the SPEC gives every marketing page the site header (P3) and footer (P4), which no section built, so this section builds them in `Base.astro`'s chrome; the board draws the sample report as an HTML card, not a screenshot, so it is built in token HTML (sharper, readable by a screen reader); the board's figures were read against their primary PDFs on 2026-10-31 (run file `docs/phase-runs/2026-10-31-site-phase-6.md`, Lessons), which moved two of them; the board's "In about a minute" (a design target, `docs/specs/2026-10-26-phishing-invoice-analyser-design.md` line 13, not a measurement) and "Eight checks" (not what `src/checks/registry.ts` runs) are unsourced figures the writing rules refuse, so the copy drops both until D08 T02 §4 measures them; product claims whose sections are not yet stamped (the link walkthrough, D04 T02; impersonation alerts, D05) are written as the board says and checked before the site goes live in §6.

**Build order:**

1. Build `site/src/pages/index.astro` against the SPEC. Done when: the page builds and the signup link points to `https://app.isitlegit.co.za/signup`.

- [x] Put the app and page addresses in one module, `site/src/lib/links.ts`: the app's `https://app.isitlegit.co.za` with `/signup`, `/signin`, `/upload` and `/eval` (Results, coordinator 2026-10-31), the site routes `/`, `/how-it-works`, `/invoice-fraud`, `/protect`, `/pricing`, `/about`, `/security`, `/privacy`, `/terms` (`design/SPEC.md` 0.1, each with its owning section), and `check@isitlegit.co.za`. Done when: the header, footer and home page import every address from it and `site/test/home.test.ts` reads it. Cheaper substitute: addresses typed into each component, which drift.
- [x] Build the site header `site/src/components/SiteHeader.astro` (`design/SPEC.md` P3, board `SiteHeader`): the logo (`design/brand/logo-svg/isitlegit-logo.svg`, alt "IsItLegit home") to `/`, a `nav` labelled "Site" with How it works, Invoice fraud, Protect your business, Pricing and Results, Sign in as the ghost button and Get started free as the primary button. Done when: the built home page has the header with each link's address from `links.ts`. Cheaper substitute: a text logo and plain links without the button treatments.
- [x] Build the phone header in the same component (`design/SPEC.md` P3 phone state, board `Home-Mobile`): below `md`, the logo, Get started and an Open menu button that opens the site links through the HTML `popover` attribute (`popovertarget`), with no script, an accessible name, `aria-expanded` kept by the browser, and Escape closing it. Done when: the built page has the button, its `popovertarget` names the menu's id, and the menu holds every header link. Cheaper substitute: hiding the links on a phone with no way to reach them.
- [x] Build the site footer `site/src/components/SiteFooter.astro` (`design/SPEC.md` P4, board `SiteFooter`): the logo on ink (`isitlegit-logo-on-dark.svg`), the check@ line, Product links (How it works, Invoice fraud, Protect your business, Pricing, Results), Company links (About and contact, Security, Privacy and POPIA, Terms), the Built on list (Muse Spark, Muse Wonder, SAM 3.1 and Muse Voice Transcribe; Cloudflare Workers), "© 2026 Rizonetech (Pty) Ltd · George, South Africa" and "IsItLegit by Rizonetech · Built for the Meta Global AI Developer Hackathon". Done when: the built page's `footer` holds both labelled link lists with their addresses. Cheaper substitute: a single copyright line.
- [x] Put the header and footer in `site/src/layouts/Base.astro` around `<main>`, the skip link still first. Done when: `site/test/build.test.ts` still passes with the skip link before the header.
- [x] Build the hero in `site/src/pages/index.astro` (board `Home`): eyebrow "For South African small businesses", the headline "Is it legit? Ask before you pay." as the page's only `h1`, the supporting line without the unmeasured "In about a minute", the check@ card with the address as text and a Copy address button, "Or upload a file" to the app's `/upload`, and "Free during launch · No card needed". Done when: `home.test.ts` finds each piece inside the hero region. Cheaper substitute: the address alone with no copy action.
- [x] State the membership step beside the forwarding action, because the app drops mail from a sender no organisation verified (`src/intake/email.ts` lines 84 to 88, `memberOfSender`, with no reply): under the check@ card, "Sign up first: we answer mail from the address or domain you verify", linking the app's `/signup`, and the same in How it works step 01. Done when: `home.test.ts` finds the sentence in the hero and in step 01, each with the signup link, and the SPEC deviation names it. Cheaper substitute: a signup button elsewhere on the page.
- [x] Make Copy address work as an enhancement in `site/src/scripts/copy-address.ts`, bundled by Astro: the button is `hidden` in the HTML and shown by the script only where `navigator.clipboard` exists; a click copies the address and announces "Address copied" in an `aria-live="polite"` region, and a refused copy announces "Copy failed: select the address and copy it". Done when: `site/test/copy-address.test.ts` covers success, refusal and no clipboard, and the built page shows the address as selectable text with the script absent. Cheaper substitute: a button that does nothing without a script.
- [x] Build the sample report card (board `Home`, the report SPEC M4's verdict band and evidence ids) in token HTML: Malicious band "The bank details on this invoice are not Fynbos Freight's.", What to do now with its sentence, Why with E4, E2 and E6 each with its explanation, and the caption "A sample report on fictional companies". Done when: `home.test.ts` finds the verdict, the action sentence, the three ids with their explanations and the caption inside the card region, and every domain in it ends `.example`. Cheaper substitute: a screenshot without text.
- [x] Build the figures band from the verified SABRIC Annual Crime Statistics 2025 numbers (calendar 2025, nine participating banks): R2.4 billion in reported client claims, up 29.2% on 2024; 110,074 incidents, more than double the 52,588 of 2023; R21,865 lost on average per incident; the page 9 quote; the source line naming SABRIC, the report, pages 3 and 7, and the nine banks; Read the report linking `https://www.sabric.co.za/wp-content/uploads/2026/08/SABRIC-Annual-Crime-Statistics-Report-2025.pdf`. Done when: each figure on the page appears in `site/src/lib/sources.ts` with its source URL, page and the date it was read, and the test checks the page against that file. Cheaper substitute: figures with no link.
- [x] Build What it catches: the three cards (Phishing, Invoice fraud, Impersonation, each with its label, heading and paragraph) and the sources line with the corrected FBI figure, "more than US$3 billion in 2025, across 24,768 complaints reported to the FBI's IC3" (2025 IC3 Annual Report, pages 25 and 26, `https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf`; the board's "worldwide" is not in the report), and the INTERPOL quote (Africa Cyberthreat Assessment Report 2025, page 17). Done when: `home.test.ts` finds the three cards with their headings and paragraphs, both links, and both figures from `sources.ts`. Cheaper substitute: an unsourced claim.
- [x] Build How it works: the three steps (Forward as an attachment; checks then four Meta models, without the unmeasured "Eight checks"; A verdict you can check), each with its paragraph, the four model cards (Muse Spark, Muse Wonder, SAM 3.1, Muse Voice Transcribe) each with its sentence of what it does, and on a phone the full-width How it works link to `/how-it-works` after the steps (board `Home-Mobile`). Done when: `home.test.ts` finds the three steps and four cards, each with its text, and the phone link. Cheaper substitute: a list of model names.
- [x] Build Protect your business with the seal (`design/brand/logo-svg/isitlegit-seal-protected.svg`) and badge (`isitlegit-badge-protected.svg`), each with alt text, and How protection works to `/protect` (§7). Done when: both images ship from the build with alt text and the link is in the page. Cheaper substitute: text without the artwork.
- [x] Build Measured, not claimed from `site/src/lib/results.ts`, which reads `eval/results-summary.json` (written by D08 T02 §4: detection rate, false-alarm rate, median seconds, sample count, run date and run id; coordinator, 2026-10-31 17:39 SAST): absent, the band keeps the SPEC's [XX] placeholders; present, it shows the four numbers with the run date; present but unparseable or missing a field, the build fails naming the problem. See the results links the Results address in `links.ts`, `https://app.isitlegit.co.za/eval`. Done when: `site/test/results.test.ts` covers absent, valid, unparseable and each missing field over fixture files, and the built band shows the placeholders while the file is absent. Cheaper substitute: invented percentages, or a blank band when the summary breaks.
- [x] Keep `isitlegit.co.za/eval` working (`design/SPEC.md` 0.1 S10): `site/public/_redirects` sends `/eval` to `https://app.isitlegit.co.za/eval` with a 302, and `design/SPEC.md` 0.1 gets a dated correction that S10 is served by the app host with the site redirecting to it (coordinator, 2026-10-31 17:39 SAST); the app lane is told. Done when: `site/dist/_redirects` holds the rule, `home.test.ts` checks it, and the SPEC's S10 section carries the correction; its HTTP read-back belongs to §6. Cheaper substitute: a dead `/eval` on the site. **Corrected 2026-10-31** (CI red, run 41217828328): the correction sat in the 0.1 row's purpose cell, which `design/tools/check-design.py` reads as the list of things S10 must cover, failing `tests/scripts/test_design_spec.py`; it is now a dated note under `### S10 Results`.
- [x] Build the closing call to action: the line "The next fake invoice is already on its way. Check it first.", "Free during launch. Protect from R499 per month after launch." (design spec section 11), Get started free to the app's `/signup` and See pricing to `/pricing`. Done when: `home.test.ts` finds the line, the pricing sentence and both links in the closing region. Cheaper substitute: one button.
- [x] Add the byline "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026" under the figures band's source line, and record it as a `Deviation (D07 T06 §2)` under S1 in `design/SPEC.md`, with the two dropped figures. Done when: the byline is in the built page and the SPEC names the deviation. Cheaper substitute: no author.
- [x] Write `site/test/home.test.ts` over the built page, each check scoped to its region (hero, figures, threats, steps, protect, results, closing, header, footer): every link's address comes from `links.ts`; the header and footer logos and the seal and badge resolve to files in `site/dist`; every external link is `https`; each figure in `sources.ts` appears in the page beside its source link; "worldwide", "about a minute" and "Eight checks" do not appear; the phone menu's button and popover pair up; every `img` has a non-empty `alt`; the Copy address button is `hidden` in the HTML. Done when: the test passes and each assertion fails with its piece removed (recorded once in the commit).
- [x] Update `site/test/build.test.ts`, which §1 wrote for the placeholder: the main-landmark check now finds the hero `h1` and the home regions inside `<main id="main">`, the skip link still first and before the header; the script check allows only Astro's hashed module under `/_astro/` and requires it on the home page, refusing any inline `<script>` or one from another origin. Done when: the test passes and fails for an inline script, a missing module or the hero outside `main`. Cheaper substitute: deleting the checks.
- [x] Write `site/test/browser.test.ts` driving Chromium through the app's helpers (`test/node/browser.ts` `launch`, `test/node/axe.ts`, read-only) over `site/dist` served on loopback: at 390 px, Tab reaches Open menu, Enter opens the menu with the browser reporting it expanded, Tab reaches every menu link, Escape closes it and focus returns to the button, and the desktop links are not in the tab order; the Copy address button shows, a click (clipboard permission granted) copies exactly `check@isitlegit.co.za` and announces "Address copied", a rejected write announces the failure line, and with JavaScript off the button stays hidden and the address stays selectable; at 390 px and 1440 px, in light and dark preference, no horizontal overflow and no axe violation (contrast included), with a screenshot of each written to `build/site-shots/` for the review. Done when: the test passes and fails with the popover attribute, the script or a token colour removed. Cheaper substitute: markup checks only.
- [x] Build the phone footer (board `Home-Mobile`): below `md` the two link lists sit in two columns, the Built on list and logo stay. Done when: the 390 px screenshot shows both columns and the browser test finds no overflow. Cheaper substitute: the desktop footer squeezed.
- [x] Give the site test step in `.github/workflows/ci.yml` the browser it needs, `MOCKUP_CHROMIUM: /usr/bin/google-chrome`, as the `pnpm test:a11y` step has. Done when: CI's site test step runs the browser test (its log names it), and `tests.scripts.test_ci_workflow` passes.
- [x] Run `article-check` on the page's built text (`site/dist/index.html`) and fix every FAIL and answer every WARN in the commit body. Done when: its output has no FAIL.
- [x] Commit: `site: home page`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site check && pnpm --filter site test` exits 0, with `site/test/home.test.ts` checking every region, link, figure, source and image, and `site/test/browser.test.ts` driving the phone menu, the copy action and axe at both widths in both themes; it fails when a figure loses its source, the signup link moves, the menu cannot be reached by keyboard or a colour fails contrast.

**Corrected 2026-10-31** (plan review, 7 P2): the forwarding action now states the membership step; the §1 build test's placeholder checks are replaced; the phone menu and the copy action are proven in a browser; the phone layout's extra link and footer are built and checked; the results handoff is asked of the coordinator; every Done when is scoped to its region.

> **Verified:** 2026-10-31 | §2 | 80e8efb9346e7c3e48db3b1c8c82068ed60f9a3b
> **Review:** `docs/reviews/d07-t06-s2.json`

## 3. How it works and invoice fraud pages

> **Started:** 2026-10-31T16:45Z

How forwarding as an attachment works (Outlook and Gmail steps), what happens to the mail (checks, models, retention), and the invoice-fraud story with the bank-change catch and what to do.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S2 How it works and S3 Invoice fraud, boards `design/mockups/png/How.png` and `InvoiceFraud.png`
**Job:** a reader learns exactly how to use it and why invoice fraud matters
**Treatment:** steps with key caps, plain words, sources for every claim
**Chrome:** the site layout in `site/src/layouts/Base.astro`, with the header and footer from §2

**Corrected 2026-10-31** (site lane, at start): the section named two items for two content-heavy boards; it is decomposed below. The boards carry the same unmeasured "eight checks" and "in about a minute" as the home board, dropped here for the same reason (SPEC S1 deviation, D07 T06 §2), and the FBI figure called "Worldwide", which the 2025 IC3 Annual Report does not say. The boards make product claims whose sections are not all stamped (link checks with Google Web Risk and QR codes, D02; logo comparison, D03; the walkthrough and the verdict floor, D04; voice languages, D01 T03; the payment document check, D06 T02); rather than a hand list at deploy, this section writes them into `site/src/lib/claims.ts` with their owning sections, which §6's deploy refuses while an owner is unstamped. The figures were read from the primary PDFs on 2026-10-31: SABRIC 2025's R1.09 billion (2023) and 97,547 incidents (2024) are on page 7 (table) and the proof-of-payment quote is on page 9; the forwarding steps are read from Microsoft's and Google's own help pages.

**Build order:**

1. Build both pages against S2 and S3. Done when: both build with every figure from `sources.ts` and every product claim in `claims.ts`.

- [x] Write `site/src/lib/claims.ts` (every product claim: an id, its text, and the section that ships it, `DNN TNN §N`) and `site/src/components/Claim.astro`, which renders a claim's text from the registry by id and marks it `data-claim="<id>"`, so a product claim reaches a page only through the registry; move the home page's claims onto it. `site/test/claims.test.ts`: every `data-claim` on a built page names a registry entry, every registry entry is rendered somewhere, and each owner resolves (`python3 scripts/todo-graph.py resolve` exits 0, 3 or 4). Done when: the test passes and fails for a claim rendered without its entry (an unknown id fails the build), an entry no page renders, or an owner that does not resolve. Cheaper substitute: a list beside the pages that nothing ties to them. **Corrected 2026-10-31** (CI red, run 41222667683; coordinator): the owner-exists check moves to `tests/scripts/test_site_claims.py`, which reads the graph in-process in the Project script tests job, since the graph validates stamps against history the Worker gates job's shallow checkout lacks.
- [x] Add §6's gate to its checklist: `site/scripts/check-claims.ts` refuses the deploy while any claim's owner is not stamped (exit 3). Done when: §6's item names it. (The script is §6's to build.)
- [x] Add to `site/src/lib/sources.ts` the invoice-fraud figures (R1.09 billion in 2023, page 7; 97,547 incidents in 2024, page 7; R1.9 billion in 2024, page 3), the proof-of-payment quote (page 9), the IC3 BEC loss figure US$3,046,598,558 (pages 8, 9 and 26), and the three vendor help pages for forwarding as an attachment, each with its URL and the date read. Done when: `site/test/how.test.ts` and `site/test/invoice-fraud.test.ts` check each figure appears on its page beside its link. Cheaper substitute: figures typed into the page.
- [x] Build `site/src/pages/how-it-works.astro` (board `How`): the answer-first question heading "How does IsItLegit check an email?", the opening paragraph without "eight checks" and "in about a minute", the sign-up-first line beside that first forwarding instruction and in step 01, as on the home page (`src/intake/email.ts` drops unverified senders), the byline "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", and the three-step strip. Done when: `how.test.ts` finds each in its region, the sign-up line with its link in the opening and in step 01. Cheaper substitute: a heading and a paragraph.
- [x] Build "Why forward as an attachment?" and the three client cards, each step as the vendor documents it today (read 2026-10-31) with a link to that page: classic Outlook for Windows, More Respond Actions, then Forward as Attachment, or Ctrl+Alt+F as `kbd` key caps ("Keyboard shortcuts for Outlook", classic Outlook section); new Outlook and Outlook on the web, open a new message in its own window and drag the email into it (Microsoft documents no menu item or shortcut for these; "Add pictures or attach files to emails in Outlook"); Gmail on the web, tick the email, then More, then Forward as attachment (support.google.com/mail/answer/9261412), with the note that the Gmail phone apps document no such option, so use a computer or the upload page. Done when: `how.test.ts` finds the three cards with these steps, the `kbd` keys and the three vendor links. For new Outlook and Outlook on the web, give the keyboard route too: a normal forward (Ctrl+F in new Outlook) is still checked, but without the original's headers the sender checks cannot run and the reply says so (`src/mail/reply.ts` `headersAvailable`), so the classic Outlook or Gmail route, or uploading the saved message, is better. Cheaper substitute: one generic sentence, or a drag-only route with no keyboard path. **Corrected 2026-10-31** (at start): the board's new Outlook and web path ("More actions, then Forward, then Forward as attachment") and its Ctrl+Alt+F for every Windows Outlook are not what Microsoft documents; recorded as an S2 deviation.
- [x] Build the members-only note under the cards, linking upload to the app's `/upload` and naming the accepted files (.eml, .msg, PDF, voice note), worded to match the app: mail is answered for a member's verified address or domain (`src/intake/email.ts`). Done when: `how.test.ts` finds it with the link. Cheaper substitute: none.
- [x] Build "What happens to the email?" with the eight cards as the board draws them (three checks, Muse Spark, SAM 3.1, Muse Wonder, Voice, Verdict) and the voice limit as the board states it (English only; no voice-clone detection), without the board's "nothing in your report is a guess". Done when: `how.test.ts` finds each card's heading and text. Cheaper substitute: a list of names.
- [x] Build "When a check cannot finish" from what the app replies (`src/mail/reply.ts`): a forward without the original's headers is checked without the sender checks, and the reply says so; a message that cannot be read, or a check that cannot finish, gets no verdict and the advice to forward again, and until then not to pay, click or reply. Done when: `how.test.ts` finds the three outcomes and the advice. Cheaper substitute: a promise of a verdict every time.
- [x] Build the three answer cards: What do you get back (7-day signed report links, `src/web/report-link.ts`), How long do we keep it (30-day deletion of mail and attachments, case summaries kept; link to `/privacy`), Does Meta keep my mail (standard model IDs, `store: false`, `src/meta/client.ts`). Done when: `how.test.ts` finds the three with their numbers and the privacy link. Cheaper substitute: none.
- [x] Build the closing call to action (Get started free to the app's `/signup`, Read about invoice fraud to `/invoice-fraud`, "Free during launch. Members join with an invite code."). Done when: both links are in the closing region.
- [x] Build `site/src/pages/invoice-fraud.astro` (board `InvoiceFraud`): "What is invoice fraud?" with the answer paragraph, the one rule (phone the number you already have), the byline, and the fictional invoice with its E4 critical callout, every name and domain fictional (`.example`, "Fictional Bank"). Done when: `invoice-fraud.test.ts` finds each and every domain ends `.example`. Cheaper substitute: a screenshot.
- [x] Build "How big is the problem in South Africa?" with the three figures, the page 9 quote, and the sources line (SABRIC pages 3, 7 and 9; the FBI line "reported to the FBI's IC3" without "Worldwide"). Done when: every figure is from `sources.ts` beside its link. Cheaper substitute: unsourced figures.
- [x] Build "How does IsItLegit catch a changed bank account?" (three steps) and the payment document check (the SABRIC proof-of-payment quote, the four signs, the stated limit and fixed action, the fictional sample card), and the closing call to action (Get started free; Protect your own business to `/protect`). Done when: `invoice-fraud.test.ts` finds each region's content and links.
- [x] Extend `site/test/browser.test.ts` to both pages: no overflow and no axe violation at 390 and 1440 px in light and dark, with screenshots. Done when: the browser test passes over all three pages.
- [x] Run `article-check` on each page's draft copy (written to the session scratchpad before the page is built) and again on each built page; fix every FAIL and answer every WARN at both stages in the commit. Done when: no FAIL at either stage.
- [x] Record the S2 and S3 deviations (dropped figures, the FBI wording, "Reviewed 31 Oct 2026") under their SPEC sections and run `python3 -m unittest tests.scripts.test_design_spec`. Done when: the test passes.
- [x] Commit: `site: how it works and invoice fraud pages`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site check && pnpm --filter site test` exits 0, with `how.test.ts`, `invoice-fraud.test.ts` and `claims.test.ts` checking every region, figure, source, vendor link and claim owner; it fails when a figure loses its source, a claim leaves its page or an owner does not resolve.

**Corrected 2026-10-31** (plan review, 4 P2 and 1 P3): claims render through the registry; the sign-up line sits beside the first forwarding instruction; the page explains incomplete checks as the app's reply does; new Outlook gets a keyboard route; article-check runs on the draft and the built page.

> **Verified:** 2026-10-31 | §3 | b5ad80d626a9457c08064358b722672774117a27
> **Review:** `docs/reviews/d07-t06-s3.json`

## 4. Pricing page with launch prices

> **Started:** 2026-10-31T17:48Z

"Free during launch" with the tiers shown as launch prices and no billing (design spec section 11): Free check; Protect from R499 per month; MSP from R199 per client per month; what each includes from spec 2b.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S5 Pricing, board `design/mockups/png/Pricing.png`
**Job:** a buyer sees what it will cost after launch and that it is free now
**Treatment:** three tiers, clear inclusions, no checkout
**Chrome:** the site layout in `site/src/layouts/Base.astro`, with the header and footer from §2

**Corrected 2026-10-31** (site lane, at start): the section had one build item for a board with a banner, three tiers, their inclusions and four questions; it is decomposed below. Every inclusion and the free tier's daily limit are product claims, so they render through `site/src/lib/claims.ts` (D07 T06 §3) with their owning sections: the 5 checks a day per sender is design spec 2b's figure built by D05 T02 §1; the 14-day trial and plan flags are D07 T02 §8 (`src/auth/plans.ts`, `TRIAL_DAYS`); MSP's console and branding are D07 T04 §6. The prices are design spec section 11's decision and its 2b table (`docs/specs/2026-10-26-phishing-invoice-analyser-design.md`), not product claims.

**Build order:**

1. Build `site/src/pages/pricing.astro` against S5. Done when: the banner, three tiers and four questions render, with every inclusion from the claims registry.

- [x] Build the heading and banner (board `Pricing`): the "Free during launch" pill, the answer-first question "What does IsItLegit cost?" and its answer (nothing during launch, checking stays free, the prices are launch prices, no card). Done when: `site/test/pricing.test.ts` finds each in the intro region. Cheaper substitute: a heading and a price list.
- [x] Build the Free check tier with what the app does today: R0 per month, its inclusions through `Claim` (verdicts with evidence on mail your team forwards from its verified address or domain, owner D01 T01 §3; up to 50 checks a day per organisation, `DEFAULT_DAILY_CASES` in `src/db/cases.ts`, owner D07 T02 §4; and, once D05 T02 ships, anyone checking mail that claims to be a Protected business, up to 5 checks a day per sender, owners D05 T02 §1 and §6), Get started free to the app's `/signup`, and the no-code route beside it ("No invite code? Ask for one at hello@isitlegit.co.za", a `mailto:` link; the address forwards to the operator, `docs/live-checks.md`). Done when: the test finds, inside the Free tier, "R0", each inclusion with its unit (per organisation, per sender), the signup link and the `mailto:` link. Cheaper substitute: "Up to 5 checks a day" with no unit or eligibility.
- [x] Build the Protect tier, highlighted, with what the trial really gives (`src/auth/plans.ts`: every feature for 14 days from the organisation's creation; an expired trial is Free; the operator can extend it, `extendTrialStatement`): "Free for 14 days during the launch", "from R499 per month" as the launch price, its six inclusions through `Claim` with their owning sections, "After the trial your organisation keeps Free check until billing starts. Need longer? Ask us at hello@isitlegit.co.za.", and Start your 14-day trial to `/signup`. Done when: the test finds, inside the Protect tier, "from R499 per month", the 14-day wording, the after-trial sentence with its `mailto:` link, the six inclusions and the link, and no checkout or card link anywhere on the page. Cheaper substitute: "Free during launch" with no trial end.
- [x] Build the MSP tier as planned, not included: "from R199 per client per month" as the planned price, a "Planned" pill, its three items worded as planned (the console and branding are D07 T04 §6, Phase 7, not designed yet), rendered as plain text, not through `Claim`, so they cannot pass for current features, and Talk to us to `/about` (S9; §8 builds it, and §6's link check refuses a deploy while it is missing). Done when: the test finds, inside the MSP tier, "from R199 per client per month", the "Planned" pill and the link, and no `data-claim` in the tier. Cheaper substitute: the board's MSP tier as if it were available.
- [x] Build "Questions about pricing" with the four answers from the board, corrected to the app (no card; joining with an invite code, how to ask for one, and the 14-day trial and what follows it, owner D07 T02 §8; what happens when the launch ends; why checking is free). Done when: the test finds the four questions with their answers and the invite-code request route.
- [x] Record the S5 deviations under its SPEC section (the Free tier's units and eligibility, the 14-day wording for Protect, MSP as planned, the no-code route) and run `python3 -m unittest tests.scripts.test_design_spec`. Done when: the test passes.
- [x] Extend `site/test/browser.test.ts` to `/pricing` (no overflow and no axe violation at 390 and 1440 px, light and dark). Done when: the browser test passes over the four pages.
- [x] Run `article-check` on the draft copy and on the built page; fix every FAIL and answer every WARN in the commit. Done when: no FAIL at either stage.
- [x] Commit: `site: pricing page with launch prices`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site check && pnpm --filter site test` exits 0, with `pricing.test.ts` checking each tier's whole price string inside its own tier ("R0", "from R499 per month", "from R199 per client per month"), the trial wording, the planned MSP marker, every current inclusion through the claims registry and no checkout link; it fails when a price, a qualifier, an inclusion or the launch banner is changed, including a swap of the two prices.

**Corrected 2026-10-31** (plan review, 4 P2 and 1 P3): the trial's end and what follows it are stated; MSP shows as planned, not included; the Free tier names its units and eligibility; the no-code route and the contact destination are in place; price checks are tier-scoped whole strings.

> **Verified:** 2026-10-31 | §4 | 73bbfc936d1f0c9e589334d8d8ab954b4524c2c2
> **Review:** `docs/reviews/d07-t06-s4.json`

## 5. Privacy and POPIA page

> **Started:** 2026-10-31T18:25Z

What data IsItLegit processes, why, for how long (raw mail and attachments deleted after 30 days; case summaries kept), who processes it (Cloudflare, Meta Model API in Standard mode with `store: false`, Fireworks AI for screening public lookalike pages with Loupe, our tuned Glimmer, on a dedicated deployment (Fireworks keeps no prompt or output of open models without opt-in; Loupe is trained through Fireworks' Training API, which stores no dataset file, on public pages, synthetic lures and redacted sample mail under the pilot client's consent, its checkpoints kept 30 days), SMTP2GO, Google Web Risk with URLs stripped of query strings; **Corrected 2026-10-28** (20:45 SAST): Loupe replaces base Glimmer on serverless, and its training on Fireworks is disclosed; whether the no-logging terms cover the dedicated deployment is confirmed in D03 T04 §12 before this page ships. **Corrected 2026-10-28** (operator decision, 09:05 SAST): Fireworks AI returns as the monitor's screener (Muse Glimmer), matching the Privacy board again; **Corrected 2026-10-27:** Baseten (earlier Fireworks AI) for Muse Glimmer is removed by operator decision, and public lookalike pages are screened by Muse Spark on the Meta Model API in Standard mode; the Privacy board's copy still names Fireworks AI and is superseded by design/SPEC.md), the information officer, and members' rights under POPIA. **Corrected 2026-10-26:** Fireworks was missing from the processors; case summary retention and the information officer now come from spec section 4.8 (POPIA bullet).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S6 Privacy and POPIA, board `design/mockups/png/Privacy.png`
**Job:** a business owner or their client trusts what happens to forwarded mail
**Treatment:** plain words, every processor named, retention stated
**Chrome:** the site layout in `site/src/layouts/Base.astro`, with the header and footer from §2

**Corrected 2026-10-31** (site lane, at start): the section had two build items for a legal page with six blocks; it is decomposed below. Every statement of what happens to data is a product claim, so it renders through `site/src/lib/claims.ts` (D07 T06 §3) with the sections that make it true: the 30-day deletion of raw mail is the bucket lifecycle rule in `wrangler.jsonc` (D01 T01 §2); report links last 7 days (D01 T01 §8); the Meta calls use standard model IDs with `store: false` (D03 T01 §1); the Web Risk lookups strip query strings (D02 T06 §1); a closed organisation's purge within 30 days is D07 T02 §9; the supplier ledger's deletion is D06 T01 §4; Fireworks sees public pages only and its no-logging terms for the dedicated deployment are confirmed in D03 T04 §12 (this section's own "confirmed before this page ships"); bank-account secrecy is D05 T01 §2 and the rate limit D05 T02 §1. The board's "we never use your mail to train a model" is narrowed to what the plan does: Loupe is trained on public pages, synthetic lures and a pilot client's redacted sample mail under that client's written consent (`samples/pilot-consent.md`), never on members' forwarded mail. The POPIA references were read on 2026-10-31 (run file, Lessons): the Act's gov.za PDF could not be read, so the page cites the sections by number (72 transfers, 23 access, 24 correction and deletion, 11(3) objection, confirmed against a mirror) in its own words and links the Regulator's POPIA page, never quoting the Act; the Regulator's complaints page (the eServices portal route) is linked and no complaints email address is printed, because the Regulator's own pages give three different ones. D07 T02 §13's deferral of "Read the privacy notice" to this section closes when this section stamps.

**Build order:**

1. Build `site/src/pages/privacy.astro` against S6. Done when: the page lists each processor, purpose and retention, every data statement through the claims registry.

- [ ] Add the privacy claims to `site/src/lib/claims.ts` with their owner lists (above) and the POPIA references to `site/src/lib/sources.ts` with each URL and the date read. Done when: `tests/scripts/test_site_claims.py` passes and each reference has a URL and date.
- [ ] Build the heading, summary and byline (board `Privacy`): the answer-first question "What happens to the email you forward?", its answer, "Rizonetech (Pty) Ltd · Last updated 31 Oct 2026", and the "On this page" list linking each block's anchor. Done when: `site/test/privacy.test.ts` finds each and every anchor resolves to a heading id on the page.
- [ ] Build "Who is responsible for your information?" (Rizonetech (Pty) Ltd, George, the responsible party under POPIA; Derick Payne, Information Officer, `hello@isitlegit.co.za` as a `mailto:` link). Done when: the test finds each, with the link.
- [ ] Build "What do we process, and why?" (mail and attachments, links and voice notes; the account; the supplier ledger; feedback) and the training statement as narrowed above. Done when: the test finds the four purposes and the statement, and no sentence promising that no model is ever trained.
- [ ] Build "How long do we keep it?" as a table (the email and attachments: 30 days; case summary, verdict and evidence: while the organisation has an account, then deleted within 30 days of closing it; report links: 7 days; account and supplier ledger: until deleted or the account is closed). Done when: the test finds each row with its period, each through the registry.
- [ ] Build "Who helps us process it?" as a table naming Cloudflare, Meta Model API, SMTP2GO, Google Web Risk and Fireworks AI with what each does and what it receives, and the cross-border sentence in our own words, citing section 72 of POPIA by number, with a link to the Regulator's POPIA page. Done when: the test finds all five processors with their rows, and the section 72 sentence with its link, and no quoted Act text.
- [ ] Build "What happens to a protected business's details?" (the registered bank account is never shown; a checker learns only match or does not match; checks are rate-limited). Done when: the test finds it, through the registry.
- [ ] Build "What are your rights?" (ask what we hold, ask for correction or deletion, object; write to `hello@isitlegit.co.za`; complain to the Information Regulator, linked to its complaints page, with no email address printed). Done when: the test finds each right with its POPIA section number and the Regulator's POPIA and complaints links, and no `inforegulator` email address on the page.
- [ ] Extend `site/test/browser.test.ts` to `/privacy` (no overflow, no axe violation at 390 and 1440 px, light and dark, anchors move focus). Done when: the browser test passes over the page.
- [ ] Run `article-check` on the draft and the built page; fix every FAIL and answer every WARN. Done when: no FAIL at either stage.
- [ ] Record the S6 deviations under its SPEC section (training statement narrowed, claims registry, "Last updated" date) and run `python3 -m unittest tests.scripts.test_design_spec`. Done when: the test passes.
- [ ] Commit: `site: privacy and POPIA page`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site check && pnpm --filter site test` exits 0, with `privacy.test.ts` finding all five processors, both retention periods, the rights and the Regulator links; it fails when a processor, a retention period or a data statement is removed.

## 6. Deploy the site and split the app host

The site deploys as Workers static assets on `isitlegit.co.za`; the app answers on `app.isitlegit.co.za`; DNS and routes are set under the standing authorisation. **Corrected 2026-10-29** (D01 T01 §9 plan review): the app host moved to §9 in Phase 1, since every link the app mails (sign-in, claim codes, report links) points at it; this section keeps the site on the apex and `www`.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Route both hosts. Done when: `https://isitlegit.co.za` serves the home page and `https://app.isitlegit.co.za/health` the app.

- [ ] Configure Workers static assets for `site/dist` on `isitlegit.co.za` and `www` (redirect to the apex), with the app on `app.isitlegit.co.za` from §9 kept. Done when: both hosts answer over HTTPS.
- [ ] Add a deploy script running the site build and checks before `wrangler deploy`. Done when: `pnpm deploy:site` refuses to deploy on a failed check.
- [ ] Check that every internal link on the built site resolves (every `href` to a site route has a built page, and `/eval` has its redirect), in the deploy script before `wrangler deploy`. Done when: the deploy refuses with a fixture page linking a route that does not exist. (Added 2026-10-31 by D07 T06 §4: §2's promise of this check, and `/about` from §4's Talk to us.)
- [ ] Check every product claim on the live pages against a stamped section before the first deploy (`docs/hackathon-criteria.md`: no claim the live service cannot back), starting with the home page's link walkthrough (D04 T02) and impersonation alerts (D05); reword any claim whose section is not stamped. Done when: `docs/live-checks.md` lists each claim with its stamped section or the rewording. (Added 2026-10-31 by D07 T06 §2.)
- [ ] Write `site/scripts/check-claims.ts`, run by the deploy script before `wrangler deploy`: it reads `site/src/lib/claims.ts` and refuses the deploy, naming each claim, while any claim's owner is not stamped (`python3 scripts/todo-graph.py resolve` exit 3). Done when: the deploy script refuses with a fixture registry naming an open section, and passes when every owner is stamped. (Added 2026-10-31 by D07 T06 §3.)
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

## 10. One-step demo check on the home page

A visitor can see IsItLegit judge a message before signing up: one action on the home page runs a fixed synthetic sample (a fictional invoice-fraud mail) and shows its report, with zero registration steps, while real mail still needs membership (`src/intake/email.ts`). Filed 2026-10-31 by D07 T06 §2's completion review (Part 2, item 1): Have I Been Pwned answers in one field and one submission, and IsItLegit's first real check needs signup, sender verification, then a forward from the mail client.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** none yet: the operator approves a board in `design/mockups/` and its `design/SPEC.md` entry first (the SPEC changes before the surface)
**Job:** a visitor sees a real verdict on a sample in one action and decides to sign up
**Treatment:** one button, the sample's report from the real report components, clearly labelled as a sample
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Record the operator's decision and the approved board. Done when: `design/SPEC.md` S1 names the demo control and this section's Needs drops `owner-decision`.

- [ ] Record the operator's choice between a prerendered sample report (static, no model call, no spend) and a live run of the pipeline on the fixed sample (Meta spend per click, a rate limit needed). Done when: the choice and its date are in this section and `design/SPEC.md` S1.
- [ ] Measure the current first-check path for a new member (steps from the home page to a first verdict), the baseline this section beats. Done when: the count is recorded here with the date.
- [ ] Commit: `site: one-step demo check on the home page`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site test` exits 0 with a test that activates the demo control once and finds the sample's verdict on the page; it fails when the control needs more than one action or any sign-up step.

## 11. Already paid: what to do now

A business owner who has already paid a fraudulent invoice finds, in one action from the invoice fraud page, what to do in the next hour in South Africa: phone their own bank's fraud line at once and ask it to contact the receiving bank, keep the mail and documents, report the case, and warn the real supplier. Filed 2026-10-31 by D07 T06 §3's completion review (Part 2, item 2): the FBI tells business email compromise victims to contact their financial institution immediately and ask it to contact the receiving institution (https://www.fbi.gov/how-we-can-help-you/common-frauds-and-scams/business-email-compromise), and the page offers only prevention.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** none yet: the operator approves a board in `design/mockups/` and its `design/SPEC.md` entry first (S3 gains the block or a new page)
**Job:** a business owner who has just paid a fake invoice acts within the hour
**Treatment:** one block or page, ordered steps, South African sources only
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Record the operator's decision on the surface and the South African sources. Done when: `design/SPEC.md` names the surface and this section's Needs drops `owner-decision`.

- [ ] Record the operator's choice between a block on `/invoice-fraud` and its own page, and the board. Done when: the choice and date are here and in `design/SPEC.md`.
- [ ] Source every step from primary South African sources (SABRIC's guidance for fraud victims, the South African Police Service for reporting, each bank's own fraud line page), read and dated, in `site/src/lib/sources.ts`. Done when: every step has a source with its date.
- [ ] Commit: `site: already paid, what to do now`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site test` exits 0 with a test that reaches the steps in one action from `/invoice-fraud` and finds each step beside its source link; it fails when a step loses its source.

## 12. Pricing terms: VAT and commitment

What a buyer can work out without contacting sales: whether prices include VAT, what makes Protect cost more than R499 (design spec 2b gives R499 to R999 without saying why), and the subscription commitment. Filed 2026-10-31 by D07 T06 §4's completion review (Part 2, item 2). No commercial terms are invented: the operator decides them first.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** none yet: the operator approves a board in `design/mockups/` and its `design/SPEC.md` entry first
**Job:** a buyer knows what the price covers and how long it binds them
**Treatment:** one block on the pricing page, plain words, no invented terms
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Record the operator's decision and the approved board. Done when: `design/SPEC.md` S5 names it and this section's Needs drops `owner-decision`.

- [ ] Record the operator's pricing rules (VAT treatment, what moves Protect above R499, minimum term, cancellation). Done when: the choice and its date are here and in `design/SPEC.md`.
- [ ] Commit: `site: pricing terms`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site test` exits 0 with a test that finds the approved content on `/pricing`; it fails when it is removed.

## 13. On-site invite request

A visitor without an invite code asks for one on the page and is told what happens next, with no email-client handoff, while access stays invite-only. Filed 2026-10-31 by D07 T06 §4's completion review (Part 2, item 3): §4 offers a mailto link to hello@isitlegit.co.za. Needs a place to receive requests (a form endpoint or the app's intake), so the operator decides where requests go first.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** none yet: the operator approves a board in `design/mockups/` and its `design/SPEC.md` entry first
**Job:** a visitor requests an invite and knows the next step
**Treatment:** one block on the pricing page, plain words, no invented terms
**Chrome:** the site layout in `site/src/layouts/Base.astro`

**Build order:**

1. Record the operator's decision and the approved board. Done when: `design/SPEC.md` S5 names it and this section's Needs drops `owner-decision`.

- [ ] Record the operator's choice of where invite requests go and who answers them, and how fast. Done when: the choice and its date are here and in `design/SPEC.md`.
- [ ] Commit: `site: on-site invite request`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site test` exits 0 with a test that finds the approved content on `/pricing`; it fails when it is removed.

## Verification

- The five pages are live, fast and accessible, with sourced copy and a working signup link.
- `python3 scripts/todo-graph.py validate` and `plan --check` pass.
