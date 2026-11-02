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
| 2 | §2 | First-run onboarding checklist | D07 T02 §7, D07 T02 §13 | [x] |
| 3 | §3 | Account settings and passkeys | D07 T02 §2, D07 T01 §10 | [x] |
| 4 | §4 | Plan and trial page | D07 T02 §8, D07 T01 §10 | [x] |
| 5 | §5 | Admin org detail and feedback queue | D07 T05 §2, D07 T03 §6 | [x] |
| 6 | §6 | Sign-in, invite and verification emails | D07 T03 §7 | [x] |
| 7 | §7 | Renew an expired report link | §1, D01 T02 §3 | [ ] |
| 8 | §8 | A plan tier sets its organisation's daily case cap | D07 T02 §8 | [x] |
| 9 | §9 | Site 404 and 500 pages | D07 T06 §1 | [x] |
| 10 | §10 | No bare 429 reaches a browser | §1 | [x] |
| 11 | §11 | Trial-end notices to the owners | D07 T02 §8 | [x] |
| 12 | §12 | Plan refusal as a page | §1, §4 | [x] |
| 13 | §13 | Remove a passkey and sign sessions out | §3 | [x] |
| 14 | §14 | Add and rename a passkey | §3 | [x] |
| 15 | §15 | Operator daily-case override up to 500 | D07 T08 §8 | [x] |
| 16 | §16 | Name a passkey's provider from | §14 | [ ] |
| 17 | §17 | Land new organisations on /welcome | §2 | [x] |
| 18 | §18 | Measure setup and first-verdict time | §2 | [ ] |
| 19 | §19 | Help route on the site 500 page | §9 | [x] |
| 20 | §20 | Feedback to eval set | §5 | [ ] |
| 21 | §21 | Operator TODO from feedback | §5 | [ ] |
| 22 | §22 | Suspend an organisation | §5 | [ ] |
| 23 | §23 | Money-at-risk aggregation | §5 | [ ] |
| 24 | §24 | Feedback queue search and step | §5 | [ ] |
| 25 | §25 | Support availability on the site 500 page | §19 | [ ] |

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

> **Resolved:** the site's 404 and 500 pages (S11) -> XREF: D07 T08 §9. Resolved 2026-11-01 by D07 T08 §9 in 4148b0e3: built in the site tree (site/src/pages/404.astro, site/src/pages/500.html.ts); production delivery of the 500 is D07 T06 §20's.

> **Resolved:** `slowDownPage`'s callers on the browser's 429s -> XREF: D07 T08 §10 (closed there: none exist by design)

**Test checkpoint:** `pnpm exec vitest run test/web/errors.test.ts` passes and fails if a thrown message reaches the page.

> **Verified:** 2026-10-31 | §1 | 9d92a4984ffc05da123ec9670fdc0ab0147896f3
> **Review:** `docs/reviews/d07-t08-s1.json`

## 2. First-run onboarding checklist

> **Started:** 2026-11-01T05:10Z

`/welcome` guides a new organisation (`design/SPEC.md` A4, board `Welcome`): verify your domain, invite your team, forward your first email as an attachment, add your suppliers, protect your business. Each step ticks itself from real state; the judge demo organisation sees a notice explaining its sample cases.

**Corrected 2026-11-01 (plan):** measured against the tree. (1) Every step reads existing tables, so no migration: a verified domain is `org_domains.state = 'verified'`, a team is two or more `member` rows, a first email is a `cases` row with `channel = 'email'`, suppliers are `suppliers` rows and protection is `identities.protected = 1`, each scoped to the active organisation. (2) The judge demo organisation is the one flagged `demo` in `organization.metadata` (`src/demo/seed.ts`); there is no `demo_judge` column, and the original item is corrected to that flag. The banner's "Open the sample cases" goes to `/cases`. (3) "Hide this list" is a preference, kept in a first-party cookie (`welcome_hidden`, the organisation ids hidden, set by a form post so it works without JavaScript, a year, `Secure`, `SameSite=Lax`, never trusted for anything but showing the link), so no table or migration is needed and no other lane's file is touched; the board's way back is "from Cases", so `/cases` carries a "Finish setting up" link until all five steps are done or the list is hidden, and `AppShell` is not changed (the plan's "link in the shell" is corrected to the Cases page, where the board puts it). (4) Redirecting a new organisation to `/welcome` after signup changes the app lane's `src/auth/signup.ts` landing, so it is its own section, §17, asked of the coordinator; this section is complete without it because the list is reachable from Cases. (5) "Show me how" opens `/settings/domains#forwarding-heading`, the forwarding help the Domains page already draws; "Copy address" reuses the shell's `[data-copy]` group; the trial card reads `planOf` and links to `/settings/plan?from=/welcome`; the check address is `CHECK_ADDRESS`. (6) The page passes `active="cases"` to the shell (SPEC P1 States) and answers a member with no organisation, a signed-out request and a failed read as every member page does.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` A4 and its board `Welcome` (`design/mockups/png/Welcome.png`)
**Job:** a new member gets to their first real verdict in minutes
**Treatment:** five steps, each with one action, progress shown, hideable
**Chrome:** `AppShell`, `Button`, `EmptyState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Compute the five steps from stored state and draw them. Done when: `test/web/welcome.test.ts` ticks each step as fixtures add the matching record, reads the progress, and refuses another organisation's state.
2. Hide the list, the Cases link and the judge banner. Done when: the same test hides and restores, follows the Cases link until done or hidden, and reads the banner only for a flagged organisation.
3. Prove it in Chromium. Done when: `test/node/welcome-browser.test.tsx` passes by keyboard, with and without JavaScript, in both themes at 360 and 1280 px.

