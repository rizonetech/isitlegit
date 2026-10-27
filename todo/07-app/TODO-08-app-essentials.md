---
schema_version: 1
id: app-essentials
domain: 07-app
status: active
title: "TODO-08 -- Error Pages, Onboarding, Account, Plan, Admin Detail and Emails"
track: day-6
---

# TODO-08 -- Error Pages, Onboarding, Account, Plan, Admin Detail and Emails

> **Goal:** Every page and message in the `design/SPEC.md` page inventory that no other file owns is built to its canvas board: the app and site error pages, the first-run onboarding checklist, account settings with passkey management, the plan and trial page, the admin organisation detail and feedback queue, and the transactional emails (sign-in link, invitation, domain verification code).

> **Current state:** Measured 2026-10-26 22:00 SAST. The page inventory in `design/SPEC.md` section 0 found these pages with no owning section; this file owns them. The shell and components come from D07 T01 §3, auth from D07 T02, the admin console from D07 T05.

## Inputs

- `design/SPEC.md` section 0 rows S11, A4, M9, M10, X2, X4, E1 to E6, N2 to N4, and their boards in `design/mockups/`; `design/brand/README.md`; `docs/manifesto.md` (Experience: every state designed, no raw errors).

## Outcome

- Each listed page renders to its board at 360 and 1280 px with no accessibility violations, and each listed email renders in its HTML and plain-text parts.

**Adjacency:** list=applicable @ D07 T08 §5; document=not-applicable (these pages carry no document); settings=applicable @ D07 T08 §3; reporting=applicable @ D07 T08 §5; notifications=applicable @ D07 T08 §6; permissions=applicable @ D07 T08 §1; audit=applicable @ D07 T02 §6; exchange=not-applicable (no import or export here); reverse=applicable @ D07 T08 §3

**Adjacency rationale:** Error pages are the permission refusals' faces; account settings hold the user's settings and the passkey removal (reverse); the admin detail and feedback queue list and report; the emails are the notifications.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | App and site error pages | D07 T01 §10 | [ ] |
| 2 | §2 | First-run onboarding checklist | D07 T02 §7 | [ ] |
| 3 | §3 | Account settings and passkeys | D07 T02 §2, D07 T01 §10 | [ ] |
| 4 | §4 | Plan and trial page | D07 T02 §8, D07 T01 §10 | [ ] |
| 5 | §5 | Admin org detail and feedback queue | D07 T05 §2, D07 T03 §6 | [ ] |
| 6 | §6 | Sign-in, invite and verification emails | D07 T03 §7 | [ ] |
| 7 | §7 | Renew an expired report link | §1, D01 T02 §3 | [ ] |

## 1. App and site error pages

