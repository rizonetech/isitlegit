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
| N10 | Weekly counts (opt-in): the three Cases tiles' numbers for the week and a link to Cases, Fridays 16:00 SAST, never message content, with a one-step unsubscribe | The opted-in member | D07 T04 §20 |

No acknowledgement is mailed when a forward is admitted (operator, 2026-10-28, D01 T01 §11): the verdict reply (N1) arrives within about a minute, and a second mail per check doubles the inbox noise for little gain.

## 1. Shared parts

Every page is drawn from these parts and from the tokens in `design/tokens/colors.json`; a page never invents its own header, navigation or colour. The approved canvas stylesheet is `mockups/source/ui.css`, and its values are the tokens: colours from `design/tokens/colors.json` (for example ink `#181519`, muted `#4D4953`, orange `#FF4A14` for graphics only, orange text `#CC2E00` for links, eyebrows and the primary button, suspicious `#8A5200` for text and `#B26A00` for graphics, and input borders in control border `#8E8A95`), type from `design/tokens/typography.json` (Exo for headings and figures, Exo 2 for text), spacing, radii and control heights from `design/tokens/spacing.json` (a 4 px scale; 12 px card radius, 16 px panel radius; controls 48 px and 36 px high). Buttons come in primary, dark, ghost, danger and link styles; pills come in safe, suspicious, malicious, partial, running and neutral, and the admin sidebar's brand ("Rizonetech admin", dark on orange) and alert (a count, white on the malicious band) as `AdminNav` draws them (D07 T01 §3).

- Deviation (D07 T01 §6): every control (button, link, text field, checkbox) shows its keyboard focus as a solid 2 px `orange-text` outline 2 px outside it, at least 4.7:1 in light and 6.1:1 in dark against the surface, subtle, light and orange-wash backgrounds controls sit on (`design/tokens/colors.json`), because WCAG 2.2 asks for 3:1 against the adjacent colours. The boards draw a 3 px ring at 25% orange on a text field (about 1.4:1) and no focus state for buttons or checkboxes. An invalid field keeps its red border under the outline.
- Deviation (D07 T01 §6): a board value exactly between two steps of the 4 px scale (26, 22, 18, 14, 10, 6 px) is built as the step above (28, 24, 20, 16, 12, 8 px) because "nearest step" leaves the tie open, and the step above keeps touch targets and text room; so the 26 px pill is 28 px, the 22 px navigation pill 24 px, the 18 px checkbox 20 px, the 14 px side padding of the input and of the small button 16 px, and the field's 6 px gap 8 px.
- Deviation (D07 T01 §8): a button keeps its words on one line at the control height and wraps them, growing taller and never wider than its container, only when they cannot fit, where the boards draw every button on one line (`.btn` is `white-space: nowrap`), because at 200% text on a 360 px phone "Go to your own cases" ran past the window (WCAG 2.2 1.4.4 and 1.4.10).

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
- Deviation (D07 T01 §9): the forward-address card's copy button says what happened on a status line under the address ("Copied" for 4 seconds, or "Copy failed: select the address to copy it" with the address selected), visible and announced politely, because the `AppNav` board draws the button but no feedback, and a click that shows nothing reads as broken.

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
- one-step demo: See a sample check, a native disclosure under the check@ card that shows the three checks and the verdict for the fictional sample email in one activation, with no sign-up step (D07 T06 §10).

States:

- phone layout: 390 px layout with the Open menu button and compact footer. (Home-Mobile)
- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state; the results band shows [XX] placeholders until D08 T02 §4 fills them. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

- Deviation (D07 T06 §10, operator decision 2026-11-01: build now): the Home board has no demo control, so the one-step demo is a native `<details>` "See a sample check" under the "Or upload a file" line, in the board's ghost button style, opening a card in the check@ card's style: the fictional email, the three checks of the sample report card in order (who sent it, the PDF, the bank account, the same evidence lines as the card, from one array in `index.astro`), the verdict and action, and "A real check needs sign-up first". It is a prerendered walkthrough (no model call, no spend, nothing sent or stored), not a live run, and the card says so before the checks ("A prewritten example on a fictional email, not a live analysis"); a live run would need a rate limit and a Meta spend cap.
- Deviation (D07 T06 §2): the hero line drops "In about a minute" and step 02 reads "Checks first, then four Meta models" for "Eight checks", because neither figure is measured (the first is a design target, the second is not what the check registry runs) and the writing rules refuse an unsourced figure; both return when the eval (D08 T02 §4) measures them.
- Deviation (D07 T06 §2): the FBI line reads "reported to the FBI's IC3" for "worldwide", because the 2025 IC3 Annual Report does not call its figure worldwide; the SABRIC source line names the nine participating banks and the year 2025, as the report does.
- Deviation (D07 T06 §2): a line under the check@ card and in step 01, "Sign up first: we answer mail from the address or domain you verify", because the app drops mail from a sender no organisation verified with no reply (`src/intake/email.ts`), so a visitor who forwards before signing up would hear nothing.
- Deviation (D07 T06 §2): a byline, "By Derick Payne, Rizonetech · Reviewed 31 Oct 2026", with the line that he read each report and checked every figure against its page, under the figures' source line, because the writing rules give marketing copy a named author, first-hand detail and a review date; and the results band reads "labelled samples" for "labelled South African samples", because the eval sets are not all South African (`eval/DATASETS.md`).
- Deviation (D07 T06 §20, interim, 2026-11-02): the proven-only home page shows only the threats and model cards whose claim owners are stamped (heading counts only while every threat is proven; step 02 names four models only while every model is proven; step 03 shows the claim when proven, else the email-verdict sentence); omitted cards return automatically when their owners stamp.

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

- Deviation (D07 T06 §3): the opening drops "eight checks" and "in about a minute" (unmeasured, as under S1), and drops "nothing in your report is a guess", because a check can finish without part of its evidence; a "When a check cannot finish" block says what the app's reply then says (`src/mail/reply.ts`).
- Deviation (D07 T06 §3): the forwarding steps follow what Microsoft and Google document (read 2026-10-31): Ctrl+Alt+F and More Respond Actions, then Forward as Attachment, for classic Outlook only; dragging the email into a new message for new Outlook and Outlook on the web, with a keyboard route (a normal forward, without the sender checks); Gmail on a computer only; each card links its vendor's page. The sign-up-first line sits beside the first instruction and in step 01, as on S1.
- Deviation (D07 T06 §20, interim, 2026-11-02): the proven-only page shows only the evidence cards whose claim owners are stamped (currently sender, attachments, Wonder, voice); the opening strip shows the investigation step only while its claim is proven (else two steps); the verdict intro and the happens intro each show the claim when proven, else the proven-only sentence; omitted cards return automatically when their owners stamp.

### S3 Invoice fraud

Boards: [PNG](mockups/png/InvoiceFraud.png) · [source](mockups/source/InvoiceFraud.dc.html)

Controls:

