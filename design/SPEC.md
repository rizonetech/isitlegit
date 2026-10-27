# IsItLegit interface specification

Status: page inventory written 2026-10-26 21:55 SAST; every page was designed on the design canvas and the operator approved all 70 boards in session on 2026-10-26 at 22:19 SAST (D07 T01 §1). Each page below links its board as a PNG (`design/mockups/png/`) and as source (`design/mockups/source/`, values to copy exactly); `design/mockups/coverage.json` maps every required control and state to the board that shows it or to the section that owns it; `python3 design/tools/export-mockups.py export` regenerates the PNGs. This file wins over any screenshot, mockup or memory (`AGENTS.md`). Brand: `design/brand/README.md`.

References chosen by the operator (2026-10-26 21:42): Stripe (stripe.com) for the marketing site's structure, typography and "show the real product" approach, and Have I Been Pwned (haveibeenpwned.com) for the one-question, one-instant-answer pattern. Pixel precision is the bar: spacing from the 4 px scale in `design/tokens/spacing.json`, type from Exo (headings) and Exo 2 (text) on the scale in `design/tokens/typography.json`, colours from `design/tokens/colors.json` only; a board value between two steps is built as the nearest step.

## Fidelity contract

Every surface is built to look and behave like its approved board, judged by a person's eye, not by pixels. The board is the target for structure, components, wording and tokens; it is a sample for data and exact measurements. This contract decides what a builder must match, what may differ, and what a reviewer may raise.

### Must match