One error page component with variants for 404 (also used for forbidden cases, revealing nothing), 403, 410 expired report link, 429 slow down (with reset time), 500 (with a reference id) and maintenance, plus the site's 404 and 500 (`design/SPEC.md` E1 to E6, S11). No page shows a stack trace or raw error text.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` E1 to E6 and S11 and their boards in `design/mockups/`
**Job:** someone who hits a dead end knows what happened and what to do next
**Treatment:** the question mark, one sentence, one way forward, the check@ address
**Chrome:** `AppShell` and `ErrorState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10; the site layout for S11

**Build order:**

1. Build the error component and wire every status. Done when: each status renders its variant in a test.
2. Add the site's error pages. Done when: the Astro build emits `404.html` and a 500 page served by the Worker on failure.

- [ ] Build `src/web/pages/error.tsx` with the six variants and the Hono `notFound` and `onError` handlers using them; `onError` logs the error class and a reference id and shows only the id. Done when: `test/web/errors.test.ts` renders each variant and finds no error message text from a thrown fixture. Cheaper substitute: the framework's default error text.
- [ ] Return the 404 variant for another organisation's case and for a missing one, byte for byte the same. Done when: the test compares both responses.
- [ ] Add `site/src/pages/404.astro` and a static `500.html`. Done when: the site build emits both.
- [ ] Commit: `web: app and site error pages`

**Test checkpoint:** `pnpm exec vitest run test/web/errors.test.ts` passes and fails if a thrown message reaches the page.

## 2. First-run onboarding checklist

`/welcome` guides a new organisation (`design/SPEC.md` A4): verify your domain, invite your team, forward your first email as an attachment, add your suppliers, protect your business. Each step ticks itself from real state; the judge demo organisation sees a notice explaining its sample cases.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` A4 and its board in `design/mockups/`
**Job:** a new member gets to their first real verdict in minutes
**Treatment:** five steps, each with one action, progress shown, dismissible when done
**Chrome:** `AppShell`, `Button`, `EmptyState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the page and compute each step from state. Done when: a test organisation's checklist reflects its domains, members, cases, suppliers and identity.

- [ ] Build `src/web/pages/welcome.tsx` with the five steps computed from D1 state, linking each to its page. Done when: `test/web/welcome.test.ts` ticks each step as fixtures add the matching record. Cheaper substitute: a static list.
- [ ] Redirect a new organisation to `/welcome` after signup and show a "finish setting up" link in the shell until all steps are done or dismissed. Done when: the test follows the redirect and dismisses.
- [ ] Show the judge demo notice for organisations flagged `demo_judge`. Done when: the judge fixture sees it.
- [ ] Commit: `web: first-run onboarding checklist`

**Test checkpoint:** `pnpm exec vitest run test/web/welcome.test.ts` passes.

## 3. Account settings and passkeys

`/settings/account` (`design/SPEC.md` M9): name, email (read-only during the event), passkeys (add, rename, remove with confirmation), active sessions (sign out others), sign out.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M9 and its board in `design/mockups/`
**Job:** a member manages how they sign in and stays in control of their sessions
**Treatment:** a short settings page, destructive actions confirmed
**Chrome:** `AppShell`, `Field`, `Button` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the page on Better Auth's account and passkey APIs. Done when: a test adds and removes a passkey and signs out another session.

- [ ] Build `src/web/pages/settings-account.tsx` with name, email, passkey list and session list. Done when: `test/web/account.test.ts` finds each control by accessible name.
- [ ] Remove a passkey and sign out other sessions only after a confirmation step, and refuse removing the last sign-in method when no email link is possible. Done when: the test covers both confirmations and the refusal. Cheaper substitute: one-click removal.
- [ ] Commit: `web: account settings and passkeys`

**Test checkpoint:** `pnpm exec vitest run test/web/account.test.ts` passes.

## 4. Plan and trial page

`/settings/plan` (`design/SPEC.md` M10): the organisation's plan (trial with days left, free, Protect), what Protect includes, the launch prices with "no billing during launch", today's case usage against the daily cap.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M10 and its board in `design/mockups/`
**Job:** an owner sees what they have, what is coming, and how much they are using
**Treatment:** plain status first, then the comparison, no checkout
**Chrome:** `AppShell` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the page from the plan flags and usage. Done when: trial, expired trial and Protect fixtures each render correctly.

- [ ] Build `src/web/pages/settings-plan.tsx` reading `org_limits` and the day's case count. Done when: `test/web/plan.test.ts` checks days left, usage and the feature list.
- [ ] Commit: `web: plan and trial page`

**Test checkpoint:** `pnpm exec vitest run test/web/plan.test.ts` passes.

## 5. Admin org detail and feedback queue

`/admin/orgs/:id` (onboarding, domains, members, cases by week, threat types, feedback, plan) and `/admin/feedback` (every "this was wrong" report with case link, kind, note, providers) behind Access (`design/SPEC.md` X2, X4).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X2 and X4 and their boards in `design/mockups/`
**Job:** the operator understands one client in depth and acts on every disputed verdict
**Treatment:** dense, calm tables; links straight to the case
**Chrome:** `AppShell` admin variant from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build both pages behind `requireAccess`. Done when: a seeded database renders both and an Access-less request is refused.

- [ ] Build `src/web/pages/admin-org.tsx` and `src/web/pages/admin-feedback.tsx` with a "resolved" toggle per feedback item recorded in `feedback.resolved_at`. Done when: `test/web/admin-detail.test.ts` checks content and the toggle.
- [ ] Commit: `admin: organisation detail and feedback queue`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-detail.test.ts` passes and fails without Access.

## 6. Sign-in, invite and verification emails

