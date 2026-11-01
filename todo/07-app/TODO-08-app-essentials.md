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
| 1 | §1 | App and site error pages | D07 T01 §10 | [x] |
| 2 | §2 | First-run onboarding checklist | D07 T02 §7, D07 T02 §13 | [ ] |
| 3 | §3 | Account settings and passkeys | D07 T02 §2, D07 T01 §10 | [x] |
| 4 | §4 | Plan and trial page | D07 T02 §8, D07 T01 §10 | [x] |
| 5 | §5 | Admin org detail and feedback queue | D07 T05 §2, D07 T03 §6 | [ ] |
| 6 | §6 | Sign-in, invite and verification emails | D07 T03 §7 | [ ] |
| 7 | §7 | Renew an expired report link | §1, D01 T02 §3 | [ ] |
| 8 | §8 | A plan tier sets its organisation's daily case cap | D07 T02 §8 | [x] |
| 9 | §9 | Site 404 and 500 pages | D07 T06 §1 | [ ] |
| 10 | §10 | Slow-down page on the browser's 429s | §1, §4 | [ ] |
| 11 | §11 | Trial-end notices to the owners | D07 T02 §8 | [ ] |
| 12 | §12 | Plan refusal as a page | §1, §4 | [x] |
| 13 | §13 | Remove a passkey and sign sessions out | §3 | [ ] |
| 14 | §14 | Add and rename a passkey | §3 | [ ] |

## 1. App and site error pages

> **Started:** 2026-10-31T21:11Z

One error page component with variants for 404 (also used for forbidden cases, revealing nothing), 403, 410 expired report link, 429 slow down (with reset time), 500 (with a reference id) and maintenance, plus the site's 404 and 500 (`design/SPEC.md` E1 to E6, S11). No page shows a stack trace or raw error text.