- Every control and state its `design/mockups/coverage.json` entry names, present and working, or the deferral it names.
- The structure: the same regions in the same order and hierarchy, the same shared parts (navigation, header, footer), the same component for each job (a band for the verdict, a card for each piece of evidence, a pill for a status).
- The wording of headings, labels, buttons, empty and error messages, unless the plan, a spec or this file sets other words.
- Values from the tokens only: colour, type role, spacing step, radius, control height. No raw colour on a surface (`test/node/no-raw-colours.test.ts`, which checks the compiled stylesheet and the app's sources).
- Accessibility: contrast from the token pairs, keyboard order, focus visible, an accessible name on every control, phone width per the phone boards.

### May differ, and is never a finding by itself

- Data. Names, counts, amounts, dates, row numbers, chart values, sample text and its length come from the running system, not from the board. A board showing 8 cases or "27 of 50" is a picture, not a requirement.
- Numbers and rules the plan or a spec sets. Where a board and the plan disagree on a fact (a limit, a price, an expiry, a count), the plan wins and the build follows it.
- Measurements within the token scale. A board value between two steps is built as the nearest step; a few pixels of difference from real fonts, real text wrapping, browser form controls or content-driven height is expected. A board's height is the canvas size, not the page height.
- Layout at widths the boards do not show, as long as it follows the nearest board (desktop or phone) and keeps the structure above.

### Deviations

A builder who must depart from a "must match" item for a real reason (the plan, real data, accessibility, the platform) records it under the page's section here as a bullet `- Deviation (DNN TNN §N): <what differs> because <why>` in the same commit, and carries on. A reviewer accepts a recorded deviation with a reason; it raises only a "must match" difference with no deviation recorded, or a deviation whose reason does not hold. A change to the approved look itself (a new layout, a different component) goes back to the operator first.

### How it is checked

Side by side, the built page at the board's width with fixture data and the board's PNG, read for the "must match" list above, plus the coverage entry and the token test. There is no pixel-difference or screenshot-threshold gate; design/tools/export-mockups.py and its future comparison step (D07 T01 §4) inform a review, they do not fail a build.

## 0. Page inventory

Every page and message IsItLegit shows. Each row names its owning TODO section; a page without an owner is a planning defect. States are the ones every page must design: loading, empty, error, and any listed.

### 0.1 Marketing site (`isitlegit.co.za`)

| # | Route | Page | Purpose and key content | Owner |
| - | ----- | ---- | ----------------------- | ----- |
| S1 | `/` | Home | One-line promise, the forward-to-check@ action, sourced South African fraud figures, the three threats, a real report, how Meta's models work, Protected seal, pricing teaser, signup | D07 T06 §2 |
| S2 | `/how-it-works` | How it works | Forward as attachment (Outlook desktop, Outlook web, Gmail), what happens to the mail, the models, retention | D07 T06 §3 |
| S3 | `/invoice-fraud` | Invoice fraud | The bank-change scam, the fixed action, sourced figures, payment document check | D07 T06 §3 |
| S4 | `/protect` | Protect your business | The trust network: protected identity, website seal, signature badge, impersonation monitor, closed-loop verification | D07 T06 §7 |
| S5 | `/pricing` | Pricing | Free during launch; Free check, Protect from R499, MSP from R199 per client | D07 T06 §4 |
| S6 | `/privacy` | Privacy and POPIA | Processors, purposes, retention, information officer, rights | D07 T06 §5 |
| S7 | `/terms` | Terms of use | Plain-language terms for the free launch period | D07 T06 §8 |
| S8 | `/security` | Security | How we handle hostile mail, disclosure policy (links `SECURITY.md`) | D07 T06 §8 |
| S9 | `/about` | About and contact | Rizonetech, the author, contact address, the hackathon build | D07 T06 §8 |
| S10 | `/eval` | Results | Latest eval against targets, model ablation, production counts | D08 T02 §4 |
| S11 | any | 404 and 500 (site) | Plain message, the search-free way back, the check@ address | D07 T08 §1 |

### 0.2 Trust pages (`isitlegit.co.za`, public)

| # | Route | Page | Purpose and key content | Owner |
| - | ----- | ---- | ----------------------- | ----- |
| T1 | `/v/:slug` | Verify a business | Business name, verified sending domains, date verified, forward-to-check steps; states: protected, not protected or lapsed, came from a foreign domain | D05 T02 §6 |
| T2 | `/s/:slug` | Website seal (framed) | Seal, business name, today's date; neutral state when the origin cannot be told | D05 T02 §9 |
| T3 | `/b/:slug.png` | Signature badge image | Protected or Not verified badge (image, not a page) | D05 T02 §7 |

### 0.3 Sign-in and onboarding (`app.isitlegit.co.za`)

| # | Route | Page | Purpose and key content | Owner |
| - | ----- | ---- | ----------------------- | ----- |
| A1 | `/signin` | Sign in | Email field, magic-link button, passkey button; states: check your inbox, link expired or used, rate limited | D07 T02 §7 |
| A2 | `/signup` | Sign up | Invite code, email, organisation name, POPIA consent; states: code invalid, used up, expired | D07 T02 §7 |
| A3 | `/invite/:token` | Accept invitation | Organisation and inviter, accept; states: expired, revoked | D07 T02 §7 |
| A4 | `/welcome` | Onboarding checklist | Verify your domain, invite your team, forward your first email, add suppliers, protect your business; judge demo notice for the judge organisation | D07 T08 §2 |
| A5 | `/settings/domains/verify` | Verify a domain | TXT record to copy, check now, emailed-code option; states: pending, verified, failed, locked | D07 T02 §7 |

### 0.4 Member app (`app.isitlegit.co.za`)

| # | Route | Page | Purpose and key content | Owner |
| - | ----- | ---- | ----------------------- | ----- |
| M1 | `/cases` | Cases (home) | Stats panel (this week, money at risk caught), filters, search, case table; states: empty first run, filtered empty | D07 T04 §1, §2 |
| M2 | `/upload` | Check a file | Drop zone, accepted types, progress; states: uploading, refused type, too large, daily cap reached | D01 T03 §6 |
| M3 | `/cases/:id` and `/r/:id` | Report | Verdict banner, headline, three reasons, actions, evidence cards, model trace, feedback; states: running, safe, suspicious, malicious, partial, failed; variants: invoice, payment document, voice note, counterparty (no private data), monitor finding | D07 T03 |
| M4 | `/suppliers` | Supplier ledger | Table with masked accounts, add and edit, CSV import with row errors, mark verified undo | D06 T01 §4 |
| M5 | `/protect` | Protected identity | Names, domains, logo, finance contact, bank accounts (masked), protected switch, signature badge snippet, website seal snippet | D05 T01 §3, D05 T02 §7, §9 |
| M6 | `/monitor` | Impersonation monitor | Findings with status, first seen, takedown pack, dismiss | D05 T04 §5 |
| M7 | `/team` | Team | Members, roles, invites, remove; last-owner guard | D07 T04 §3 |
| M8 | `/settings/domains` | Domains and addresses | Verified domains and sending addresses, forwarding help | D07 T04 §4 |
| M9 | `/settings/account` | Account | Name, email, passkeys (add, remove), sessions, sign out | D07 T08 §3 |
| M10 | `/settings/plan` | Plan | Trial days left, what Protect includes, launch pricing, daily cap and usage | D07 T08 §4 |

### 0.5 Admin console (`app.isitlegit.co.za/admin`, Cloudflare Access)

| # | Route | Page | Purpose and key content | Owner |
| - | ----- | ---- | ----------------------- | ----- |
| X1 | `/admin` | Overview | Organisations table, model spend against caps, service health | D07 T05 §2 |
| X2 | `/admin/orgs/:id` | Organisation detail | Onboarding, domains, members, cases by week, threats, feedback, plan | D07 T08 §5 |
| X3 | `/admin/invites` | Invite codes | Create, list uses, revoke | D07 T05 §2 |
| X4 | `/admin/feedback` | Feedback queue | "This was wrong" reports with case links and provider attribution | D07 T08 §5 |
| X5 | `/admin/eval` | Eval runs | Every run, targets, ablation | D08 T02 §4 |

### 0.6 Error and system pages (app)

| # | Route | Page | Purpose and key content | Owner |
| - | ----- | ---- | ----------------------- | ----- |
| E1 | any | 404 Not found | Same page for a missing and a forbidden case (reveals nothing) | D07 T08 §1 |
| E2 | `/r/:id` | 410 Link expired | Report link past its 7 days; how to get a new one | D07 T08 §1 |
| E3 | any | 403 No access | Signed in but not a member of this organisation | D07 T08 §1 |
| E4 | any | 429 Slow down | Rate limit or daily cap, with when it resets | D07 T08 §1 |
| E5 | any | 500 Something broke | Apology, reference id, status, the forward address still works | D07 T08 §1 |
| E6 | any | Maintenance | Planned downtime notice | D07 T08 §1 |

### 0.7 Email messages

| # | Message | Recipient | Owner |
| - | ------- | --------- | ----- |
| N1 | Verdict reply (member and counterparty variants) | The forwarder | D07 T03 §7 |
| N2 | Sign-in link | The user | D07 T08 §6 |
| N3 | Invitation | The invitee | D07 T08 §6 |
| N4 | Domain verification code | `admin@` or `postmaster@` the domain | D07 T08 §6 |
| N5 | Bank verification request | The supplier's registered finance contact | D05 T03 §1 |
| N6 | Impersonation alert | The protected business | D05 T02 §4 |
| N7 | Monitor alert with takedown pack | The protected business | D05 T04 §5 |
| N8 | Daily limit reached | The member | D07 T02 §4 |
| N9 | Operator notice (budget cap, feedback) | The operator | D03 T01 §2, D07 T03 §6 |

## 1. Shared parts

Every page is drawn from these parts and from the tokens in `design/tokens/colors.json`; a page never invents its own header, navigation or colour. The approved canvas stylesheet is `mockups/source/ui.css`, and its values are the tokens: colours from `design/tokens/colors.json` (for example ink `#181519`, muted `#4D4953`, orange `#FF4A14` for graphics only, orange text `#CC2E00` for links, eyebrows and the primary button, suspicious `#8A5200` for text and `#B26A00` for graphics, and input borders in control border `#8E8A95`), type from `design/tokens/typography.json` (Exo for headings and figures, Exo 2 for text), spacing, radii and control heights from `design/tokens/spacing.json` (a 4 px scale; 12 px card radius, 16 px panel radius; controls 48 px and 36 px high). Buttons come in primary, dark, ghost, danger and link styles; pills come in safe, suspicious, malicious, partial, running and neutral, and the admin sidebar's brand ("Rizonetech admin", dark on orange) and alert (a count, white on the malicious band) as `AdminNav` draws them (D07 T01 §3).

- Deviation (D07 T01 §6): every control (button, link, text field, checkbox) shows its keyboard focus as a solid 2 px `orange-text` outline 2 px outside it, at least 4.7:1 in light and 6.1:1 in dark against the surface, subtle, light and orange-wash backgrounds controls sit on (`design/tokens/colors.json`), because WCAG 2.2 asks for 3:1 against the adjacent colours. The boards draw a 3 px ring at 25% orange on a text field (about 1.4:1) and no focus state for buttons or checkboxes. An invalid field keeps its red border under the outline.
- Deviation (D07 T01 §6): a board value exactly between two steps of the 4 px scale (26, 22, 18, 14, 10, 6 px) is built as the step above (28, 24, 20, 16, 12, 8 px) because "nearest step" leaves the tie open, and the step above keeps touch targets and text room; so the 26 px pill is 28 px, the 22 px navigation pill 24 px, the 18 px checkbox 20 px, the 14 px side padding of the input and of the small button 16 px, and the field's 6 px gap 8 px.

### P1 App navigation

Boards: [PNG](mockups/png/AppNav.png) · [source](mockups/source/AppNav.dc.html)

Controls:

- Logo: opens Cases.
- Organisation switcher (Karoo Couriers): switches the active organisation for a member of more than one.
- Check a file: primary button, opens Check a file (M2).
- Main links: Cases, Suppliers, Protect, Monitor (with a "1 new" count pill), Team.
- Settings links: Domains and addresses, Account, Plan (with the trial pill "Trial, 11 days").
- Copy the check address: copies check@isitlegit.co.za from the footer card.
- Sign out: ends the session and opens Sign in.

States:

- Active item: one of cases, suppliers, protect, monitor, team, domains, account, plan is highlighted through the `active` property; Check a file and onboarding pages keep Cases highlighted.
- Counts: the Monitor pill shows new findings and disappears at zero; the Plan pill shows trial days left, or the plan name after the trial.
- Deviation (D07 T01 §3): the sidebar is fixed to the window's left edge with its own scroll, so its footer card and user block stay at the bottom of the window on a long page, where the page boards lay the navigation out in the page's flow; one placement serves the in-page sidebar and the phone popover alike, so a menu left open while the window widens past `md` still sits beside the content (the browser's top layer cannot be put back in the page by CSS).
- Deviation (D07 T01 §3): below `md` the sidebar opens from the phone header's Menu button as a popover (`Report-Mobile` draws the button, not what it opens); a browser without the Popover API (before Chrome 114, Safari 17, Firefox 125) gets no Menu and the sidebar as a full-width block in the page above the content.

### P2 Admin navigation

Boards: [PNG](mockups/png/AdminNav.png) · [source](mockups/source/AdminNav.dc.html)

Controls:

- Links: Overview, Organisations, Invite codes, Feedback (with the open count in an alert pill, solid as `AdminNav` draws it), Eval runs.

States:

- Active item: one of overview, orgs, invites, feedback, eval through the `active` property.
- Identity footer: "Signed in through Cloudflare Access" with the operator's name; the console has no sign-out of its own because Access owns the session.

### P3 Site header

Boards: [PNG](mockups/png/SiteHeader.png) · [source](mockups/source/SiteHeader.dc.html)

Controls:

- Logo: opens Home.
- Links: How it works, Invoice fraud, Protect your business, Pricing, Results.
- Sign in: ghost button to the app's sign-in page.
- Get started free: primary button to Sign up.

States:

- Phone layout: this header is desktop only; on a phone the compact header on the Home phone board (S1) replaces it.

### P4 Site footer

Boards: [PNG](mockups/png/SiteFooter.png) · [source](mockups/source/SiteFooter.dc.html)

Controls:

- Product links: How it works, Invoice fraud, Protect your business, Pricing, Results.
- Company links: About and contact, Security, Privacy and POPIA, Terms.

States:

- One state: logo on ink, the check@ address, the "Built on" list of Meta models and Cloudflare Workers, copyright line.

## 2. Marketing site

Every page uses the site header (P3) and footer (P4). Articles carry a byline and review date ("By Derick Payne, Rizonetech · Reviewed 26 Oct 2026"). Every external figure links to its source; product results are placeholders until the eval runner fills them.

### S1 Home

Boards: [PNG](mockups/png/Home.png) · [source](mockups/source/Home.dc.html) · [phone PNG](mockups/png/Home-Mobile.png) · [phone source](mockups/source/Home-Mobile.dc.html)

Controls:

- one-line promise: Hero headline and supporting line. (Home)
- forward-to-check@ action: check@ card with Copy address; Or upload a file opens M2. (Home)
- sourced South African fraud figures: SABRIC 2025 figures with the page 9 quote and Read the report link. (Home)
- the three threats: Phishing, invoice fraud, impersonation cards with the FBI IC3 and INTERPOL source links. (Home)
- a real report: Sample malicious invoice report card, labelled as fictional. (Home)
- how Meta's models work: Three steps and the four model cards. (Home)
- Protected seal: Seal and badge with How protection works (opens S4). (Home)
- pricing teaser: Closing line with See pricing. (Home)
- signup: Primary call to action to Sign up. (Home)

States:

- phone layout: 390 px layout with the Open menu button and compact footer. (Home-Mobile)
- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state; the results band shows [XX] placeholders until D08 T02 §4 fills them. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S2 How it works

Boards: [PNG](mockups/png/How.png) · [source](mockups/source/How.dc.html)

Controls:

- forward as attachment: Explains why headers matter. (How)
- Outlook desktop: Steps with the Ctrl Alt F key caps. (How)
- Outlook web: Steps for Outlook on the web. (How)
- Gmail: Steps for Gmail. (How)
- what happens to the mail: The checks and evidence cards. (How)
- the models: Muse Spark, SAM 3.1, Muse Wonder, voice and verdict cards. (How)
- retention: 30-day deletion and the Privacy and POPIA link. (How)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S3 Invoice fraud

Boards: [PNG](mockups/png/InvoiceFraud.png) · [source](mockups/source/InvoiceFraud.dc.html)

Controls:

- the bank-change scam: The scam explained with the fictional invoice and its E4 callout. (InvoiceFraud)
- the fixed action: Phone the supplier on the number you already have. (InvoiceFraud)
- sourced figures: SABRIC 2025 figures, quote and FBI IC3 figure with source links. (InvoiceFraud)
- payment document check: What the check looks for, its limit, and a sample card. (InvoiceFraud)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S4 Protect your business

Boards: [PNG](mockups/png/ProtectSite.png) · [source](mockups/source/ProtectSite.dc.html)

Controls:

- protected identity: Register domains, logo and bank account. (ProtectSite)
- website seal: Seal shown on the real domain, blocked on a copy. (ProtectSite)
- signature badge: Badge that turns copies into evidence. (ProtectSite)
- impersonation monitor: Daily lookalike watch with Muse Spark Contributor screening (corrected 2026-10-27, was Muse Glimmer). (ProtectSite)
- closed-loop verification: Finance contact confirms changed bank details; the buttons drawn are illustration of the email reply (N5). (ProtectSite)
- Protect my business: Opens Sign up; See a verify page opens T1; See pricing opens S5. (ProtectSite)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

The bank verification illustration shows "No, this is not us" and "Yes, we changed it" as the supplier sees them; the real request is answered by email reply (N5).

### S5 Pricing

Boards: [PNG](mockups/png/Pricing.png) · [source](mockups/source/Pricing.dc.html)

Controls:

- Free during launch: Banner and pill. (Pricing)
- Free check: R0 tier with Get started free. (Pricing)
- Protect from R499: Protect tier with Start free during launch. (Pricing)
- MSP from R199 per client: MSP tier with Talk to us (opens S9). (Pricing)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S6 Privacy and POPIA

Boards: [PNG](mockups/png/Privacy.png) · [source](mockups/source/Privacy.dc.html)

Controls:

- processors: Cloudflare, Meta Model API with store: false, SMTP2GO, Google Web Risk (corrected 2026-10-27: Baseten and Fireworks AI removed; Muse Spark Contributor on public lookalike pages runs on the Meta Model API). (Privacy)
- purposes: Mail, account, supplier ledger, feedback. (Privacy)
- retention: Retention table. (Privacy)
- information officer: Responsible party and contact hello@isitlegit.co.za. (Privacy)
- rights: POPIA rights with the Information Regulator link; On this page anchors. (Privacy)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S7 Terms of use

Boards: [PNG](mockups/png/Terms.png) · [source](mockups/source/Terms.dc.html)

Controls:

- plain-language terms for the free launch period: Question headings with On this page anchors. (Terms)

States:

- draft review date: Draft pill until the operator dates the review. (Terms)
- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S8 Security

Boards: [PNG](mockups/png/Security.png) · [source](mockups/source/Security.dc.html)

Controls:

- how we handle hostile mail: Six safeguards. (Security)
- disclosure policy: GitHub private reporting with the 3-working-day response. (Security)
- links SECURITY.md: Link to the policy file. (Security)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S9 About and contact

Boards: [PNG](mockups/png/About.png) · [source](mockups/source/About.dc.html)

Controls:

- Rizonetech: The company, with the Rizonetech logo card and repository link. (About)
- the author: Built by Derick Payne directing AI coding agents. (About)
- contact address: hello@isitlegit.co.za, check@ and vulnerability reporting cards. (About)
- the hackathon build: Meta Global AI Developer Hackathon and the four models, with the results page link. (About)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

### S10 Results

Boards: [PNG](mockups/png/Results.png) · [source](mockups/source/Results.dc.html)

Controls:

- latest eval against targets: Headline tiles with fixed targets and the eval/DATASETS.md link. (Results)
- model ablation: One row per model switched off. (Results)
- production counts: Counts from real use, never shown or added to the test set. (Results)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: Placeholder values until the eval runner publishes a run. (Results)
- error: Site error page (S11). (Site-500)

### S11 404 and 500 (site)

Boards: [PNG](mockups/png/Site-404.png) · [source](mockups/source/Site-404.dc.html) · [PNG](mockups/png/Site-500.png) · [source](mockups/source/Site-500.dc.html)

Controls:

- plain message: One sentence on each page. (Site-404)
- the search-free way back: Home, How it works and Pricing on the 404; Try again and Home on the 500. (Site-404)
- the check@ address: Forward panel on both pages. (Site-404)

States:

- 404: Not found page. (Site-404)
- 500: Error page with a reference id. (Site-500)
- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: The 500 page is the error state. (Site-500)

## 3. Trust pages

Public pages on isitlegit.co.za for people checking a business. They never show bank details or contact people.

### T1 Verify a business

Boards: [PNG](mockups/png/Verify-Protected.png) · [source](mockups/source/Verify-Protected.dc.html) · [PNG](mockups/png/Verify-NotProtected.png) · [source](mockups/source/Verify-NotProtected.dc.html) · [PNG](mockups/png/Verify-Foreign.png) · [source](mockups/source/Verify-Foreign.dc.html) · [phone PNG](mockups/png/Verify-Mobile.png) · [phone source](mockups/source/Verify-Mobile.dc.html)

Controls:

- business name: Name with the Protected pill and seal. (Verify-Protected)
- verified sending domains: Registered domains as green chips. (Verify-Protected)
- date verified: Verified and rechecked dates. (Verify-Protected)
- forward-to-check steps: Steps for Outlook and Gmail with the copy button; Protect your own business opens S4. (Verify-Protected)

States:

- protected: Protected state. (Verify-Protected)
- not protected or lapsed: Grey Not verified state with Sign in to renew your protection. (Verify-NotProtected)
- came from a foreign domain: Malicious band naming the origin. (Verify-Foreign)
- phone layout: 390 px layout. (Verify-Mobile)
- loading: No loading state. Not applicable: server-rendered page delivered whole.
- empty: Unknown business. Deferred to D05 T02 §6: an unknown slug has no board; the owner renders it with the site 404 (S11).
- error: Site error page (S11). (Site-500)

### T2 Website seal (framed)

Boards: [PNG](mockups/png/Seal-Frames.png) · [source](mockups/source/Seal-Frames.dc.html)

Controls:

- seal: The seal is one link to T1. (Seal-Frames)
- business name: Name on the own-domain seal. (Seal-Frames)
- today's date: Date that makes a screenshot go stale. (Seal-Frames)

States:

- neutral state when the origin cannot be told: No name, no Protected, no date. (Seal-Frames)
- counterfeit domain: Browser refuses the frame; the business is alerted. (Seal-Frames)
- loading: No loading state. Not applicable: a small framed page delivered whole.
- empty: No empty state. Not applicable: the neutral state covers a seal with nothing to vouch for.
- error: Unknown or lapsed slug. Deferred to D05 T02 §9: a lapsed or unknown slug has no board; the owner serves the neutral seal.

### T3 Signature badge image

Boards: [PNG](mockups/png/Badges.png) · [source](mockups/source/Badges.dc.html)

States:

- protected or not verified badge: the one image a signature carries; it shows Protected while protection is current and Not verified once it lapses. (Badges)
- Protected badge: The live badge at two heights. (Badges)
- Not verified badge: Grey badge for a lapsed or unknown business. (Badges)
- loading: No loading state. Not applicable: an image, not a page.
- empty: No empty state. Not applicable: an image, not a page.
- error: An unknown slug serves the Not verified badge. (Badges)

## 4. Sign-in and onboarding

Sign-in pages use a split layout: brand panel on ink at left, the form at right.

### A1 Sign in

Boards: [PNG](mockups/png/Signin.png) · [source](mockups/source/Signin.dc.html) · [PNG](mockups/png/Signin-States.png) · [source](mockups/source/Signin-States.dc.html)

Controls:

- email field: Email input. (Signin)
- magic-link button: Primary submit. (Signin)
- passkey button: Starts WebAuthn; Create an account opens A2. (Signin)

States:

- check your inbox: With Send another link and Use a different email. (Signin-States)
- link expired or used: With Email me a new link. (Signin-States)
- rate limited: With the time new links resume. (Signin-States)
- passkey prompt: With Try the passkey again and Email me a link instead. (Signin-States)
- loading: Busy submit. Deferred to D07 T02 §7: the submit button shows a busy state while the request runs; not drawn.
- empty: No empty state. Not applicable: a form page; the empty form is the default state.
- error: App error page (E5). (Error-500)

### A2 Sign up

Boards: [PNG](mockups/png/Signup.png) · [source](mockups/source/Signup.dc.html)

Controls:

- invite code: Code input. (Signup)
- email: Email input. (Signup)
- organisation name: Organisation input. (Signup)
- POPIA consent: Consent checkbox with Read the privacy notice; Create account enabled only with consent. (Signup)

States:

- code invalid: Inline message. (Signup)
- used up: Inline message under the field. (Signup)
- expired: Inline message. (Signup)
- loading: Busy submit. Deferred to D07 T02 §7: the submit button shows a busy state while the request runs; not drawn.
- empty: No empty state. Not applicable: a form page; the empty form is the default state.
- error: App error page (E5). (Error-500)

### A3 Accept invitation

Boards: [PNG](mockups/png/Invite.png) · [source](mockups/source/Invite.dc.html)

Controls:

- organisation and inviter: Inviter, organisation, role, address and expiry. (Invite)
- accept: Primary; Not you? Decline is the ghost button. (Invite)

States:

- expired: Ask the inviter for a new one. (Invite)
- revoked: Nothing was shared. (Invite)
- loading: No loading state. Not applicable: server-rendered page delivered whole.
- empty: No empty state. Not applicable: an invitation page always has its invitation or a state above.
- error: App error page (E5). (Error-500)

### A4 Onboarding checklist

Boards: [PNG](mockups/png/Welcome.png) · [source](mockups/source/Welcome.dc.html)

Controls:

- verify your domain: Done step. (Welcome)
- invite your team: Done step. (Welcome)
- forward your first email: Step with Show me how. (Welcome)
- add suppliers: Step with Add suppliers. (Welcome)
- protect your business: Step with Protect Karoo Couriers. (Welcome)

States:

- judge demo notice for the judge organisation: Banner with Open the sample cases (section 9). (Welcome)
- progress: Progress bar with Hide this list. (Welcome)
- loading: Not drawn. Deferred to D07 T08 §2: server-rendered; the shell's loading pattern from D07 T01 §3 applies; not drawn.
- empty: No empty state. Not applicable: the checklist always has its five steps.
- error: App error page (E5). (Error-500)

The board draws this page inside the app layout with the app navigation, while section 0 lists it under sign-in and onboarding; the build follows the board.

### A5 Verify a domain

Boards: [PNG](mockups/png/Verify-Domain.png) · [source](mockups/source/Verify-Domain.dc.html)

Controls:

- TXT record to copy: Name and value with Copy buttons. (Verify-Domain)
- check now: Looks the record up. (Verify-Domain)
- emailed-code option: admin@ or postmaster@ choice, Send code, code input and Verify. (Verify-Domain)

States:

- pending: Last checked line. (Verify-Domain)
- verified: Other states panel. (Verify-Domain)
- failed: Other states panel. (Verify-Domain)
- locked: Other states panel. (Verify-Domain)
- loading: Busy Check now. Deferred to D07 T02 §7: Check now shows a busy state during the DNS lookup; not drawn.
- empty: No empty state. Not applicable: the page always concerns one claimed domain.
- error: App error page (E5). (Error-500)

## 5. Member app

Every member page sits in the app layout: the app navigation (P1) at left, content on white at right. Sample data is always fictional and labelled.

### M1 Cases (home)

Boards: [PNG](mockups/png/Cases.png) · [source](mockups/source/Cases.dc.html) · [PNG](mockups/png/Cases-Empty.png) · [source](mockups/source/Cases-Empty.dc.html)

Controls:

- stats panel: Four tiles with Export counts as CSV. (Cases)
- this week: Checked this week tile. (Cases)
- money at risk caught: Rand tile. (Cases)
- filters: Verdict segmented filter, channel and period. (Cases)
- search: Search input. (Cases)
- case table: Rows open M3; Previous and Next. (Cases)

States:

- empty first run: Forward instructions, Copy address, upload link. (Cases-Empty)
- filtered empty: No cases match, with Clear filters. (Cases-Empty)
- loading: A running case shows the Checking pill; the page itself is server-rendered. (Cases)
- empty: Same as empty first run. (Cases-Empty)
- error: App error page (E5). (Error-500)

### M2 Check a file

Boards: [PNG](mockups/png/Upload.png) · [source](mockups/source/Upload.dc.html) · [PNG](mockups/png/Upload-States.png) · [source](mockups/source/Upload-States.dc.html)

Controls:

- drop zone: Drop zone with Choose a file. (Upload)
- accepted types: Email, PDF, image, audio, and what is refused. (Upload)
- progress: Progress bar. (Upload-States)

States:

- uploading: Disabled button. (Upload-States)
- refused type: Names the problem and what to do. (Upload-States)
- too large: Names the limit. (Upload-States)
- daily cap reached: Reset time and About your plan. (Upload-States)
- signed out: Sign in again. (Upload-States)
- loading: The uploading state. (Upload-States)
- empty: The ready drop zone is the empty state. (Upload)
- error: App error page (E5). (Error-500)

### M3 Report

Boards: [PNG](mockups/png/Main.png) · [source](mockups/source/Main.dc.html) · [PNG](mockups/png/Report-Safe.png) · [source](mockups/source/Report-Safe.dc.html) · [PNG](mockups/png/Report-Running.png) · [source](mockups/source/Report-Running.dc.html) · [PNG](mockups/png/Report-Partial.png) · [source](mockups/source/Report-Partial.dc.html) · [PNG](mockups/png/Report-Invoice.png) · [source](mockups/source/Report-Invoice.dc.html) · [PNG](mockups/png/Report-Counterparty.png) · [source](mockups/source/Report-Counterparty.dc.html) · [PNG](mockups/png/Report-Voice.png) · [source](mockups/source/Report-Voice.dc.html) · [phone PNG](mockups/png/Report-Mobile.png) · [phone source](mockups/source/Report-Mobile.dc.html)

Anatomy, top to bottom (Main):

- Breadcrumb back to Cases.
- Header: subject as the title, sender, who forwarded it and when; Download PDF and Copy link.
- Verdict banner: the verdict's motion frame on a white tile, "Verdict · confidence" eyebrow, a one-sentence headline, and one sentence on what it means for the reader.
- What to do now: a numbered list of at most three actions; invoice and voice variants call it "Do this first" and put the phone instruction first.
- Why we say so: exactly three reasons, each led by its evidence pill (E7, E4, E2) that jumps to the evidence card.
- Evidence: a count line ("9 findings · 8 checks ran · nothing skipped"), then evidence cards by kind, each with an id and severity pill (Critical, High, Medium, Low, Info), a title and its proof: walkthrough steps with screenshots, lookalike domain with RDAP date, hidden text quoted, logo crop comparison, authentication header excerpt, reputation listing with "listed in error? request a review", first-time sender.
- Model trace: a table of step, model, what it did, time and cost, with the total; sample figures are labelled.
- Footer: retention and access line, and "This verdict is wrong".

Controls:

- verdict banner: Motion frame, eyebrow, headline and one sentence. (Main)
- headline: One sentence. (Main)
- three reasons: Three evidence-pill reasons that jump to their cards. (Main)
- actions: At most three numbered actions; Download PDF and Copy link in the header. (Main)
- evidence cards: Cards by kind with severity pills; listed in error? request a review. (Main)
- model trace: Step, model, what it did, time and cost. (Main)
- feedback: Opens the feedback control (D07 T03 §6). (Main)

States:

- running: Step progress, early findings, refreshes every 2 seconds. (Report-Running)
- safe: Info findings and Checks that found nothing. (Report-Safe)
- suspicious: Shown on the voice note and partial boards. (Report-Voice)
- malicious: The main board. (Main)
- partial: Notice naming each missing check; Not checked cards. (Report-Partial)
- failed: Reference id, Retry the check, Upload it instead. (Report-Partial)
- invoice: Masked comparison, PDF preview, bank verification timeline. (Report-Invoice)
- payment document: Not drawn as a report. Deferred to D07 T03 §3: no board of its own; the payment document card on S3 is its visual reference.
- voice note: Player, transcript, extracted request, limits. (Report-Voice)
- counterparty (no private data): Public signed-link view. (Report-Counterparty)
- monitor finding: Not drawn as a report. Deferred to D07 T03 §3: no board of its own; the monitor detail panel on M6 is its visual reference.
- phone layout: 390 px layout. (Report-Mobile)
- loading: The running state. (Report-Running)
- empty: No empty state. Not applicable: a report always has a verdict, a running state or a failed state.
- error: The failed state. (Report-Partial)

### M4 Supplier ledger

Boards: [PNG](mockups/png/Suppliers.png) · [source](mockups/source/Suppliers.dc.html)

Controls:

- table with masked accounts: Masked accounts with statuses and Edit. (Suppliers)
- add and edit: Add supplier form with Cancel; Edit per row. (Suppliers)
- mark verified undo: Undo toast. (Suppliers)
- search: Search input. (Suppliers)

States:

- CSV import with row errors: Row error table and Download a template. (Suppliers)
- loading: Not drawn. Deferred to D06 T01 §4: server-rendered; not drawn.
- empty: Not drawn. Deferred to D06 T01 §4: no supplier yet has no board; the owner shows Add supplier and Import CSV.
- error: App error page (E5). (Error-500)

### M5 Protected identity

Boards: [PNG](mockups/png/Protect.png) · [source](mockups/source/Protect.dc.html)

Controls:

- names: Registered and trading names. (Protect)
- domains: Verified and pending, link to M8. (Protect)
- logo: Logo with Replace logo. (Protect)
- finance contact: Name and email. (Protect)
- bank accounts (masked): Masked accounts with Remove (confirmed and logged). (Protect)
- protected switch: The Protected switch; View your public verify page opens T1. (Protect)
- signature badge snippet: Snippet with steps for Outlook desktop, Outlook web and Gmail. (Protect)
- website seal snippet: Snippet with steps for WordPress and plain HTML. (Protect)

States:

- recent impersonation alerts: Alerts table. (Protect)
- loading: Not drawn. Deferred to D05 T01 §3: server-rendered; not drawn.
- empty: Not drawn. Deferred to D05 T01 §3: an organisation with no protected identity yet has no board.
- error: App error page (E5). (Error-500)

### M6 Impersonation monitor

Boards: [PNG](mockups/png/Monitor.png) · [source](mockups/source/Monitor.dc.html)

Controls:

- findings with status: Findings list with New and live, Watching, Taken offline, Dismissed. (Monitor)
- first seen: Column. (Monitor)
- takedown pack: Download button. (Monitor)
- dismiss: Dismiss button. (Monitor)

States:

- loading: Not drawn. Deferred to D05 T04 §5: server-rendered; not drawn.
- empty: Not drawn. Deferred to D05 T04 §5: no findings yet has no board.
- error: App error page (E5). (Error-500)

### M7 Team

Boards: [PNG](mockups/png/Team.png) · [source](mockups/source/Team.dc.html)

Controls:

- members: Members table. (Team)
- roles: Role select and role descriptions. (Team)
- invites: Invite by email; Resend and Revoke on pending invitations. (Team)
- remove: Per member. (Team)

States:

- last-owner guard: Guard notice. (Team)
- loading: Not drawn. Deferred to D07 T04 §3: server-rendered; not drawn.
- empty: No empty state. Not applicable: a team always has at least its owner.
- error: App error page (E5). (Error-500)

### M8 Domains and addresses

Boards: [PNG](mockups/png/Domains.png) · [source](mockups/source/Domains.dc.html)

Controls:

- verified domains and sending addresses: the two lists below, verified domains first, then single addresses outside those domains. (Domains)
- verified domains: Domains table with Remove and Continue. (Domains)
- sending addresses: Allowed addresses with Remove. (Domains)
- forwarding help: Outlook desktop, Outlook on the web, Gmail. (Domains)

States:

- loading: Not drawn. Deferred to D07 T04 §4: server-rendered; not drawn.
- empty: No empty state. Not applicable: an organisation always has the domain it signed up with.
- error: App error page (E5). (Error-500)

### M9 Account

Boards: [PNG](mockups/png/Account.png) · [source](mockups/source/Account.dc.html)

Controls:

- name: Name input with Save. (Account)
- email: Email input. (Account)
- passkeys (add, remove): Passkeys table with Remove. (Account)
- sessions: Sessions table with Sign out per session. (Account)
- sign out: Signs out other sessions. (Account)

States:

- loading: Not drawn. Deferred to D07 T08 §3: server-rendered; not drawn.
- empty: No empty state. Not applicable: an account always has its profile and current session.
- error: App error page (E5). (Error-500)

### M10 Plan

Boards: [PNG](mockups/png/Plan.png) · [source](mockups/source/Plan.dc.html)

Controls:

- trial days left: Trial card. (Plan)
- what Protect includes: Protect tier list. (Plan)
- launch pricing: Three tiers; the Free check card shows Up to 5 checks a day in the build. (Plan)
- daily cap and usage: Usage bar with Tell us. (Plan)

States:

- loading: Not drawn. Deferred to D07 T08 §4: server-rendered; not drawn.
- empty: No empty state. Not applicable: every organisation has a plan.
- error: App error page (E5). (Error-500)

The board's Free check card still reads "A monthly limit"; the build shows "Up to 5 checks a day" as on S5 and in design spec section 2b.

## 6. Admin console

Every admin page sits behind Cloudflare Access with the admin navigation (P2) on ink at left.

### X1 Overview

Boards: [PNG](mockups/png/Admin-Overview.png) · [source](mockups/source/Admin-Overview.dc.html)

Controls:

- organisations table: Table with search; names open X2; Export CSV and New invite code. (Admin-Overview)
- model spend against caps: Bars for Meta today and Meta total (corrected 2026-10-27: the Glimmer bar left with Glimmer). (Admin-Overview)
- service health: Six tiles (email intake, workflows, Meta Model API, Browser Run, Google Web Risk, outbound mail), each with a status dot, a word (Healthy, Slow, Down) and a detail line; a red tile emails the operator. (Admin-Overview)

States:

- loading: Not drawn. Deferred to D07 T05 §2: server-rendered; not drawn.
- empty: Not drawn. Deferred to D07 T05 §2: no organisations yet has no board.
- error: App error page (E5). (Error-500)

### X2 Organisation detail

Boards: [PNG](mockups/png/Admin-Org.png) · [source](mockups/source/Admin-Org.dc.html)

Controls:

- onboarding: Onboarding steps. (Admin-Org)
- domains: Verified and pending. (Admin-Org)
- members: Members with roles. (Admin-Org)
- cases by week: Chart. (Admin-Org)
- threats: Top threats list. (Admin-Org)
- feedback: Rows with Open queue. (Admin-Org)
- plan: Plan card with Extend trial, Change daily cap and Suspend. (Admin-Org)

States:

- loading: Not drawn. Deferred to D07 T08 §5: server-rendered; not drawn.
- empty: Empty sections say so. (Admin-Org)
- error: App error page (E5). (Error-500)

### X3 Invite codes

Boards: [PNG](mockups/png/Admin-Invites.png) · [source](mockups/source/Admin-Invites.dc.html)

Controls:

- create: New code form. (Admin-Invites)
- list uses: Uses column; Copy per active code. (Admin-Invites)
- revoke: Revoke per active code and the Revoked status. (Admin-Invites)

States:

- loading: Not drawn. Deferred to D07 T05 §2: server-rendered; not drawn.
- empty: Not drawn. Deferred to D07 T05 §2: no codes yet has no board.
- error: App error page (E5). (Error-500)

### X4 Feedback queue

Boards: [PNG](mockups/png/Admin-Feedback.png) · [source](mockups/source/Admin-Feedback.dc.html)

Controls:

- "This was wrong" reports with case links and provider attribution: Tabs New, Triaged, Closed and the queue rows. (Admin-Feedback)
- case links: Each case opens its report. (Admin-Feedback)
- provider attribution: Column naming the check or model. (Admin-Feedback)
- triage: Triage note, File a TODO, Close: verdict was right. (Admin-Feedback)

States:

- loading: Not drawn. Deferred to D07 T08 §5: server-rendered; not drawn.
- empty: Not drawn. Deferred to D07 T08 §5: an empty queue has no board.
- error: App error page (E5). (Error-500)

### X5 Eval runs

Boards: [PNG](mockups/png/Admin-Eval.png) · [source](mockups/source/Admin-Eval.dc.html)

Controls:

- every run: Runs table. (Admin-Eval)
- targets: Five target tiles. (Admin-Eval)
- ablation: Ablation table. (Admin-Eval)
- start a run: With Open eval/RESULTS.md and the frontier log link. (Admin-Eval)

States:

- loading: Not drawn. Deferred to D08 T02 §4: a run in progress has no board.
- empty: Placeholder layout before the first run. (Admin-Eval)
- error: App error page (E5). (Error-500)

## 7. Error pages

App error pages are 960 by 640 cards on subtle grey: the question mark motion frame, an eyebrow with the code, one plain sentence, one way forward, and a reference id with the time. None shows a stack trace or raw error text.

### E1 404 Not found

Boards: [PNG](mockups/png/Error-404.png) · [source](mockups/source/Error-404.dc.html)

Controls:

- same page for a missing and a forbidden case: One message for both; Go to your cases and Check a file. (Error-404)

States:

- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: No nested error state. Not applicable: this page is itself an error page.

### E2 410 Link expired

Boards: [PNG](mockups/png/Error-410.png) · [source](mockups/source/Error-410.dc.html)

Controls:

- report link past its 7 days: Explains the 7-day rule. (Error-410)
- how to get a new one: Plus the forward-again fallback. (Error-410)

States:

- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: No nested error state. Not applicable: this page is itself an error page.

### E3 403 No access

Boards: [PNG](mockups/png/Error-403.png) · [source](mockups/source/Error-403.dc.html)

Controls:

- signed in but not a member of this organisation: With Go to your own cases and Sign out. (Error-403)

States:

- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: No nested error state. Not applicable: this page is itself an error page.

### E4 429 Slow down

Boards: [PNG](mockups/png/Error-429.png) · [source](mockups/source/Error-429.dc.html)

Controls:

- rate limit or daily cap: Daily cap; the burst limit uses the same page. (Error-429)
- when it resets: Reset time with See your plan and Back to cases. (Error-429)

States:

- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: No nested error state. Not applicable: this page is itself an error page.

### E5 500 Something broke

Boards: [PNG](mockups/png/Error-500.png) · [source](mockups/source/Error-500.dc.html)

Controls:

- apology: With Try again. (Error-500)
- reference id: Reference with the time. (Error-500)
- status: What happens next; Email support. (Error-500)
- the forward address still works: Forward reminder. (Error-500)

States:

- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: No nested error state. Not applicable: this page is itself an error page.

### E6 Maintenance

Boards: [PNG](mockups/png/Error-Maintenance.png) · [source](mockups/source/Error-Maintenance.dc.html)

Controls:

- planned downtime notice: Window, what is safe, late replies, Reload. (Error-Maintenance)

States:

- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: No nested error state. Not applicable: this page is itself an error page.

## 8. Email messages

Every email is a 600 px body inside the mail client: logo at top, one coloured band or heading, at most one primary button with its plain link beneath, and a footer saying why the recipient got it and "We never ask for passwords, PINs or bank details by email". Layout is tables only, with alt text and a plain-text part. Senders: check@ for replies and the cap notice, no-reply@ for sign-in and invitations, verify@ for codes and bank requests, alerts@ for alerts and operator notices.

### N1 Verdict reply

Boards: [PNG](mockups/png/Email-Reply.png) · [source](mockups/source/Email-Reply.dc.html) · [PNG](mockups/png/Email-Reply-Counterparty.png) · [source](mockups/source/Email-Reply-Counterparty.dc.html)

States:

- verdict reply: the reply to every forward, in a member and a counterparty variant. (Email-Reply)
- member variant: Verdict band, actions, reasons, report button, Headers checked panel. (Email-Reply)
- counterparty variant: Sender against registered domains, See the evidence, Protect panel. (Email-Reply-Counterparty)
- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N2 Sign-in link

Boards: [PNG](mockups/png/Email-Signin.png) · [source](mockups/source/Email-Signin.dc.html)

Controls:

- sign-in link: Button and plain link, 15-minute expiry. (Email-Signin)

States:

- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N3 Invitation

Boards: [PNG](mockups/png/Email-Invite.png) · [source](mockups/source/Email-Invite.dc.html)

Controls:

- invitation: Button and plain link, 48-hour expiry. (Email-Invite)

States:

- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N4 Domain verification code

Boards: [PNG](mockups/png/Email-DomainCode.png) · [source](mockups/source/Email-DomainCode.dc.html)

Controls:

- domain verification code: Large code, nothing to click, 30-minute expiry. (Email-DomainCode)

States:

- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N5 Bank verification request

Boards: [PNG](mockups/png/Email-VerifyRequest.png) · [source](mockups/source/Email-VerifyRequest.dc.html)

Controls:

- bank verification request: YES or NO by reply; no links or attachments. (Email-VerifyRequest)

States:

- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N6 Impersonation alert

Boards: [PNG](mockups/png/Email-Impersonation.png) · [source](mockups/source/Email-Impersonation.dc.html)

Controls:

- impersonation alert: Facts, three steps, Open the case. (Email-Impersonation)

States:

- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N7 Monitor alert with takedown pack

Boards: [PNG](mockups/png/Email-Monitor.png) · [source](mockups/source/Email-Monitor.dc.html)

Controls:

- monitor alert with takedown pack: the alert email and the takedown pack it links. (Email-Monitor)
- monitor alert: Screenshot mock and facts. (Email-Monitor)
- takedown pack: Button and plain link. (Email-Monitor)

States:

- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N8 Daily limit reached

Boards: [PNG](mockups/png/Email-Cap.png) · [source](mockups/source/Email-Cap.dc.html)

Controls:

- daily limit reached: Not checked, reset time, Open your cases. (Email-Cap)

States:

- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

### N9 Operator notice

Boards: [PNG](mockups/png/Email-Operator.png) · [source](mockups/source/Email-Operator.dc.html) · [PNG](mockups/png/Email-Operator-Feedback.png) · [source](mockups/source/Email-Operator-Feedback.dc.html)

States:

- operator notice: one notice per event to the operator, for a budget cap or a piece of feedback. (Email-Operator)
- budget cap: Spend figures and Open the admin overview. (Email-Operator)
- feedback: Summary and Open the feedback queue. (Email-Operator-Feedback)
- loading: No loading state. Not applicable: email message, delivered whole.
- empty: No empty state. Not applicable: email message, always sent with its content.
- error: No error state. Not applicable: email message; a send failure is retried by the mail queue and never shown to the recipient.

## 9. Judge demo

The judges' organisation (design spec section 5) is a normal organisation with sample cases on fictional companies and a 14-day trial, created from the `JUDGE-4MX9` invite code (X3).

Boards: [PNG](mockups/png/Welcome.png) · [source](mockups/source/Welcome.dc.html)

Controls:

- Open the sample cases: opens Cases (M1) with the sample cases.

States:

- Judge banner above the onboarding checklist: "Welcome, judges. This organisation is ready to explore.", naming the sample cases (a phishing email, an invoice with changed bank details, a voice note and a safe statement) and inviting a live test forward to check@isitlegit.co.za.
- Admin view: the "Judges (demo)" row in X1 with its trial and sample cases.

Approved: 2026-10-26 by the operator