- the bank-change scam: The scam explained with the fictional invoice and its E4 callout. (InvoiceFraud)
- the fixed action: Phone the supplier on the number you already have. (InvoiceFraud)
- sourced figures: SABRIC 2025 figures, quote and FBI IC3 figure with source links. (InvoiceFraud)
- payment document check: What the check looks for, its limit, and a sample card. (InvoiceFraud)
- already paid recovery: Four ordered steps (phone your bank's fraud line, keep the mail and documents, open a SAPS case, warn the supplier), each beside its source link, reached by an "Already paid?" anchor in the opening. (Site-500 pattern: none; D07 T06 §11)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

- Deviation (D07 T06 §3): the FBI line reads "The FBI's IC3 received" for "Worldwide, the FBI received", because the 2025 IC3 Annual Report does not call its figure worldwide; the sources line names SABRIC's nine participating banks; the byline reads "Reviewed 31 Oct 2026" with the author's line that he checked every figure against the report's table.
- Deviation (D07 T06 §20, interim, 2026-11-02): the proven-only page shows the catch section only while at least one of its claims is proven, with only the proven steps (currently none, so the section is omitted); the section heading promises bank-change detection only while the catch claim itself is proven, else the neutral "Invoice checks"; the limit box shows only while its claim is proven; the SABRIC paragraph introduces the proven edit signs; omitted parts return automatically when their owners stamp.
- Deviation (D07 T06 §11): the InvoiceFraud board draws no recovery block; the page also carries an "already paid" block (four sourced recovery steps under a labelled heading, reached by an anchor in the opening), because the page's reader may already have paid. Operator decision 2026-11-02 (a block on this page, not a new page).

### S4 Protect your business

Boards: [PNG](mockups/png/ProtectSite.png) · [source](mockups/source/ProtectSite.dc.html)

Controls:

- protected identity: Register domains, logo and bank account. (ProtectSite)
- website seal: Seal shown on the real domain, blocked on a copy. (ProtectSite)
- signature badge: Badge that turns copies into evidence. (ProtectSite)
- impersonation monitor: Daily lookalike watch with Loupe screening (a Muse Glimmer LoRA tuned on Fireworks), Muse Spark as failover (corrected 2026-10-28 20:45 SAST: Loupe, a Muse Glimmer 30B LoRA fine-tuned on Fireworks for this job (D03 T04, the glimmer lane), replaces base Glimmer on serverless, operator decisions 15:01 to 15:16 SAST; corrected 2026-10-28, operator decision: Glimmer on Fireworks restored; corrected 2026-10-27, was Muse Glimmer). (ProtectSite)
- closed-loop verification: Finance contact confirms changed bank details; the buttons drawn are illustration of the email reply (N5). (ProtectSite)
- Protect my business: Opens Sign up; See a verify page opens T1; See pricing opens S5. (ProtectSite)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

The bank verification illustration shows "No, this is not us" and "Yes, we changed it" as the supplier sees them; the real request is answered by email reply (N5).

- Deviation (D07 T06 §7): the answer reads "checks mail that claims to be you against what you registered, when someone forwards it, and finds lookalike websites every day. A fake that nobody forwards and no lookalike site shows, we do not see" for the board's "every fake gets caught against the truth", because no section can back universal detection, and replaces "Nothing protects your business when someone pretends to be you to your own customers and suppliers" with "Your own mail filter never sees an email a scammer sends to your customers or suppliers in your name" so no unsupported exclusivity is claimed; the board's "watch new certificates" is marked "Planned" (D05 T04 §7 builds it after the event); the price sentence reads "free for 14 days during the launch ... R499 per organisation per month" as S5 does; both Protect CTAs carry the invite-code disclosure and request link ("Members join with an invite code during the launch. No invite code? Ask for one at hello@isitlegit.co.za") as S5 does; the byline reads "Reviewed 31 Oct 2026".
- Deviation (D07 T06 §7): the bank verification illustration carries a visually hidden text equivalent of the request and both answers, because its drawn buttons are an illustration with no controls, and the "See a verify page" link opens the demo business `/v/fynbos-freight`, which D07 T07 §1 seeds; `docs/live-checks.md` records its read-back before the link goes live.
- Deviation (D07 T06 §20, interim, 2026-11-02): the proven-only page publishes the intro without the answer sentence and shows only the protection blocks whose claim owners are proven (currently none, so the section is omitted); the story, hero art, cost band and CTAs stay. The answer sentence and the blocks return automatically when their owners stamp.

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

- Deviation (D07 T06 §4): the Free check tier says what the app does today ("Verdicts on mail your team forwards from its verified address or domain", "Up to 5 checks a day per organisation", `src/auth/plan-sql.ts`) for the board's "For anyone who receives a suspicious email" and "Up to 5 checks a day", whose counterparty checks (5 a day per sender) are listed as planned until D05 T02 §1 ships; and it adds "No invite code? Ask for one at hello@isitlegit.co.za", because signup needs an invite code during the launch.
- Deviation (D07 T06 §4): the Protect price reads "from R499 per organisation per month", the unit design spec 2b gives ("per company"), which the board leaves out.
- Deviation (D07 T06 §4): Protect reads "Free for 14 days during the launch" and "Start your 14-day trial" for "Free during launch" and "Start free during launch", with "After the trial your organisation keeps Free check until billing starts", because the trial ends after 14 days whether or not billing has started (`src/auth/plans.ts`); MSP carries a "Planned" pill and planned items, because its console and branding are D07 T04 §6, not built.

### S6 Privacy and POPIA

Boards: [PNG](mockups/png/Privacy.png) · [source](mockups/source/Privacy.dc.html)

Controls:

- processors: Cloudflare, Meta Model API with store: false, Fireworks AI (Loupe screening public lookalike pages on a dedicated deployment; Fireworks keeps no prompt or output of open models without opt-in; Loupe is trained through Fireworks' Training API, which stores no dataset file, its checkpoints kept 30 days), SMTP2GO, Google Web Risk (corrected 2026-10-28 20:45 SAST: Loupe replaces serverless Glimmer, and its training is disclosed; whether the no-logging terms cover a dedicated LoRA deployment is confirmed with Fireworks in D03 T04 §12 before launch; corrected 2026-10-28, operator decision: Fireworks AI returns as the monitor's screener, so the Privacy board's copy is right again on it; corrected 2026-10-27: Fireworks AI and Baseten were removed; this list wins over the board's copy). (Privacy)
- purposes: Mail, account, supplier ledger, feedback. (Privacy)
- retention: Retention table. (Privacy)
- information officer: Responsible party and contact hello@isitlegit.co.za. (Privacy)
- rights: POPIA rights with the Information Regulator link; On this page anchors. (Privacy)

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

- Deviation (D07 T06 §5, corrected 2026-10-31 22:03 SAST by operator decision): the training statement reads "Forwarded mail may be kept and used to improve IsItLegit's screening models. Your address and name are removed, and other genuine mail is redacted. It is never sold or published." for the board's "we never use your mail to train a model", because day-zero capture keeps every forwarded case for training; the earlier wording ("We do not train any model on the mail you forward") is withdrawn. The Fireworks row says what it receives in production (public pages) and in training, and its no-logging terms are stated as Fireworks states them, with a link, with no assurance about our dedicated deployment.
- Deviation (D07 T06 §5): the retention table adds the pictures and text derived from a message (kept with the case, not deleted at 30 days) and sign-in and security records (365 days, `src/auth/audit.ts`), and the purposes add sign-in and security records, because the app keeps both; section 72 of POPIA and the data subject's rights are cited by section number and linked to the Information Regulator, with no complaints email address printed, because the Regulator's own pages list three different ones; the byline reads "Last updated 31 Oct 2026" with the author's line that he read the code.
- Deviation (D07 T06 §20, interim, 2026-11-02): the proven-only page lists only the purposes whose claim owners are stamped (currently four; the supplier-ledger purpose is blocked until `D06 T01 §1` and `§3` stamp) and keeps only the proven retention rows; omitted items return automatically when their owners stamp.

### S7 Terms of use

Boards: [PNG](mockups/png/Terms.png) · [source](mockups/source/Terms.dc.html)

Controls:

- plain-language terms for the free launch period: Question headings with On this page anchors. (Terms)

States:

- draft review date: Draft pill until the operator dates the review. (Terms)
- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: No empty state. Not applicable: static page with fixed content, nothing to be empty.
- error: Site error page (S11). (Site-500)

Deviation (D07 T06 §8, §17): the board's draft pill reads "Draft for the launch period; reviewed by Rizonetech on [date]"; the operator approved the launch terms on 1 Nov 2026 (D07 T06 §17), so `/terms` prints "Reviewed by Rizonetech on 1 Nov 2026" with no draft marker; while no approval date is recorded it prints "Draft for the launch period; awaiting Rizonetech review" so it never claims a completed review prematurely. In section 1, `/terms` discloses that sign-up during the launch requires an invite code (`hello@isitlegit.co.za`). In section 5, where the board says "When a model is unavailable or a daily cap is reached, you get a report marked partial", `/terms` distinguishes a model outage or model spend cap (`D03 T01 §2`, `D04 T01 §5`, which produces a report marked `partial`) from the organisation's 50-check daily limit (`D07 T02 §4`, which refuses further checks until the next UTC day). In section 6, `/terms` states that updates to the free launch terms are published on `/terms` with an updated date and that any future paid plan requires a separate commercial agreement and opt-in when billing is built (no automated broadcast promise is made while `TODO-06` has `Adjacency: all=not-applicable`). Deviation (D07 T06 §20, interim, 2026-11-02): the section-5 distinction is a blocked claim (`terms.limits.partial`, owner `D04 T01 §5` unstamped), so the proven-only `/terms` omits the whole sentence until they stamp, and the section keeps the launch-basis sentence with the liability cap; the distinction returns automatically on the next build after the stamp.

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

Deviation (D07 T06 §8): alongside the board's GitHub Security Advisories button and `SECURITY.md` link, `/security` gives a direct private email reporting link (`hello@isitlegit.co.za`) and an email alternative for a reporter without a GitHub account (the earlier note that the repository opens publicly on 3 November 2026 was dropped in D07 T06 §21, once D07 T06 §18 read it back as public).
Deviation (D07 T06 §20, interim, 2026-11-02): the proven-only page shows only the safeguards whose claim owners are stamped (currently four) and heads the section with that count, "Six safeguards in the pipeline" only when all six are proven; omitted cards return automatically when their owners stamp.

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

Deviation (D07 T06 §8): `/about` links `github.com/rizonetech/isitlegit` (public; the opening-date note was dropped in D07 T06 §21 once the read-back in D07 T06 §18 showed it public), cites the SABRIC 2025 loss and incident figures (`R2.4 billion` across `110,074` incidents) beside a link to the primary report under "Why start with small businesses?", and links sign-up (`app.isitlegit.co.za/signup`) in the `check@isitlegit.co.za` contact card so a visitor sees that only verified member addresses and domains are answered.
Deviation (D07 T06 §8, structure): `/security` lays the six safeguards in two columns and stacks the data and disclosure sections, and `/about` places the company card below the introduction and stacks the build and rationale sections, where the boards show three columns and paired regions on desktop; the single-column order is the reading order on every width, the text is long enough that three columns would break lines under the 60-character measure, and the boards' regions, headings and cards are all present.

### S10 Results

Boards: [PNG](mockups/png/Results.png) · [source](mockups/source/Results.dc.html)

Controls:

- latest eval against targets: Headline tiles with fixed targets and the eval/DATASETS.md link. (Results)
- model ablation: One row per model switched off. (Results)
- production counts: Counts from real use, never shown or added to the test set. (Results)
- run history: A table of every published full run (date and run id, commit, selection, detection, false alarms, median cost), newest first; a run on another set version, selection or deployed commit is marked "Different selection: not comparable" with the reason, never silently compared. (Results, extended by D08 T02 §10 in the page's own table pattern; no new board.)
- independent validation: The statement below, printed under the history. (Results, D08 T02 §10)

Independent validation (wording, D08 T02 §10): "Independent validation means a person or organisation outside Rizonetech runs these same labelled sets against the live service and publishes their own figures, including where they disagree with ours. The sets, their licences and how they were built are described in eval/DATASETS.md so anyone can do this. It has not happened yet: every figure on this page is our own measurement, published whether it is good or not, and the run history above is the record it can be checked against."

States:

- loading: No loading state. Not applicable: static page, prerendered by Astro and served whole.
- empty: Placeholder values until the eval runner publishes a run. (Results)
- error: Site error page (S11). (Site-500)

**Corrected 2026-10-31** (coordinator, D07 T06 §2): S10 is served by the app host at `https://app.isitlegit.co.za/eval`, where it reads the eval runs from D1, not prerendered by Astro; `isitlegit.co.za/eval` redirects there (`site/public/_redirects`), and the home page's results band reads the same run from `eval/results-summary.json` at build time.

- Deviation (D08 T02 §4): S10 is served in the app's public shell (the mark and the app host's origin note) rather than the marketing site's header, because that header is the Astro site's; its tiles read "Median time to analyse" with the forward-to-reply target marked "Not measured" (the figure is the server's admission-to-verdict time, and the forward-to-reply time belongs to the live mail run, D09 T01 §1), the intro drops "Every release runs the same test" (not yet true), the attack table lists the kinds the sets hold, "Bank changes caught" says "Not counted yet" until a check names one, and the real-use counts leave out the eval and demo organisations.

### S11 404 and 500 (site)

Boards: [PNG](mockups/png/Site-404.png) · [source](mockups/source/Site-404.dc.html) · [PNG](mockups/png/Site-500.png) · [source](mockups/source/Site-500.dc.html)

Controls:

- plain message: One sentence on each page. (Site-404)
- the search-free way back: Home, How it works and Pricing on the 404; Try again and Home on the 500. (Site-404)
- the check@ address: Forward panel on both pages. (Site-404)
- the help route: a mailto link to the contact address on the 500, its address visible and selectable so a visitor with no mail handler can copy it into webmail. (Site-500)

States:

- 404: Not found page. (Site-404)
- 500: Error page with a reference id. (Site-500)
- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: The 500 page is the error state. (Site-500)

- Deviation (D07 T08 §9): `/404` is built in the site layout, so it shows the site header and footer where the Site-404 board draws a bare logo and domain; the sentences, the three links and the check@ panel are the board's. The 500 is a standalone `500.html` generated by `site/src/pages/500.html.ts` with the app's tokens inlined and no script, font or stylesheet to fetch, with a plain wordmark in the header; its reference line is the fixed `Reference 500-site`, because a static page has no per-request id to show (the board's `7F3A-21C9`); `Try again` is a link with an empty address, which reloads whichever address failed. Both check@ panels add the line the home page carries, "Sign up first: we answer mail from the address or domain you verify", with the sign-up link, so no visitor is promised a reply the app would not send. Serving the 500 while the origin fails is production wiring, D07 T06 §20.

- Deviation (D07 T08 §19): the Site-500 board draws no help link; the standalone 500 also carries a mailto help link to the contact address under the check@ panel, with the address shown as the link text so it can be read and copied without a mail handler. It adds no external request (a `mailto:` fetches nothing), so the page stays standalone. Operator decision 2026-11-02.

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
- Deviation (D05 T02 §6): the Not verified state does not say when protection lapsed, because no lapse date is stored, and its "You can still check the email" card becomes "Check with them directly", because the counterparty path (D05 T02 §1) does not check mail for a business that is not protected, so promising a reply would mislead.
- Deviation (D05 T02 §6): the steps are four boxes, Outlook and Gmail on a computer and on a phone, with "If no reply comes" below, because the phone apps forward differently and the Gmail app cannot attach; the first step says to forward from the mailbox that received the email, which the counterparty check needs.
- Deviation (D05 T02 §6): "checked again today" reads "checked again as this page opened", with the date, because the check is made live as the page is drawn and no stored recheck exists.
- Deviation (D05 T02 §6): the foreign-origin state (Verify-Foreign) is not drawn because D05 T02 §9 builds the seal whose copies it names.
- Deviation (D05 T02 §6): an unknown address draws the 404 inside the public shell with "This business is not protected by IsItLegit", since the site's own 404 (S11) is D07 T08 §1's and the verify page must not repeat the address.
- Deviation (D05 T02 §6): the domain chips carry ink text on the safe wash for contrast, and the address shows beside Copy so the clipboard's refusal can select it.

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
- sign-in code: The code field and Sign in on the check your inbox state. Deferred to D07 T02 §11: built from A1's controls, not drawn.

States:

- check your inbox: With Send another link and Use a different email. (Signin-States)
- link expired or used: With Email me a new link. (Signin-States)
- rate limited: With the time new links resume. (Signin-States)
- passkey prompt: With Try the passkey again and Email me a link instead. (Signin-States)
- code refused: The refusal on the code field, with Send another link. Deferred to D07 T02 §11: built from A1's controls, not drawn.
- loading: Busy submit. Deferred to D07 T02 §7: the submit button shows a busy state while the request runs; not drawn.
- empty: No empty state. Not applicable: a form page; the empty form is the default state.
- error: App error page (E5). (Error-500)

Confirm step (D07 T02 §10, 2026-10-29; built from A1's controls, not drawn): the mailed link opens `/signin/confirm`, which only shows the heading "Sign in to IsItLegit", one line ("Press the button to finish signing in. The link works once.") and one primary "Sign in to IsItLegit" button; nothing happens until it is pressed, because mail systems open links before the member does. Its states:

Sign-in code (D07 T02 §11, 2026-10-30, operator decision "Code sign-in: yes"; built from A1's controls, not drawn): every sign-in mail carries a 6-digit code beside the link ("Or type this code in the browser where you asked for the link", shown "123 456"), and the "check your inbox" state leads with a "Code from the email" field (hint: "Reading the mail on another device? Type its 6-digit code here to sign in on this one.") and a primary "Sign in" button; Send another link and Use a different email follow as ghost buttons, as the board draws them. The code signs in only the browser that asked, once, within the link's 15 minutes, and spends the link with it. Its refusals sit on the field: "That code is not right. 2 tries left." (then "1 try left."), "That code no longer works after three wrong tries. Send another link.", "That code has run out: codes work for 15 minutes. Send another link.", "This code works only in the browser where you asked for the link, while the link is new. Send another link from here.", "That code no longer works: its link was already used. Send another link.", "Enter the 6-digit code from the email." for anything but six digits, and the confirm step's own rate-limited, no-account and did-not-finish answers.

- confirm, signed in: The member lands on the page the link named.
- confirm, link expired or used: A1's state, with an Email field and Email me a new link, the return path kept; any address gets one neutral "If that address can sign in, a new link is on its way".
- confirm, check your inbox: A1's state, with Send another link (the same address) and Use a different email (the form with that address to correct).
- confirm, did not finish: Sign-in did not finish (the service's failure after the link was used), with the new-link form and the return path kept.
- confirm, link asked for on another device (D07 T02 §12, 2026-11-01, operator decision "Wrong-device link: b"; built from A1's controls, not drawn): the confirm page for a link the opening browser did not ask for (it holds no matching sign-in handle, which a link scanner never does) reads "Finish on the device where you asked", says the link was asked for on another device and that the 6-digit code in the same email signs that device in, and offers one secondary action, "Sign in on this device instead", which is the page's ordinary sign-in; the app keeps no readable code, so the page points to the email's rather than showing it. The browser that asked, a link no sign-in code was issued for (an invitation), and a link whose asking device has used its three code tries read the plain page. A check that fails reads "We could not check this link just now", keeps the link and its destination, spends nothing, and offers Try again. (Sign in)
- confirm, rate limited: A1's state on the confirm step: too many tries from here; the same button and link work again once the limit's 10-minute window passes, at the time the page shows.
- confirm, no account: This address has no IsItLegit account; ask the organisation's owner for an invitation (a new link would be refused the same way).
- confirm, link could not be sent: The recovery's send failed, with the form and the address kept, so the retry is one press.
- confirm, loading: Deferred to D07 T02 §7, as A1's own: no script runs on this page yet (D07 T01 §9).

Checked at 375 px with no sideways scroll, and by keyboard (the button and the Email field reachable and labelled). D07 T02 §7 draws these on A1's frame.

- Deviation (D07 T02 §7): the check-your-inbox state says "If that address can sign in, a new link is on its way. It works once, for 15 minutes." where the board names the address a link went to, because every request is answered alike so the page never tells a stranger who can sign in (D01 T02 §2).
- Deviation (D07 T02 §7): the rate-limited state says "Too many sign-in links from here" and "New links can be sent from here again at 14:32 SAST", where the board counts links sent to the address, because the limit the page answers is this client's own (D07 T02 §6); counting an address's links would say whether it can sign in.
- Deviation (D07 T02 §7): the rate-limited state's button repeats the same request ("Send another link at 14:32", then "Send another link") as a ghost button, with the passkey button and the "or" divider below it (D07 T02 §16).
- Deviation (D07 T02 §16): the passkey button and the "or" divider are drawn only where the browser offers passkeys (WebAuthn in a secure context, with the app script running); without them the page offers the email link alone. The prompt's "Email me a link instead" is a link-styled button that returns to the email field, where the board links to the page.

### A2 Sign up

Boards: [PNG](mockups/png/Signup.png) · [source](mockups/source/Signup.dc.html)

- Deviation (D07 T02 §13): an unusable invite code is answered in one sentence for every reason ("We do not recognise that code, or it has been used up or has expired. Ask whoever gave it to you for a new one.") where the board draws three, because the signup endpoint answers every unusable code alike so a guess cannot tell a dead code from none (D07 T02 §4, `test/auth/invite.test.ts`). The operator's decision, 2026-10-31 (through the coordinator): one message for every unusable code, keeping "a guess learns nothing".
- Deviation (D07 T02 §13): Read the privacy notice opens the public site's `https://isitlegit.co.za/privacy` (S6), the page being on the app's host.

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

- registrar-assisted verification: "Connect with <Registrar>" first when the domain's registrar supports Domain Connect and IsItLegit's template; the hand-off to the registrar and the automatic check on return (a plain link: no JavaScript required). (Verify-Domain, added by D07 T04 §5; the board change goes to the operator with this text.)
- TXT record to copy: Name and value with Copy buttons. (Verify-Domain)
- provider DNS help: "How do I add this at my provider?" in the DNS card, opening steps for Cloudflare, Hetzner, xneelo and Afrihost, generic TXT steps for every other provider, and how to find the DNS host or hand the record to whoever manages it. (Verify-Domain) (D07 T04 §11, operator decision 2026-11-02)
- check now: Looks the record up. (Verify-Domain)
- emailed-code option: admin@ or postmaster@ choice, Send code, code input and Verify. (Verify-Domain)

States:

- connect ready: "Your registrar can add the record for you." with Connect with <Registrar>. (Verify-Domain, D07 T04 §5)
- connect cancelled: "The registrar did not add the record." with Connect again; the claim is kept and the other ways stand. (Verify-Domain, D07 T04 §5)
- added, not visible yet: "The record is added. DNS has not shown it here yet." with Check now. (Verify-Domain, D07 T04 §5)
- registrar unknown: the Connect option is checked again with Try again; the TXT record and the emailed code stand. (Verify-Domain, D07 T04 §5)
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

- Deviation (D07 T04 §1): the Gmail tile reads "Tick the email in your inbox, then More at the top, Forward as attachment." where the board says "Open the email, then More, Forward as attachment.", because Gmail offers Forward as attachment from the inbox toolbar's More menu with the message ticked (Gmail Help, "Forward emails as attachments"), not from an opened message's menu.

Controls:

- stats panel: Four tiles with Export counts as CSV. (Cases)
- counts export period: Beside the one-press 12-week Export counts as CSV, From and To date fields with an Export period button, and This month and This quarter links carrying the current calendar month's and quarter's SAST dates. A chosen period exports one row per week for the weeks overlapping it; a reversed range, a range over 2 years or an unreadable date is refused with the 400 page. (Cases) (D07 T04 §19, operator decision 2026-11-02)
- threat kinds: The muted line under Malicious or suspicious, "5 phishing, 3 invoice, 1 impersonation": the week's flagged cases by kind, descending, ties in that board order, nothing drawn when no kind is present. A kind is a reporting bucket from positive evidence on the case's current run (invoice classification; a lookalike or confirmed brand mismatch for impersonation; a lure or credential form for phishing), one kind per case in that order, so the kinds need not sum to the tile. (Cases) (D07 T04 §18, operator decision 2026-11-02)
- this week: Checked this week tile. (Cases)
- money at risk caught: Rand tile. (Cases)
- filters: Verdict segmented filter, channel and period. (Cases)
- checked by: Checked by select beside channel, Everyone then each member; a checker who has left reads "Member no longer available" and Clear filters returns to Everyone. (Cases) (D07 T04 §10, operator decision 2026-11-02)
- date range: From and To date inputs beside the period, with the active range named and Clear dates returning to the fixed periods; a From after the To names the problem with Swap them. Setting a date makes the range the date filter; clearing both returns to the period. (Cases) (D07 T04 §8, operator decision 2026-11-02)
- search: Search input; its placeholder names the `/` key. (Cases)
- search shortcut: Pressing `/` outside a text field, select or editable region focuses the search box; the key stays text inside a field. The hint beside the box carries its Turn off / Turn on button (WCAG 2.1.4), and the choice is kept in the browser. (Cases) (D07 T04 §15, operator decision 2026-11-02)
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
- accepted types: Email, PDF, Word (.docx), Excel (.xlsx) and PowerPoint (.pptx), image, audio, and what is refused (older Office files and macro files among them). (Upload) (D01 T03 §13, 2026-11-01)
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
- Deviation (D01 T03 §6): a page without its script shows a "Check this file" submit under the drop zone, which the boards do not draw: the boards send a file the moment it is chosen, which only the app script can do, so without it the form needs a button to send; it is hidden where the script runs.
- Deviation (D01 T03 §6): the daily limit's zone is not dimmed to 60% as `Upload-States` draws it, since dimmed muted text falls to 3:1 against the zone (WCAG 2.2 1.4.3 asks 4.5:1); the zone says "Uploads paused until midnight" with a plain border and the amber alert carries the state. Choose a file stays usable, so a choice after midnight is checked.
- Deviation (D07 T08 §8): for an organisation whose daily cap is 0 (an operator's pause), the zone says "Uploads paused" and the alert "Checks are paused for <organisation>. Ask IsItLegit to turn them back on.", with no Try again, since nothing restarts at 00:00 SAST while the pause lasts.
- Several files (D01 T03 §6, not drawn): dropping more than one is refused with "Drop one file at a time." and nothing is sent; a stalled request (30 seconds without progress) or an answer that never comes says so in the alert region, with Try again sending the kept file.

### M3 Report

Boards: [PNG](mockups/png/Main.png) · [source](mockups/source/Main.dc.html) · [PNG](mockups/png/Report-Safe.png) · [source](mockups/source/Report-Safe.dc.html) · [PNG](mockups/png/Report-Running.png) · [source](mockups/source/Report-Running.dc.html) · [PNG](mockups/png/Report-Partial.png) · [source](mockups/source/Report-Partial.dc.html) · [PNG](mockups/png/Report-Invoice.png) · [source](mockups/source/Report-Invoice.dc.html) · [PNG](mockups/png/Report-Counterparty.png) · [source](mockups/source/Report-Counterparty.dc.html) · [PNG](mockups/png/Report-Voice.png) · [source](mockups/source/Report-Voice.dc.html) · [phone PNG](mockups/png/Report-Mobile.png) · [phone source](mockups/source/Report-Mobile.dc.html) · [PNG](mockups/png/Report-EvidenceViewer.png) · [source](mockups/source/Report-EvidenceViewer.dc.html) · [PNG](mockups/png/Report-EvidenceViewer-Mobile.png) · [source](mockups/source/Report-EvidenceViewer-Mobile.dc.html) · [PNG](mockups/png/Report-MessagePreview.png) · [source](mockups/source/Report-MessagePreview.dc.html) · [PNG](mockups/png/Report-Running-Early.png) · [source](mockups/source/Report-Running-Early.dc.html) · [PNG](mockups/png/Report-Dispute.png) · [source](mockups/source/Report-Dispute.dc.html) · [PNG](mockups/png/Report-Mobile-Attribution.png) · [source](mockups/source/Report-Mobile-Attribution.dc.html)

Anatomy, top to bottom (Main):

- Breadcrumb back to Cases.
- Header: subject as the title, sender, who forwarded it and when; Download PDF and Copy link.
- Verdict banner: the verdict's motion frame on a white tile, "Verdict · confidence" eyebrow, a one-sentence headline, and one sentence on what it means for the reader.
- What to do now: a numbered list of at most three actions; invoice and voice variants call it "Do this first" and put the phone instruction first.
- Why we say so: exactly three reasons, each led by its evidence pill (E7, E4, E2) that jumps to the evidence card.
- Evidence: a count line ("9 findings · 8 checks ran · nothing skipped") with its Check versions disclosure, then evidence cards by kind, each with an id and severity pill (Critical, High, Medium, Low, Info), a title and its proof: walkthrough steps with screenshots, lookalike domain with RDAP date, hidden text quoted, logo crop comparison, authentication header excerpt, reputation listing with "listed in error? request a review", first-time sender.
- Check versions lines (D07 T09 §11, operator approval routed through the coordinator 2026-11-02): each line keeps the check's name and Worker version first ("version not recorded" where none was stored), then what the check did in plain words: "ran", "read part of its input", "did not run" or "failed". A partial or skipped line follows with its stored reason, drawn as text. A failed line follows with its reason in plain words: a stored `Timeout` reads "it ran out of time", `EvidenceRefused` reads "its findings could not be stored", and any other stored class reads "it failed". A ran line carries no reason.
- Detection data on the version lines (D07 T09 §12, operator approval routed through the coordinator 2026-11-02): a line for a check that reads the brand table (the lookalike-domain, display-brand and reputation counter-signal checks) then names the detection data it judged by: "data <revision> (<identity>, KV)" or "(<identity>, bundled)", from the stored provenance of that run, drawn as text. Where none was stored it reads "data not recorded", never today's table. No other check's line names data.
- Model trace: a table of step, model, what it did, time and cost, with the total; sample figures are labelled.
- Footer: retention and access line, and "This verdict is wrong".

Controls:

- verdict banner: Motion frame, eyebrow, headline and one sentence. (Main)
- headline: One sentence. (Main)
- previous and next case: Previous and Next stepping through the filtered Cases list the member came from, each keeping the list's filters, drawn at the report's head and foot with "Case X of Y"; the end that has no case is disabled, and the Cases breadcrumb returns to that filtered list and page. Keys while the step controls have focus: `j` next, `k` previous, `u` back to the list, never while typing. A signed link and a report opened without the list show none. (Main) (D07 T04 §9, operator decision 2026-11-02)
- three reasons: Three evidence-pill reasons that jump to their cards. (Main)
- actions: At most three numbered actions; Download PDF and Copy link in the header. (Main)
- evidence cards: Cards by kind with severity pills; listed in error? request a review. (Main)
- check versions: A quiet native disclosure on the evidence count line, closed by default, keyboard-operable with no JavaScript; one activation lists each check of the run shown with the Worker version that ran it, or "version not recorded" for a check stored before versions were kept, and the list follows the run the report shows after a retry; absent when no outcomes are stored for the run, and not drawn on the running report. (Terminal reports)
- Deviation (D07 T03 §44): a clean lookalike check's line shows the producer's stored summary, which today is its generic "no lookalike of a known name" without the domains it examined (`lookalikeSummary` in `src/checks/domain-lookalike.ts`), where `Report-Safe` draws what the check saw; the producer's wording is the checks lane's to name (asked 2026-11-02), and this deviation goes when it lands.
- model trace: Step, model, what it did, time and cost. (Main)
- feedback: Opens the feedback control (D07 T03 §6). (Main)
- feedback withdrawal: once saved, the feedback shows Change and Withdraw; Withdraw takes it back in one press (busy while it posts, sent once), says "You took your feedback back." once, and shows the closed control again with focus on it; a failure leaves the saved feedback and says it is still there. The feedback leaves the operator's waiting notices and the providers' false-alarm lists, and a notice not yet sent for it is not sent (D07 T03 §21). (Main)

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
- evidence viewer, open: the full-resolution capture in an in-page dialog over the report, scrollable, with Close and Escape, the screenshot's number, size and when it was taken, and a download link. (Report-EvidenceViewer; phone, Report-EvidenceViewer-Mobile)
- evidence viewer, phone: the same dialog filling the 390 px screen, with Close in the header, the capture scrolling both ways, and a "Download (PNG)" link. (Report-EvidenceViewer-Mobile)
- original message preview: a dialog over the report with two tabs, "Message" (the stored message as plain text) and "Complete headers" (every header, in the order received), opened from a finding's card by "View the original message" or "View complete headers"; a long or hostile message shows its first 200 KB as text with a line saying so, and an original no longer stored says so. (Report-MessagePreview)
- early authentication results: while the case is running, a card "What the receiving mail system recorded" (SPF, DKIM, DMARC, each a status pill, a name and one plain sentence) with "Early result" and the time it was read, and the line "These are what the receiving system recorded when the message arrived. They are not the verdict, and a later step may add to them." (Report-Running-Early)
- one-press dispute: the footer's question "Was this verdict wrong?" with one button whose words name the opposite verdict ("I think this is safe" on a malicious or suspicious verdict, "I think this is a scam" on a safe one); after the press, "Sent: you said this looks safe." and the optional note with Send the note, Change and Withdraw; from the email's link the report opens with the button focused. (Report-Dispute)
- phone attribution: who brought the case in on a phone, as a line under the subject (option A, chosen by the operator 2026-11-01; option B, under the verdict band, was not chosen). (Report-Mobile-Attribution)
- Measured 2026-11-02 (D07 T09 §4, stimulus `phone-attribution-v1`, app revision in `eval/phone-attribution-results.json`): scripted phone readers (a deterministic viewport scan of the shipped report itself, a proxy for human reading, not human times) over three synthetic cases with distinct sender and submitter identified the labelled submitter in the first viewport on all 15 shipped runs, a median of 0 scroll actions; on the benchmark shape (the same shipped report with the phone line's segment removed) no run identified the submitter at all, a median of 2 scroll actions and a disclosure opened on every run. Scripted scan times are instrumentation-bound at this scale and separate nothing; the medians are in the results file. The placement stands: fewer scrolls, no navigation needed, no confusion by the scripted measure. A human study is D07 T09 §17.
- evidence viewer, capture gone: the preview that opens it is replaced by "This screenshot is no longer stored" and "Kept for 30 days. The finding above still stands.", with nothing to open. (Report-EvidenceViewer)

- Deviation (D07 T03 §2): the eyebrow's confidence word is read from the verdict's stored confidence as high at 0.8 and above, medium at 0.5 and above and low below, because no band is defined upstream and a raw number is not shown; the 0.6 cap for a forward without its headers (D04 T01 §4) therefore reads medium. The operator decided to keep these bands (2026-10-31, through the coordinator).
- Feedback control (D07 T03 §6, 2026-10-31; built from the shared controls, not drawn: the boards draw only the footer's "This verdict is wrong"): a member's "This verdict is wrong" opens in place a choice ("It is safe" or "It is a scam", the one that disputes this verdict first), an optional note of up to 1000 characters, and Send; states: closed, open, sending (Send busy), saved ("You said this verdict is wrong: …", with Change, which reopens it filled), refused (the error on its field, what was typed kept) and outage (the same, nothing saved). A signed-link reader, a running check and a failed check have no control.
- Deviation (D07 T03 §2): the band's sentence on what the verdict means is a fixed sentence per verdict, where the boards draw one written for the message, because the stored verdict does not carry that sentence yet; D07 T03 §10 draws the stored one once D04 T01 §2 stores it.
- An upload's header (D07 T03 §28, 2026-10-31; built from the header's parts, not drawn): the title is a stored subject first, else the uploaded file's name (labelled "Uploaded file" for a screen reader), else "No subject"; an uploaded email titled by its subject names its file in the line below ("Uploaded file <name>"). The breadcrumb and the phone's line carry the same title.
- Signed link footer (D07 T03 §26, 2026-10-31; not drawn): under the link's own expiry line, "Is this your organisation's report? Sign in to tell us if we got it wrong." on a report with a verdict, and "... Sign in to see it with your organisation's cases." on a running or failed check; Sign in returns to the report's own path, so a member opens the member view and anyone else the 404.
- Header (D07 T03 §9, 2026-10-31; the parts the boards do not draw): a subject not stored (a case not parsed yet, or none) reads "No subject"; a sender reads whichever of its name and address is stored, and nothing when neither is; an inline forward reads "Forwarded by", an upload "Uploaded by <member>" (the member's email when their name is blank), "Uploaded by a former member" when its uploader is no longer a member of the organisation, and "Uploaded" alone when no uploader was recorded, the Cases list's own rule (D07 T04 §7; one read for both, D07 T03 §42, 2026-10-31). A signed link's header shows the subject and sender but not who forwarded it, and no breadcrumb. Download PDF is the browser's print and shows only where the app script runs.
- Deviation (D07 T03 §9): on a phone the header keeps Copy link and Download PDF above the band, where `Report-Mobile` draws none, so a phone reader can keep or share the report too; the title stays in the page for screen readers while the line under the band says it.

- Evidence viewer (D07 T03 §8; operator decision 2026-10-28 22:42 SAST for the in-page dialog, built now by the operator's decision of 2026-11-01 03:30 SAST; the boards `Report-EvidenceViewer` and `Report-EvidenceViewer-Mobile` are approved by the operator 2026-11-01 11:35 SAST (`docs/coordinator.md`)): an evidence figure's preview is a button, "Open at full size", named by its caption ("Open the screenshot at full size: <caption>"), that opens the capture at its natural size in a native `<dialog>` over the report (modal, the page behind inert), headed by the card's id and the caption, with "Screenshot N of M · W × H px · taken T s into the walk" beneath, a scrollable region (keyboard focusable, scrolling both ways on a phone) holding the capture, a footer line saying what it is and a "Download the screenshot (PNG)" link. Close and Escape shut it and focus returns to the preview that opened it. A capture that is gone (a stored artefact past its 30 days, or missing) is drawn on the card in place of the preview as "This screenshot is no longer stored" with "Kept for 30 days. The finding above still stands.", and offers nothing to open. The capture's alt text names what it shows (its caption). The sample figures on the boards are labelled samples, as the report's are.
- Original message preview (D07 T03 §19; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-MessagePreview` approved by the operator 2026-11-01 11:35 SAST (`docs/coordinator.md`)): from a finding's card a member opens the original in place, as inert plain text: the stored visible text and the complete headers in their own tab, never the message's HTML, never a remote load, links not clickable, under the report's access rule (a link holder sees what the public view shows; another organisation gets 404). Close and Escape shut it and focus returns to the card's button. A message past 200 KB shows its first 200 KB and says so; one gone after its 30 days says "The original message is no longer stored" and keeps the findings. The download of the original (.eml) stays.
- Early authentication results (D07 T03 §37; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-Running-Early` approved by the operator 2026-11-01 11:35 SAST (`docs/coordinator.md`)): the operator's choice is the report page's running state, not a first reply. Once the checks step has stored the authentication outcomes (`check_outcomes`, D02 T01 §3) the running report shows the card between the "Checking" band and the progress list, read from what is stored; before they are stored the card is absent, and if the receiving system reported no results the card says so. It names the receiving system's own records and says they are not the verdict.
- One-press dispute (D07 T03 §22; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-Dispute` approved by the operator 2026-11-01 11:35 SAST (`docs/coordinator.md`)): a dispute is one press on a button naming the opposite verdict, sent once (busy while it posts), with the optional note offered after and Change and Withdraw as §6 and §21 have them; the intent from the email or the signed link survives sign-in, so the report opens with the button focused and focus-visible, and choosing and pressing stay the member's.
- Deviation (D07 T03 §22): the saved state's three actions sit in two rows (Send the note ending the note's own form, then Change and Withdraw), where the board draws one row, because each action is its own form and HTML forms cannot nest; the words, order and button treatments are the board's.
- Attribution on a phone (D07 T03 §43; built now by the operator's decision of 2026-11-01 03:30 SAST, board `Report-Mobile-Attribution` approved by the operator 2026-11-01 11:35 SAST (`docs/coordinator.md`), option A chosen (the attribution under the subject)): the phone report says who brought the case in ("Forwarded by <name>" or "Uploaded by <name>"), in the screen reader's reading order, shown to members and never to a link holder.
- Deviation (D07 T03 §39): the Check versions disclosure sits on the evidence count line where no board draws it, because the boards predate check implementation revisions (D02 T01 §4); the count line's own words, order and treatments are the boards'.
- Deviation (D07 T03 §8): the viewer's heading line shows the capture's own size (read from the loaded image) and, on a phone, "scrolls both ways", where the board's desktop line also says "Screenshot N of M" and "taken T s into the walk" (the stored finding holds neither: a screenshot's place among the walk's captures and its time are not stored). The opening control's name is "Open at full size: <caption>", not the SPEC's "Open the screenshot at full size: <caption>", so the visible words "Open at full size" are part of the name (WCAG 2.5.3). The footer is two short lines ("The page as the contained browser saw it." on a wide screen, "Pinch or scroll to read it." on a phone) rather than the board's longer sentence. The capture is asked for afresh and its answer decides the state: the artefact route marks its answers with `x-artefact-state` (`gone`, `link-expired`, `unavailable`), because a 410 alone cannot tell an expired report link from a deleted file; an expired link says "This report link has expired. Ask for a new one." and, like a gone capture, offers nothing to open.
- Deviation (D07 T03 §19): the headers tab's line does not say the authentication results in the headers are "the receiving server's own" (the board's footer), because any `Authentication-Results` header in a message can be forged: it reads "Every header as stored, in the order received. A result written into a header may be forged; the authentication check says which results were the receiving server's.". The message tab shows the parsed plain-text body as sent, not the model's visible text (which also lacks visible instruction-like phrases), falling back to the visible text only for a message with no plain part and saying so ("This message has only an HTML version. This is its visible text, with hidden text and instruction-like phrases taken out."). The 200 KB note reads "Showing the first 200 KB as plain text. The message is longer; download the original to read the rest.". A text never stored, an empty body and an empty header list each say so in their own words ("The message text was not stored.", "The message has no text.", "The message has no headers."), the other tab and the download staying usable; the dialog also has the viewer's link-expired, signed-out and failed-read states. Without the app script "View the original message" and "View complete headers" are the original's download.

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
- Deviation (D06 T01 §4): an account shows its last three digits ("•••• 731") and the search takes the last three, because D05 T01 §2 and D06 T01 §2 keep only three.
- Deviation (D06 T01 §4): the add form's "Bank and branch code" is two fields, Bank and Branch code, so a refusal sits on the field it is about; the bank details are optional together, since a supplier can be recorded before its account.
- Deviation (D06 T01 §4): the "Changed on invoice" status, its finance-contact request line and the Undo toast are not drawn because D06 T01 §6 owns them.
- Deviation (D06 T01 §4): Edit opens an edit panel on the page (no dialog component exists) holding the supplier's details, its accounts with Remove, Add account and Remove supplier; each account on a row has its own Change link, which opens the account change with its confirmation.
- Deviation (D06 T01 §4): the status line under Verified names the latest account's provenance (added by hand, imported from CSV, or verified from a case) with who recorded it and when, and a supplier with no account shows "No account yet".
- Deviation (D06 T01 §4): the search has its own Search button, so it works without a script.

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
- Deviation (D05 T01 §3): the signature badge region is not drawn because D05 T02 §7 owns the badge snippet and its mail-client steps. Drawn since D05 T02 §7, with the deviations below.
- Deviation (D05 T02 §7): the badge's alternative text is "Check this business with IsItLegit", not the board's "Protected by IsItLegit", because the image is live and may say Not verified, and a recipient who blocks images or uses a screen reader would otherwise be told the business is protected.
- Deviation (D05 T02 §7): the snippet's image height is 36 px, the smaller of T3's two heights, not the board's 44 px, which T3 does not draw; the one 104 px tall PNG stays sharp at either.
- Deviation (D05 T02 §7): the board's note "a badge copied into a fake turns into an alert to you" is not drawn because copied-badge detection is D05 T02 §8's; the card says what is true now, that the badge proves nothing by itself and that a lapse turns every badge to Not verified within the hour, or a little later where a mail service keeps its own copy of images.
- Deviation (D05 T02 §7): the card's steps are for classic Outlook on Windows, new Outlook with Outlook on the web (which share their Settings), and Gmail, each reaching the default signature for new messages and for replies, and open in place under their names, not as links; they are not checked in the real editors: D05 T02 §10 was skipped by the operator for the competition (2026-11-01).
- Deviation (D05 T02 §7): the card is also shown to a member who cannot change the identity, since copying the badge changes nothing and staff paste it into their own signatures; the card names no preview person but the signed-in member, and the Copy button is the page's one control for a member.
- Deviation (D05 T01 §3): the website seal region is not drawn because D05 T02 §9 owns the seal snippet and its site steps.
- Deviation (D05 T01 §3): the recent impersonation alerts table and "2 alerts this month" are not drawn because D05 T02 §4 owns the alerts that fill them.
- Deviation (D05 T01 §3): "View your public verify page" is not drawn because D05 T02 §6 builds the page it opens.
- Deviation (D05 T01 §3): the finance contact has no Name field because D05 T01 §1 keeps the contact as one verified address and a name would need a new column.
- Deviation (D05 T01 §3): the bank table's Use column shows the account holder because D05 T01 §2 stores the holder and no use.
- Deviation (D05 T01 §3): an account's number shows as "•••• 773", its last three digits, because D05 T01 §2 keeps only three.
- Deviation (D05 T01 §3): a "Remove logo" control is added because a logo needs a reverse and the board draws none.
- Deviation (D05 T01 §3): the Protected switch is a labelled checkbox in the header band, saved with "Save identity" together with the names and the contact, because registration is one save and a switch that acted alone could not be refused on its field.
- Deviation (D05 T01 §3): the registered name is shown as read-only text and "Add account" opens no dialog, its fields are drawn under the table, because the registered name is the organisation's own and no dialog component exists.

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
- find a person: A find field above the members list matching a name or email substring, case and accent folded; no result reads "No one on the team matches." (Team) (D07 T04 §26, operator decision 2026-11-02)
- roles: Role select and role descriptions. (Team)
- invites: Invite by email; Resend and Revoke on pending invitations. (Team)
- invite several: The invite field takes up to 20 addresses separated by commas or new lines with one shared role; the answer lists one outcome per address (sent, not sent, unknown, refused with its reason) with a Retry that resubmits only the addresses that did not go. (Team) (D07 T04 §22, operator decision 2026-11-02)
- remove: Per member. (Team)
- team history by person: The history filters carry a person select (the organisation's members, or Anyone): a chosen person narrows the list to changes by them or to them, and a More link pages through every match. (Team) (D07 T04 §24, operator decision 2026-11-02)
- team history: Under the pending invitations, owners only: a table (When, What, Who, Whom, Outcome) of role changes, revocations and removals, newest first, with an action select and From and To date filters; empty reads "No team changes in this period." and a failed read names the failure with Try again, the rest of the page unaffected. (Team) (D07 T04 §23, operator decision 2026-11-02)

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
- empty: "No mail is accepted yet" with one action, Add a domain, for an organisation with no domain and no address (it signed up by addresses only, or removed its last). Added by D07 T04 §4; the second action, Add a single address, joins it with D07 T04 §27. Members see the sentence and "An owner or admin can add a domain."
- error: App error page (E5). (Error-500)

- Registrar step (D07 T04 §5): a pending domain's Continue opens its verification page (A5), where "Connect with <Registrar>" is offered first when the registrar supports Domain Connect for IsItLegit's template; this list itself is unchanged.

- Deviation (D07 T04 §4): a code-verified domain reads "A code mailed to the domain's admin@ or postmaster@ address", because which of the two was used is not stored. Add a domain opens a form on the page (a disclosure, keyboard and no-JavaScript safe) where the board shows a button only; the single-address button is D07 T04 §27. The verifier's name the board adds ("by Thandi N.") is drawn since D07 T04 §28, from the member D07 T02 §24 stores with the claim.

#### M8a Verify a single address

Added by D07 T04 §27. A single address is proved by a code mailed to it, on a page of its own at `/settings/addresses/<address>` that follows the domain claim page (A5) and takes the same pieces; no board draws it yet, so it is built from the Verify-Domain board's emailed-code card, in tokens.

Controls:

- add a single address: a field and Add on the Addresses table and in the empty state, for an owner or admin. (Domains)
- the code: six digits with Verify. (Verify-Domain, emailed-code card)
- Send a new code: held with its reason and time while a code was sent recently or the address is locked. (Verify-Domain)
- Continue: on a pending address's row, to this page. (Domains)

States:

- sent: "A code was mailed to <address>." with that it works for 30 minutes.
- uncertain: "The code may not have gone. Check the inbox before sending another." The claim is kept.
- failed to send: "The code could not be sent. The address is saved as pending; send a new code." The claim is kept.
- already verified: "<address> is already verified."
- not an address, verified by another organisation, too many waiting, send limits: under the field, the typed address kept.
- pending with no code: "No code is waiting. Send one."
- wrong code: "That code is not right." with the attempts left.
- locked: "Too many wrong codes." with the time a new code can be sent.
- expired: "That code has expired. Send a new one."
- malformed: "Enter the six digits you were mailed."
- taken meanwhile: "<address> was verified by another organisation, so this claim cannot be verified. Remove it."
- gone: the claim no longer exists; back to the list.
- verified: "<address> is verified." with how and when.
- loading: Busy Verify and Send a new code. Not drawn.
- error: App error page (E5). (Error-500)

#### M8b Verifier detail

Added by D07 T04 §29 (operator decision 2026-11-01: option A, brief at `2512b42c`). A proved domain's cell carries the proved wording (§28) with a native disclosure on it: closed it reads exactly the proved wording; open in place it names the verifier's full name and email with the exact verification time in SAST. Keyboard works with no JavaScript, on the Domains table and the phone list. A former member opens the same place and reads only "a former member" with the date; nothing more about a departed member is shown. The email is the address the Team page already shows to members of the organisation. Names and addresses are drawn as text.

Controls:

- verifier detail: a native disclosure on the proved wording of a verified domain, in the Domains table and the phone list; and on the "Why it is allowed" wording of a verified single address, in the Addresses table and the phone list. "Anyone @domain" rows keep "The whole domain is verified" with no disclosure. (Domains)

States:

- closed: the proved wording unchanged (§28).
- open: "Proved by <full name> (<email>), <date> at <time> SAST." A member with no name reads "Proved by <email>, <date> at <time> SAST." A former member reads "a former member" with the date only. No disclosure is drawn when no verifier was recorded.
- loading: Not drawn. Server-rendered; not drawn.
- error: App error page (E5). (Error-500)

### M9 Account

Boards: [PNG](mockups/png/Account.png) · [source](mockups/source/Account.dc.html)

Controls:

- name: Name input with Save. (Account)
- email: Email input. (Account)
- passkeys (add, remove): Passkeys table with Remove. (Account)
- sessions: Sessions table with Sign out per session. (Account)
- sign out: Signs out other sessions. (Account)
- close account: Close account button for the owner of the active organisation, naming that organisation in its confirmation (this organisation, its stored mail and cases, and its history are deleted 30 days after closing; closing refuses new cases at once and cannot be undone). Shown only to an owner; after closing, the page states the organisation is closed and its deletion date. (Account)
- weekly counts: A checkbox, "Email me this organisation's weekly counts on Fridays", with the day it was switched on, for the active organisation. (Account) (D07 T04 §20, operator decision 2026-11-02)

States:

- loading: Not drawn. Deferred to D07 T08 §3: server-rendered; not drawn.
- empty: No empty state. Not applicable: an account always has its profile and current session.
- error: App error page (E5). (Error-500)

- Deviation (D07 T08 §3): the passkey rows read "Added" and the device type, without the board's "Last used", because the passkey table keeps no last-used time (Better Auth stores a counter, not a clock); the session rows read "Signed in" with the date and "Last active", without the board's "with a passkey" or "with an email link", because a session does not record how it was made; "Last active" is to the day ("Today", "Yesterday", a date) because Better Auth renews a session's timestamp at most once a day, not on each request; and the email is plain text with "Your email address cannot be changed during the launch", where the board shows a field with "Changing it sends a confirmation link to the new address", because changing an address is not offered during the event.

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
- model spend against caps: Bars for Meta today, Meta total, Fireworks today and Fireworks total (corrected 2026-10-28: the Fireworks bars return with Glimmer on Fireworks; corrected 2026-10-27: the Glimmer bar left with Glimmer). (Admin-Overview)
- service health: Six tiles (email intake, workflows, Meta Model API, Browser Run, Google Web Risk, outbound mail), each with a status dot, a word (Healthy, Slow, Down) and a detail line; a red tile emails the operator. (Admin-Overview)

States:

- loading: Not drawn. Deferred to D07 T05 §2: server-rendered; not drawn.
- empty: Not drawn. Deferred to D07 T05 §2: no organisations yet has no board.
- error: App error page (E5). (Error-500)
- Deviation (D07 T05 §2): the organisations table carries a Daily cap column the board does not draw, showing each cap as its plan's or as an override, with Set and Use plan limit.
- Deviation (D07 T05 §2): the table and CSV carry each organisation's Created date the board does not draw; the section requires it.

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
- Deviation (D07 T08 §5): Suspend is not built; the plan card omits the button until §22 lands the suspension mechanism with its enforcement and reinstatement.
- Deviation (D07 T08 §5): the threats card omits the "money at risk" line until §23 lands the invoice lane's verified amount contract; no amount column exists in the merged migrations.
- Deviation (D07 T08 §5): the header names the invite's label through `invite_redemptions`, never the board's literal code, because only code hashes are stored (X3).

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
- Deviation (D07 T05 §2): the board's Copy on every active row is one-time copy on the creation result only; no later visit shows or copies a code, because only its hash is stored. Lost-code recovery is revoking the code and making a new one.
- Deviation (D07 T05 §2): the board's Daily cap each is not built; a code admits organisations whose cap the operator sets per organisation (the overview's Daily cap control, and X2's plan card).

### X4 Feedback queue

Boards: [PNG](mockups/png/Admin-Feedback.png) · [source](mockups/source/Admin-Feedback.dc.html)

Controls:

- "This was wrong" reports with case links and provider attribution: Tabs New, Triaged, Closed and the queue rows. (Admin-Feedback)
- case links: Each case opens its report. (Admin-Feedback)
- provider attribution: Column naming the check or model. (Admin-Feedback)
- triage: Triage note, File a TODO, Close: verdict was right. (Admin-Feedback)
- Deviation (D07 T08 §5): "Add to eval set" and "File a TODO" are not built; the panel carries the triage note and Close until §20 and §21 land their backends.
- Deviation (D07 T08 §5): They-say reads Safe for `false_alarm` and Unsafe for `missed`; the board's literal "Suspicious" is not printed because the requested severity is not stored.

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

- Deviation (D08 T02 §9): the board's Start a run button is built as written CLI guidance (the `pnpm eval:run` and `pnpm eval:baseline` commands with their stated caps) beside the two links, never a button that starts a run, because an eval run spends shared Meta budget under a cap stated before it and a web action cannot state or hold that cap.
- Deviation (D08 T02 §9): the Frontier log panel carries the link to `docs/frontier-log.md` and its one-line purpose, not the log's entries, because the Worker serves no repository files at runtime and a copied entry would go stale in the page; the log itself stays the single source.

States:

- loading: Not drawn. Deferred to D08 T02 §4: a run in progress has no board.
- empty: Placeholder layout before the first run. (Admin-Eval)
- error: App error page (E5). (Error-500)

## 7. Error pages

App error pages are 960 by 640 cards on subtle grey: the question mark motion frame, an eyebrow with the code, one plain sentence, one way forward, and a reference id with the time. None shows a stack trace or raw error text.

- Deviation (D07 T01 §8): the art tile rounds at 16 px (`card-large`) for the boards' 24 px, because 24 is no radius token and `card-large` is the nearest.
- Deviation (D07 T01 §8): in the dark theme the art tile is white (`on-band`) and the first-run art of M1 sits on a white tile, because the art is drawn in ink for a light ground and vanishes on the dark theme's `light`; the verdict band's tile (D07 T01 §7) is white in both themes for the same reason.
- Deviation (D07 T01 §8): below `md` the art tile stacks above the words at 88 px with the art at 72 px, because no phone board draws an error page and the 152 px tile beside the words leaves them under 150 px at 360 px.

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

- Deviation (D07 T03 §1): the sentence ends "The case itself stays in your organisation's account: sign in to open it." where the board says the case stays "until it reaches 30 days", because 30 days is the raw files' limit; a case's summary stays while the organisation has an account (design spec 4.8), so the board's words would tell a member an older report is gone when signing in opens it.

Controls:

- report link past its 7 days: Explains the 7-day rule. (Error-410)
- how to get a new one: Plus the forward-again fallback. (Error-410)

States:

- loading: No loading state. Not applicable: static error page, rendered whole.
- empty: No empty state. Not applicable: static error page with fixed content.
- error: No nested error state. Not applicable: this page is itself an error page.

### E3 403 No access

Boards: [PNG](mockups/png/Error-403.png) · [source](mockups/source/Error-403.dc.html)

- Deviation (D07 T08 §3): the 403 page offers "Your account" beside Sign out, because a member with no organisation can still manage how they sign in and cannot reach the Account link inside the organisation frame.
- Deviation (D07 T04 §1): the Cases list answers its own 403 (no active organisation, or a membership just removed) with Sign out alone, because the board's "Go to your own cases" is that page and would answer the same 403 again.
- Deviation (D07 T02 §15): a member of the organisation who is not an owner or admin, asking for an owner's page (the domain verification page), gets a 403 of its own: "Only an owner or admin verifies domains.", "An owner or admin of <organisation> verifies its domains. Ask one of them to do it." and Go to your cases. The board draws only the not-a-member case, whose sentence (ask an owner to invite this address) would be wrong for someone already a member.

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
- no verdict (D07 T03 §7, 2026-10-31; not drawn): a check that could not finish takes the member frame, its band in the partial colour with "Check failed · no verdict", the failure's own words (`buildReply`'s advice) and Open the full report; no actions or reasons.
- dispute link (D07 T03 §22, 2026-11-01; not drawn): the member variant's footer sentence "Think we got it wrong? Tell us on the report page." links to the report with the dispute intent (`dispute=1`), so a member opening it lands on the one-press dispute, focused; the plain Open the full report link carries no intent.
- mailbox surface (D07 T09 §3, operator decision 2026-11-02: a mail-client action link, not an Outlook add-in and not a mail-client button): that same signed, expiring dispute link, in both the HTML and plain parts of the reply, is the dispute surface inside the mailbox. Opening it is the first activation and saves nothing, so a mail scanner or a forwarded link disputes nothing; signing in keeps the intent; the one-press button on the report is the second activation and the only one that stores feedback, with the member's own session. The two activations are the dispute's own, for a member with a session: a signed-out member signs in first, and that authentication is the reader's own, not a dispute step (D07 T09 §16 holds the stricter count). Anyone who is not a member of the case's organisation is refused and stores nothing.

### N2 Sign-in link

Boards: [PNG](mockups/png/Email-Signin.png) · [source](mockups/source/Email-Signin.dc.html)

Controls:

- sign-in link: Button and plain link, 15-minute expiry. (Email-Signin)
- sign-in code: The 6-digit code beside the link. Deferred to D07 T02 §11: built from N2's text, not drawn.

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

- Deviation (D07 T08 §6): the sign-in and invitation emails (N2, N3) come from signin@isitlegit.co.za, where the boards and section 8 say no-reply@, the sender the sign-in mail has used since 2026-10-29 (one verified sender domain covers every address, and a reply to it bounces as a reply to no-reply@ would). The domain verification code (N4) does not name who asked or the organisation, which the sender does not know; it says "Someone at an organisation on IsItLegit", and it is also sent for a single address (its own wording, mailed to that address).

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
