---
schema_version: 1
id: member-console
domain: 07-app
status: active
title: "TODO-04 -- Member Console"
track: day-6
---

# TODO-04 -- Member Console

> **Goal:** A signed-in member sees their organisation's cases with filters and search, weekly stats and money at risk caught, the team and its invites, and the approved domains and sending addresses; owners and admins manage them.

> **Current state:** Measured 2026-10-26 20:00 SAST. Auth pages (D07 T02 §7), the report (D07 T03), identity (D05 T01 §3), ledger (D06 T01 §4) and monitor findings (D05 T04 §5) are planned elsewhere and linked from the console navigation.

## Inputs

- Design spec 4.8 (client dashboard: cases and verdicts, invoice flags and money at risk caught, weekly stats, team, approved domains, supplier ledger), 4.10 (production counts), `design/SPEC.md` member console.
- -> XREF: D01 T01 §16 -- the original's subject and sender the Cases rows and search read
- -> XREF: D01 T03 §11 -- the uploading member that Checked by names

## Outcome

- A member finds any case by sender, subject words, verdict or date; sees this week's counts and money at risk caught; owners manage team and domains.

**Adjacency:** list=applicable @ D07 T04 §1; document=not-applicable (each case's document is its report); settings=applicable @ D07 T04 §4; reporting=applicable @ D07 T04 §2; notifications=not-applicable (the console sends nothing); permissions=applicable @ D07 T04 §3; audit=applicable @ D07 T02 §6; exchange=applicable @ D07 T04 §2; reverse=applicable @ D07 T04 §3

**Adjacency rationale:** The cases list is the find path; stats are the reporting with a CSV export of counts; team management carries roles (permission) and removal (reverse); domains and addresses are the organisation's settings; changes are recorded in `auth_events`.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Cases list with filters and search | D07 T03 §1 | [x] |
| 2 | §2 | Weekly stats, money at risk, CSV export | §1 | [x] |
| 3 | §3 | Team and invites page | D07 T02 §3, D07 T01 §10 | [ ] |
| 4 | §4 | Domains and sending addresses page | D07 T02 §15 | [ ] |
| 5 | §5 | Registrar-assisted domain verification | §4 | [ ] |
| 6 | §6 | MSP console and own branding | D07 T02 §8 | [ ] |
| 7 | §7 | Subject, sender and search in the Cases list | §1, D01 T01 §16, D01 T03 §11 | [x] |
| 8 | §8 | A chosen date range in the Cases list | §1 | [ ] |
| 9 | §9 | Next and previous case from a report | §1, D07 T03 §1 | [ ] |
| 10 | §10 | A Checked by filter in the Cases list | §7 | [ ] |
| 11 | §11 | DNS help for each provider on the domain page | D07 T02 §15 | [ ] |
| 12 | §12 | Remove a case checked by mistake | §1 | [ ] |
| 13 | §13 | Invoice and payment-document words in Type | §7, D06 T02 §3 | [ ] |
| 14 | §14 | Multi-word search in the Cases list | §7 | [ ] |
| 15 | §15 | Slash shortcut to the Cases search | §7 | [ ] |
| 16 | §16 | Live Cases search latency vs Gmail | §7 | [ ] |
| 17 | §17 | Money at risk caught tile | §2, D06 T01 §3 | [ ] |
| 18 | §18 | Threat kinds under Malicious or suspicious | §2 | [ ] |
| 19 | §19 | Chosen reporting period for the counts export | §2 | [ ] |
| 20 | §20 | Opt-in weekly counts report by email | §2 | [ ] |
| 21 | §21 | Invitations panel on the Team page | §3 | [ ] |
| 22 | §22 | Invite several colleagues at once | §21 | [ ] |
| 23 | §23 | Team history for owners | §3 | [ ] |
| 24 | §24 | Team history by person | §23 | [ ] |

## 1. Cases list with filters and search

> **Started:** 2026-10-30T16:54:24Z

Every case of the organisation, newest first, with verdict, channel, sender (display only for members), subject and time; filters by verdict, channel and date; search by sender or subject words; paged 25 at a time.

**Phase:** 2

**Corrected 2026-10-30** (the operator's decision, 18:20 SAST, through the coordinator): was Phase 6. Every sign-in lands on `/cases` (`DEFAULT_RETURN`), so the Cases list is built before the sign-in page (D07 T02 §7), which depends on it, ahead of the operator's own sign-up (D99 T02 §1).
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, cases list
**Job:** a member finds a past check without its link
**Treatment:** a scannable table, verdict first, filters that keep their state in the URL
**Chrome:** `AppShell`, `VerdictBadge`, `EmptyState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Corrected 2026-10-30** at start, against the code and the boards (`Cases`, `Cases-Empty`):
- The subject and the original's sender are not stored yet: storing them at intake is the checks lane's D01 T01 §16 (migration 0038, filed at this lane's request through the coordinator), not this section's, and is not on main. The row's subject-and-sender cell, and the search box that searches them, move to §7 (filed below), which waits on D01 T01 §16. Until then a row is named by what was checked (`Forwarded email`; `Uploaded document`, `image` or `voice note`) and the search box is not drawn.
- "Checked by" is the member who forwarded the mail: the case's `forwarded_by` matched to a member of the organisation by address (their name, else the address). An upload stores no uploader (D01 T03 §1 admits it with no forwarder), so its cell reads "Not recorded" until the checks lane stores one; asked of the checks lane through the coordinator, and §7 draws it.
- The "Type" column's invoice and payment-document words ("Email, invoice") come from the invoice checks (D06), not stored on the case; §7 draws them from the evidence once D06 T01 classifies a case. This section shows the channel and source kind.
- The stats tiles above the table are §2's. A row's verdict pill reads the case's real state, as the report does (`shownState`, `src/web/pages/report-view.tsx`): Checking, Partial, Could not be checked, or the verdict.
- `requireOrg` answers any refusal as JSON. A page answers it as a page: a member with no active organisation, or one just removed, gets the E3 403 page, not a JSON body.

**Build order:**

1. Build `GET /cases` behind `requireSession` (D07 T02 §1). Done when: filters and paging work in a rendered test (search is §7's), and an anonymous request is sent to `/signin`. **Corrected 2026-10-30 (plan review P3).**

- [x] Read one page of the organisation's cases in `src/db/case-list.ts` (`listCases(db, orgId, { verdict, channel, period, page }, now)`): newest first by `created_at` then `id`, 25 a page, scoped by `org_id`, with the matching count and the organisation's total; the period's start in SAST days (7, 30 or 90, or all time). Done when: `test/db/case-list.test.ts` reads each filter, the page edges and another organisation's cases never appearing, and a bad filter value is refused, not ignored. Evidence 2026-10-30: `test/db/case-list.test.ts` 4 passed (a bad verdict, page 0 and no organisation refused; 27 cases paged 25 and 2, page 7 answering page 2, another organisation's case never read; the period starting at SAST midnight; a failing database a typed `database` refusal); the filter shapes live in `src/db/case-filters.ts` so the page and its browser test read them without the database.
- [x] Name who checked each email case: the `forwarded_by` address matched to a member of the organisation (`"user".name`, else the address), in the same read. Done when: the test shows a member's name, a former member's address, and "Not recorded" for an upload. Evidence 2026-10-30: `test/web/cases-page.test.ts` "names who checked each case" reads Thandi Nkosi for a member, the address for a former member and null (drawn "Not recorded") for an upload.
- [x] Build `src/web/pages/cases.tsx` (`GET /cases` behind `requireSession` and the active organisation): heading "Cases" and "Everything <organisation> has checked", Check a file (`/upload`, D01 T03 §6), the verdict segmented filter (All, Malicious, Suspicious, Safe), channel (All channels, Email, Upload) and period (Last 7 days, Last 30 days, Last 90 days, All time; Last 30 days by default), the table (Verdict, Case, Type, Checked by, When; every row opens `/r/<id>`), "Showing 1 to 25 of 64" and Previous and Next. Filters and page live in the query string; a bad value answers the default, never a 500. Changing a filter goes back to page 1; Previous and Next keep every filter; a page past the last answers the last page (or the empty state when nothing matches); Previous is disabled on page 1 and Next on the last, as disabled links (`aria-disabled`, no `href`). Done when: `test/web/cases-page.test.ts` covers each filter, combined filters, paging with filters kept, a filter change from page 3 returning page 1, an out-of-range page and every row's link. **Added 2026-10-30 (plan review P2).** Evidence 2026-10-30: the route is `src/web/pages/cases.tsx`, the page `src/web/pages/cases-view.tsx`; `test/web/cases-page.test.ts` covers each filter and three combinations, the form echoing the address, bad values answering defaults, paging 30 cases with the filter kept in both pager links, page 9 answering the last, and the ends drawn as disabled buttons (a link with no `href` is no control; announced as dimmed), every row linking `/r/<id>`.
- [x] Keep the filters working without JavaScript (a GET form with its own Apply button) and, with htmx (D07 T01 §9), redraw only the results on each change and push the URL, so Back returns to the previous filters. The newest change wins (`hx-sync` replaces a request still in flight), the form shows "Loading cases" while it waits, and the results' count line is announced politely; focus stays on the control that changed. Done when: `test/node/cases-browser.test.tsx` changes a filter, sees the URL and rows change, presses Back and sees the earlier rows; with a delayed response it sees the loading line, and two quick changes leave only the second's rows; it filters, pages and opens a report by keyboard alone; and with JavaScript off, Apply submits the form. **Added 2026-10-30 (plan review P2).** Evidence 2026-10-30: `test/node/cases-browser.test.tsx` (13 passed) changes a verdict and reads the pushed address and new rows with only the results fetched and focus kept, presses Back and reads the earlier rows; with a delayed response sees Loading cases; two quick changes leave only the second's rows (removing `hx-sync` fails it); filters with ArrowRight, pages with Enter and opens a report by keyboard; and with JavaScript off filters through Apply.
- [x] Never show cases from history without asking the server: htmx keeps no page snapshots (`historyCacheSize` 0 and `refreshOnHistoryMiss`, set once in `src/web/components/Document.tsx` for every page), so Back reloads the page through the session and organisation checks; every answer is `private, no-store`. Done when: the browser test switches organisation (or is removed) and presses Back, and sees the active organisation's cases or the 403 page, never the earlier organisation's rows. **Added 2026-10-30 (plan review P1).** Evidence 2026-10-30: `src/web/components/Document.tsx` sets `historyCacheSize` 0 and `refreshOnHistoryMiss`; the browser test switches organisation then presses Back and reads the new organisation's rows, then removes the member and reads the 403 page; keeping snapshots fails two tests.
- [x] Recover a filter request that fails as the page would: when a results request is answered with an error (an expired session sent to sign in, a revoked membership, a database outage) or cannot be sent, `src/web/client/app.ts` loads the requested address as a whole page, so the reader meets the sign-in page, the 403 page or the 503 page, whose Try again keeps the filters. Done when: the browser test drives each through a filter change, not a direct page load. **Added 2026-10-30 (plan review P1).** Evidence 2026-10-30: `src/web/client/app.ts` loads the address whole on `htmx:responseError`, `htmx:sendError` and a response that landed elsewhere; the browser test drives an expired session (lands on sign-in with `next` keeping the filter), a removal (403 page), an outage (503 page whose Try again keeps the filter and, once the store is back, shows the rows) and a dropped connection through a filter change; removing the handlers fails four tests.
- [x] Write "When" as SAST: "Just now" under a minute, the time today, "Yesterday", then "Fri 24 Oct", with the full date and time in the cell's `datetime` and title. Done when: unit cases cover each band and the SAST midnight edge. Evidence 2026-10-30: `test/web/cases-page.test.ts` "when a case arrived" covers Just now, 09:14, Yesterday, Sat 24 Oct, Fri 24 Oct 2025, the full title, and 00:30 SAST on the 30th as today while 23:30 SAST on the 29th is Yesterday.
- [x] Show the first-run state (board `Cases-Empty`) when the organisation has no cases: the eyebrow, heading and sentence, the check address with Copy address (D07 T01 §9's copy script), the three how-to tiles, and the accepted-senders line with Or upload a file. The line reads the organisation's verified domains and verified addresses (`src/auth/senders.ts`'s sources): domains only ("Only mail sent from karoocouriers.example, your verified domain, is accepted."), addresses only, both, or neither (no mail is accepted yet; a link to Domains and addresses, `/settings/domains`, D07 T04 §4). Done when: the page test reads each of the four. **Corrected 2026-10-30 (plan review P2).** Evidence 2026-10-30: `test/web/cases-page.test.ts` reads the first-run state with Copy address and the how-to tiles for a domain-only, an address-only, a domain-and-addresses and a no-sender organisation (the last linking `/settings/domains`), from `verifiedSenders` in `src/auth/senders.ts`.
- [x] Show the filtered-empty state when filters match nothing: 'No cases match Malicious, last 7 days.', "64 cases in total. Try a wider date range or another verdict." and Clear filters, which resets verdict, channel and page and selects All time (`/cases?period=all`, since the default is the last 30 days). Done when: the page test reads it, and an organisation with only older cases sees them after Clear filters. **Corrected 2026-10-30 (plan review P2).** Evidence 2026-10-30: `test/web/cases-page.test.ts` reads "No cases match Malicious, last 7 days.", "1 case in total.", Clear filters to `/cases?period=all`, and a 60-day-old case missing from `/cases` but listed there; pointing Clear filters at `/cases` fails it.
- [x] Draw each row's state as the report does (`shownState`): received and running as Checking, partial with a verdict as Partial beside nothing hidden, partial or done without one as Could not be checked, and done as its verdict; All lists them all, and a verdict filter lists only cases with that verdict. Done when: the page test renders a fixture of each and reads its pill and its place under All. **Added 2026-10-30 (plan review P2).** Evidence 2026-10-30: `test/web/cases-page.test.ts` renders received and running (Checking), partial with a verdict (Partial), partial without one (Partial with "Could not be checked"), done (Malicious), all five under All in order and only the partial under Suspicious; hiding the words fails it.
- [x] Answer a member with no active organisation, or one just removed, with the E3 403 page (`ErrorState` 403), and a read that fails with the E5 page (503, its reference logged as the report's is, Try again keeping the filters). The active organisation and membership are read through one function `src/auth/org.ts` exports, which `requireOrg` also uses, so the page and the API agree. Done when: the page test covers each. Evidence 2026-10-30: `activeMembership` in `src/auth/org.ts` (requireOrg uses it, `test/auth/org.test.ts` 19 passed); `test/web/cases-page.test.ts` reads the 403 page with the address and Sign out for a removed member and for no active organisation (a Deviation in `design/SPEC.md` E3), and the 503 page with its logged reference and Try again keeping the filters. The error pages moved to `src/web/pages/errors.tsx`, shared with the report.
- [x] Pass the accessibility gate's rules at 360 and 1280 px in both themes, the table a real table with its caption and column headers, the segmented filter a labelled radio group, on a phone the table reflowing to one card per case with no sideways scroll. Done when: the browser test scans each and measures the width. Evidence 2026-10-30: `test/node/cases-browser.test.tsx` scans the list, the filtered-empty and the first-run states at 360 and 1280 px in both themes with no problem and no sideways scroll (a captioned table on desktop, one card per case on phones, the verdict filter a fieldset of radios). It found a body shorter than the viewport leaving the sidebar's text over two backgrounds: `Document` now gives the body `min-h-screen`.
- [x] Close the completion review's in-scope gaps: every results request (the filters and the pager) joins one queue so the newest wins in either order; a results request from a page drawn for another organisation (switched in another tab) reloads the whole page (`x-cases-org`, answered `HX-Redirect`); the Gmail tile says to tick the email and use More at the top (a Deviation in `design/SPEC.md` M1); a session store that cannot be read answers the E5 page (`sessionGate` in `src/auth/gate.ts`, the API keeping JSON); focus stays on a pager end through each redraw; and the list is timed at 10,000 cases. Done when: `test/node/cases-browser.test.tsx` (15) drives both queue orders, the switched organisation, and Tab and Enter through filtering, paging to the last page and back and opening a case with no programmatic focus; `test/web/cases-page.test.ts` (15) reads the session-store outage's E5 page with its logged reference and the stale organisation's 204 `HX-Redirect`; `test/db/case-list.test.ts` (5) reads 10,000 cases at p95 6 ms on the local SQLite through `cases_org_created` (production D1 adds its network time). Each fix's removal fails its test. **Added 2026-10-30 (completion review).**
- [x] Commit: `web: cases list with filters and search`

> **Resolved:** the row's subject and original sender, the search box that searches them, the uploader's name and the invoice words in Type (boards `Cases`) -> XREF: D07 T04 §7. Resolved 2026-10-31 by D07 T04 §7 in `fc506f22` and `468d6311`: the subject over the sender, the search, and the uploader in Checked by; the invoice words in Type moved on to D07 T04 §13.

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if another organisation's case appears.

> **Verified:** 2026-10-30 | §1 | d3456050f9e9893852d6041dace75d72ae0059ec
> **Review:** `docs/reviews/d07-t04-s1.json`

## 2. Weekly stats, money at risk, CSV export

> **Started:** 2026-10-31T15:50:26Z

**Corrected 2026-10-28:** the title read "Weekly stats, money at risk and CSV export"; shortened by a word so the Phase 6 plan table stays within 100 characters once 11-character references (D01 T01 §10, D05 T04 §10) joined it.

This week and last: cases checked, verdict mix, median time to verdict, invoice flags and the money at risk caught (sum of flagged invoice amounts), with a CSV export of the counts (never message content).

**Corrected 2026-10-31:** measured against the board `Cases` and the tree. (1) The board's stats panel is four tiles (Checked this week with last week's count; Malicious or suspicious with its kinds; Money at risk caught with the invoices behind it; Median time to verdict with Export counts as CSV) and no chart, so the uPlot daily chart is struck: the board is the Fidelity source, and nothing in `package.json` or `design/SPEC.md` carries uPlot. (2) Money at risk needs flagged invoice amounts, which nothing stores yet (D06 T01 §3 bank-change rules, trust lane, open), so that tile moves to §17. (3) The kinds line under Malicious or suspicious ("5 phishing, 3 invoice, 1 impersonation") needs a stored kind per case, which no check writes and no spec defines, so it moves to §18 with an owner decision. This section ships the three tiles whose data is stored today and the CSV.

**Corrected 2026-10-31 (plan review, `docs/reviews/07-app/D07-T04-s2.md`):** four gaps closed before the build. (1) Counting rules: a case belongs to the week it arrived in (`cases.created_at`), whatever its state; "checked" counts every case that arrived (received, running, done and partial); a verdict is the stored `cases.verdict` of a done or partial case, so a partial case with a verdict counts in its verdict and one without counts as unfinished; the median is over the week's arrivals that have a `case_verdicts` row, measured to that row's `created_at` even when the verdict came in the next week; the CSV's `malicious + suspicious + safe + unfinished` always equals `checked`. (2) The panel redraws with every results request (it joins the out-of-band swap beside `#case-count`) and never reads the list's filters. (3) The CSV route and a stats read that fails on `/cases` are proven through the session gate, the 403, the 503 and a retry. (4) The panel is proven in Chromium at phone and desktop widths in both themes, its labels tied to their numbers (`dl`, `dt`, `dd`), and Export downloads by keyboard. A week is Monday 00:00 to Monday 00:00 SAST (ISO 8601 weeks, the industry default; changing it later changes only `weekStart`).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, stats panel (board `Cases`)
**Job:** an owner sees what IsItLegit did for the business this week
**Treatment:** the board's tiles over the filters, numbers large, the comparison line small and muted
**Chrome:** §1's page, above the filters

**Build order:**

1. Compute the week's numbers in `src/db/case-stats.ts`. Done when: `test/web/stats.test.ts` checks a seeded week.
2. Draw the tiles on the Cases page in `src/web/pages/cases-view.tsx`. Done when: the page test reads each tile.
3. Serve the CSV at `GET /cases/stats.csv` in `src/web/pages/cases.tsx`. Done when: the test reads its header and rows.

- [x] Add `weekStart(now)` in `src/db/case-stats.ts`: the Monday 00:00 SAST at or before `now`, as an ISO instant. Done when: `test/web/stats.test.ts` reads Monday 2026-10-26 00:00 SAST (2026-10-25T22:00:00Z) for Friday 2026-10-30 and for Monday 00:00 itself, and the previous Monday for Sunday 23:59 SAST. Cheaper substitute: a rolling 7 days, which the board's "this week" is not.
- [x] Add `weeklyStats(db, orgId, now)` in `src/db/case-stats.ts` by the counting rules above: this week's cases checked, last week's, this week's malicious and suspicious count, and the median seconds from arrival to verdict, every read scoped by the organisation. Done when: the test checks a seeded week with cases on both sides of each week boundary, received, running, done, partial-with-verdict and partial-without cases, a case that arrived Sunday with its verdict on Monday (counted in the earlier week), another organisation's cases ignored, an even count's median the mean of the middle two, and no verdicts read as no median. Cheaper substitute: an average, which one slow case skews.
- [x] Draw the three tiles above the filters as `#case-stats`, a `dl` of label (`dt`) and number (`dd`): Checked this week with "N last week"; Malicious or suspicious, its number in the malicious colour token; Median time to verdict in seconds ("48 s"), whole minutes and seconds from 90 s ("2 min 5 s"), "No verdicts yet" with none. One column on a phone, a column each on a wide screen, as the board lays its tiles side by side. Source: board `Cases` stats panel. Done when: the page test reads each tile's number and words for a seeded week, 89 s as "89 s" and 90 s as "1 min 30 s". Cheaper substitute: the numbers without their labels for a screen reader.
- [x] Redraw `#case-stats` with every results request, out of band beside `#case-count` (`hx-select-oob`), from the same week whatever the filters. Done when: the browser test reads the panel's numbers change after a filter change once the server's counts changed, and the page test reads the same panel under any filter. Cheaper substitute: a panel drawn once and stale until a reload.
- [x] Draw "Export counts as CSV" as a link to `/cases/stats.csv` in the median tile, as the board places it. Done when: the page test reads the link. Cheaper substitute: a button that needs JavaScript.
- [x] Serve `GET /cases/stats.csv` behind the session gate and the active organisation (the 403 and 503 pages as the list answers them): one row per week for the last 12 weeks, newest first, columns `week_start,checked,malicious,suspicious,safe,unfinished,median_seconds_to_verdict`, `text/csv; charset=utf-8`, `content-disposition: attachment; filename="isitlegit-weekly-counts.csv"`, `cache-control: private, no-store`. Done when: the test reads the header, 12 rows, this week's counts summing to `checked`, no subject or sender anywhere, and another organisation's counts never. Cheaper substitute: a CSV of the cases themselves, which would carry message content.
- [x] Prove the CSV's refusals: no session answers the sign-in redirect (303 for a browser), a member removed or with no active organisation the 403 page, a read that fails the 503 page with its reference logged and Try again naming `/cases/stats.csv`, and the retry then the CSV. Done when: `test/web/stats.test.ts` reads each answer. Cheaper substitute: an empty CSV on a failed read.
- [x] Answer a stats read that fails on `/cases` with the 503 page, as a list read that fails. Done when: the page test reads the 503 page, never a panel of zeros. Cheaper substitute: zeros.
- [x] Prove the panel in Chromium in `test/node/cases-browser.test.tsx`: the accessibility scans at 360 and 1280 px in both themes with the panel, its no-verdict state and a minutes median; no sideways scroll; Export reached by Tab and pressed with Enter downloads `isitlegit-weekly-counts.csv`. Done when: each passes in the browser test. Cheaper substitute: reading the link's `href` only.
- [x] Keep the stats panel off the first-run state (no cases at all). Done when: the page test reads no tiles for a new organisation. Cheaper substitute: three zeros over the first-run instructions.
- [x] Commit: `web: weekly stats, money at risk and CSV export`

> **Deferred:** the Money at risk caught tile -> XREF: D07 T04 §17
> **Deferred:** the kinds line under Malicious or suspicious -> XREF: D07 T04 §18

**Corrected 2026-10-31:** `GET /cases/stats.csv` was answered 404 by the report's `GET /cases/:caseId`, which claimed any word as a case id; with the coordinator's approval the report route now claims only a ULID (`src/web/pages/report.tsx`), and any other `/cases/<x>` is the same 404 page from `src/web/pages/cases.tsx` without a read (`test/web/stats.test.ts` "/cases/<x> routing").

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` and `pnpm exec vitest run --project node test/node/cases-browser.test.tsx` pass, and fail if the CSV includes subjects or another organisation's counts, or `/cases/stats.csv` is read as a case.

> **Verified:** 2026-10-31 | §2 | 57a9c9fa51be5b9f75ad63d4ca7da18f622b0e74
> **Review:** `docs/reviews/d07-t04-s2.json`

## 3. Team and invites page

> **Started:** 2026-10-31T16:24:34Z

Owners and admins invite by email, change roles and remove members; members see the team (spec 4.8, D07 T02 §3).

**Corrected 2026-10-31:** the section bundled five capabilities, two of them (team history, and inviting several addresses at once) not on the board `Team` yet. Split by single responsibility: this section is the Team page with its members (the table, role changes, removal, the last-owner guard); the invitations panel (invite, pending, Resend, Revoke, the "email not sent" mark) moved to §21; inviting several addresses at once to §22 (a SPEC change first, as it already said); the owners' team history to §23 and filtering it by one person to §24 (no board draws history, so a SPEC change first). Two live accounts are protected (operator, 2026-10-31): demo@rizonetech.com in Fynbos Freight and derick@rizonetech.com are never removed from their organisations; the refusal belongs to the remove-member path in `src/auth/auth.ts` (D07 T02, the app lane's file, asked through the coordinator), and this page draws it.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team (board `Team`)
**Job:** an owner brings the finance clerk in and removes someone who left
**Treatment:** the board's one members table, a role select per member, Remove confirmed, the guard notice under the table
**Chrome:** `AppShell` with Team active, `Button`, the shared select and focus styles from D07 T01

**Build order:**

1. Draw `GET /team` from the organisation's members in `src/web/pages/team.tsx` and `src/web/pages/team-view.tsx`. Done when: `test/web/team-page.test.ts` reads the table.
2. Take role changes and removals as posts to `/team` that run Better Auth's organization endpoints in process, so D07 T02's hooks (audit, sessions ended, last owner) hold. Done when: the test reads each change made and recorded.

- [ ] Draw `GET /team` behind the session gate and the active organisation: heading "Team", "People at <organisation> who can check mail and see cases", and the members table (Name with "You" on the reader's row, Email, Role, Last active from the member's newest session, a Remove button), newest-joined last as the board orders it; the sign-in, 403 and 503 pages as the Cases list answers them. Source: board `Team`. Done when: `test/web/team-page.test.ts` reads every member of the organisation and none of another's. Cheaper substitute: a table of user ids.
- [ ] Draw the role descriptions line under the invite panel's place ("Owner: everything, including the plan and removing people. Admin: suppliers, protection, domains and invites. Member: checks mail and sees cases."). Source: board `Team`. Done when: the page test reads it. Cheaper substitute: none.
- [ ] Draw a role select (Owner, Admin, Member) on each other member's row for an owner, and for an admin on Member and Admin rows only (Better Auth's rule that an admin cannot make or change an owner); the reader's own role and every row for a member as a plain pill. Done when: the page test reads the selects an owner, an admin and a member each get. Cheaper substitute: selects for everyone that the API then refuses.
- [ ] Change a role by posting `/team` with the member and role, from the app's origin and naming the organisation the page was drawn for, through `auth.api.updateMemberRole` in process, then 303 back to `/team` with the outcome; with htmx the select's change posts at once, without JavaScript a Save button beside it. Done when: the test reads the role changed and an `auth_events` row for it, a post naming another organisation or from another origin changing nothing. Cheaper substitute: writing `member.role` directly, skipping D07 T02's hooks.
- [ ] Remove a member through a confirmation (a `dialog` with the member's name, Remove and Cancel; without JavaScript a confirm page), through `auth.api.removeMember` in process, then 303 back with "<name> was removed". Done when: the test reads the member gone, their sessions in the organisation ended and an `auth_events` row, and Cancel changing nothing. Cheaper substitute: removal on one press.
- [ ] Draw the last-owner guard: for the only owner their own Remove disabled and the notice "You are the only owner, so you cannot be removed or made an admin. Make someone else owner first." under the table; a post that would remove or demote the last owner answered with the notice and nothing changed (D07 T02's own refusal, drawn). Source: board `Team`. Done when: the test reads the notice, the disabled button and an attempted post changing nothing. Cheaper substitute: the guard drawn but the post accepted.
- [ ] Draw the refusal of removing a protected account (the remove-member path's answer once the app lane adds it) as a notice like the guard's, nothing changed. Done when: the test reads the notice for demo@rizonetech.com in a Fynbos Freight fixture and the member kept. Cheaper substitute: hiding the Remove button only.
- [ ] Mark Team active in the shell and keep the page's actions out of a member's reach (no selects or Remove for a member; a member's post answered 403). Done when: the test reads a member's read-only page and their post refused. Cheaper substitute: hidden buttons with an open post.
- [ ] Prove the page in Chromium in `test/node/team-browser.test.tsx`: a role change and a removal by keyboard, the dialog's focus kept in and returned, and the accessibility scans at 360 and 1280 px in both themes. Done when: each passes. Cheaper substitute: rendered-HTML tests only.
- [ ] Commit: `web: team and invites page`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` and `pnpm exec vitest run --project node test/node/team-browser.test.tsx` pass, and fail if the last owner can be removed or a member's post changes a role.

## 4. Domains and sending addresses page

The organisation's approved domains and sending addresses with their verification state, adding and removing them (verification flow from D07 T02 §7), and the help text for forwarding as an attachment in Outlook and Gmail.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, domains section
**Job:** an admin controls which mail IsItLegit accepts for the business
**Treatment:** state per row, one add action, removal confirmed
**Chrome:** `AppShell`, `Field`, `Button` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build `GET /settings/domains`. Done when: add, verify link, remove and the forwarding help render.

- [ ] Build `src/web/pages/settings-domains.tsx` listing domains and addresses with state and remove buttons, linking to verification. Done when: `test/web/domains-settings.test.ts` covers add and remove.
- [ ] Add M8's empty state to `design/SPEC.md` first (an organisation with no domain, after removing its last or onboarding by addresses only: what it says and the one action to add a domain or an address), then build it, and show each pending claim's challenge from `GET /api/org/domains` (D07 T02 §5: `codeExpiresAt`, `lockedUntil`, `nextCodeAt`), so a reloaded page states the remaining wait without a trial request. Done when: the SPEC section and board show the empty state, and `test/web/domains-page.test.ts` renders it for an organisation with none and renders a locked claim's remaining wait from the read alone. Source: D07 T02 §5 completion review (Part 1 item 13, Part 2 item 2).
- [ ] Add the forwarding-as-attachment help for Outlook (desktop and web) and Gmail, with the reason headers matter. Done when: the help section renders.
- [ ] Commit: `web: domains and sending addresses page`

**Test checkpoint:** `pnpm exec vitest run test/web/domains-settings.test.ts` passes.


## 5. Registrar-assisted domain verification

Adding a domain today means copying a TXT record into the registrar by hand and coming back to check (D07 T02 §5). Registrars that support Domain Connect can add the record themselves after the owner approves, so a supported domain verifies with no field typed by hand (D07 T02 §5 completion review, Part 2 item 1). DNS by hand and the emailed code stay as the other ways.

**Phase:** 7
**Needs:** none
**Surface:** yes

**Fidelity:** `design/SPEC.md` M8 (the domains page), extended with the registrar step; no board yet.
**Job:** an owner verifies a domain at a supported registrar in at most three actions (add the domain, approve at the registrar, return verified), typing no DNS value.
**Treatment:** the registrar option first when the domain's registrar supports it, the manual record and the emailed code below it.
**Chrome:** the domains page's own controls (§4), no new toolbar or dialog shape.

**Build order:**

1. Design the registrar step and find which registrars support it. Done when: the SPEC and its board show the step, and a test lists a domain's Domain Connect support from its DNS.
2. Build the flow. Done when: a stubbed registrar adds the record and the domain verifies with no value typed.

- [ ] Add the registrar step to M8 in `design/SPEC.md` (the Connect button, the hand-off to the registrar, the return, and what an unsupported registrar shows), with its board. Done when: the SPEC section and the board exist and the controls are named.
- [ ] Discover Domain Connect support for a claimed domain (its `_domainconnect` TXT record and the provider's settings) in `src/auth/domain-connect.ts`. Done when: `test/auth/domain-connect.test.ts` finds support for a stubbed provider and none for a domain without the record.
- [ ] Publish IsItLegit's Domain Connect template for the `_isitlegit` TXT record and build the hand-off URL carrying the claim's token, signed as the protocol requires. Done when: the test builds the URL a stubbed provider accepts, and one with a changed token is refused.
- [ ] Return from the registrar to the domains page and run the DNS check (D07 T02 §5) automatically, showing the outcome. Done when: a rendered-page test returns from a stubbed registrar and finds the domain verified, and an unsupported registrar falls back to the manual record with no dead button.
- [ ] Commit: `web: registrar-assisted domain verification`

**Test checkpoint:** `pnpm exec vitest run test/auth/domain-connect.test.ts test/web/domains-page.test.ts` passes and fails if a domain verifies without its token in DNS or an unsupported registrar shows the Connect button.

## 6. MSP console and own branding

Spec 2b prices an MSP tier for IT providers ("wholesale per client, MSP console, own branding"), and D07 T02 §8 names both as features (`msp-console`, `msp-branding`, on the trial and MSP), but no section built either (D07 T02 §8 completion review). An MSP manages its client organisations from one console and shows its own name and logo to them. Phase 7 is this run's scope decision (2026-10-29, D07 T02 §8), not the spec's: the spec prices MSP without deferring it, but the console has no design and no board yet, and during the event every organisation's trial already unlocks both features; the operator can bring it forward (recorded in `docs/phase-runs/2026-10-28-phase-1.md`).

**Phase:** 7
**Needs:** none
**Surface:** yes

**Fidelity:** none yet: the console and branding pages need their `design/SPEC.md` rows and boards first.
**Job:** an MSP's staff open one console listing their client organisations, open any client's cases in one action, and the clients see the MSP's name and logo in their mail and pages.
**Treatment:** the member console's list and shell (§1, D07 T01), scoped to the MSP's clients.
**Chrome:** the app shell's own controls, no new dialog shape.

**Build order:**

1. Design and model the MSP relation. Done when: the SPEC rows and boards exist and an MSP-to-client relation is stored.
2. Build the console and the branding. Done when: an MSP's staff see only their clients, and a client's pages and mail carry the MSP's brand.

- [ ] Add the MSP console and the branding settings to `design/SPEC.md`'s page inventory, with their boards. Done when: both rows name their owning section (this one) and their states.
- [ ] Store which organisations an MSP manages (a migration and its reads), the MSP's staff reaching a client only through it. Done when: a test finds an MSP's staff reading their client's cases and refused another organisation's.
- [ ] Gate the console on `msp-console` and the branding on `msp-branding` (`requireFeature`, D07 T02 §8). Done when: a Protect organisation is refused both, an MSP or trial organisation passes, and removing a gate fails the test.
- [ ] Commit: `web: MSP console and own branding`

**Test checkpoint:** `pnpm exec vitest run test/web/msp-console.test.ts` passes and fails if an MSP reads a client it does not manage or a non-MSP plan reaches the console.

## 7. Subject, sender and search in the Cases list

> **Started:** 2026-10-31T15:02:03Z

Each row named as the board names it: the original's subject over its sender, the search box that finds a case by either, and the uploader in Checked by. Filed 2026-10-30 from D07 T04 §1's start, where the stored fields did not yet exist.

**Corrected 2026-10-31:** the section also drew "the invoice and payment-document words in Type" from the invoice checks' stored classification. No such classification is stored yet (D06 T01 §1 invoice detection and D06 T02 §3 the standalone document path are open in the trust lane, and `src/invoice/` writes nothing to `cases`), so that item moved to §13, which waits on them; this section ships what is stored today.

**Corrected 2026-10-31:** "the subject over the sender (name and address)" now follows the board `Cases`, whose second line is the sender's address alone; the name is drawn only when no address is stored, and the search reads both. An upload's first line is its file name (`upload_name`, stored since migration 0043), the second "Uploaded PDF" and the like, as the board's "Proof of payment, R12,450.00 / Uploaded PDF" row draws it.

**Corrected 2026-10-31 (plan review, `docs/reviews/07-app/D07-T04-s7.md`):** three gaps closed before the build. (1) The search's typing, delay, Enter, no-JavaScript submit, newest-wins, focus, Back and reload are proven in Chromium (`test/node/cases-browser.test.tsx`), and the new input and two-line rows join its width, theme and accessibility scans. (2) Paging and combined filters are proven over more than 25 matches. (3) SQLite's `lower()` folds ASCII only (D1 has no ICU), so `instr(lower(col), lower(?))` misses "CAFÉ" for "café": the search reads a `search_text` column written by the Worker with Unicode case and accent folding (`searchText` in `src/db/case-search.ts`), at every write of the fields it covers, and the rows stored before it are refilled by the 15-minute schedule. The migration number and the edits to `src/db/cases.ts` and `src/index.ts` (other lanes' files) are asked of the coordinator.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases (board `Cases`)
**Job:** a member finds a past check by what it was about or who sent it
**Treatment:** the board's two-line cell, subject over sender; search as the board's input, in the query string with the filters
**Chrome:** §1's page

**Build order:**

1. Wait for D01 T01 §16 (the checks lane: the original's subject and sender stored on the case, migration 0038) to reach main and this branch, then add it to this section's Depends with its XREF. Done when: `validate` accepts the edge.
2. Add the folded search column and its writers: the migration the coordinator numbers, `src/db/case-search.ts`, and the writes in `src/db/cases.ts`. Done when: `test/web/cases-page.test.ts` finds "CAFÉ" by "cafe".
3. Read the stored fields and the search in `src/db/case-list.ts` `listCases`. Done when: `test/web/cases-page.test.ts` reads them through `listCases` and the page.
4. Draw the two-line cell, the search input and the uploader in `src/web/pages/cases-view.tsx`. Done when: `test/web/cases-page.test.ts` reads each on the rendered page and `test/node/cases-browser.test.tsx` drives the search in Chromium.

- [x] Add D01 T01 §16 to this section's Depends once it is on main and merged here. Done when: `validate` accepts the edge. Evidence 2026-10-30: D01 T01 §16 (the original's subject and sender, migration 0038) and D01 T03 §11 (`uploaded_by`, migration 0039) are stamped on main, merged here at 5731f56, and both are in the Depends column; `validate` accepts them.
- [x] Add `q` to `CaseFilters` and `filtersFrom` in `src/db/case-filters.ts`: trimmed, inner whitespace collapsed, at most 100 characters, empty the default; `casesHref` in `src/web/pages/cases-view.tsx` keeps it in the address. Done when: the test reads `filtersFrom` of a 300-character `q` as its first 100 characters and `casesHref` round-trips `q`. Cheaper substitute: a search held only in the input and lost on the pager, Back or a reload.
- [x] Add `searchText(fields)` in `src/db/case-search.ts`: the subject, sender name, sender address and upload name joined by newlines, Unicode NFKD, combining marks removed, `toLowerCase()`, at most 1,100 characters; `q` is folded by the same function. Done when: a node test reads "CAFÉ Zoë" folded to "cafe zoe" and a `%` kept as itself. Cheaper substitute: SQLite `lower()`, which leaves "É" as it is.
- [x] Add the `search_text` column to `cases` in the migration the coordinator numbers (`src/db/migrations/<NNNN>_case_search_text.sql`), nullable, bounded by a `CHECK` on its length. Done when: the local migrations apply and `PRAGMA table_info(cases)` lists it. Cheaper substitute: a view or a column computed by SQLite, which cannot fold Unicode.
- [x] Write `search_text` with `searchText` at each write of the fields it covers in `src/db/cases.ts`: the two case inserts (`upload_name`) and `setOriginalHeader` (subject and sender). Done when: the test reads `search_text` set on a new upload and after `setOriginalHeader`. Cheaper substitute: computing it only in the list's read.
- [x] Refill the rows stored before the column with `refreshSearchText(db, limit)` in `src/db/case-search.ts`, 200 rows a pass where `search_text IS NULL` and a covered field is stored, called from the 15-minute schedule in `src/index.ts` `scheduled()`. Done when: the test reads an old row refilled by one pass and a second pass changing nothing. Cheaper substitute: a SQL `lower()` backfill in the migration.
- [x] Filter `listCases` by the folded `q` as a bound substring of `search_text` (`instr(c.search_text, ?)`), never a `LIKE` pattern, inside the `org_id = ?` clause, so the matching count, the page count and the rows all honour it with the verdict, channel and period. Done when: the test finds a case by a subject word, a sender address, a sender name, an upload's file name and "cafe" for "CAFÉ", finds a `%` or `_` literally, and never returns another organisation's case with the same subject. Cheaper substitute: filtering the 25 rows of one page in the view, or a `LIKE` that reads `%` as any text.
- [x] Prove paging and combined filters over a search: 30 matching cases and 5 that do not, in two verdicts. Done when: the test reads "Showing 1 to 25 of 30" and "Showing 26 to 30 of 30" with `q` in both pager addresses, the count narrowed by a verdict to its share, and a changed search answering page 1. Cheaper substitute: a count query that ignores `q`.
- [x] Return `subject`, `senderName`, `senderAddress`, `uploadName` and `uploadMediaType` on `ListedCase` from `listCases`. Done when: the test reads each from a stored case. Cheaper substitute: a second query per row.
- [x] Draw the Case cell as the board's two lines in `Rows` (table and phone card): an email's subject (or "No subject" when only a sender is stored) over the sender's address (the name when no address is stored); an email with neither stored keeps "Forwarded email"; an upload's file name over "Uploaded PDF", "Uploaded document", "Uploaded image" or "Uploaded voice note" from its media type and kind, and "Uploaded PDF" and the like alone when no name is stored. Source: board `Cases` column "Subject and sender". Done when: the page test reads a subject and its sender in one row, "No subject" over a sender, and an upload's file name over "Uploaded PDF". Cheaper substitute: the subject alone, or the sender's name and address run together on one line.
- [x] Rename the Case column header "Subject and sender" as the board names it. Done when: the page test reads the header. Cheaper substitute: none (one word change).
- [x] Draw the search input in `Filters` before the verdict control: `type="search"`, `name="q"`, `id="case-search"`, placeholder "Search by sender or subject", a visually hidden label "Search cases", a magnifier icon, its value the current `q`; with htmx it redraws the results 300 ms after typing stops and on Enter; without JavaScript Enter or Apply submits the GET form. Source: board `Cases` search box. Done when: the page test reads the input with its value from the address, and an htmx request with `q` returns only the matching rows. Cheaper substitute: a search box with no label, or one that sends a request on every keystroke without the delay.
- [x] Drive the search in Chromium in `test/node/cases-browser.test.tsx`: typing redraws the results once after the delay with `q` in the address, focus staying in the input; Enter searches at once; clearing the box restores the full list; a slow earlier search never overwrites a newer one; Back and a reload show the search and its results; without JavaScript Enter submits the form. Done when: each scenario passes in the browser test. Cheaper substitute: requesting `?q=` directly, which never exercises the input.
- [x] Add the search input and the two-line rows to the browser test's accessibility scans at phone and desktop widths in both themes. Done when: the scans pass with the input and a two-line row on the page. Cheaper substitute: scanning only the page without a search.
- [x] Name the search in the filtered-empty heading ("No cases match "invoice", last 30 days.") and keep Clear filters clearing it. Done when: the page test reads the search words in the heading and Clear filters' address has no `q`. Cheaper substitute: the generic heading that hides why nothing matched.
- [x] Read the uploader in `listCases`: an upload's `uploaded_by` matched to a member of the organisation by user id, their name, else their email; "Former member" when `uploaded_by` names no member of the organisation now; null (drawn "Not recorded") only when `uploaded_by` is null, an upload from before migration 0039. Source: `checkerName` in `src/db/case-list.ts`, the same member rule. Done when: the page test reads a member's name on an upload, "Former member" for an uploader who left, "Not recorded" for an upload without `uploaded_by`, and never a name of a user outside the organisation. Cheaper substitute: the raw user id, or "Not recorded" for every upload.
- [x] Commit: `web: subject, sender and search in the cases list`

> **Deferred:** the invoice and payment-document words in Type ("Email, invoice", "Payment document") -> XREF: D07 T04 §13

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` and `pnpm exec vitest run --project node test/node/cases-browser.test.tsx` pass, and fail if a search returns another organisation's case, a `%` in the search matches every case, "cafe" misses "CAFÉ", or typing in the search box redraws nothing.

> **Verified:** 2026-10-31 | §7 | aa6143fac032a2930bf0a4fff4f74bac38b77102
> **Review:** `docs/reviews/d07-t04-s7.json`

## 8. A chosen date range in the Cases list

A member looking for a check from a known week picks its dates instead of paging through a fixed period. Filed 2026-10-30 from D07 T04 §1's completion review (excellence item 2): the board `Cases` offers only fixed periods, so the control is a design change first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, once the operator approves a board change adding the date range
**Job:** a member finds the checks of a known week or month in one step
**Treatment:** a From and To date beside the period filter, in the query string with the other filters
**Chrome:** §1's filters

**Build order:**

1. Draw the date range on the board `Cases` and have the operator approve it. Done when: `design/SPEC.md` M1 lists the control.
2. Build it into §1's filters and `src/db/case-list.ts`. Done when: `test/web/cases-page.test.ts` filters by a range.

- [ ] Add the date range to the board and SPEC M1 with the operator's approval. Done when: `design/SPEC.md` M1 names it.
- [ ] Filter `listCases` by a From and To date (SAST days, inclusive) and draw the control. Done when: `test/web/cases-page.test.ts` reads a range's cases only.
- [ ] Commit: `web: a chosen date range in the cases list`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if a case outside the range is listed.

## 9. Next and previous case from a report

A member reviewing a filtered run of cases steps from one report to the next without going back to the list. Filed 2026-10-30 from D07 T04 §1's completion review (excellence item 3): the board `Main` (M3) has no such control, so the control is a design change first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 Report, once the operator approves a board change adding the step controls
**Job:** a member works through a filtered list of reports in order
**Treatment:** Previous and Next on the report, keeping the list's filters
**Chrome:** D07 T03 §1's report

**Build order:**

1. Draw the controls on the report board and have the operator approve them. Done when: `design/SPEC.md` M3 lists them.
2. Carry the list's filters to the report and step through them. Done when: `test/web/report-access.test.ts` steps to the next case under a filter.

- [ ] Add Previous and Next to the report board and SPEC M3 with the operator's approval. Done when: `design/SPEC.md` M3 names them.
- [ ] Carry the filters from `/cases` to `/r/<id>` and answer Previous and Next within them, scoped by the organisation. Done when: `test/web/report-access.test.ts` steps to the next filtered case and never to another organisation's.
- [ ] Commit: `web: next and previous case from a report`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts` passes and fails if a step leaves the filter or the organisation.

## 10. A Checked by filter in the Cases list

A member narrows the list to the cases one colleague checked. Filed 2026-10-30 at the checks lane's suggestion (D01 T03 §11's completion review, through the coordinator): the board `Cases` has no such filter, so the control is a design change first; it waits on §7 so an upload names its uploader.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, once the operator approves a board change adding the filter
**Job:** a member reviews what one colleague has checked
**Treatment:** a Checked by select beside the channel filter (Everyone, then each member), in the query string with the other filters
**Chrome:** §1's filters

**Build order:**

1. Draw the filter on the board `Cases` and have the operator approve it. Done when: `design/SPEC.md` M1 lists the control.
2. Filter `listCases` by the member (their forwarding address for email, their user id for an upload) and draw the select. Done when: `test/web/cases-page.test.ts` filters by a member.

- [ ] Add the Checked by filter to the board and SPEC M1 with the operator's approval. Done when: `design/SPEC.md` M1 names it.
- [ ] Filter `src/db/case-list.ts` by one member of the organisation, refusing a member of another, and draw the select with the organisation's members. Done when: `test/web/cases-page.test.ts` lists only that member's cases and never another organisation's.
- [ ] Commit: `web: a checked by filter in the cases list`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if the filter lists a case another member checked.

## 11. DNS help for each provider on the domain page

An owner who does not know where their DNS lives reaches the steps for their provider in one action from the domain page: where the TXT record goes, what the provider calls Name (host, `@`, or the whole name), the value, TTL, and what to do when Check now still finds nothing. Filed 2026-10-30 from D07 T02 §15's completion review (excellence item 2, against Microsoft 365's domain setup): the board `Verify-Domain` has no help entry, so it is a design change first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` A5 Verify a domain, once the operator approves a board change adding the help entry
**Job:** an owner adds the TXT record at their own DNS provider without searching for how
**Treatment:** a "How do I add this at my provider?" entry beside the record, opening steps for the common South African and global providers, with propagation troubleshooting
**Chrome:** D07 T02 §15's page

**Build order:**

1. Draw the help entry on the board `Verify-Domain` and have the operator approve it. Done when: `design/SPEC.md` A5 lists the control.
2. Write and test the steps for each provider named. Done when: `test/web/domains-page.test.ts` opens each provider's steps from the page.

- [ ] Add the help entry to the board and SPEC A5 with the operator's approval, naming the providers covered. Done when: `design/SPEC.md` A5 names it and the providers.
- [ ] Write each provider's steps (where the record goes, what its Name field expects, TTL, propagation and troubleshooting), checked against that provider, and draw them from the page. Done when: `test/web/domains-page.test.ts` reaches each provider's steps in one action and reads the Name each expects.
- [ ] Commit: `web: dns help for each provider on the domain page`

**Test checkpoint:** `pnpm exec vitest run test/web/domains-page.test.ts` passes and fails if a provider's steps name the wrong field for the record's name.

## 12. Remove a case checked by mistake

**Corrected 2026-10-31:** two live accounts are protected (operator, 2026-10-31, through the coordinator): demo@rizonetech.com in Fynbos Freight (`ZF5SufztotybeXIWVncExFAVu9GYZ8Fu`) and derick@rizonetech.com. No removal path deletes, resets or bulk-cleans either account, its organisation or its cases; the removal built here skips them, with a test.

Filed 2026-10-31 from D01 T03 §6's completion review (out-of-scope excellence item). A member who uploads the wrong file, or a private one by mistake, has no way to remove it: the case, its stored file and its evidence stay until the 30-day retention. VirusTotal Private Scanning lets its users delete a file alone or the file and its report. Whether a member may delete, who in the organisation may, and what is kept for audit are the operator's to decide; the stored objects are D01's (the checks lane), asked through the coordinator.

**Phase:** 6
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases and M3 Report, a removal confirmation added to the boards
**Job:** a member undoes a check they did not mean to make
**Treatment:** Remove on the report and in the Cases list's row, one confirmation, said once when done
**Chrome:** `Button`, the confirmation dialog (D07 T01 §6)

**Build order:**

1. Record the decision. Done when: who may remove, what is kept for audit and the window are recorded here.
2. Remove a case. Done when: a removed case's file, evidence and report are gone and its link answers 410.

- [ ] Record the operator's decision on who may remove a case, within what time, and what is kept for audit (a row naming who removed what and when, never the file). Done when: a dated **Decided:** line here names them and the `owner-decision` Need is removed.
- [ ] Add Remove to the report and the Cases list's row, behind one confirmation naming the case, for the members the decision allows. Done when: `test/web/report-access.test.ts` and `test/web/cases-page.test.ts` find it for an allowed member only. Cheaper substitute: asking the operator by email.
- [ ] Remove the case's stored objects, evidence and report through D01's storage (asked of the checks lane through the coordinator), keeping the audit row, and answer the case's report and signed links with 410 afterwards. Done when: the test removes a case and finds no object under `raw/<case>/` or `art/<case>/`, no evidence row, the audit row, and 410 from both links.
- [ ] Commit: `web: remove a case checked by mistake`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts test/web/cases-page.test.ts` passes with a case removed and its links answering 410.

## 13. Invoice and payment-document words in Type

The Type column's "Email, invoice" and "Payment document" words, as the board `Cases` draws them, read from the invoice checks' stored classification once it exists. Filed 2026-10-31 from D07 T04 §7's start, where no classification is stored yet.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases (board `Cases`)
**Job:** a member sees at a glance which checks were invoices or payment documents
**Treatment:** the board's Type words, "Email, invoice" for an email carrying an invoice and "Payment document" for an uploaded proof of payment or bank letter
**Chrome:** §1's page

**Build order:**

1. Read where D06 T01 §1 and D06 T02 §3 (D06 T02 §3 waits on D06 T01 §1 through D06 T02 §2) store a case's invoice and payment-document classification once both are merged here. Done when: the column or table is named in this section with a `**Corrected:**` note.
2. Draw the words in `src/web/pages/cases-view.tsx` `TYPE_WORDS` from that classification. Done when: `test/web/cases-page.test.ts` reads each.

- [ ] Return the stored classification on `ListedCase` from `listCases` in `src/db/case-list.ts`, scoped by the organisation. Done when: the test reads it from a stored invoice case. Cheaper substitute: guessing from the file name.
- [ ] Draw "Email, invoice" for an email whose classification is an invoice, in the table and the phone card. Source: board `Cases` Type column. Done when: the page test reads "Email, invoice". Cheaper substitute: "Invoice" alone, dropping the channel.
- [ ] Draw "Payment document" for an upload classified as a proof of payment or bank letter. Source: board `Cases` Type column. Done when: the page test reads "Payment document". Cheaper substitute: "Document" for every PDF.
- [ ] Commit: `web: invoice and payment-document words in the cases list`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if an unclassified document reads "Payment document".

## 14. Multi-word search in the Cases list

A member who remembers "Remittance 4471", or a sender and a subject word, finds the case in one search: every word must match, in any order, across the subject, sender and file name. Filed 2026-10-31 from D07 T04 §7's completion review (G4): §7 matches the words as one contiguous run within one field.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases (board `Cases`)
**Job:** a member finds a case from the scraps they remember, in one search
**Treatment:** the same search box; only what it matches changes
**Chrome:** §1's page

**Build order:**

1. Split the folded words on spaces in `src/db/case-list.ts` `listCases` and require each as a substring of the case's search text. Done when: `test/web/cases-page.test.ts` finds "Remittance advice 4471" by "remittance 4471".

- [ ] Split `fold(q)` into at most 8 words in `listCases`, each a bound `instr(...) > 0` term joined by AND, scoped by the organisation. Done when: the page test finds a case by "remittance 4471", by a sender word with a subject word, and never by a word it lacks. Cheaper substitute: OR across the words, which floods the list.
- [ ] Keep a quoted phrase ("advice 4471") as one contiguous run. Done when: the page test reads a quoted phrase matching only the contiguous text. Cheaper substitute: dropping the quotes and splitting the phrase.
- [ ] Commit: `web: every search word matched, in any order`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if a search word the case lacks still finds it.

## 15. Slash shortcut to the Cases search

A member presses `/` anywhere on the Cases list, outside a text field, and lands in the search box, as Gmail and GitHub let them. Filed 2026-10-31 from D07 T04 §7's completion review (G5): the board shows no shortcut or its hint, so the shortcut and how it is discovered are a design decision first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases (board `Cases`), once the SPEC records the shortcut and its hint
**Job:** a keyboard user reaches the search in one keystroke
**Treatment:** the search box's placeholder or a hint names the key; the key never fires while typing in a field
**Chrome:** §1's page

**Build order:**

1. Record the owner's decision (the key, its hint) as a SPEC M1 change. Done when: `design/SPEC.md` M1 names the shortcut.
2. Focus `#case-search` on `/` in `src/web/client/app.ts`. Done when: `test/node/cases-browser.test.tsx` reads focus moved by the key and text typed in a field untouched.

- [ ] Record the owner's decision on the key and its hint in `design/SPEC.md` M1. Done when: the SPEC names both. Cheaper substitute: a shortcut nobody can discover.
- [ ] Focus `#case-search` on `/` outside editable controls, in `src/web/client/app.ts`. Done when: the browser test reads focus in the box after `/`, and a `/` typed in the search box or another field stays text. Cheaper substitute: a key handler that swallows `/` in fields.
- [ ] Commit: `web: slash focuses the cases search`

**Test checkpoint:** `pnpm exec vitest run --project node test/node/cases-browser.test.tsx` passes and fails if `/` typed in a field is swallowed.

## 16. Live Cases search latency vs Gmail

The Cases search's speed on a phone against production D1, measured, and compared with finding the same message in Gmail. Filed 2026-10-31 from D07 T04 §7's completion review (G6): §7 measured 10,000 cases in the local Worker test (15 ms for a hit, 5 ms for a miss), not a deployed tenant on a phone.

**Phase:** 7
**Needs:** attended
**Surface:** no

**Build order:**

1. Ask the coordinator to seed a demo organisation with 10,000 cases on the deployed Worker (a production write, theirs), then time the search from a phone. The seed goes into a separate demo organisation, never Fynbos Freight (`ZF5SufztotybeXIWVncExFAVu9GYZ8Fu`) or the operator's test account, which are protected (operator, 2026-10-31). Done when: the measurement is recorded in `docs/evidence/` with the p95.

- [ ] Time typing-to-results for a hit and an all-time miss on the deployed Worker with a 10,000-case demo organisation, at a mobile network profile, 20 runs each. Done when: `docs/evidence/case-search-latency.md` records each p95, under one second including the 300 ms pause.
- [ ] Time the same retrieval in Gmail on the same phone. Done when: the evidence file records Gmail's time beside ours.
- [ ] Commit: `docs: live case search latency against Gmail`

**Test checkpoint:** `test -s docs/evidence/case-search-latency.md && grep -q "p95" docs/evidence/case-search-latency.md` passes and fails while the measurement is missing.

## 17. Money at risk caught tile

The board's third tile: the rand total of this week's invoices whose bank details changed and were caught, with "N invoices with changed bank details" under it. Filed 2026-10-31 from D07 T04 §2's start, where no flagged invoice amount is stored yet.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, stats panel (board `Cases`)
**Job:** an owner sees the money IsItLegit kept from going to a fraudster this week
**Treatment:** the board's tile, the amount in rand with thousands separators, the invoice count under it
**Chrome:** §2's stats panel

**Build order:**

1. Read where D06 T01 §3 stores a flagged invoice's amount once it is merged here. Done when: this section names the column with a `**Corrected:**` note.
2. Add the tile to §2's panel. Done when: `test/web/stats.test.ts` reads it.

- [ ] Sum this week's flagged invoice amounts in cents in `weeklyStats` in `src/db/case-stats.ts`, scoped by the organisation. Done when: the test reads the sum and count from seeded flags. Cheaper substitute: summing every invoice, flagged or not.
- [ ] Draw the tile in rand ("R184,300"), with "N invoices with changed bank details", between Malicious or suspicious and Median time. Source: board `Cases`. Done when: the page test reads both lines. Cheaper substitute: cents shown raw.
- [ ] Add `money_at_risk_cents` to the CSV. Done when: the test reads the column. Cheaper substitute: none.
- [ ] Commit: `web: money at risk caught tile`

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if an unflagged invoice's amount is counted.

## 18. Threat kinds under Malicious or suspicious

The line under the board's Malicious or suspicious tile ("5 phishing, 3 invoice, 1 impersonation"): each flagged case's kind, counted. Filed 2026-10-31 from D07 T04 §2's start: no check stores a case-level kind and no spec defines the set, so which kinds and which evidence decides each is the owner's decision first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, stats panel (board `Cases`)
**Job:** an owner sees what kind of attacks reached the business this week
**Treatment:** the board's muted line under the number, kinds in descending count
**Chrome:** §2's stats panel

**Build order:**

1. Record the owner's set of kinds and the rule deciding each (from the verdict's evidence) in `design/SPEC.md` M1. Done when: the SPEC names both.
2. Count them in `weeklyStats` and draw the line. Done when: `test/web/stats.test.ts` reads it.

- [ ] Record the owner's kinds and their deciding evidence in `design/SPEC.md` M1. Done when: the SPEC names both. Cheaper substitute: kinds guessed from subject words.
- [ ] Count this week's malicious and suspicious cases by kind in `src/db/case-stats.ts`. Done when: the test reads the counts from seeded evidence. Cheaper substitute: one kind per case read from the headline text.
- [ ] Draw the line under the tile, kinds in descending count. Source: board `Cases`. Done when: the page test reads "5 phishing, 3 invoice, 1 impersonation" from a seeded week. Cheaper substitute: none.
- [ ] Commit: `web: threat kinds under malicious or suspicious`

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if a safe case is counted in a kind.

## 19. Chosen reporting period for the counts export

An owner exports exactly a calendar month or quarter of counts, without trimming the 12-week CSV by hand. Filed 2026-10-31 from D07 T04 §2's completion review (out-of-scope 1): the board offers one Export link, so a period control is a design change first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, stats panel, once the SPEC records the period control
**Job:** an owner hands a month's or a quarter's numbers to the business without spreadsheet work
**Treatment:** the one-press 12-week export stays the default; a period choice sits beside it
**Chrome:** §2's stats panel

**Build order:**

1. Record the owner's decision on the periods offered and the control in `design/SPEC.md` M1. Done when: the SPEC names both.
2. Take the period in `GET /cases/stats.csv` in `src/web/pages/cases.tsx`. Done when: `test/web/stats.test.ts` reads a month's rows only.

- [ ] Record the owner's periods and control in `design/SPEC.md` M1. Done when: the SPEC names both. Cheaper substitute: free date fields with no validation.
- [ ] Take `from` and `to` SAST dates in `GET /cases/stats.csv`, bounded to 2 years, one row per week or per day as the SPEC says. Done when: the test reads October 2026's rows only, and a reversed or unbounded range refused with the 400 page. Cheaper substitute: filtering the 12-week rows.
- [ ] Commit: `web: chosen period for the counts export`

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if a row outside the period is exported.

## 20. Opt-in weekly counts report by email

An owner who opts in receives the week's counts by email every Monday, with a one-step unsubscribe, instead of visiting Cases to export them. Filed 2026-10-31 from D07 T04 §2's completion review (out-of-scope 2): the console's Adjacency declares it sends nothing, so a recurring report is an owner decision first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` notifications, once the SPEC records the weekly report
**Job:** an owner sees the week's protection numbers without opening the console
**Treatment:** a plain email of the three tiles' numbers and a link to Cases, never message content
**Chrome:** the transactional email layout

**Build order:**

1. Record the owner's decision (who may opt in, the day and hour, the content) in `design/SPEC.md`. Done when: the SPEC names each.
2. Send it from the 15-minute schedule through the existing mail sender. Done when: a test reads one send per opted-in owner per week.

- [ ] Record the owner's decision on the weekly report in `design/SPEC.md`. Done when: the SPEC names who, when and what. Cheaper substitute: a report sent to every member unasked.
- [ ] Store the opt-in per member with a timestamp, set and cleared from Account settings. Done when: a test reads it set and cleared. Cheaper substitute: an organisation-wide flag.
- [ ] Send Monday's report once per opted-in member from the schedule, idempotent per week, a failed send retried by the mail sender. Done when: a test reads one send per member per week, none after an unsubscribe. Cheaper substitute: a send on every schedule tick.
- [ ] Commit: `mail: opt-in weekly counts report`

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if an unsubscribed member is sent the report.

## 21. Invitations panel on the Team page

The board's invite panel (an email and a role, Send invitation) and its Pending invitations table (Email, Role, Sent by whom, Expires, Resend and Revoke), with an invite whose email did not go marked and sent again. Moved 2026-10-31 from §3, which bundled it.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team (board `Team`)
**Job:** an owner or admin brings a colleague in and sees who has not joined yet
**Treatment:** the board's panel above the members and the pending table under them
**Chrome:** §3's page

**Build order:**

1. Draw the panel and the pending table in `src/web/pages/team-view.tsx` and post invites, resends and revokes through Better Auth's endpoints in process. Done when: `test/web/team-page.test.ts` reads each action made.

- [ ] Draw the invite panel for owners and admins (Invite by email, Role with Member default, Send invitation) and post it through `auth.api.createInvitation` in process (D07 T02 §3's allowlist and send key), 303 back with "Invitation sent to <address>". Source: board `Team`. Done when: the page test reads the invitation stored and its send recorded. Cheaper substitute: inserting the invitation row directly.
- [ ] Draw Pending invitations (Email, Role, "Today 09:02 by Thandi N.", Expires in SAST, Resend, Revoke) for owners and admins, and nothing of them for a member. Source: board `Team`. Done when: the page test reads each column. Cheaper substitute: the invitation ids.
- [ ] Resend through the invite request with `resend: true` and Revoke through `auth.api.cancelInvitation`, each confirmed in words after. Done when: the test reads a resend recorded and a revoked invitation gone from the table and refused at `/invite/:id`. Cheaper substitute: revoke hiding the row only.
- [ ] Mark an invite answered 502 (D07 T02 §3) "email not sent" in the pending table with Send again, which resends and clears the mark on 200. Done when: `test/web/team-page.test.ts` gets a 502, reads the mark and the button by name, and a 200 resend clears it. Cheaper substitute: a toast with the invite gone. Source: D07 T02 §3 plan review (P2 3).
- [ ] Draw the panel's refusals (an address the allowlist refuses, an existing member, the daily invite limit) as the field's error, the address kept. Done when: the test reads each refusal under the field. Cheaper substitute: the 403 page.
- [ ] Commit: `web: invitations on the team page`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if a revoked invitation can still be accepted.

## 22. Invite several colleagues at once

One submit invites several addresses with one shared role, each address's outcome listed and only the failed ones retried. Moved 2026-10-31 from §3; a SPEC change to the board `Team` first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, once the SPEC records the multi-address invite
**Job:** an owner brings a whole office in at once
**Treatment:** the invite field takes several addresses; the outcome lists each
**Chrome:** §21's panel

**Build order:**

1. Record the owner's decision on the multi-address invite in `design/SPEC.md` M7. Done when: the SPEC names it.
2. Send one invite request per address. Done when: `test/web/team-page.test.ts` reads ten outcomes.

- [ ] Record the multi-address invite (separator, limit, outcome list) in `design/SPEC.md` M7. Done when: the SPEC names each. Cheaper substitute: a comma-separated field with one result.
- [ ] Invite each address through its own request (the allowlist and its own send key, D07 T02 §3) and list each outcome (sent, not sent, unknown, refused), retrying only the ones that did not go. Done when: `test/web/team-page.test.ts` invites ten addresses with one submit, one refused by SMTP2GO, reads ten outcomes, and a retry sends only that one. Cheaper substitute: one request with a single overall result. Source: D07 T02 §3 completion review (Part 2 item 2).
- [ ] Commit: `web: invite several colleagues at once`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if a retry resends an address that went.

## 23. Team history for owners

The organisation's role changes, revocations and removals (D07 T02 §6's owner-only read), newest first, filtered by action and date, on the Team page for owners. Moved 2026-10-31 from §3; no board draws it, so a SPEC change first.

**Phase:** 7
**Needs:** owner-decision
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, once the SPEC records the history
**Job:** an owner sees who changed what on the team, and when
**Treatment:** a history table under the pending invitations, owners only
**Chrome:** §3's page

**Build order:**

1. Record the history's place and filters in `design/SPEC.md` M7. Done when: the SPEC names them.
2. Draw it from `GET /api/team/history` (D07 T02 §6). Done when: a rendered test reads it filtered.

- [ ] Record the team history in `design/SPEC.md` M7 (place, columns, filters, empty and error states). Done when: the SPEC names each. Cheaper substitute: the raw audit rows.
- [ ] Draw the history newest first, filtered by action and date, its empty and error states, for owners only. Done when: a rendered test shows it filtered, empty and failed, and an admin sees none. Cheaper substitute: history for every role. Source: D07 T02 §6 plan review.
- [ ] Commit: `web: team history for owners`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if an admin sees the history.

## 24. Team history by person

Filter the team history by one person, as the actor or the target, in one step, paging through every match. Moved 2026-10-31 from §3.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, as §23 records it
**Job:** an owner sees everything one person did or had done to them on the team
**Treatment:** a person filter beside §23's filters
**Chrome:** §23's history

**Build order:**

1. Add `actor` and `target` to `GET /api/team/history` and a person filter to the history. Done when: a rendered test pages through one person's changes.

- [ ] Add `actor` and `target` to `GET /api/team/history` (D07 T02 §6) and a person filter, paging through every match. Done when: a rendered test picks a member and reads every change by and to them across pages. Cheaper substitute: filtering one page in the browser. Source: D07 T02 §6 completion review (E2).
- [ ] Commit: `web: team history by person`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if another person's change appears under the filter.

## Verification

- A member finds cases, reads stats and exports counts; owners manage team and domains, with permissions enforced on the server.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
