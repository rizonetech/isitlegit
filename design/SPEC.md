# IsItLegit interface specification

Status: page inventory written 2026-10-26 21:55 SAST; page designs are drafted on the design canvas and approved by the operator page by page (D07 T01 §1). This file wins over any screenshot, mockup or memory (`AGENTS.md`). Brand: `design/brand/README.md`.

References chosen by the operator (2026-10-26 21:42): Stripe (stripe.com) for the marketing site's structure, typography and "show the real product" approach, and Have I Been Pwned (haveibeenpwned.com) for the one-question, one-instant-answer pattern. Pixel precision is the bar: an 8 px spacing grid, type from Exo (headings) and Exo 2 (text), colours from the brand tokens only.

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