- [x] Compute the steps in `src/web/pages/welcome.tsx` (`stepsOf(db, orgId)`: five booleans and the counts the board words, in one bounded read scoped to the organisation, a failed read an outage) and draw `GET /welcome` in `src/web/pages/welcome-view.tsx`: the heading with the member's first name, the progress ("2 of 5 done" with a bar that has a text and `role="progressbar"` values), each step with its number or tick and its words from the stored counts ("karoocouriers.example is verified", "3 people joined"), and each step's action: a Done pill once ticked, and until then Verify a domain (to `/settings/domains`), Invite people (to `/team`), Show me how (to `/settings/domains#forwarding-heading`), Add suppliers (to `/suppliers`) and Protect <organisation> (to `/protect`); a member who is not an owner or admin, who cannot verify a domain or invite, gets "An owner or admin does this" in place of those two buttons and the step unticked. Done when: `test/web/welcome.test.ts` reads each step's state, words and action for an empty organisation and for one with a verified domain, three members, an emailed case, a supplier and a protected identity, for an owner and for a member, and none of another organisation's records. Cheaper substitute: a static list.
- [x] Draw the right-hand cards: the check address card (`CHECK_ADDRESS`, the shell's `[data-copy]` Copy address) and the trial card from `planOf` (`src/auth/plans.ts`), truthful for each state: a trial says "Everything in Protect for N days, free. No card needed." (N days left, "1 day" in the singular, "ends today" on the last), a lapsed trial or the Free plan says which it is and what Protect adds, Protect and MSP say the plan name; each with See the plan to `/settings/plan?from=/welcome`. A plan that cannot be read is the page's outage, never a guessed promise. Done when: the test reads each of the five plan states and the last day of a trial, follows See the plan, and reads the outage with a failed plan read. Cheaper substitute: a static 14-day promise.
- [x] Mount it in `src/index.ts` behind `sessionGate` and the active organisation, private and no-store, a member with no organisation getting the 403 page and a read that fails the 500 page with Try again to `/welcome`. Done when: the test reads the signed-out redirect, the no-organisation page and the retryable outage.
- [x] Hide and restore the list with a form: `POST /welcome` with `action=hide` or `show` sets or clears the `welcome_hidden` cookie for the organisation and answers 303 back (to `/cases` after hide, to `/welcome` after show), the origin checked as the other member posts are. `/welcome` stays reachable and carries "Show this list again" while hidden. Done when: the test posts both, reads the cookie flags, a post from another origin changing nothing, and `/welcome` still drawing.
- [x] Show the way to the list on `/cases` (`src/web/pages/cases.tsx`, one extra bounded read, never blocking the Cases list if it fails): "Finish setting up (n of 5 done)" while the list is not hidden, a quiet "Show setup list" once it is hidden, both to `/welcome`, and nothing once all five are done. Done when: the test follows the link, hides, navigates away, finds the "Show setup list" link, reopens and restores with no URL typed, finds nothing after the fifth step, and finds the Cases page intact when the steps cannot be read.
- [x] Show the judge demo banner above the checklist for an organisation whose `organization.metadata` carries `"judge": true` (the demo lane sets `{"demo": true, "judge": true}` on the judge organisation of D07 T07, a flag for showing the banner and never proof of anything): "Welcome, judges. This organisation is ready to explore.", naming the sample cases (a phishing email, an invoice with changed bank details, a voice note and a safe statement), inviting a live test forward to `CHECK_ADDRESS`, with Open the sample cases to `/cases` and "Sample data on a fictional company."; nothing for any other organisation. Done when: the test reads every sentence and the link for a flagged organisation and nothing for an unflagged one, one flagged `demo` only, or one with unreadable metadata.
- [x] Prove the page in Chromium: Verify a domain, Invite people, Show me how, Add suppliers, Protect <organisation> and Copy address reached and activated by keyboard with their names, progress after a step is completed, Hide this list and Show this list again with and without JavaScript, the Cases link through hide and restore, the banner and the progress read by role, both themes at 360 and 1280 px with the accessibility rules. Done when: `test/node/welcome-browser.test.tsx` passes.
- [x] Commit: `web: first-run onboarding checklist`

**Test checkpoint:** `pnpm exec vitest run test/web/welcome.test.ts` and `pnpm exec vitest run --project browser test/node/welcome-browser.test.tsx` pass.

> **Verified:** 2026-11-01 | §2 | d1bf62626217b7d8222639d8173992b9fa72908e
> **Review:** `docs/reviews/d07-t08-s2.json`

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

> **Resolved:** removing a passkey and signing sessions out -> XREF: D07 T08 §13 (built and stamped there)

> **Resolved:** adding and renaming a passkey -> XREF: D07 T08 §14 (built and stamped there)

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

> **Resolved:** the trial-end notices -> XREF: D07 T08 §11 (built and stamped there)

> **Resolved:** the plan-refusal browser journey -> XREF: D07 T08 §12 (built and stamped there)

> **Verified:** 2026-11-01 | §4 | fd6b132cca9d0dd6b8adfbbab8f1e237dd70e7e9
> **Review:** `docs/reviews/d07-t08-s4.json`

## 5. Admin org detail and feedback queue

> **Started:** 2026-11-02T02:55:00Z

`/admin/orgs/:id` (onboarding, domains, members, cases by week, threat types, feedback, plan) and `/admin/feedback` (every "this was wrong" report with case link, kind, note, providers) behind Access (`design/SPEC.md` X2, X4).

**Corrected 2026-11-02:** measured against the tree at 6b1976f9. (1) `feedback.resolved_at` does not exist: table 0045 carries kind, note and providers but no triage state, so this section adds migration 0077 (confirmed 2026-11-02): `triage TEXT NOT NULL DEFAULT 'new'` in (`new`, `triaged`, `closed`) and `triage_note TEXT` (nullable, at most 1000 like `note`). No `resolved_at`: board X4 triages with actions, not a toggle. (2) X4's triage is wider than "a resolved toggle": tabs New, Triaged and Closed with counts, a detail panel (the member's quote, what-drove-our-verdict from the verdict's reasons, the triage note), and three actions: "Add to eval set", "File a TODO", "Close: verdict was right". Close moves triage to closed with the note kept. "Add to eval set" and "File a TODO" have no backend: no eval-set intake table exists (0067 and 0073 carry runs, results and published only) and no product TODO mechanism exists (`operator-actions.md` is the handover blocker list). Owner-decision in plan review: a minimal intake here, or filed sections with Deviations. (3) X2's Onboarding reuses `stepsOf` from `welcome-steps.ts` (D07 T08 §2); the plan card extends trials with `extendTrial` and changes plans with `setPlan`, reading `planOf` (D07 T02 §8); Change daily cap reuses the §2 override statement; Suspend has no mechanism anywhere in `src/` or the migrations, so the button waits on an owner decision (hidden with a Deviation, or a filed suspend feature). (4) Cases by week and top threats reuse the §2 aggregates; the board's "money at risk" line has no amount column in the merged migrations, so the plan review decides whether the line reads from the invoice lane's tables or ships as a Deviation until that lane lands them. (5) Case links open the signed report; feedback rows read their case's verdict from `case_verdicts`.

**Corrected 2026-11-02 (plan review P1/P2):** the review's 11 gaps are answered in the Build order above. The workflow item names selection, save-without-close, explicit Triaged, Reopen, persisted navigation and reload proof; stale operator POSTs are refused on `updated_at` and member edits reopen to new; counts read triage `new` while notices still read `notified_at`; every mutation sits behind Access plus the same-origin check with bounded inputs and value-keeping failures; plan controls name the 0 to 50 limit, refusals with reasons, and reversals; aggregates are org-scoped with zero weeks and multi-org tests; attribution maps providers else top check else model with truthful They-say; report links are followed end to end as a non-member operator; empty, outage and paging states are drawn and browser-proven. "Add to eval set" and "File a TODO" are filed as §20 and §21 with X4 Deviations (no backends exist); Suspend is filed as §22 with an X2 Deviation; money at risk is filed as §23 with an X2 Deviation. The board's literal invite code is replaced by the code's label through `invite_redemptions` (hashes only), and `missed` reads Unsafe, both recorded below.

> **Deferred:** the "Add to eval set" action and its synthetic-copy promise -> XREF: D07 T08 §20
> **Deferred:** the "File a TODO" action -> XREF: D07 T08 §21
> **Deferred:** Suspend and reinstatement -> XREF: D07 T08 §22
> **Deferred:** the "Money at risk caught" line -> XREF: D07 T08 §23
> **Deferred:** queue search and previous/next complaint navigation -> XREF: D07 T08 §24

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X2 and X4 and their boards in `design/mockups/`
**Job:** the operator understands one client in depth and acts on every disputed verdict
**Treatment:** dense, calm tables; links straight to the case
**Chrome:** `AppShell` admin variant from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build both pages behind `requireAccess`. Done when: a seeded database renders both and an Access-less request is refused.

- [x] Build `src/web/pages/admin-org.tsx` and `src/web/pages/admin-feedback.tsx` with the triage migration, the New/Triaged/Closed tabs with counts, row selection with a detail panel (no report opened), the triage note, Close and Reopen per feedback item recorded in `feedback.triage` and `feedback.triage_note` ("Add to eval set" and "File a TODO" are not built: X4 Deviations, XREFs D07 T08 §20 and §21). A member edit after triage (`updated_at` moved) reopens the item to new with the operator's note kept; an operator POST carrying a stale `updated_at` is refused and re-rendered with fresh data and the typed note kept; a withdrawn row renders as withdrawn. Done when: `test/web/admin-detail.test.ts` checks content, tabs, selection, the note, close, reopen, stale refusal and withdrawal, with a reload proving every transition and note survives. Cheaper substitute: a resolved toggle.
- [x] Refuse and recover on every mutation behind `requireAccess` and the same-origin check, with bounded action, note (at most 1000), plan, date and cap inputs, missing-record handling, and failed writes that keep the typed values without claiming success. Done when: the test posts without Access, from another origin, with invalid values and a missing row, then retries successfully with a fresh read-back.
- [x] Update the queue counts to the triage state: `feedbackWaiting` and the overview's open count read triage `new`, while notice sending still reads `notified_at` alone. Done when: the test sends a notice without closing the complaint and closes one with the overview, navigation and queue counts moving.
- [x] Follow fresh signed report links as the Access-authenticated operator with no membership in that organisation. Done when: the test mints a link per case from its stored organisation identity, opens it, and reads missing, unavailable and signing-failure cases refused.
- [x] Draw the empty states (empty organisation sections, empty tabs, withdrawn selection), the outage with a working retry, and queue pages of 50 that keep every record reachable. Done when: the worker test reads each state and the browser test pages the queue.
- [x] Give the admin detail page its plan controls (`design/SPEC.md` X2: Extend trial, Change daily cap with Use plan limit, and the plan), through `setPlan` and `extendTrial` (D07 T02 §8), operator only, reading the plan with `planOf`, showing the effective stored cap, with overrides surviving plan changes. The cap form takes 0 to 50 (the §15 operator override to 500 is a different control). `extendTrial` refusing (paid plan, non-extending date) disables the control with its reason or refuses under the field. Done when: the operator extends a trial and changes a plan from the page, an organisation's own owner is refused, the next feature check follows, and each control is reversed (override cleared, plan changed back). Suspend is not built: X2 Deviation, XREF D07 T08 §22. Source: D07 T02 §8 plan review.
- [x] Draw X2 from `stepsOf` (onboarding), the domains and invitation rows (pending members read `invitation.status`), members with roles, org-scoped weekly case buckets with zero weeks shown, the 30-day threat list from the check ranking, this org's feedback rows (Status reads triage), and the plan card (trial end, effective cap, protected identity). The invite origin reads the code's label through `invite_redemptions`, never the literal code (X3: only hashes are stored). "Decided by" reads the first cited provider, else the case's top check, else the deciding model; They-say reads Safe for `false_alarm` and Unsafe for `missed` (the board's literal Suspicious is a Deviation: severity is not stored). Money at risk is not built: X2 Deviation, XREF D07 T08 §23. Done when: the worker test seeds two organisations across a week boundary and reads every card, and the browser test reads the page at both widths in both themes with chart text alternatives.
- [x] Commit: `admin: organisation detail and feedback queue`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-detail.test.ts` passes and fails without Access; `pnpm exec vitest run --project browser test/node/admin-detail-browser.test.tsx` reads row selection, note editing, every retained action, keyboard focus and contrast at 360 and 1280 px in both themes.

> **Verified:** 2026-11-02 | §5 | 0d15586e68b3e649d0626345371cd03f46fb4281
> **Review:** `docs/reviews/d07-t08-s5.json`

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

- [x] Build `src/mail/templates/auth-mail.ts` with `signinEmail` (carrying the six-digit code and its same-browser instructions in both parts, as SPEC N2 and `src/auth/signin-code.ts` require), `inviteEmail` and `claimCodeEmail` (a domain variant, "proving it controls <domain>", and an address variant for `src/auth/domains.ts`'s single-address verification, with the accurate receipt reason for each: `admin@` or `postmaster@` for a domain, the address itself for an address), each returning `{ text, html }` from the boards `Email-Signin`, `Email-Invite` and `Email-DomainCode`: the logo, one heading, one sentence, the single button and the plain link (sign-in and invitation) or the large code with nothing to click (domain code), the expiry in words and the SAST time, the "did not ask" line, the reason for receiving it and the footer ("We never ask for passwords, PINs or bank details by email"), as tables with inline token styles and every user-supplied value escaped. Done when: `test/mail/auth-emails.test.ts` extracts the code from each delivered part of a real sign-in link and completes the existing sign-in with it, renders each with a hostile inviter, organisation and domain name and finds every value escaped, both parts complete, and the first URL of each text the real link. Cheaper substitute: the current plain text only.
- [x] Use them from the three senders (`sendMagicLink`, `sendInvitationEmail` in `src/auth/auth.ts`, the coordinator's approval 2026-11-01; `sendClaimCode` in `src/auth/claim-mail.ts`), passing `html` and the new `text` and changing nothing else (both of `sendClaimCode`'s callers in `src/auth/domains.ts`, the domain and the single address, pass which they are): the send keys, kinds, subjects, From addresses, hooks and the sign-in code row stay. Done when: the same test sends a sign-in link, an invitation and a claim code through the real senders with a stubbed provider and asserts each From (`SIGNIN_FROM`, `SIGNIN_FROM`, `CLAIM_FROM`), subject, kind, both parts and that the existing auth, invitation and claim tests still pass. Cheaper substitute: calling the templates only from the test.
- [x] Say the expiries truthfully: 15 minutes from `MAGIC_LINK_SECONDS` with the requested and expiry times, the invitation's 48 hours from its own `expiresAt`, the code's 30 minutes from the caller, and the three-wrong-tries lock the claim enforces. Done when: the test reads each from its owner's constant or stored value and fails if one is retyped. Cheaper substitute: fixed numbers.
- [x] Prove the rendering in Chromium at 360 and 1280 px (`test/node/auth-emails-browser.test.tsx`, the browser project): each HTML part set into a page with a very long organisation, inviter and domain name shows no sideways scroll, its link and code stay inside the column and its button and link are keyboard-focusable with their names, the content stays readable with images blocked (alt text shown), and contrast between each text and its background meets AA. Done when: the browser test passes. Cheaper substitute: string checks on the HTML.
- [x] Run the email lint on each (tables for layout, no `display:flex` or `grid`, no `position` or `float`, `alt` on every image, no script or tracking pixel). Done when: it passes on each and fails on a planted `display:grid` and on a planted image without `alt`. Cheaper substitute: eyeballing the HTML.
- [x] Record the domain-code board's differences in `design/SPEC.md` N4 (who asked and the organisation are not known to the sender). Done when: N4 lists the Deviation and `design/tools/check-design.py` passes. Cheaper substitute: none.
- [x] Commit: `mail: sign-in, invitation and verification emails`

**Test checkpoint:** `pnpm exec vitest run test/mail/auth-emails.test.ts` passes, with `test/auth/org.test.ts`, `test/auth/claim-mail.test.ts` and the sign-in tests.

> **Verified:** 2026-11-01 | §6 | e940214a4531b70ad9c8be5bac2d393cd6da09fd
> **Review:** `docs/reviews/d07-t08-s6.json`

## 7. Renew an expired report link

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

A recipient whose report link has passed its 7 days (D01 T01 §8) reaches the 410 page (`design/SPEC.md` E2, §1), which today offers signing in or forwarding the email again. A stranger holding an old link must learn nothing, yet the person the reply went to should get a fresh link to the same report in one step, without a new analysis or searching for the case. Filed from D01 T01 §8's completion review (out-of-scope excellence gap, 2026-10-27), which compared it with Stripe's hosted invoice page, whose expired-link page sends a fresh link to the recipient's address.

**Phase:** 7
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

> **Started:** 2026-11-01T09:33Z

**Corrected 2026-11-01** (site lane, at start; the coordinator moved the section to the site lane): (1) the 404 is `site/src/pages/404.astro` in the site layout (`Base.astro`: header, footer, the check@ panel), so it shows the site's own header and footer where the board draws a bare logo and domain; (2) the 500 is generated at build time by an endpoint `site/src/pages/500.html.ts` into one standalone `500.html` (Astro emits a `500.html` directory for a page named that, and the contract asks for a file), with the app's tokens and an inline question mark mark inlined, no script, no web font and no stylesheet to fetch, so it renders when the Worker or the assets fail; (3) a static page has no per-request id, so the board's reference id is the fixed `Reference 500-site` and the page does not claim a unique one; (4) `Try again` is a link with an empty `href`, which reloads whichever address failed, and `Home` goes to `/`; (5) the page tests read each page's sentence, links and check@ address from the built files, the 500's standalone nature (no `<script`, no `<link`, no `src`, no `url(`), and the link gate and the claims gate stay green.

The marketing site's own error pages (`design/SPEC.md` S11, boards `Site-404` and `Site-500`): a plain message, the search-free way back and the check@ address, in the site layout. Moved 2026-10-31 from §1, which put them in the site lane's tree.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S11 (boards `Site-404`, `Site-500`)
**Job:** someone who lands on a missing site page knows what happened and how to get back
**Treatment:** the question mark, one sentence, the way back, the check@ address
**Chrome:** the site layout (D07 T06 §1)

**Build order:**

1. Add the two pages, wire the 404 into the site Worker, and prove both in a browser. Done when: the site build emits `404.html` and a standalone `500.html`, the site Worker's config serves the 404 page for an unknown address, and both pass the page tests and the browser checks.

- [x] Add `site/src/pages/404.astro` from the board `Site-404` in the site layout, with the one sentence, the way back (Home, How it works, Pricing) and the check@ panel; and set `assets.not_found_handling` to `"404-page"` in `site/wrangler.jsonc` so the assets Worker answers an unknown address, at any depth, with this page and status 404 (Cloudflare serves the nearest `404.html`). Done when: the build emits `404.html`, its test reads the sentence and the three links, and `site/test/deploy.test.ts` reads `not_found_handling` in the config. Cheaper substitute: Astro's default 404, which the Worker would not serve.
- [x] Add `site/src/pages/500.html.ts`, the one producer of a standalone `500.html` (the board `Site-500`): the sentence, Try again (an empty `href`, which reloads whichever address failed) and Home, the check@ panel and `Reference 500-site`, with the app's tokens inlined and no script, no stylesheet link, no web font and no external request. Done when: the build emits exactly one `500.html` file (not a directory) and its test reads it standalone: its sentence, links and address, and no `<script`, `<link`, `src=` or `url(`. Cheaper substitute: a text 500.
- [x] Qualify the check@ panel on both pages as the home page does: "Sign up first: we answer mail from the address or domain you verify", with the sign-up link, so an anonymous visitor is not promised a reply. Done when: both pages' tests read the sentence and the sign-up link and fail without them.
- [x] Prove both pages in Chromium: at 390 and 1440 px in both themes, no horizontal overflow and no axe violation (contrast included); every recovery link reachable by Tab with a visible focus and an accessible name; `500.html` rendered with JavaScript disabled and every request but its own document blocked, still showing its content; and Try again on a 500 served at another address reloads that address. Done when: those tests pass and fail when the page loses its content, a link or its focus.
- [x] Record the S11 deviations in `design/SPEC.md` (the 404 in the site layout with the site's header and footer; the fixed `Reference 500-site` for a static page; the sign-up qualification) and the production wiring in `todo/07-app/TODO-06-marketing-site.md` \u00a720: the zone's custom 5xx page or the app Worker's error handler serving `https://isitlegit.co.za/500.html` with the error status, and the live read-backs (an unknown address returns 404 with this page; the 500 file is reachable). Done when: the deviations and the \u00a720 item are in the files and the design-spec test passes.
- [x] Commit: `site: 404 and 500 pages`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site test` exits 0: both files are emitted, their sentences and links are read, the 404 is wired in the Worker config, and the Chromium tests pass for both pages. (**Corrected 2026-11-01**, plan review: the delivery of the 500 during a real failure and the live 404 read-back are production wiring, D07 T06 \u00a720's.)

> **Verified:** 2026-11-01 | §9 | 4148b0e35af0f7a6ec9c90d96f2e221baedc9ad2
> **Review:** `docs/reviews/d07-t08-s9.json`

## 10. No bare 429 reaches a browser

Closed 2026-11-01 on the coordinator's decision: no full-page 429 exists to draw. Every 429 a browser can meet already draws its own designed state (the upload page's limit alert, the sign-in pages' rate-limited states, the Team page's redrawn page) or is a JSON answer a browser never navigates to (the domain claim routes, the upload API). Rewriting an already-answered 429 on its way out would be a response filter, not a fix at the owning layer, so there is no net; `slowDownPage` (E4, D07 T08 §1) stays for a handler that needs it later. What remains worth keeping is a guard: a new place that answers 429 must be classified, so a bare 429 never reaches a page by accident. Replaces the section filed 2026-10-31 from §1's plan review.

> **Started:** 2026-11-01T02:10Z

**Phase:** 6
**Risk:** light
**Needs:** none
**Surface:** no

**Build order:**

1. Add the guard test. Done when: `test/node/browser-429.test.ts` lists every source file that answers 429 and fails for one that is not classified.

- [x] Add `test/node/browser-429.test.ts`: classify every place in the Worker source that names a 429, site by site (a count per file), as an API that answers JSON, a page that draws its own state (naming the test that holds that state), or an outbound read of someone else's 429, each with its reason; a new site in a new or an already classified file, or a dropped one, changes a count and fails with the instruction to give the page a designed state or use `slowDownPage`. Done when: the test passes for the tree and fails for planted fixtures of a new bare site in a new file, one more in a classified file, and a dropped site, and each named proof test exists and still mentions a 429 state. Cheaper substitute: a comment listing the files.
- [x] Commit: `test: no bare 429 reaches a browser`

**Test checkpoint:** `pnpm exec vitest run --project node test/node/browser-429.test.ts` passes.

> **Verified:** 2026-11-01 | §10 | 4dfc8e2393fbce0f7b319eff499b2f5a942cd134
> **Review:** `docs/reviews/d07-t08-s10.json`

## 11. Trial-end notices to the owners

> **Started:** 2026-11-01T02:36Z

An owner is told before the trial ends and when it has: one notice three days before and one at the end, saying the exact end time, which protection stops and that free checks continue. Split from §4 on 2026-11-01; source D07 T02 §8 completion review.

**Corrected 2026-11-01 (plan):** measured against the tree. (1) The trial's end comes from `planOf`'s rule (`src/auth/plans.ts`: `org_limits.trial_ends_at`, else the organisation's `createdAt` plus `TRIAL_DAYS`), and an organisation is on the trial only while no stored `plan` is set; the job selects with that rule in SQL (the same expression `dailyCapSql` uses in `src/auth/plan-sql.ts`) and then reads each candidate through `planOf`, so the job and the Plan page never disagree. (2) Mail kind `notice` admits members of any organisation (`isAllowedRecipient`, `src/mail/allowlist.ts`), so owners are admitted; the sender is `IsItLegit <no-reply@isitlegit.co.za>` (a reply to a notice has nowhere to go and bounces, which is wanted). (3) The hook is one `ctx.waitUntil(sendTrialNotices(env, new Date()))` line in `scheduled()`'s quarter-hour branch of `src/index.ts` (the coordinator's approval 2026-11-01); the job is a no-op when no trial is near an end, so the cost is two indexed reads. (4) Both notices are sent to every owner of the organisation (`member.role` holds `owner`), once each per trial end: the send key is `trial:<org>:<kind>:<end as ISO>`, so an extension (a new end) is a new notice and the stale one is never sent. (5) "Never to protected test data": the demo and test organisations (`src/auth/protected.ts`) get none. (6) An organisation that moved to Protect or MSP, or to Free by the operator, has no trial to end and gets none.

**Phase:** 6
**Needs:** none
**Surface:** no
**Job:** an owner is not surprised by the end of the trial
**Treatment:** a plain email from no-reply@ with the end time in SAST and one link to the Plan page

**Build order:**

1. Select the organisations whose trial ends in about three days or has ended, and send each owner one notice per trial end. Done when: `test/mail/trial-notices.test.ts` sends each once, with the quarter-hour hook proven to call it.

- [x] Add `sendTrialNotices(env, now)` in `src/mail/trial-notices.ts`, run from the quarter-hour branch of `scheduled()` (one `ctx.waitUntil` line in `src/index.ts`): organisations on the trial whose end is within three days (the three-day notice) and organisations whose trial ended in the last seven days and are still on the trial's free plan (the end notice; seven days, not one, so an outage is recovered), each notice to every owner separately, with the send key `trial:<org>:<kind>:<end as ISO>:<owner user id>` (the ledger's key is unique, so the recipient is part of it) and mail kind `notice`. Done when: `test/mail/trial-notices.test.ts` runs the job through the real ledger with two owners and sends each notice to each owner once, a second and an overlapping run (two calls awaited together) send nothing more, an extension (a later `trial_ends_at`) sends a new notice for the new end and none for the stale one, and nothing is sent for Protect, MSP, an operator-set Free, the protected organisations, or an organisation with no owner. Cheaper substitute: sending on every run.
- [x] Recover a failed or lost send without duplicating it: a send the provider refused (`failed`) is tried again by the next run while the notice is still due (the ledger claims a failed key again), an uncertain one is left to the reconciler (D01 T02 §5) and never sent again, an eligibility that has changed since (a plan chosen, an extension) drops the notice, and every run logs one JSON line with the counts sent, failed and uncertain so the operator sees an unresolved failure. Done when: the test fails the provider once and finds the next run sends it, drops the lost response as uncertain, finds an extension between the failure and the retry suppress the stale notice, runs past the seven-day window and sends nothing, and reads the log line. Cheaper substitute: logging only.
- [x] Write the two emails (`trialNoticeEmail` in `src/mail/templates/auth-mail.ts`, the same table frame, button and panel as the other transactional mail): the subject names the organisation and the day, the body the organisation, the exact end time in SAST, which protection stops (or has stopped) and that free checks continue, one button to the Plan page and its plain link, and a line that says to switch to the organisation first if the member belongs to more than one; both parts complete, every outside value escaped. Done when: the test asserts the subject, the organisation, the SAST time, the before and after wording, the lost protections, the continuing free checks, no claim of billing, the plain-text link first, and runs the email lint and a Chromium render at 360 and 1280 px (`test/node/auth-emails-browser.test.tsx`). Cheaper substitute: a one-line text.
- [x] Commit: `mail: trial-end notices`

**Test checkpoint:** `pnpm exec vitest run test/mail/trial-notices.test.ts` passes and fails if a notice is sent twice for one trial end or to one owner only; `pnpm exec vitest run --project browser test/node/auth-emails-browser.test.tsx` passes.

> **Verified:** 2026-11-01 | §11 | 08fc6831bb30ba466a0bbadb5828cb1ffc494f4d
> **Review:** `docs/reviews/d07-t08-s11.json`

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

> **Started:** 2026-11-01T03:22Z

The destructive half of the Account page (`design/SPEC.md` M9, board `Account`): Remove on a passkey, Sign out on a session, and Sign out other sessions, each after a confirmation page, with or without JavaScript. Split from §3 on 2026-11-01.

**Corrected 2026-11-01 (plan):** measured against the tree after §3. (1) The confirmations are routes of `src/web/pages/settings-account.tsx` (the page's route file; the actions post to the same `POST /settings/account` as the name save, fields `action`, `id`), with the confirm pages in `settings-account-view.tsx` and the Remove and Sign out controls drawn into §3's passkey and session rows; ids are the stored `passkey.id` and `session.id`, constrained to the shape Better Auth mints. (2) Better Auth's own handler runs in process (`passkey/delete-passkey`, `revoke-session`, `revoke-other-sessions`), so its hooks and audit run as for any request; a session token is resolved server-side from the member's own stored sessions and never reaches a page. (3) A lost answer is reconciled from storage: after a call that fails or gets no answer, the stored passkey or session is read; gone means it went through and is reported done, still there means it did not and the page says so, never "done" from the failure alone. (4) The member's own session has no Sign out beside it (Sign out is its own control), and "Sign out other sessions" is drawn only when there are others. (5) A stale session (401 or 403) goes to sign-in and returns to the page. (6) The last passkey may be removed: the email link always remains (§3).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M9 (board `Account`)
**Job:** a member removes a lost device's passkey or a stranger's session and knows it worked
**Treatment:** a confirmation naming what goes and what stays, Remove or Cancel
**Chrome:** §3's page and the Team page's confirmation shape (`RemoveConfirm`, D07 T04 §3)

**Build order:**

1. Add the three confirmations and their posts through Better Auth's handler in process. Done when: `test/web/account.test.ts` removes a passkey and signs sessions out.

- [x] Add `GET /settings/account/passkeys/<id>/remove` (a passkey id constrained to the shape Better Auth mints) and the post: the confirmation names the passkey, says the entry may remain in the device's password manager and that signed-in sessions are separate (with Sign out other sessions beside it), Remove calls `passkey/delete-passkey`, Cancel keeps it; another member's passkey id answers "no longer on your account". Done when: the test removes, cancels, tries another member's id, and reads the stored passkey gone only after Remove. Cheaper substitute: one-click removal.
- [x] Add the session confirmations (`.../sessions/<id>/sign-out` and `.../sessions/sign-out-others`): a session row carries its id, the route resolves the token from the member's own stored sessions (the token never reaches a page) and calls `revoke-session` or `revoke-other-sessions`; Cancel leaves sessions usable; this device's own session cannot be signed out here (Sign out is its own control), by the page or by a posted request. Done when: the test signs one session out and the cookie of another is refused, signs all others out with the member's own session surviving, Cancel leaves every cookie working, and both the confirmation GET and the action POST given another member's session id or the caller's current session id answer "no longer on your account" or the this-device refusal, exposing no session detail or token, revoking nothing, with a way back. Cheaper substitute: revoking by a token in the page.
- [x] Answer an unanswered or failed removal or revocation from storage before offering to try again: the passkey or session read again, gone meaning it went through and is reported done, still there meaning it did not; "Sign out other sessions" is checked by what remains (some left is the partial state: "Some were signed out, not all; the list is as stored now, sign out the rest"); a read that fails is its own unresolved state ("we could not confirm; reload before trying again"), never complete success and never "nothing changed" without the read; a stale session (401 or 403) asks the member to sign in again and returns here. Done when: the test drops the answer to each operation that succeeded and finds the stored result named, fails each call to read "still there", revokes only some sessions to read the partial state, fails the read-back to read the unresolved state, and covers the 401 and 403. Cheaper substitute: a generic error banner with retry.
- [x] Prove the confirmations in Chromium by keyboard with and without JavaScript, with focus and the announced result after each, and the empty states after the last eligible entry goes. Done when: `test/node/account-browser.test.tsx` passes, and its accessibility loop visits the three confirmation pages and their failure states at 360 and 1280 px in both themes (contextual accessible names for the repeated row actions, a visible keyboard focus, no horizontal overflow). Cheaper substitute: rendered-HTML tests only.
- [x] Commit: `web: remove a passkey and sign sessions out`

**Test checkpoint:** `pnpm exec vitest run test/web/account.test.ts` and `pnpm exec vitest run --project browser test/node/account-browser.test.tsx` pass.

> **Verified:** 2026-11-01 | §13 | 8cc82d7a0aca4cebeff1c6881e597aebab067b27
> **Review:** `docs/reviews/d07-t08-s13.json`

## 14. Add and rename a passkey

> **Started:** 2026-11-01T03:49Z

The registration half of the Account page: a client ceremony beside the sign-in one in `src/web/client/app.ts`, a name for the new passkey, Rename, and every refusal and lost answer. Split from §3 on 2026-11-01; source D07 T02 §2 completion review.

**Corrected 2026-11-01 (plan):** measured against the tree after §3 and §13. (1) The sign-in ceremony in `src/web/client/app.ts` already has `fromB64url` and `toB64url`; registration adds `creationOptionsFromJSON` and `attestationToJSON` beside `requestOptionsFromJSON` and `assertionToJSON`, and a `[data-passkey-add]` control revealed only where WebAuthn is. (2) The proof runs against the real Worker, as `test/node/passkey-e2e-browser.test.tsx` does (the Worker started from `wrangler.jsonc` on a local D1, Chromium's virtual authenticator over CDP): `test/node/account-passkey-browser.test.tsx` adds a passkey from the Account page, names it, renames it, cancels a prompt, loses the answer to a registration that succeeded, and fails the re-read, each against Better Auth's own verifier, with a faked server only for the refusals the real one cannot be made to give. (3) The new passkey's id comes from `verify-registration`'s answer, and the name is asked on a page of its own (`GET /settings/account/passkeys/<id>/rename`, the same form Rename opens from a row), so adding and renaming are one form with or without JavaScript. (4) Rename posts `action=rename-passkey` to `POST /settings/account` and runs `passkey/update-passkey`; a name is one line of at most 100 characters (the rule of `src/auth/names.ts`, applied here to the passkey's name). (5) A registration the browser refuses because the device is not unlocked is `USER_VERIFICATION_REQUIRED` from the Worker's own vetting (`src/auth/passkey.ts`) and `NotAllowedError` from the browser: both are worded.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M9 (board `Account`)
**Job:** a member adds a passkey in a few seconds and can name it
**Treatment:** an Add a passkey button, the browser's prompt, then the new row with its name asked
**Chrome:** §3's page and the sign-in page's passkey states (D07 T02 §16)

**Build order:**

1. Add the registration ceremony, the rename page and the lost-answer reconciliation. Done when: `test/node/account-passkey-browser.test.tsx` (the real Worker and Chromium's virtual authenticator) adds a passkey from the Account page, names it, renames it, signs out and signs in with it.
2. Prove the pages. Done when: `test/web/account.test.ts` and `test/node/account-browser.test.tsx` cover the rename page's ownership, Cancel and refusals, the reconciliation states, keyboard use, the no-JavaScript naming form and the accessibility loop.

- [x] Add the client ceremony to `src/web/client/app.ts` (`[data-passkey-add]`: `passkey/generate-register-options`, `navigator.credentials.create`, `passkey/verify-registration`), revealed only when WebAuthn is there, one ceremony at a time (the control held busy, a second press starts nothing), then a navigation to the new passkey's naming page `/settings/account/passkeys/<id>/rename?added=1` with "Passkey added" said. Done when: `test/node/account-passkey-browser.test.tsx` adds a passkey from the Account page with the virtual authenticator, reads it in the list, then signs out and signs in with that passkey on the sign-in page (a stored row alone is not a usable passkey), and a second press during the ceremony starts nothing. Cheaper substitute: a button that only links to documentation.
- [x] Say each refusal in words with the next step: the prompt cancelled or timed out (nothing added), a device not unlocked (`USER_VERIFICATION_REQUIRED`, `src/auth/passkey.ts`), a verification failure, an expired session (401, sign in again and return here), a credential already registered, and options that could not be fetched. Done when: the browser tests drive each and read its sentence, that focus lands on the message, and that the list is unchanged. Cheaper substitute: one generic failure line.
- [x] Draw the rename page `GET /settings/account/passkeys/:id/rename` in `src/web/pages/settings-account.tsx` (the form the Rename link on each row and the add ceremony both open): the name field with its label, error associated with the field, Save and Cancel (a link back to `/settings/account` leaving the stored name unchanged), and a passkey that is gone, never existed or belongs to another member answered by 303 to the Account page with "no longer on your account", the same on `POST`, disclosing and changing nothing of another member's credential. Done when: `test/web/account.test.ts` reads the page, Cancel, the foreign and missing id on both GET and POST with the stored row and name untouched, and the 401 sign-in redirect.
- [x] Rename a passkey through `passkey/update-passkey` in process from that form: a bounded one-line name (at most 100 characters), an empty or over-long one refused under the field with it kept, 303 back with "Passkey renamed" announced, and a failure answered as its own outcome over the stored name. Done when: `test/web/account.test.ts` renames, reads the stored name, and reads each refusal and the failure state. Cheaper substitute: editing the stored row.
- [x] Reconcile a lost answer before acting again, for both operations. Add: when the registration gets no answer, the client does not start another ceremony; it navigates to `/settings/account?reconcile=add&known=<ids of the passkeys listed before>` and the server names the passkey that was not in that list as the one just created and offers its naming page, or says nothing was added and offers to try again, so an add that succeeded is not registered twice and recovery names the correct credential when other passkeys exist. Rename: when the answer is lost, the page re-reads the stored name and shows it ("saved as ..." or "still ..."), with its Rename link to retry. A failed re-read is its own unresolved state ("we could not check; reload before trying again") in both. Done when: `test/node/account-passkey-browser.test.tsx` commits a registration against the real Worker with its response dropped and finds one new passkey, no second ceremony, and the naming page of that credential with an earlier passkey present; `test/web/account.test.ts` covers a rename committed with its answer dropped, one not committed, and a failed read-back, each asserting the shown stored name and the recovery action. Cheaper substitute: a retry button after any failure. Source: D07 T02 §2 completion review (Part 1 item 10).
- [x] Prove accessibility and no-JavaScript use: Add and each Rename control reached and activated by keyboard with their contextual names ("Rename passkey <name>"), focus and announcement after a cancelled prompt, an error and each navigation, the naming form working with JavaScript disabled, and the rename page, the added state and every refusal and reconciliation state in the 360 and 1280 px, both-theme accessibility loop. Done when: `test/node/account-browser.test.tsx` covers each.
- [x] Commit: `web: add and rename a passkey`

**Test checkpoint:** `pnpm exec vitest run test/web/account.test.ts`, `pnpm exec vitest run --project browser test/node/account-browser.test.tsx` and `pnpm exec vitest run --project browser test/node/account-passkey-browser.test.tsx` pass.

> **Verified:** 2026-11-01 | §14 | 769dad34879c0c1ec8fc7fd77ee06a53bf5d41a7
> **Review:** `docs/reviews/d07-t08-s14.json`

## 15. Operator daily-case override up to 500

The operator-only daily-cases override (`setDailyCapOverrideStatement`, `src/auth/plan-sql.ts`, D07 T08 §8) is limited to 50, the event's maximum. The eval lane's live run (D08 T02 §1, 275 samples) needs one organisation to check more than 50 a day, so the ceiling for the override alone goes up to 500. Filed 2026-11-01 at the coordinator's request.

> **Started:** 2026-11-01T01:40Z

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Raise the override's ceiling and prove its edges. Done when: `test/auth/daily-cap.test.ts` accepts 500, refuses 501 and 50.5, and finds the plan caps and a member's view unchanged.

- [x] Raise `MAX_DAILY_CASES_OVERRIDE` to 500 in `src/auth/plan-sql.ts` and say why in its comment (the override is the operator's alone; `PLAN_DAILY_CASES`, `DEFAULT_DAILY_CASES` and the plans' advertised allowances are unchanged; spend stays held by the Meta caps). Done when: `test/auth/daily-cap.test.ts` runs `setDailyCapOverrideStatement` with 500 (accepted and stored), 501 and a fraction (each a `RangeError`), and a negative number (refused), and finds `PLAN_DAILY_CASES` still `{ trial: 50, free: 5, protect: 50, msp: 50 }`. Cheaper substitute: changing the constant alone.
- [x] Give the operator the command: `node scripts/org-plan.ts <organisation id> cap <0 to 500>` and `cap clear` in `scripts/org-plan.ts`, with the shared `setDailyCapOverrideStatement` and `clearDailyCapOverrideStatement` and a read-back of the stored override (printed), refusing an unknown organisation, an out-of-range or non-integer number and a failed `wrangler d1 execute`. Done when: `test/node/org-plan.test.ts` sets 500, reads it back, clears it to the inherited limit, restores a previous override, and refuses 501, `1.5`, `abc`, a missing organisation and a failed command. Cheaper substitute: SQL typed by hand.
- [x] Prove the raised cap admits cases up to it and no further, through the real admission: an organisation with the override at 500 admits case 51 and case 500 and refuses 501, while one without it still refuses the 51st. Done when: the test makes the cases through `admitCase` (`src/db/cases.ts`) and reads the stored counts and the refusal. Cheaper substitute: asserting the generated SQL.
- [x] Show the effective cap where members see it, and nowhere else changed: an overridden organisation's Plan page and upload usage read 500 as their limit, the plans' tier text still says 5 and 50, and clearing the override returns the page to the plan limit. Done when: `test/web/plan.test.ts` and `test/web/upload-page.test.ts` read each against a stored 500 and after clearing. Cheaper substitute: reading `todayUsage` only.
- [x] Prove a member cannot set it: only `scripts/org-plan.ts` calls `setDailyCapOverrideStatement` and `clearDailyCapOverrideStatement` outside `src/auth/plan-sql.ts`, and no route, page or Better Auth hook writes `daily_cases_override`. Done when: a test scans `src/` and `scripts/` for callers and for the column name in SQL and fails for a planted fixture that imports the setter from a route file. Cheaper substitute: a comment.
- [x] Commit: `auth: operator daily-case override up to 500`

**Test checkpoint:** `pnpm exec vitest run test/auth/daily-cap.test.ts test/web/plan.test.ts test/web/upload-page.test.ts` and `pnpm exec vitest run --project node test/node/org-plan.test.ts` pass.

> **Verified:** 2026-11-01 | §15 | cc85e58f5a128cffef9d5001502ea245b06f8d09
> **Review:** `docs/reviews/d07-t08-s15.json`

## 16. Name a passkey's provider from

Filed from the D07 T08 §14 completion review (excellence item E3). A passkey row says "Syncs between devices" or "This device only" and a name the member typed or the day it was added; the same row could say where it lives (iCloud Keychain, Google Password Manager, 1Password, Windows Hello), because the authenticator's AAGUID is stored in `passkey.aaguid`. Which provider an AAGUID belongs to is third-party data and a design addition to the Account board, so a wrong or invented label would mislead a member deciding which passkey to remove: nothing is built before the owner approves the board and the source of the mapping.

**Phase:** 7
**Needs:** operator
**Surface:** yes
**Fidelity:** `design/SPEC.md` M9 (board `Account`, once its provider column is drawn)
**Job:** a member removing or renaming a passkey can tell which password manager or device holds it
**Treatment:** one short provider label in the passkey row, nothing shown when the AAGUID is unknown, tokens only
**Chrome:** the Account page from §3 and the passkey rows from §13 and §14

**Operator decision (open):** the provider label is a design change to the approved `Account` board and needs a mapping source (the FIDO Alliance Metadata Service or the community passkey-authenticator-aaguids list). Recording `Provider labels approved: YYYY-MM-DD (<board>, <source>)` here and removing `operator` from Needs releases the section.

**Build order:**

1. Draw and approve the label and its source. Done when: the board, the SPEC entry and the approval line exist.
2. Show the label from the stored AAGUID. Done when: `test/web/account.test.ts` reads a known provider, and nothing for an unknown or empty AAGUID.

- [ ] Draw the provider label on the `Account` board and add it to `design/SPEC.md` M9. Done when: the board and SPEC entry are committed and the approval line is recorded here. Cheaper substitute: guessing from the device type.
- [ ] Read `passkey.aaguid` in `readAccount` (`src/web/pages/settings-account.tsx`) and map it through a checked-in table from the approved source (`src/web/pages/passkey-providers.ts`). Done when: a known AAGUID shows its provider in the row and an unknown, null or malformed one shows nothing. Cheaper substitute: showing the raw AAGUID.
- [ ] Prove the row in Chromium at 360 and 1280 px in both themes. Done when: `test/node/account-browser.test.tsx` passes the accessibility loop with the label drawn.
- [ ] Commit: `web: name a passkey's provider`

**Test checkpoint:** `pnpm exec vitest run test/web/account.test.ts` and `pnpm exec vitest run --project browser test/node/account-browser.test.tsx` pass.

## 17. Land new organisations on /welcome

> **Started:** 2026-11-01T09:35Z

Filed from the D07 T08 §2 plan (item 4). A person who signs up and makes an organisation lands on `/cases`, where an empty first run tells them what to do; the board's first screen for a new organisation is the checklist. The landing is decided in the signup path (`src/auth/signup.ts`, the app lane's file, D07 T02 §13), so the change is asked of the coordinator before it is made, and it touches only where a newly made organisation is sent, never an existing member's sign-in.

**Corrected 2026-11-01 (plan):** the landing is not in `src/auth/signup.ts` but in `createAuth` (`src/auth/auth.ts`): the signup's first link is sent through the magic-link endpoint with `callbackURL: DEFAULT_RETURN`, used by no other link, so the change is that one value (`/welcome`). The coordinator approved the console lane making it (2026-11-01 11:30 SAST) and told the app lane. The signup test that held `/cases` is changed to `/welcome`; `test/auth/flow.test.ts` keeps proving every ordinary sign-in link lands on `/cases` or the asked page.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Send a newly made organisation to `/welcome`. Done when: `test/auth/invite.test.ts test/auth/flow.test.ts` follows a real signup to `/welcome` and an existing member's sign-in to where it went before.

- [x] Ask the coordinator to approve the one-line landing change in `src/auth/signup.ts`, and record the approval here. Done when: the approval is recorded with its date. Cheaper substitute: none.
- [x] Land the organisation just made by signup on `/welcome` and leave every other sign-in, link and invitation landing as it is. Done when: the signup test reads the landing for a new organisation and for an existing member, an invitation acceptance and a sign-in with a `next`, all unchanged.
- [x] Commit: `auth: land a new organisation on the welcome list`

**Test checkpoint:** `pnpm exec vitest run test/auth/invite.test.ts test/auth/flow.test.ts test/web/signup-page.test.ts test/web/invite-page.test.ts` passes (the signup landing through the first link, the inbox page and the new-link recovery; ordinary sign-in and invitation acceptance unchanged).

> **Verified:** 2026-11-01 | §17 | 8dd6231920938f85e79e9c9e6462684e114b5cb4
> **Review:** `docs/reviews/d07-t08-s17.json`

## 18. Measure setup and first-verdict time

Filed from the D07 T08 §2 completion review (gaps 2 and 11). The welcome list says "Most teams finish in about ten minutes" (the approved board's sentence) and exists to get a new member to their first real verdict in minutes; nothing measures either. Real organisations have to use it first, so this waits for attended runs, and it ends in either evidence for the sentence or a reworded sentence on the board and in `design/SPEC.md` A4.

**Phase:** 7
**Needs:** attended
**Surface:** no

**Build order:**

1. Measure on real use. Done when: a dated record holds the median and 95th-percentile time from an organisation's creation to its first finished report, and from the first checklist view to five steps done, for the organisations that have used the list.

- [ ] Write `scripts/onboarding-times.ts` to read, per organisation, the creation time, the first email case and its finished time, and the setup steps' stored dates, with counts only (no addresses or content). Done when: the script prints the medians and 95th percentiles for the organisations in a local fixture database and refuses an organisation with no case.
- [ ] Run it on production data after the competition's first judge and member sessions and record the figures here with the date. Done when: the record is in this section. Cheaper substitute: none.
- [ ] Keep the board's sentence only if the median supports it; otherwise reword it on the board and in `design/SPEC.md` A4 and in `src/web/pages/welcome-view.tsx`. Done when: the page, the board and the SPEC say the same words, with the reason recorded.
- [ ] Commit: `web: measure and word the setup time`

**Test checkpoint:** `pnpm exec vitest run --project node test/node/onboarding-times.test.ts` passes.

## 19. Help route on the site 500 page

> **Started:** 2026-11-02T17:12Z

When a visitor's retry fails and Home fails too, the standalone 500 offers no way to reach a person: the sign-up link does not help an existing member, and the check@ panel is for mail. A help link independent of the failing site (a mailto to the contact address) would be one activation away. Filed 2026-11-01 by D07 T08 \u00a79's completion review (excellence item 2); it adds a control the S11 board does not draw, so the SPEC changes first.

**Phase:** 7
**Operator decision 2026-11-02:** Add a mailto help link to the contact address on the standalone 500 page (SPEC S11 changes first).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` S11 (a deviation or a revised board for the 500's help link)
**Job:** a visitor stuck on the 500 reaches Rizonetech in one activation without the site (one activation opens an email composer)
**Treatment:** one text link in the 500's panel, a mailto to the contact address, with the address itself visible and selectable beside the link so a visitor with no configured mail handler can copy it into webmail
**Chrome:** the standalone 500

**Build order:**

1. Decide with the operator whether the 500 carries a help link, record it in the SPEC, then add it. Done when: the 500 shows the link and its test finds the mailto, with the page still standalone.

- [x] Record the decision in `design/SPEC.md` S11 (including the visible-address fallback), add the link and the visible, selectable contact address to `site/src/pages/500.html.ts` and test it in the built file and in Chromium. Done when: the tests pass with the link present and the page still has no external request.
- [x] Prove usability, not only presence: the built link's destination is exactly the `contact` mailto from `site/src/lib/links.ts`, and `site/test/browser.test.ts` asserts its visible accessible name, Tab reachability, focus indicator and native mailto target with JavaScript disabled and subresource requests blocked. Done when: that test fails on an unfocusable or mis-targeted help link. (Plan review P2, 2026-11-02.)

**Groomed 2026-11-02 (site lane, drift sweep, no box ticked):** the decision is already recorded in the header (add the mailto, SPEC S11 first), so step 1's "decide with the operator" is stale; what remains is the S11 record, then the link. Not shipped: `site/src/pages/500.html.ts` has no contact mailto (the `contact` address already exists at `site/src/lib/links.ts:36`), and SPEC S11 lists no help link yet. The existing standalone test asserts no external requests; a `mailto:` keeps the page standalone, but the item must name updating `site/test/errors.test.ts` to assert the mailto's presence, not only the absence of external requests.
- [x] Commit: `site: a help link on the 500`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site test` exits 0 with the 500's help link read.

> **Deferred:** staffed support availability beside the 500 help route -> XREF: D07 T08 §25

> **Verified:** 2026-11-02 | §19 | 81eba2aea924bceb2e2cdff412b18aaeb435fcf3
> **Review:** `docs/reviews/d07-t08-s19.json`

## 20. Feedback to eval set

Board X4's "Add to eval set" stores a synthetic copy of the case, so the member's real email never leaves their case. No eval-set intake exists (0067 and 0073 carry runs, results and published only), and the synthetic-data rules with intake review, consumption, duplicate prevention and removal belong to the eval lane. Filed 2026-11-02 from D07 T08 §5's plan review (P1 gap 2).

**Phase:** 7
**Operator decision 2026-11-02:** The eval-set intake is owned and reviewed by the eval lane; this section's admin action calls that intake (a cross-lane section for the intake is filed through the coordinator).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X4 (the triage action)
**Job:** the operator feeds a disputed verdict back into the eval set without touching real mail
**Treatment:** the board's button and the synthetic-copy promise
**Chrome:** the feedback detail panel from §5

**Build order:**

1. Decide with the operator and the eval lane where the intake lives and who reviews it, record it here, then build it. Done when: an operator action on a feedback item stores a synthetic copy the eval harness consumes, exactly once, removable, with the real email never copied.

- [ ] Record the intake contract in this section, add the button to the feedback panel, and test single storage, duplicate prevention and removal. Done when: the tests pass with the real email untouched.
- [ ] Commit: `admin: feedback to eval set`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-eval-intake.test.ts` passes and fails if the real case email is read.

## 21. Operator TODO from feedback

Board X4's "File a TODO" files the operator's follow-up from a feedback item. No product TODO backend exists (`operator-actions.md` is the handover blocker list, not product data). Filed 2026-11-02 from D07 T08 §5's plan review (P1 gap 2).

**Phase:** 7
**Operator decision 2026-11-02:** A product TODO store in the database: created retry-safely from feedback and read back in the admin console. The repository TODO system is not a product backend.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X4 (the triage action)
**Job:** the operator turns a disputed verdict into tracked follow-up work
**Treatment:** the board's button and a durable, re-readable task
**Chrome:** the feedback detail panel from §5

**Build order:**

1. Decide with the operator what a product TODO is (destination, read-back, retry-safe creation), record it here, then build it. Done when: filing from a feedback item stores a task the operator reads back, exactly once.

- [ ] Record the TODO contract in this section, add the button to the feedback panel, and test creation, read-back and retry safety. Done when: the tests pass with no duplicate task on retry.
- [ ] Commit: `admin: operator TODO from feedback`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-operator-todo.test.ts` passes and fails if a retried filing stores two tasks.

## 22. Suspend an organisation

Board X2's plan card carries Suspend. No suspension mechanism exists anywhere in `src/` or the migrations, and enforcement (refusing admission, signing, verification) with reinstatement belongs with the auth lane. Filed 2026-11-02 from D07 T08 §5's plan review (P2 gap 6).

**Phase:** 7
**Operator decision 2026-11-02:** Build suspension with enforcement at every gate (admission, signing, verification) plus reinstatement, with the auth lane; the interim X2 Deviation stands until it lands.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X2 (the plan card action)
**Job:** the operator stops a client using the service and restores it later
**Treatment:** the board's button with a reason and a reversible state
**Chrome:** the organisation detail page from §5

**Build order:**

1. Decide with the operator and the auth lane what suspension blocks and how reinstatement works, record it here, then build it. Done when: a suspended organisation is refused at every gate and reinstated cleanly, with the button showing the state.

- [ ] Record the suspension contract in this section, add the control, and test refusal at each gate plus reinstatement. Done when: the tests pass with no gate admitting a suspended organisation.
- [ ] Commit: `admin: suspend an organisation`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-suspend.test.ts` passes and fails if any gate admits a suspended organisation.

## 23. Money-at-risk aggregation

Board X2's threats card ends with "Money at risk caught" across the invoices. No amount column exists in the merged migrations, and the verified amount contract belongs to the invoice lane. Filed 2026-11-02 from D07 T08 §5's plan review (P2 gap 7).

**Phase:** 7
**Operator decision 2026-11-02:** Sum the invoice lane's verified amounts under a contract this section lands with that lane; no amount is derived from unverified case data. The X2 Deviation stands until the contract exists.

**Needs:** none
**Surface:** no
**Fidelity:** `design/SPEC.md` X2 (the threats card line)
**Job:** the operator sees the rand amount the service caught
**Treatment:** one truthful line with the invoice count
**Chrome:** the threats card from §5

**Build order:**

1. Agree the amount contract with the invoice lane, record it here, then build the aggregation. Done when: the line reads the lane's verified amounts and the test pins the sum.

- [ ] Record the amount contract in this section and test the aggregation across invoices. Done when: the tests pass with the sum matching the lane's figures.
- [ ] Commit: `admin: money at risk`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-money-at-risk.test.ts` passes and fails if the summed amount differs from the invoice lane's figures.

## 24. Feedback queue search and step

The feedback queue finds a complaint only by paging through its tab fifty at a time, and the detail panel offers no way to step to the next complaint. Search or filter (by case, organisation or words) and previous/next item navigation need their own surface: the board X4 queue has neither, so the controls need operator approval and a SPEC note before they are drawn. Filed 2026-11-02 from D07 T08 §5's completion review (gap G16).

**Phase:** 7
**Operator decision 2026-11-02:** Approve both: bounded search inside the current tab and Previous/Next complaint controls carrying tab, page and selection (a SPEC note recorded before they are drawn).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` X4 (the queue)
**Job:** the operator finds a known complaint and walks a tab without losing their place
**Treatment:** the board's tabs and pages until the operator approves more
**Chrome:** the feedback queue from §5

**Build order:**

1. Put the search/filter and adjacent-item controls to the operator with the design note, record the decision here, then build them. Done when: a known case is reachable without sequential paging and one activation moves to the adjacent complaint with page and tab kept.

- [ ] Record the operator's decision on the search box and the previous/next controls in this section's body, with the `design/SPEC.md` X4 note or Deviation they need. Done when: the section names the exact controls, labels and positions an implementer draws.
- [ ] Add the queue search to `listTriage` in `src/db/feedback-triage.ts` as a bounded term matched against case subject, sender and organisation inside the current tab. Done when: the module test returns only rows of the requested tab and state. Cheaper substitute: filtering the rendered page in the browser, which would hide records instead of finding them.
- [ ] Draw the search field in `src/web/pages/admin-feedback-view.tsx` as a GET form that keeps `triage` and drops `page` on a new search. Done when: the queue page renders the field with an accessible name and the search term survives in the address. Cheaper substitute: a client-side script, which the server-rendered queue does not need.
- [ ] Add Previous and Next complaint links to the detail panel in `src/web/pages/admin-feedback-view.tsx`, each carrying the tab, page and adjacent selection. Done when: both links appear only when an adjacent record exists in the tab. Cheaper substitute: browser history buttons, which leave the queue after a mutation.
- [ ] Carry the search term and adjacent selection through the pager links in `src/web/pages/admin-feedback-view.tsx`. Done when: paging a search result keeps the term and every record stays reachable. Cheaper substitute: resetting to page one, which loses the operator's place.
- [ ] Test find and step in `test/web/admin-detail.test.ts`: seed two organisations across a page boundary, find one case by its words, and step across the boundary. Done when: the test passes with the queue position preserved and fails if a step returns a record outside its tab.
- [ ] Read the queue and panel in `test/node/admin-detail-browser.test.tsx` at 360 and 1280 px in both themes, with keyboard focus and axe clean. Done when: the browser test passes with the new controls operable by keyboard alone. Cheaper substitute: worker-test only, which cannot see focus order or contrast.
- [ ] Commit: `admin: feedback queue search and adjacent navigation`

**Test checkpoint:** `pnpm exec vitest run test/web/admin-detail.test.ts` passes and fails if a search returns a record outside its tab.

## 25. Support availability on the site 500 page

The standalone 500's help route (§19) gives an address with no expectation of when a person answers; the GOV.UK and HMRC service-error pattern, named by §19's completion review (2026-11-02), states support availability beside the contact route. Filed 2026-11-02 by D07 T08 §19's completion review (out-of-scope gap 3): the wording is an operator support-policy decision first (actual staffed hours and a response expectation the service can keep), so nothing is promised on the page before that decision exists.

**Phase:** 7
**Needs:** operator
**Surface:** yes
**Fidelity:** `design/SPEC.md` S11 (the help-route control §19 added; this section extends its text)
**Job:** a visitor stuck on the 500 knows when a person will answer
**Treatment:** one plain sentence beside the help link, only what the operator has staffed
**Chrome:** the standalone 500

**Build order:**

1. Record the operator's staffed hours and response expectation, then state them beside the help link. Done when: `design/SPEC.md` S11 carries the sentence and the built 500 shows it next to the address.

- [ ] Record the operator's support hours and response expectation (with its date) in `design/SPEC.md` S11 and in this section. Done when: both records exist and say the same words. Cheaper substitute: a generic "we reply soon", refused (an unstaffed promise).
- [ ] Add the sentence to the help line in `site/src/pages/500.html.ts`, reading the address from `contact` in `site/src/lib/links.ts` as §19 does. Done when: the built page shows the expectation beside the address and still makes no external request. Cheaper substitute: hard-coding the address again, refused (links.ts owns it).
- [ ] Extend `site/test/errors.test.ts` to find the expectation beside the address in the built file. Done when: the test fails when the sentence is removed.
- [ ] Commit: `site: support availability on the 500`

**Test checkpoint:** `pnpm --filter site build && pnpm --filter site test` exits 0 with the stated expectation read beside the help address on the built 500.

## Verification

- Every page and message in this file matches its board, at phone and desktop widths, with no accessibility violations.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
