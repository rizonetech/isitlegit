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
| 2 | §2 | First-run onboarding checklist | D07 T02 §7, D07 T02 §13 | [ ] |
| 3 | §3 | Account settings and passkeys | D07 T02 §2, D07 T01 §10 | [ ] |
| 4 | §4 | Plan and trial page | D07 T02 §8, D07 T01 §10 | [ ] |
| 5 | §5 | Admin org detail and feedback queue | D07 T05 §2, D07 T03 §6 | [ ] |
| 6 | §6 | Sign-in, invite and verification emails | D07 T03 §7 | [ ] |
| 7 | §7 | Renew an expired report link | §1, D01 T02 §3 | [ ] |
| 8 | §8 | A plan tier sets its organisation's daily case cap | D07 T02 §8 | [ ] |

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
- [ ] Reconcile an uncertain passkey change before acting again: when adding, renaming or removing a passkey gets no answer, re-read `/api/auth/passkey/list-user-passkeys` and show what is saved before offering to try again, so a passkey that was saved is not added twice; a stale session (403) asks the member to sign in again and returns here. On removal, say that the entry may remain in the device's password manager and that signed-in sessions are separate (with "sign out other sessions" beside it). Done when: `test/web/account.test.ts` drops the answer to an add that succeeded and finds one passkey listed with no second registration, and covers the 403 path and the removal wording. Cheaper substitute: a generic error banner with a retry button fails the test. Source: D07 T02 §2 completion review (Part 1 item 10).
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
- [ ] Read the plan from `planOf` (D07 T02 §8), not `org_limits`: an organisation with no row is on the trial. Done when: the page, the AppShell trial pill and `hasFeature` agree before expiry, at expiry and after an operator change, from persisted data. Source: D07 T02 §8 plan review.
- [ ] Give a plan refusal a browser journey: a page a member reaches from a Protect feature their plan lacks (D07 T02 §8's 403 `code: "plan"`) says what the feature needs and links to this page in one action, keeping where they came from; a plan that could not be read (503) is its own retryable state. Done when: rendered tests show both states, keyboard operation, and the return path kept. Source: D07 T02 §8 completion review.
- [ ] Tell an owner before the trial ends: one notice three days before and one at the end, saying the exact end time, which protection stops and that free checks continue, sent once each (a send key per trial end) and not after an extension moves the end. Done when: a test sends each once, an extension suppresses the stale ones, and a resend sends nothing more. Source: D07 T02 §8 completion review.
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
- [ ] Give the admin detail page its plan controls (`design/SPEC.md` X2: Extend trial, and the plan), through `setPlan` and `extendTrial` (D07 T02 §8), operator only, reading the plan with `planOf`. Done when: the operator extends a trial and changes a plan from the page, an organisation's own owner is refused, and the next feature check follows. Source: D07 T02 §8 plan review.
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

**Operator decision (2026-10-28 22:42 SAST):** the 410 page offers one button, "Send me a new link", which mails a fresh link to the address the reply originally went to; the page answers the same whatever happens, so an old link's holder learns nothing and cannot redirect it. The `Error-410` board's change is drawn in that direction and approved before the build; `operator` stays in Needs until `Renewal approved: YYYY-MM-DD (Error-410)` is recorded here.

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

## 8. A plan tier sets its organisation's daily case cap

> **Started:** 2026-10-31T17:22:18Z

The plan becomes the one source of an organisation's daily case cap: Free check is up to 5 checks a day (`design/SPEC.md` S5 and M10, "Up to 5 checks a day"; design spec 2b), the admin console's value (D07 T05) is an explicit override of it, and an organisation with no plan keeps today's default of 50 until the operator says otherwise. Filed 2026-10-31 at the coordinator's request: intake reads `org_limits.daily_cases` (`admitCase`, `src/db/cases.ts`), which is `NOT NULL DEFAULT 50`, so a plan written to `org_limits` silently carries 50 and nothing derives a cap from the plan; the trust lane's D05 T02 §1 depends on this.

**Corrected 2026-10-31:** measured against the tree before the build. (1) The coordinator numbered the migration 0055 (`src/db/migrations/0055_daily_cases_override.sql`) and approved the change to `admitCase` in `src/db/cases.ts`, the checks lane's file, told once it lands. (2) A third reader of the cap exists: the daily cap notice in `src/intake/email.ts` (`sendCapNotice`, the intake lane's), which says the cap reached; it reads the same expression, or the notice would name 50 to a Free organisation capped at 5. (3) The admin console that sets an organisation's cap is not built (D07 T05 §1, this lane's, whose item still says it writes `org_limits.daily_cases`): this section provides the set and clear statements (`setDailyCapOverrideStatement`, `clearDailyCapOverrideStatement` in `src/auth/plan-sql.ts`) and corrects D07 T05's item to call them, so the admin console is built on the override, never the old column.