The transactional emails the auth flows send (`design/SPEC.md` N2 to N4), built like the reply (D07 T03 §7): inline-styled HTML from tokens plus a complete plain-text part, sign-in and invitation from `no-reply@isitlegit.co.za` and the domain code from `verify@`, with the purpose and expiry stated and no tracking. **Corrected 2026-10-26:** these said `check@`, so a member replying to a sign-in email would start a check; `no-reply@` has no Email Routing rule, so a reply bounces.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` N2 to N4 and their boards in `design/mockups/`
**Job:** a person trusts and acts on a sign-in, invitation or verification email from IsItLegit
**Treatment:** the logo, one sentence, one button, the plain link, the expiry
**Chrome:** the email layout from D07 T03 §7

**Build order:**

1. Build the three templates and wire them to the senders. Done when: snapshots match the boards and the email lint passes.

- [ ] Build `src/mail/templates/signin.tsx`, `invite.tsx` and `domain-code.tsx` and use them from D07 T02 §1, §3 and §5, sending sign-in and invitation from `no-reply@` and the code from `verify@`. Done when: `test/mail/auth-emails.test.ts` snapshots both parts of each and asserts each From address.
- [ ] Run the email lint (no flex or grid, tables for layout, alt text) on each. Done when: it passes and fails on a planted `display:grid`.
- [ ] Commit: `mail: sign-in, invitation and verification emails`

**Test checkpoint:** `pnpm exec vitest run test/mail/auth-emails.test.ts` passes.

## 7. Renew an expired report link

A recipient whose report link has passed its 7 days (D01 T01 §8) reaches the 410 page (`design/SPEC.md` E2, §1), which today offers signing in or forwarding the email again. A stranger holding an old link must learn nothing, yet the person the reply went to should get a fresh link to the same report in one step, without a new analysis or searching for the case. Filed from D01 T01 §8's completion review (out-of-scope excellence gap, 2026-10-27), which compared it with Stripe's hosted invoice page, whose expired-link page sends a fresh link to the recipient's address.

**Phase:** 6
**Needs:** operator
**Surface:** yes
**Fidelity:** `design/SPEC.md` E2 (the 410 page, once its renewal control is drawn), board `Error-410` and the renewed-link email
**Job:** the person the reply went to gets back into their report in one request and one click
**Treatment:** one field or one button, one sentence on what happens next, the same answer whether or not the address is entitled, tokens only
**Chrome:** the error page from §1, the shared `Button` and `Field` (D07 T01 §6), the reply mail design (D07 T03 §7)

**Operator decision (open):** the renewal control is a design change to the approved `Error-410` board (an email field, or a button that mails the original recipient), drawn and approved first. Recording `Renewal approved: YYYY-MM-DD (<board>)` here and removing `operator` from Needs releases the section.

**Build order:**

1. Draw and approve the renewal. Done when: the board and the SPEC entry exist and the approval line is recorded.
2. Renew without leaking. Done when: an entitled request mails a fresh link and every request gets the same page.

- [ ] Draw the renewal on `design/mockups/source/Error-410.dc.html` and its PNG, and add it to `design/SPEC.md` E2 (the control, the confirmation sentence, the email). Done when: the board and SPEC entry are committed and the operator's `Renewal approved:` line is recorded here. Cheaper substitute: telling the reader to forward the email again, which reruns the analysis.
- [ ] Accept a renewal only for an authentic expired link (`verifyReportLink` answers `expired`) and send the fresh link only to an address the case already records as its reply recipient or a member of the case's organisation. Done when: `test/web/report-renew.test.ts` sends to the recorded recipient and to a member, and to nobody for any other address or for a tampered or foreign link.
- [ ] Answer every request with the same confirmation page and timing class, whether or not anything was sent, so the page reveals neither the case nor who may receive it. Done when: the test compares the entitled and unentitled responses byte for byte.
- [ ] Mail the fresh link with `signReportLink` and an absolute link from the trusted origin (D01 T02 §3), through `sendMail` with a `kind` of `renewal`, at most 3 per case per day. Done when: the test records one `mail_sends` row per renewal and refuses the fourth in a day with the same page. Cheaper substitute: extending the old link's lifetime, which would make every leaked link live longer.
- [ ] Prove the page in Chromium: the control is reachable by keyboard, its label names it, and the confirmation is announced. Done when: `test/node/report-renew-browser.test.tsx` passes in both themes.
- [ ] Commit: `web: renew an expired report link`

**Test checkpoint:** `pnpm exec vitest run test/web/report-renew.test.ts test/node/report-renew-browser.test.tsx` passes, and fails if an unentitled address is mailed or its page differs from the entitled one.

## Verification

- Every page and message in this file matches its board, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