**Corrected 2026-10-31:** measured against the tree. (1) `src/web/pages/errors.tsx` (the app lane's, D07 T03) already draws E1 404, E3 403, E2 410 and E5 500 through `errorPage`, and the shared `ErrorState` (D07 T01) already has the 429 and maintenance art, titles and colours, so this section adds only the two missing page functions (E4 429 with its reset time, E6 maintenance) and does not rebuild the rest. (2) Nothing answers an unmatched path or an uncaught throw with those pages: `src/index.ts` has no `notFound` or `onError`, so Hono's plain "404 Not Found" and a plain 500 reach a member; the two handlers are added there (`src/index.ts`, the coordinator's, approval asked). (3) The planned downtime notice needs a switch: a `MAINTENANCE` variable in `wrangler.jsonc` (the coordinator's, approval asked) that makes every request answer the maintenance page, 503 with `retry-after`, and nothing when unset. (4) `test/web/errors.test.ts` does not exist; the two byte-for-byte 404s exist in `test/web/report-access.test.ts` (the app lane's) and this section adds its own comparison. (5) The site's 404 and 500 (S11) are Astro pages in `site/`, the site lane's tree (D07 T06): they move to §9, which depends on the site layout and asks that lane.

**Corrected 2026-10-31 (build):** the two new pages are separate functions, `slowDownPage` (daily cap and burst) and `maintenancePage`, because `errorPage` takes a case id and a retry address that neither uses; `MAINTENANCE` is empty for normal, `<start ISO>/<end ISO>` for a window on the page, or any other text for the page without a window; the board's "See your plan" opens `/settings/plan` (M10, D07 T08 §4, not built yet).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` E1 to E6 and S11 and their boards in `design/mockups/`
**Job:** someone who hits a dead end knows what happened and what to do next
**Treatment:** the question mark, one sentence, one way forward, the check@ address
**Chrome:** `AppShell` and `ErrorState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10; the site layout for S11

**Build order:**

1. Add the 429 and maintenance variants to `src/web/pages/errors.tsx` and wire `notFound`, `onError` and the maintenance switch in `src/index.ts`. Done when: `test/web/errors.test.ts` renders each status's variant and finds no error text from a thrown fixture.

- [x] Add `slowDownPage(...)` (E4: the daily cap with the limit and the reset time in words and as 00:00 SAST, or the burst limit with its seconds; 429 with `retry-after`) and `maintenancePage()` (E6: a planned downtime notice, `retry-after`) to `src/web/pages/errors.tsx` from `ErrorState` and the boards `Error-429` and `Error-Maintenance`, with their titles and page headers. A daily cap of 0 (an operator's pause, `pausedAlert` in `src/web/pages/upload-view.tsx`) is drawn paused, with no reset time promised. Done when: `test/web/errors.test.ts` renders each with its sentence and the reset time (E6 names the check@ address; the board of E4 does not), the paused state without a reset time, and no stack or raw message. Cheaper substitute: the 500 page for both.
- [x] Answer every unmatched path with the 404 variant and every uncaught throw with the 500 variant through `app.notFound` and `app.onError` in `src/index.ts` (the coordinator's, approved 2026-10-31 20:57): `onError` logs the error class and a reference id as JSON and shows only the reference, status 503 with `retry-after`, "Try again" opening the same address for a `GET` and the Cases list for any other method, a `HEAD` and a request that does not accept HTML answered with the same status and no body. Done when: the test requests an unknown path and a route that throws a fixture with a secret in its message and finds the 404 and 500 pages with the reference logged and the message in neither, the retry link per method, and the bodyless answers. Cheaper substitute: the framework's default error text.
- [x] Add the maintenance switch: when `MAINTENANCE` is set (`wrangler.jsonc` `vars`, approved) every request except `/static/` answers `maintenancePage()` with 503 and `retry-after` before any route runs, so no write happens meanwhile; the `email` handler is untouched and keeps taking mail (it is not held, so the page says replies may be late). Done when: the test sets the variable and reads the page, status and `retry-after` on `/cases` and `/r/<id>` (the requested path kept in Reload), finds a `POST` changing nothing, finds `/static/` still served, and reads normal pages once it is cleared. Cheaper substitute: a deploy that takes the Worker down.
- [x] Return the 404 variant for another organisation's case and for a missing one, byte for byte the same apart from the reference line. Done when: the test compares both responses. Shipped by D07 T03 §1: `test/web/report-access.test.ts` ("answers the same 404 for a tampered or malformed link, another organisation's case, a missing one and a non-member") compares them.
- [x] Commit: `web: app and site error pages`

> **Deferred:** the site's 404 and 500 pages (S11) -> XREF: D07 T08 §9

> **Deferred:** `slowDownPage`'s callers on the browser's 429s, its burst countdown, and the "See your plan" destination (`/settings/plan`) -> XREF: D07 T08 §10 and D07 T08 §4

**Test checkpoint:** `pnpm exec vitest run test/web/errors.test.ts` passes and fails if a thrown message reaches the page.

> **Verified:** 2026-10-31 | §1 | 9d92a4984ffc05da123ec9670fdc0ab0147896f3
> **Review:** `docs/reviews/d07-t08-s1.json`

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

> **Started:** 2026-11-01T00:08Z

`/settings/account` (`design/SPEC.md` M9): name, email (read-only during the event), passkeys (add, rename, remove with confirmation), active sessions (sign out others), sign out.

**Corrected 2026-11-01 (plan):** measured against the tree. (1) Better Auth's passkey plugin is configured (`src/auth/auth.ts`, vetted by `src/auth/passkey.ts`); the sign-in side of the ceremony exists in `src/web/client/app.ts` (`[data-passkey]`, `navigator.credentials.get`), the registration side does not, so "add" needs a client ceremony beside it (`/api/auth/passkey/generate-register-options`, `navigator.credentials.create`, `/api/auth/passkey/verify-registration`). (2) The page runs Better Auth's own handler in process like the Team page (`src/web/pages/team.tsx`): name through `update-user`, a passkey's name through `passkey/update-passkey`, removal through `passkey/delete-passkey`, sessions through `list-sessions`, `revoke-session` and `revoke-other-sessions`. A session's token is never put in a page: each session row carries its session id, and the route resolves the token from the member's own stored sessions. (3) "Refuse removing the last sign-in method when no email link is possible": an email link is always possible to the account's own address, so removing the last passkey is allowed and the page says the email link remains; a test holds that and the guard is the account having an address. (4) The email address is read-only (the event rule), drawn as text, never an input that posts. (5) A passkey's removal does not remove it from the device's password manager, and signed-in sessions are separate: both are said on the confirm page. (6) The page is the member's own account, not the organisation's: it is reached by any signed-in member, with or without an active organisation.

**Corrected 2026-11-01 (plan review):** split by single responsibility. This section keeps the page: the read of name, email, passkeys and sessions, the name save, the empty states, the account-only frame and the outage. Removing a passkey and signing sessions out (with their confirmations and failure recovery) is §13; adding and renaming a passkey (the client ceremony, its refusals and the reconciliation after a lost answer) is §14. The board draws "Last used" on a passkey and "Signed in" with the method on a session; the passkey table stores no last-used time and a session no method, so this section records both as SPEC M9 Deviations rather than invent them. `memberShell` throws when the member has no matching organisation, so the account page draws its own frame (the member variant with no organisation switcher entry, or the public one) for a member with no organisation or one whose active organisation was removed.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M9 and its board in `design/mockups/`
**Job:** a member manages how they sign in and stays in control of their sessions
**Treatment:** a short settings page, destructive actions confirmed
**Chrome:** `AppShell`, `Field`, `Button` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the page on Better Auth's account and passkey APIs. Done when: a test adds and removes a passkey and signs out another session.

- [x] Record the two board differences in `design/SPEC.md` M9 first: no "Last used" on a passkey and no sign-in method on a session, each with its reason. Done when: M9 lists both Deviations and `design/tools/check-design.py` passes. Cheaper substitute: leaving the board unmatched without a record.
- [x] Build `GET /settings/account` in `src/web/pages/settings-account.tsx` (view `settings-account-view.tsx`, mounted in `src/index.ts` with the standing one-line mount) behind `sessionGate`, private and no-store: the name field with Save, the email as read-only text, the passkey table (name, added date, device type; the Rename and Remove controls belong to §14 and §13 and are drawn by them), the session table (device from the user agent, last active in SAST, "This device" marked; Sign out per session is §13's), and Sign out. Done when: `test/web/account.test.ts` finds each control by accessible name for a member with two passkeys and three sessions, signed out is sent to sign-in, and another member's passkeys and sessions never appear. Cheaper substitute: a static page.
- [x] Draw the account-only frame for a member with no organisation or one whose active organisation was removed (`memberShell` would throw), and the empty states: no passkeys ("No passkeys yet. You sign in with an email link."), only this session ("This is your only session."). Done when: the test requests the page as a member with no membership and as one whose active organisation was deleted (a 200 with a frame, no organisation switcher entry), and reads both empty lines. Cheaper substitute: the 403 page.
- [x] Save a changed name through Better Auth's `update-user` in process (a bounded form, `src/auth/form.ts`), 303 back with "Name saved" announced; an empty or over-long name refused under the field with what was typed kept; an API or storage failure answered as "could not be confirmed" over the stored name with what was typed kept, never as saved. Done when: the test saves and reads the stored name, reads each refusal, and fails the write to read the unconfirmed state. Cheaper substitute: posting the user row directly.
- [x] Say a read that fails (sessions, passkeys) as the retryable outage every member page gives. Done when: the test fails each read and reads Try again opening the same address, then recovers. Cheaper substitute: an empty list.
- [x] Prove the page in Chromium by keyboard (Tab to each control and Save with Enter, the announced result), the empty states, and the accessibility gate's rules at 360 and 1280 px in both themes. Done when: `test/node/account-browser.test.tsx` passes. Cheaper substitute: rendered-HTML tests only.
- [x] Commit: `web: account settings and passkeys`

**Test checkpoint:** `pnpm exec vitest run test/web/account.test.ts` and `pnpm exec vitest run --project browser test/node/account-browser.test.tsx` pass.

> **Deferred:** removing a passkey and signing sessions out -> XREF: D07 T08 §13

> **Deferred:** adding and renaming a passkey -> XREF: D07 T08 §14

> **Verified:** 2026-11-01 | §3 | 225db9f6745cd9a0c2b8bce86b91c738f8af8ee5
> **Review:** `docs/reviews/d07-t08-s3.json`

## 4. Plan and trial page

> **Started:** 2026-10-31T23:06Z

`/settings/plan` (`design/SPEC.md` M10): the organisation's plan (trial with days left, free, Protect), what Protect includes, the launch prices with "no billing during launch", today's case usage against the daily cap.


**Corrected 2026-10-31:** the daily cap and usage on this page read `todayUsage` (`src/db/case-list.ts`), which reads `dailyCapSql` (D07 T08 §8): the cap by the effective plan with the operator's override first, and a cap of 0 shown as paused by IsItLegit, never as resetting at midnight. "About your plan" on the upload page's limit alert opens this page.
**Corrected 2026-11-01 (plan):** split by single responsibility. The page and its plan read stay here; the two later checklist items move to their own sections: the trial-end notices (a scheduled mail job and a send key per trial end) to §11, and the plan-refusal browser journey (a page a member reaches from a Protect feature their plan lacks) to §12, both listed in the console lane. Measured against the tree: `planOf` (`src/auth/plans.ts`) returns `trial` with `daysLeft`, `free` or `protect`/`msp`, or null, and throws `PlanUnavailable`; `todayUsage` (`src/db/case-list.ts`) gives `used` and `limit`; `pausedAlert` (`src/web/pages/upload-view.tsx`) already links "About your plan" here; the AppShell has the Plan nav entry. The board `Plan` shows Free check, Protect and MSP with launch prices, the trial card with days left and the date the trial ends in SAST, and the usage bar with "Tell us" (`mailto:` the support address). The page is read-only for every role (no checkout), and the Free check card says "Up to 5 checks a day" (the SPEC M10 note). A cap of 0 draws "Paused by IsItLegit", not a reset time.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M10 and its board in `design/mockups/`
**Job:** an owner sees what they have, what is coming, and how much they are using
**Treatment:** plain status first, then the comparison, no checkout
**Chrome:** `AppShell` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build the page from the plan flags and usage. Done when: trial, expired trial and Protect fixtures each render correctly.

- [x] Build `GET /settings/plan` in `src/web/pages/settings-plan.tsx` (the page in `settings-plan-view.tsx`) behind `sessionGate` and `activeMembership` like every member page, scoped to the active organisation, answered `private, no-store`, mounted in `src/index.ts` with the standing one-line mount: the status card, the usage bar and the three launch tiers (current one marked). The card says: a trial with days left and the end date in SAST; Free after a lapsed trial ("Trial used", the end date) and Free assigned without a trial end (no end date and no claim that a trial was used); Protect; MSP. Usage says used of limit with a bounded bar, "0 left today" when used reaches or passes the limit (a cap lowered or a trial lapsed can leave used above limit), resets at 00:00 SAST, and a cap of 0 as "Paused by IsItLegit" with no reset time; "Tell us" is `mailto:` the support address. Done when: `test/web/plan.test.ts` requests the mounted route as signed out (redirect to sign-in), as a removed member (the 403 page) and as an owner, an admin and a member of two organisations with different plans and usage (each sees only its own), and reads every state above, including zero usage, exactly capped, over-cap, paused and the SAST midnight rollover, from persisted rows. Cheaper substitute: a static page of the three tiers.
- [x] Read the plan from `planOf` only, never `org_limits` directly: an organisation with no row is on the trial counted from its own `createdAt` (`planOf`'s rule). Done when: the page, the AppShell trial pill and `hasFeature` agree before expiry, at expiry, for an explicit Free without a trial end, and after an operator change (`setPlan`, `extendTrial`), from persisted data. Source: D07 T02 §8 plan review. Cheaper substitute: reading `org_limits.plan`.
- [x] Say a plan or usage that could not be read as the retryable outage every member page gives (`memberShell` throws `ShellUnavailable` when `planOf` fails, so the page answers the 503 with Try again opening the same address, and never draws the free plan or a trial). Done when: the test makes `planOf` and then the usage read fail persistently and reads the retryable page each time, then recovers through Try again once the read works. Cheaper substitute: drawing the free plan.
- [x] Prove the page in Chromium: Plan reached from the navigation by keyboard, "Tell us" with its `mailto:` destination, a retry from the outage page recovering, and the accessibility gate's rules at 360 and 1280 px in both themes. Done when: `test/node/plan-browser.test.tsx` passes. Cheaper substitute: rendered-HTML tests only.
- [x] Commit: `web: plan and trial page`

**Test checkpoint:** `pnpm exec vitest run test/web/plan.test.ts` and `pnpm exec vitest run --project node test/node/plan-browser.test.tsx` pass.

> **Deferred:** the trial-end notices -> XREF: D07 T08 §11

> **Resolved:** the plan-refusal browser journey -> XREF: D07 T08 §12 (built and stamped there)

> **Verified:** 2026-11-01 | §4 | fd6b132cca9d0dd6b8adfbbab8f1e237dd70e7e9
> **Review:** `docs/reviews/d07-t08-s4.json`

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

> **Started:** 2026-11-01T00:44Z

The transactional emails the auth flows send (`design/SPEC.md` N2 to N4), built like the reply (D07 T03 §7): inline-styled HTML from tokens plus a complete plain-text part, sign-in and invitation from `no-reply@isitlegit.co.za` and the domain code from `verify@`, with the purpose and expiry stated and no tracking. **Corrected 2026-10-26:** these said `check@`, so a member replying to a sign-in email would start a check; `no-reply@` has no Email Routing rule, so a reply bounces.

**Corrected 2026-11-01 (plan):** measured against the tree. (1) The three senders exist and send plain text only through `sendMail` (`html` is supported by `MailMessage`): `sendMagicLink` and `sendInvitationEmail` in `src/auth/auth.ts` (From `SIGNIN_FROM`, `no-reply@`, kind `signin`) and `sendClaimCode` in `src/auth/claim-mail.ts` (From `CLAIM_FROM`, `verify@`, kind `claim`); the From addresses are already right, so the work is the HTML and the board's words, with the send keys, kinds, subjects and the first URL of the text (the tests read the link from it) unchanged. (2) The reply email's frame (`src/mail/templates/reply.ts`) is the pattern: tables, inline styles from `design/tokens`, the PNG logo (`EMAIL_LOGO`), escaped text; its layout lint lives in `test/mail/reply-design.test.ts`, so this section's test carries the same rules. (3) Templates are one module, `src/mail/templates/auth-mail.ts`, with the three builders, rather than three `.tsx` files: the reply email is plain string-built HTML, not JSX. (4) Expiries come from their owners, never retyped: `MAGIC_LINK_SECONDS` (15 minutes), the invitation's own `expiresAt` (48 hours, shown in SAST), and the claim code's 30 minutes (`CODE_LIFETIME_MS` in `src/auth/domains.ts`, passed in by the caller). (5) The domain-code board names who asked and the organisation; the sender knows neither (`sendClaimCode` gets the recipient, the claim and the code), so the email says "Someone at an organisation on IsItLegit" as the text does now, and a SPEC N4 Deviation records the difference. (6) The sign-in board prints the requested time and the expiry time; both are computed at send. (7) No tracking: no pixel, no wrapped links; the one link is the real one.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` N2 to N4 and their boards in `design/mockups/`
**Job:** a person trusts and acts on a sign-in, invitation or verification email from IsItLegit
**Treatment:** the logo, one sentence, one button, the plain link, the expiry
**Chrome:** the email layout from D07 T03 §7

**Build order:**

1. Build the three templates and wire them to the senders. Done when: snapshots match the boards and the email lint passes.

- [ ] Build `src/mail/templates/auth-mail.ts` with `signinEmail` (carrying the six-digit code and its same-browser instructions in both parts, as SPEC N2 and `src/auth/signin-code.ts` require), `inviteEmail` and `claimCodeEmail` (a domain variant, "proving it controls <domain>", and an address variant for `src/auth/domains.ts`'s single-address verification, with the accurate receipt reason for each: `admin@` or `postmaster@` for a domain, the address itself for an address), each returning `{ text, html }` from the boards `Email-Signin`, `Email-Invite` and `Email-DomainCode`: the logo, one heading, one sentence, the single button and the plain link (sign-in and invitation) or the large code with nothing to click (domain code), the expiry in words and the SAST time, the "did not ask" line, the reason for receiving it and the footer ("We never ask for passwords, PINs or bank details by email"), as tables with inline token styles and every user-supplied value escaped. Done when: `test/mail/auth-emails.test.ts` extracts the code from each delivered part of a real sign-in link and completes the existing sign-in with it, renders each with a hostile inviter, organisation and domain name and finds every value escaped, both parts complete, and the first URL of each text the real link. Cheaper substitute: the current plain text only.
- [ ] Use them from the three senders (`sendMagicLink`, `sendInvitationEmail` in `src/auth/auth.ts`, the coordinator's approval 2026-11-01; `sendClaimCode` in `src/auth/claim-mail.ts`), passing `html` and the new `text` and changing nothing else (both of `sendClaimCode`'s callers in `src/auth/domains.ts`, the domain and the single address, pass which they are): the send keys, kinds, subjects, From addresses, hooks and the sign-in code row stay. Done when: the same test sends a sign-in link, an invitation and a claim code through the real senders with a stubbed provider and asserts each From (`no-reply@`, `no-reply@`, `verify@`), subject, kind, both parts and that the existing auth, invitation and claim tests still pass. Cheaper substitute: calling the templates only from the test.
- [ ] Say the expiries truthfully: 15 minutes from `MAGIC_LINK_SECONDS` with the requested and expiry times, the invitation's 48 hours from its own `expiresAt`, the code's 30 minutes from the caller, and the three-wrong-tries lock the claim enforces. Done when: the test reads each from its owner's constant or stored value and fails if one is retyped. Cheaper substitute: fixed numbers.
- [ ] Prove the rendering in Chromium at 360 and 1280 px (`test/node/auth-emails-browser.test.tsx`, the browser project): each HTML part set into a page with a very long organisation, inviter and domain name shows no sideways scroll, its link and code stay inside the column and its button and link are keyboard-focusable with their names, the content stays readable with images blocked (alt text shown), and contrast between each text and its background meets AA. Done when: the browser test passes. Cheaper substitute: string checks on the HTML.
- [ ] Run the email lint on each (tables for layout, no `display:flex` or `grid`, no `position` or `float`, `alt` on every image, no script or tracking pixel). Done when: it passes on each and fails on a planted `display:grid` and on a planted image without `alt`. Cheaper substitute: eyeballing the HTML.
- [ ] Record the domain-code board's differences in `design/SPEC.md` N4 (who asked and the organisation are not known to the sender). Done when: N4 lists the Deviation and `design/tools/check-design.py` passes. Cheaper substitute: none.
- [ ] Commit: `mail: sign-in, invitation and verification emails`

**Test checkpoint:** `pnpm exec vitest run test/mail/auth-emails.test.ts` passes, with `test/auth/org.test.ts`, `test/auth/claim-mail.test.ts` and the sign-in tests.

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
- [x] Commit: `auth: a plan tier sets the daily case cap`

**Test checkpoint:** `pnpm exec vitest run --project worker test/auth/daily-cap.test.ts test/db/cases.test.ts test/web/upload-page.test.ts test/intake/email.test.ts` and `pnpm exec vitest run --project node test/node/check-limits.test.ts` pass, and fail if a Free organisation's or an expired trial's sixth check of the day is admitted, the usage line or the notice names 50 for it, or the probe changes a column admission does not read. (**Corrected 2026-10-31:** the cap's own tests are `test/auth/daily-cap.test.ts`, beside `test/auth/plans.test.ts`, which stays green unchanged.)

> **Verified:** 2026-10-31 | §8 | f710f177913a7dd2375795709e4f8356594c8c55
> **Review:** `docs/reviews/d07-t08-s8.json`

## 9. Site 404 and 500 pages

The marketing site's own error pages (`design/SPEC.md` S11, boards `Site-404` and `Site-500`): a plain message, the search-free way back and the check@ address, in the site layout. Moved 2026-10-31 from §1, which put them in the site lane's tree.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S11 (boards `Site-404`, `Site-500`)
**Job:** someone who lands on a missing site page knows what happened and how to get back
**Treatment:** the question mark, one sentence, the way back, the check@ address
**Chrome:** the site layout (D07 T06 §1)

**Build order:**

1. Add `site/src/pages/404.astro` and a static `500.html` in the site layout, asked of the site lane (`site/` is its tree) at build time. Done when: the site build emits both.

- [ ] Add `site/src/pages/404.astro` from the board `Site-404` in the site layout, with the way back to the home page and the check@ address. Done when: the site build emits `404.html` and its test reads the sentence and the link. Cheaper substitute: Astro's default 404.
- [ ] Add a static `site/public/500.html` from `Site-500`, with no script and no dependency on the Worker, for the Worker to serve when it cannot render. Done when: the build emits it and a test reads it standalone. Cheaper substitute: a text 500.
- [ ] Commit: `site: 404 and 500 pages`

**Test checkpoint:** `pnpm --dir site build` emits `404.html` and `500.html`, and the site's page test reads their sentences.

## 10. Slow-down page on the browser's 429s

`slowDownPage` (E4, D07 T08 §1) is built but nothing calls it: the upload page draws its own inline refusal for the daily cap (`src/web/pages/upload-view.tsx`), and `src/intake/upload.ts:132` answers the JSON API's 429. Filed 2026-10-31 from §1's plan review (`docs/reviews/07-app/D07-T08-s1.md`, gaps 1 and 4): a browser navigation that is refused with 429 (a form posted without JavaScript, or a page opened directly while capped or rate limited) shows the E4 page with the real limit, reset time and `retry-after`, the API's JSON unchanged.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` E4 (board `Error-429`)
**Job:** someone refused for going too fast or too far knows when they can go on
**Treatment:** the limit, the reset time in words, one way forward, the check@ address
**Chrome:** `ErrorState` (D07 T01 §6) through `slowDownPage` (D07 T08 §1)

**Build order:**

1. List every browser path that can answer 429 and route the full-page ones to `slowDownPage` with measured numbers. Done when: `test/web/slow-down.test.ts` requests each as a browser and as JSON and finds the E4 page and the unchanged JSON.

- [ ] List the browser paths that answer 429 today (`grep -rn "429" src`) in the section's Corrected note, each marked full page (routed here), inline (kept, with its reason) or JSON (unchanged). Done when: the note names each `file:line` with its mark. Cheaper substitute: routing only the upload route.
- [ ] Route each full-page 429 to `slowDownPage` with the organisation's real limit (`todayUsage`, `src/db/case-list.ts`) and the next SAST midnight, or the burst limit's real seconds, keeping the JSON body for a request that does not accept HTML. Done when: `test/web/slow-down.test.ts` shows the page's limit and reset time equal the stored cap and `sastDayStart` plus one day, and `retry-after` equal to the wait. Cheaper substitute: fixed text.
- [ ] Draw the paused state (a daily cap of 0, `pausedAlert` in `src/web/pages/upload-view.tsx`) on the full page without promising a midnight reset. Done when: a test with `daily_cases_override` 0 finds no reset time and the operator contact. Cheaper substitute: the reset sentence.
- [ ] Count the burst limit's seconds down on the page with a no-JavaScript fallback of the static sentence, and reload when it reaches zero. Done when: a Chromium test reads the seconds fall and the page leave the refusal, and the no-script page keeps the sentence. Cheaper substitute: a static number.
- [ ] Prove "See your plan" opens the Plan page (D07 T08 §4) and "Back to cases" the Cases list. Done when: the test follows both links to a 200. Cheaper substitute: asserting the href.
- [ ] Commit: `web: slow-down page on the browser's 429s`

**Test checkpoint:** `pnpm exec vitest run test/web/slow-down.test.ts` passes and fails if a full-page 429 answers the JSON body or a wrong reset time.

## 11. Trial-end notices to the owners

An owner is told before the trial ends and when it has: one notice three days before and one at the end, saying the exact end time, which protection stops and that free checks continue. Split from §4 on 2026-11-01; source D07 T02 §8 completion review.

**Phase:** 6
**Needs:** none
**Surface:** no
**Job:** an owner is not surprised by the end of the trial
**Treatment:** a plain email from no-reply@ with the end time in SAST and one link to the Plan page

**Build order:**

1. Select the organisations whose trial ends in about three days or has ended, and send each owner one notice per trial end. Done when: `test/mail/trial-notices.test.ts` sends each once.

- [ ] Add `sendTrialNotices(env, now)` in `src/mail/trial-notices.ts` run from the scheduled handler: organisations on the trial whose end is within three days (the three-day notice) and organisations whose trial ended in the last day and are still on the free plan (the end notice), to every owner, with a send key `trial:<org>:<kind>:<end as ISO>`. Done when: the test sends the three-day notice and the end notice once each, a second run sends nothing, and an extension (a later `trial_ends_at`) sends a new notice for the new end and none for the stale one. Cheaper substitute: sending on every run.
- [ ] Write the two emails (subject, the end time in SAST, which protection stops, that free checks continue, the Plan page link) with a plain-text part, in the N-series email shape (`design/SPEC.md` 8). Done when: the test reads both bodies and finds no claim of billing. Cheaper substitute: a one-line text.
- [ ] Never send to an organisation that has moved to Protect or MSP, or whose owner is protected-test data. Done when: the test sends nothing for each. Cheaper substitute: none.
- [ ] Commit: `mail: trial-end notices`

**Test checkpoint:** `pnpm exec vitest run test/mail/trial-notices.test.ts` passes and fails if a notice is sent twice for one trial end.

## 12. Plan refusal as a page

> **Started:** 2026-10-31T23:38Z

A page a member reaches from a Protect feature their plan lacks (D07 T02 §8's 403 `code: "plan"`) says what the feature needs and links to the Plan page in one action, keeping where they came from; a plan that could not be read (503) is its own retryable state. Split from §4 on 2026-11-01; source D07 T02 §8 completion review.

**Corrected 2026-11-01 (plan):** measured against the tree after §4. `requireFeature`'s JSON 403 (`code: "plan"`, `src/auth/plans.ts`) has no caller in `src/`; the two Protect pages draw the plan-lacking state themselves, as `ErrorState` with a "See your plan" button to `/settings/plan` (`src/web/pages/identity-view.tsx:755` for `/protect`, `src/web/pages/suppliers-view.tsx:947` for `/suppliers`), those files belong to the trust lane, and the plan-unreadable 503 is §4's retryable outage. What this lane can still deliver is the destination's half of the journey: `/settings/plan` keeps where the member came from (`?from=<same-site path>`, shown as "Back to <page>", dropped when it is not a same-site path) and a test that the two pages' buttons reach it in one action. The buttons passing `?from=` is asked of their owners.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` E3/E4 family (the error-page frame) and M10
**Job:** someone who meets a feature their plan lacks learns what to do, not just that they may not
**Treatment:** the error frame, one sentence naming the feature and plans, one action to the Plan page
**Chrome:** `ErrorState` through `errorPage` (D07 T08 §1)

**Build order:**

1. Make the Plan page return a member to where they came from, from the real buttons, through an outage too. Done when: `test/web/plan-refusal.test.ts` follows each real button through the Plan page and Back to its origin.

- [x] Honour `?from=<path>` on `GET /settings/plan` (`src/web/pages/settings-plan.tsx`, `settings-plan-view.tsx`): a path that `sameSitePath` (`src/auth/paths.ts`) accepts shows "Back" to it in place of "Back to cases", anything else (a `//host`, a scheme, a backslash, a path past 2048 characters) is dropped. Done when: `test/web/plan.test.ts` follows `?from=/protect` to a Back link to `/protect`, and finds the Cases link for `?from=//evil.example`, `?from=https://evil.example` and an over-long value. Cheaper substitute: always back to Cases.
- [x] Keep the validated return path through the Plan page's outage: when the plan or usage read fails, the retryable page's Try again opens `/settings/plan?from=<the same path>` (`outage()` in `src/web/pages/settings-plan.tsx` takes the requested address), and a `from` that fails `sameSitePath` is not carried. Done when: `test/web/plan-refusal.test.ts` fails a read, reads Try again with the `from` kept, recovers, and finds Back to the origin. Cheaper substitute: a Try again to the bare address.
- [x] Pass the origin from the two real buttons (the trust lane's files, `src/web/pages/identity-view.tsx` and `src/web/pages/suppliers-view.tsx`, the coordinator's approval 2026-11-01 01:43): `/settings/plan?from=/protect` and `?from=/suppliers`, with the tests that assert those addresses. Done when: the test requests `/protect` and `/suppliers` as a free-plan organisation, follows each page's actual "See plans" button to the Plan page, finds "You are on the free plan", and follows Back to the originating page. Cheaper substitute: asserting the href.
- [x] Prove Back in Chromium by keyboard: activation of Back for both origins and the Cases fallback, with accessible names and visible focus, and the accessibility gate's rules at 360 and 1280 px in both themes. Done when: `test/node/plan-browser.test.tsx` passes with a `from` state. Cheaper substitute: rendered-HTML tests only.
- [x] Commit: `web: plan refusal page`

**Test checkpoint:** `pnpm exec vitest run test/web/plan-refusal.test.ts test/web/plan.test.ts` and `pnpm exec vitest run --project node test/node/plan-browser.test.tsx` pass.

> **Verified:** 2026-11-01 | §12 | 143ccf034dac63f684007495a99e6126fe63f7ae
> **Review:** `docs/reviews/d07-t08-s12.json`

## 13. Remove a passkey and sign sessions out

The destructive half of the Account page (`design/SPEC.md` M9, board `Account`): Remove on a passkey, Sign out on a session, and Sign out other sessions, each after a confirmation page, with or without JavaScript. Split from §3 on 2026-11-01.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M9 (board `Account`)
**Job:** a member removes a lost device's passkey or a stranger's session and knows it worked
**Treatment:** a confirmation naming what goes and what stays, Remove or Cancel
**Chrome:** §3's page and the Team page's confirmation shape (`RemoveConfirm`, D07 T04 §3)

**Build order:**

1. Add the three confirmations and their posts through Better Auth's handler in process. Done when: `test/web/account.test.ts` removes a passkey and signs sessions out.

- [ ] Add `GET /settings/account/passkeys/<id>/remove` (a passkey id constrained to the shape Better Auth mints) and the post: the confirmation names the passkey, says the entry may remain in the device's password manager and that signed-in sessions are separate (with Sign out other sessions beside it), Remove calls `passkey/delete-passkey`, Cancel keeps it; another member's passkey id answers "no longer on your account". Done when: the test removes, cancels, tries another member's id, and reads the stored passkey gone only after Remove. Cheaper substitute: one-click removal.
- [ ] Add the session confirmations (`.../sessions/<id>/sign-out` and `.../sessions/sign-out-others`): a session row carries its id, the route resolves the token from the member's own stored sessions (the token never reaches a page) and calls `revoke-session` or `revoke-other-sessions`; Cancel leaves sessions usable; this device's own session cannot be signed out here (Sign out is its own control). Done when: the test signs one session out and the cookie of another is refused, signs all others out with the member's own session surviving, and Cancel leaves every cookie working. Cheaper substitute: revoking by a token in the page.
- [ ] Answer an unanswered revocation or removal by re-reading the stored list before offering to try again, and a failed call as "could not be confirmed" over the stored state: a passkey or session already gone reads "no longer on your account", and a stale session (403) asks the member to sign in again and returns here. Done when: the test drops the answer to each operation that succeeded and finds the stored result named, fails each call to read the unconfirmed state, and covers the 403. Cheaper substitute: a generic error banner with retry.
- [ ] Prove the confirmations in Chromium by keyboard with and without JavaScript, with focus and the announced result after each, and the empty states after the last eligible entry goes. Done when: `test/node/account-browser.test.tsx` passes. Cheaper substitute: rendered-HTML tests only.
- [ ] Commit: `web: remove a passkey and sign sessions out`

**Test checkpoint:** `pnpm exec vitest run test/web/account.test.ts` and `pnpm exec vitest run --project browser test/node/account-browser.test.tsx` pass.

## 14. Add and rename a passkey

The registration half of the Account page: a client ceremony beside the sign-in one in `src/web/client/app.ts`, a name for the new passkey, Rename, and every refusal and lost answer. Split from §3 on 2026-11-01; source D07 T02 §2 completion review.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M9 (board `Account`)
**Job:** a member adds a passkey in a few seconds and can name it
**Treatment:** an Add a passkey button, the browser's prompt, then the new row with its name asked
**Chrome:** §3's page and the sign-in page's passkey states (D07 T02 §16)

**Build order:**

1. Add the registration ceremony and the rename form. Done when: `test/node/account-browser.test.tsx` adds and renames a passkey with Chromium's virtual authenticator.

- [ ] Add the client ceremony to `src/web/client/app.ts` (`[data-passkey-add]`: `passkey/generate-register-options`, `navigator.credentials.create`, `passkey/verify-registration`), revealed only when WebAuthn is there, one ceremony at a time (the control held busy, a second press aborts nothing), then the page drawn again with "Passkey added" and the name asked. Done when: the browser test adds a passkey with the virtual authenticator and reads it in the list, and a second press during the ceremony starts nothing. Cheaper substitute: a button that only links to documentation.
- [ ] Say each refusal in words with the next step: the prompt cancelled or timed out (nothing added), a device not unlocked (`USER_VERIFICATION_REQUIRED`, `src/auth/passkey.ts`), a verification failure, an expired session (401, sign in again and return here), a credential already registered, and options that could not be fetched. Done when: the browser test drives each and reads its sentence and that the list is unchanged. Cheaper substitute: one generic failure line.
- [ ] Rename a passkey through `passkey/update-passkey` in process from a form (the name asked after an add uses it): a bounded name, an empty or over-long one refused under the field with it kept, 303 back with "Passkey renamed" announced, and a failure answered as "could not be confirmed" over the stored name. Done when: `test/web/account.test.ts` renames, reads the stored name, and reads each refusal and the unconfirmed state. Cheaper substitute: editing the stored row.
- [ ] Reconcile a lost answer before acting again: when an add or rename gets no answer, re-read `passkey/list-user-passkeys` and show what is saved before offering to try again, so an add that succeeded is not registered twice; a failed re-read is its own unresolved state ("we could not check; reload before trying again"). Done when: the browser test commits a registration, drops its response, and finds one passkey and no second ceremony started, and fails the re-read to read the unresolved state. Cheaper substitute: a retry button after any failure. Source: D07 T02 §2 completion review (Part 1 item 10).
- [ ] Commit: `web: add and rename a passkey`

**Test checkpoint:** `pnpm exec vitest run test/web/account.test.ts` and `pnpm exec vitest run --project browser test/node/account-browser.test.tsx` pass.

## Verification

- Every page and message in this file matches its board, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