**Corrected 2026-10-31 (plan review, `docs/reviews/07-app/D07-T08-s8.md`):** four gaps closed before the build. (1) The cap follows the organisation's effective plan by `planOf`'s own rule, not the presence of an `org_limits` row: an organisation with no row is on its trial until 14 days after its `createdAt` (or `trial_ends_at` when extended) and Free after it, so an expired trial is capped at 5, as its plan says; 50 stays only for an organisation that is not found. (2) The live limit probe `eval/launch/check-limits.ts` (D09, the eval lane's) changes and restores `daily_cases` to prove admission; once admission reads the override it must change the override, asked of the coordinator. (3) The admin console's handoff (D07 T05) names a reachable "Use plan limit" control and shows whether a cap is the plan's or an override. (4) The upload page's usage line and the delivered cap notice are each proven through their own path, in the checkpoint.

**Phase:** 5
**Needs:** none
**Surface:** no

**Build order:**

1. Ask the coordinator for the migration number, then make the override explicit: a nullable `org_limits.daily_cases_override` that the admin console writes, the old column's values carried over only where the operator set one. Done when: the local migrations apply and the schema test reads the column.
2. Read every cap through one function, `dailyCap`, in `src/auth/plans.ts` (override, else the plan's cap, else the default). Done when: `test/auth/plans.test.ts` reads each case and intake refuses the sixth Free check of the day.

- [x] Add the plan caps to `src/auth/plans.ts` as `PLAN_DAILY_CASES`: `free` 5 (SPEC S5, design spec 2b), `trial`, `protect` and `msp` the default 50 until the operator sets them, and `DEFAULT_DAILY_CASES` 50 for an organisation with no plan. Done when: a test reads each value. Cheaper substitute: a cap per organisation copied from its plan by hand.
- [x] Add `org_limits.daily_cases_override` (nullable, `CHECK (daily_cases_override IS NULL OR daily_cases_override >= 0)`) in the migration the coordinator numbers, copying `daily_cases` into it only for rows whose value is not 50 (an operator's own setting), and leaving `daily_cases` for the old readers until they move. Done when: the schema test upgrades a table holding a 50 row and a 200 row and reads null and 200. Cheaper substitute: treating every stored 50 as an override.
- [x] Give the protected demo organisation Fynbos Freight (`ZF5SufztotybeXIWVncExFAVu9GYZ8Fu`, operator, 2026-10-31) an explicit override of 50, its trial cap, in migration 0055, only where that organisation exists, so a judge's demo never drops to 5 a day mid-event (coordinator, 2026-10-31). Done when: the schema test reads the override 50 for a Fynbos Freight organisation row after the migration, no row made where it does not exist, and its plan and trial untouched. Cheaper substitute: relying on the trial's 14 days outlasting the event.
- [x] Add `dailyCapSql` in `src/auth/plan-sql.ts`, one SQL expression that gives an organisation's cap by its effective plan (`planOf`'s rule: Protect or MSP stored; Free stored; otherwise the trial until `COALESCE(trial_ends_at, createdAt + 14 days)` and Free after), the override first when set, 50 when the organisation is not found; shared by the Worker and the operator's script. Done when: a test reads 5 for a stored Free organisation, 50 for a trial, Protect and MSP organisation, 50 for an organisation with no `org_limits` row inside its 14 days and 5 at and after its trial's end, 50 again for one whose trial is extended, and 200 for an override on a Free one; and `dailyCapSql` agrees with `planOf` on every case. Cheaper substitute: the cap read in JavaScript after the count, which two arrivals can race; or "no row means 50", which leaves an expired trial uncapped.
- [x] Read the cap through `dailyCapSql` in `admitCase` (`src/db/cases.ts`, the checks lane's, approved by the coordinator), in `todayUsage` (`src/db/case-list.ts`) and in `sendCapNotice` (`src/intake/email.ts`), so admission, the usage line and the cap notice agree. Done when: `test/db/cases.test.ts` admits five cases for a Free organisation and refuses the sixth as `capped`; the upload page rendered for that organisation reads its usage as 5 of 5 (`test/web/upload-page.test.ts`); and an email forward refused at the cap delivers a notice naming 5 (the intake's own test of `sendCapNotice`); each fails when its reader uses the old column. Cheaper substitute: the upload page's line changed and intake left at 50.
- [x] Add `setDailyCapOverrideStatement(orgId, cases)` (0 to 50, the event maximum, D07 T05) and `clearDailyCapOverrideStatement(orgId)` in `src/auth/plan-sql.ts`, and correct D07 T05's cap item to call them, with a "Use plan limit" control that clears the override and a cap shown as the plan's or as an override. Done when: a test sets and clears an override and reads the cap follow, and D07 T05's item names `daily_cases_override`, "Use plan limit", the inherited-or-override display and a page test of clearing with read-back and admission following the plan. Cheaper substitute: an override that can never be removed, or a clear helper no page reaches.
- [x] Move the live limit probe `eval/launch/check-limits.ts` (D09, the eval lane's, asked through the coordinator) to change, record, restore and read back `daily_cases_override` instead of `daily_cases`, with `test/node/check-limits.test.ts` covering it. Done when: the probe's test reads the override set, admission refused at it, and the override restored to null or its earlier value. Cheaper substitute: a probe that changes a column admission no longer reads.
- [ ] Commit: `auth: a plan tier sets the daily case cap`

**Test checkpoint:** `pnpm exec vitest run --project worker test/auth/daily-cap.test.ts test/db/cases.test.ts test/web/upload-page.test.ts test/intake/email.test.ts` and `pnpm exec vitest run --project node test/node/check-limits.test.ts` pass, and fail if a Free organisation's or an expired trial's sixth check of the day is admitted, the usage line or the notice names 50 for it, or the probe changes a column admission does not read. (**Corrected 2026-10-31:** the cap's own tests are `test/auth/daily-cap.test.ts`, beside `test/auth/plans.test.ts`, which stays green unchanged.)

## Verification

- Every page and message in this file matches its board, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
