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
| 3 | §3 | Team and invites page | D07 T02 §3, D07 T01 §10 | [x] |
| 4 | §4 | Domains and sending addresses page | D07 T02 §15 | [x] |
| 5 | §5 | Registrar-assisted domain verification | §4 | [ ] |
| 6 | §6 | MSP console and own branding | D07 T02 §8 | [ ] |
| 7 | §7 | Subject, sender and search in the Cases list | §1, D01 T01 §16, D01 T03 §11 | [x] |
| 8 | §8 | A chosen date range in the | §1 | [x] |
| 9 | §9 | Next and previous case | §1, D07 T03 §1 | [x] |
| 10 | §10 | A Checked by filter in the | §7 | [x] |
| 11 | §11 | DNS help per provider | D07 T02 §15 | [x] |
| 12 | §12 | Remove a case checked by mistake | §1 | [ ] |
| 13 | §13 | Invoice and payment-document words in Type | §7, D06 T02 §3 | [x] |
| 14 | §14 | Multi-word search in the Cases list | §7 | [x] |
| 15 | §15 | Slash shortcut to the | §7 | [x] |
| 16 | §16 | Live Cases search latency vs Gmail | §7 | [ ] |
| 17 | §17 | Money at risk caught tile | §2, D06 T01 §3 | [ ] |
| 18 | §18 | Threat kinds under Malicious | §2 | [x] |
| 19 | §19 | Chosen reporting period for the | §2 | [x] |
| 20 | §20 | Opt-in weekly counts | §2 | [ ] |
| 21 | §21 | Invitations panel on the Team page | §3 | [x] |
| 22 | §22 | Invite several colleagues at once | §21 | [x] |
| 23 | §23 | Team history for owners | §3 | [x] |
| 24 | §24 | Team history by person | §23 | [x] |
| 25 | §25 | Protected accounts refused on the Team page | §3 | [x] |
| 26 | §26 | Find a person on the Team page | §3 | [x] |
| 27 | §27 | Add a single address and verify it by code | §4 | [x] |
| 28 | §28 | Verifier's name on the Domains page | §4 | [x] |
| 29 | §29 | Verifier detail on the Domains page | §28 | [x] |
| 30 | §30 | Calendar month and quarter ranges in the Cases list | §8 | [ ] |
| 31 | §31 | Saved Cases views | §8 | [ ] |
| 32 | §32 | Searchable Checked by picker | §10 | [ ] |
| 33 | §33 | Suggest the DNS host's own guide | §11 | [ ] |
| 34 | §34 | Exact calendar-period counts export | §19 | [x] |
| 35 | §35 | Phone forwarding guidance on the Cases page | §1 | [ ] |
| 36 | §36 | Choose a departed person in the team history | §23 | [ ] |
| 37 | §37 | Gateway relay range settings | §4 | [ ] |

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
> **Resolved:** the kinds line under Malicious or suspicious -> XREF: D07 T04 §18

**Corrected 2026-10-31:** `GET /cases/stats.csv` was answered 404 by the report's `GET /cases/:caseId`, which claimed any word as a case id; with the coordinator's approval the report route now claims only a ULID (`src/web/pages/report.tsx`), and any other `/cases/<x>` is the same 404 page from `src/web/pages/cases.tsx` without a read (`test/web/stats.test.ts` "/cases/<x> routing").

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` and `pnpm exec vitest run --project node test/node/cases-browser.test.tsx` pass, and fail if the CSV includes subjects or another organisation's counts, or `/cases/stats.csv` is read as a case.

> **Verified:** 2026-10-31 | §2 | 57a9c9fa51be5b9f75ad63d4ca7da18f622b0e74
> **Review:** `docs/reviews/d07-t04-s2.json`

## 3. Team and invites page

> **Started:** 2026-10-31T16:24:34Z

Owners and admins invite by email, change roles and remove members; members see the team (spec 4.8, D07 T02 §3).

**Corrected 2026-10-31:** the section bundled five capabilities, two of them (team history, and inviting several addresses at once) not on the board `Team` yet. Split by single responsibility: this section is the Team page with its members (the table, role changes, removal, the last-owner guard); the invitations panel (invite, pending, Resend, Revoke, the "email not sent" mark) moved to §21; inviting several addresses at once to §22 (a SPEC change first, as it already said); the owners' team history to §23 and filtering it by one person to §24 (no board draws history, so a SPEC change first). Two live accounts are protected (operator, 2026-10-31): demo@rizonetech.com in Fynbos Freight and derick@rizonetech.com are never removed from their organisations; the refusal belongs to the remove-member path in `src/auth/auth.ts` (D07 T02, the app lane's file, asked through the coordinator), and this page draws it.

**Corrected 2026-10-31 (plan review, `docs/reviews/07-app/D07-T04-s3.md`):** seven gaps closed before the build. (1) The protected-account refusal waits on the app lane's change to `src/auth/auth.ts`, so drawing it moved to §25, which names that wait; this section ships nothing that depends on it. (2) A change runs Better Auth's own HTTP handler (`auth.handler`) with a request built from the member's (their cookie, the app's origin), never `auth.api` without a request, so D07 T02's hooks run whole: the member lock and the previous role (`src/auth/auth.ts`, update-member-role, which needs `ctx.request`), the audit and their cleanup on a throw. (3) Each control follows Better Auth's rule per actor and target: an owner changes and removes anyone but themselves while another owner remains; an admin changes and removes members and admins only, offered Admin and Member only, an owner's row read-only with its reason. (4) Every refusal and failure of a change is drawn as what happened, read back from the stored state, never as done. (5) Removal carries the same origin and drawn-organisation checks as a role change, through the dialog or its page. (6) The no-JavaScript paths are proven in Chromium. (7) Last active is the member's newest session's last refresh (`session.updatedAt`, which Better Auth renews about once a day of use), in SAST words, and "No recent sign-in" when they have no session.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team (board `Team`)
**Job:** an owner brings the finance clerk in and removes someone who left
**Treatment:** the board's one members table, a role select per member, Remove confirmed, the guard notice under the table
**Chrome:** `AppShell` with Team active, `Button`, the shared select and focus styles from D07 T01

**Build order:**

1. Draw `GET /team` from the organisation's members in `src/web/pages/team.tsx` and `src/web/pages/team-view.tsx`. Done when: `test/web/team-page.test.ts` reads the table.
2. Take role changes and removals as posts to `/team` that run Better Auth's HTTP handler with a request built from the member's, so D07 T02's hooks (member lock, previous role, audit, sessions ended, last owner) hold. Done when: the test reads each change made and recorded.

- [x] Draw `GET /team` behind the session gate and the active organisation: heading "Team", "People at <organisation> who can check mail and see cases", and the members table (Name with "You" on the reader's row, Email, Role, Last active from the member's newest session's `updatedAt` in SAST words ("Now" within five minutes, the time today, "Yesterday", the day, with the year when not this year's; "No recent sign-in" with no session), a Remove button), newest-joined last as the board orders it; the sign-in, 403 and 503 pages as the Cases list answers them. Source: board `Team`. Done when: `test/web/team-page.test.ts` reads every member of the organisation and none of another's, a member with two sessions read by the newer, one with none read "No recent sign-in", and a session at 23:59 SAST read "Yesterday" the next day. Cheaper substitute: a table of user ids, or the membership's joining date as "Last active".
- [x] Draw the role descriptions line under the invite panel's place ("Owner: everything, including the plan and removing people. Admin: suppliers, protection, domains and invites. Member: checks mail and sees cases."). Source: board `Team`. Done when: the page test reads it. Cheaper substitute: none.
- [x] Draw each row's controls by Better Auth's rule for the reader and the target: an owner gets a select of Owner, Admin and Member and a Remove on every other member's row; an admin gets a select of Admin and Member and a Remove on Member and Admin rows only, and an owner's row read-only with "Only an owner can change an owner" as the Remove button's description; a member gets no selects or Remove; the reader's own row a pill. Done when: the page test reads the exact options and buttons an owner, an admin and a member each get on owner, admin and member rows. Cheaper substitute: selects for everyone that the API then refuses.
- [x] Change a role by posting `/team` with the member and role, from the app's origin and naming the organisation the page was drawn for, through `auth.handler` on a request to `/auth/organization/update-member-role` carrying the member's cookie and the app's origin, then 303 back to `/team` with the outcome; with htmx the select's change posts at once, without JavaScript a Save button beside it. Done when: the test reads the role changed and its `auth_events` row naming the actor and the previous and new roles, a post naming another organisation, from another origin or without one changing nothing, and a member another change holds (the 409 member lock) answered with "Someone else is changing <name> now. Try again in a moment." and the lock released after a failed change. Cheaper substitute: `auth.api` without a request, or writing `member.role` directly, which skip D07 T02's hooks.
- [x] Remove a member through a confirmation page at `/team/remove/<member id>` (the member's name, Remove and Cancel; **Corrected 2026-10-31:** this read "a `dialog`; without JavaScript a confirm page": the page serves both, with no client script, its focus a page's own), carrying the drawn organisation and checked for the app's origin at the final post, through `auth.handler` on `/auth/organization/remove-member` with the member's cookie, then 303 back with "<name> was removed". Done when: the test reads the member gone, their sessions in the organisation ended and an `auth_events` row; Cancel, a foreign or missing origin, another organisation's member id and an organisation switched between opening the confirmation and pressing Remove each change nothing. Cheaper substitute: removal on one press.
- [x] Draw the last-owner guard: for the only owner their own Remove disabled and the notice "You are the only owner, so you cannot be removed or made an admin. Make someone else owner first." under the table; a post that would remove or demote the last owner answered with the notice and nothing changed (D07 T02's own refusal, drawn). Source: board `Team`. Done when: the test reads the notice, the disabled button and an attempted post changing nothing. Cheaper substitute: the guard drawn but the post accepted.
- [x] Draw every other answer of a change as what happened, from the stored state read again: a session expired (the sign-in page, back to `/team` after), a permission lost since the page was drawn (the page redrawn with the controls the reader now has and "You can no longer change the team."), a member already removed ("<name> is no longer a member."), a failed or uncertain change ("The change to <name> could not be confirmed. The team below is as stored now; try again if it is not what you asked.", the page redrawn from the stored state, never the asked change as done; **Corrected 2026-10-31:** this read "the 503 page with Try again", but htmx draws no 5xx answer and the app script reloads the asked address, which would redraw the page with nothing said, so the failure is an outcome notice like every other answer). While a change runs its control is busy and a second press sends nothing (`data-busy`). Done when: the test reads each answer and the stored state unchanged where the change did not happen, and the browser test reads a failed change never shown as done. Cheaper substitute: "Saved" before the answer.
- [x] Mark Team active in the shell and keep the page's actions out of a member's reach (no selects or Remove for a member; a member's post answered 403). Done when: the test reads a member's read-only page and their post refused. Cheaper substitute: hidden buttons with an open post.
- [x] Prove the page in Chromium in `test/node/team-browser.test.tsx`: a role change and a removal by keyboard through the confirm page, the busy control, a refused and a failed change drawn as such, and the accessibility scans at 360 and 1280 px in both themes. Done when: each passes. Cheaper substitute: rendered-HTML tests only.
- [x] Prove the no-JavaScript paths in Chromium: change a role with Save, cancel a removal and confirm one on the confirm page, then reload and read the stored state. Done when: each passes with JavaScript off. Cheaper substitute: the htmx paths only.
- [x] Commit: `web: team and invites page`

> **Resolved:** the invitations panel and pending invitations on the board `Team` -> XREF: D07 T04 §21 (built and stamped there)
> **Resolved:** the refusal to remove a protected account -> XREF: D07 T04 §25 (built and stamped there)

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` and `pnpm exec vitest run --project node test/node/team-browser.test.tsx` pass, and fail if the last owner can be removed, a member's post changes a role, or a role change skips its audit's previous role.

> **Verified:** 2026-10-31 | §3 | e6cd4b8fca4bc320b3d1fc2aa819b2e0bf98576d
> **Review:** `docs/reviews/d07-t04-s3.json`

## 4. Domains and sending addresses page

> **Started:** 2026-10-31T18:38:14Z

The organisation's approved domains and sending addresses with their verification state, adding and removing them (verification flow from D07 T02 §7), and the help text for forwarding as an attachment in Outlook and Gmail.

**Corrected 2026-10-31:** measured against the board `Domains`, `design/SPEC.md` M8 and the tree. (1) `GET /settings/domains` has no route (the shell links to it; `src/web/pages/domains.tsx` serves only `/settings/domains/:domain`, D07 T02 §15, the app lane's). (2) The page drives the existing `/api/org` routes in process (`domainRoutes.fetch` from `src/auth/domains.ts` with the member's cookie and the app's origin: the same handlers, gates and audit as the JSON API), so `src/auth/domains.ts` is read and never edited. (3) The address claim has no page: "Add a single address" and the code entry for an address (the board's second button, and Continue for a pending address) are D07 T04 §27; this section lists single addresses and removes them. (4) The board's "by Thandi N." in How it was proved is not stored with the claim (the verifying actor lives only in `auth_events`, kept 12 months): the column reads the method and the date. (5) Protected identity reads `getIdentity(...).effective` (`src/trust/identity.ts`, D05 T01): "Yes" on a verified domain while protection holds, "Not set up" otherwise, "After verifying" on a pending one. (6) Cases this month counts forwarded mail from the domain (or the address) since the first of the month in SAST. (7) SPEC M8's "no empty state, always the domain it signed up with" is wrong for an organisation that onboarded by addresses only or removed its last domain: the empty state is added to the SPEC first, as the second item already said. Members see both lists read-only, with no Add, Remove or Continue, as Team's.

**Corrected 2026-10-31 (plan review, `docs/reviews/07-app/D07-T04-s4.md`):** six gaps closed before the build. (1) The JSON routes gate every method to owners and admins, so a member's read-only view cannot use them: the page reads the lists itself, scoped by the organisation (`org_domains`, `org_addresses`) for every role, and only an owner or admin adds the pending claims' challenge from `GET /api/org/domains` in process. (2) The two DELETE handlers record nothing: the audit belongs in them (the owning layer, so the JSON API is covered too): `remove-domain` and `remove-address` events (`src/auth/domains.ts` and the `AuthEventKind` union in `src/auth/audit.ts`, the app lane's, edit approved by the coordinator; `auth_events.kind` is unconstrained text, so no migration), with the page's removal proving the persisted event. (3) A removal's confirmation says what really changes: removing a domain ends mail accepted because of it, not mail from a separately verified address under it; removing an address does not end mail its verified domain admits; and removing the last verified domain or the finance contact's address ends Protected identity (`getIdentity().effective`), said when it applies; tests read back effective protection and the sender lookup after each removal. (4) Every failure of a change is drawn from the stored state: a claim already removed in another tab ("<domain> is no longer on the list."), a lost session (sign in, back to the page after), a failed read or write (the page redrawn with "could not be confirmed", the typed domain kept), never as done. (5) How it was proved is "DNS TXT record" or "A code mailed to the domain's admin@ or postmaster@ address", never one of them: the recipient is not stored. (6) The empty state offers only Add a domain until §27 adds the address action; each action is tested through its destination.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M8 Domains and addresses (board `Domains`)
**Job:** an admin controls which mail IsItLegit accepts for the business
**Treatment:** the board's two tables over the forwarding help; state per row, one Add a domain action, removal confirmed on its own page
**Chrome:** `AppShell` with Domains active, `Field`, `Button`, `Pill` from D07 T01

**Build order:**

1. Draw `GET /settings/domains` from `GET /api/org/domains`, the identity and the month's counts in `src/web/pages/domains-list.tsx` and `domains-list-view.tsx`. Done when: `test/web/domains-list.test.ts` reads both tables.
2. Take add and remove as posts to `/settings/domains` that run the JSON routes in process. Done when: the test reads each change made, recorded and refused.

- [x] Add M8's empty state to `design/SPEC.md` first (an organisation with no domain and no address: "No mail is accepted yet" and Add a domain; §27 adds the address action), update the SPEC's M8 states, then build it. Done when: the SPEC section reads it and `test/web/domains-list.test.ts` renders it for an organisation with none and the Add a domain action reaches its form. Cheaper substitute: two empty tables.
- [x] Draw `GET /settings/domains` behind the session gate and the active organisation: heading "Domains and addresses", "We accept mail at check@isitlegit.co.za only from addresses <organisation> has proved it owns.", the Domains table (Domain in the mono face, Status Verified or Pending, How it was proved: "DNS TXT record" or "A code mailed to the domain's admin@ or postmaster@ address" with the date in SAST, "Waiting for the TXT record" or the challenge's state for a pending one, Protected identity, Remove, and Continue to `/settings/domains/<domain>` for a pending one), none of another organisation's, read by the page's own scoped queries for every role (a member reads both tables); the sign-in, 403 and 503 pages as the Cases list answers them. Source: board `Domains`. Done when: the page test reads, through real owner, admin and member sessions on the mounted page, every domain row of the organisation and none of another's, each state's words and the Continue link. Cheaper substitute: the domain names alone.
- [x] For an owner or admin, show each pending claim's challenge from `GET /api/org/domains` read in process (`codeExpiresAt`, `lockedUntil`, `nextCodeAt`, D07 T02 §5): "Code sent, valid until <time>", "Locked until <time>", "Next code at <time>", so a reloaded page states the remaining wait without a request. Done when: the page test renders a locked claim's remaining wait and a live code's expiry from the read alone. Cheaper substitute: "Pending" with no wait. Source: D07 T02 §5 completion review (Part 1 item 13, Part 2 item 2).
- [x] Draw the Addresses table (Address, Why it is allowed, Cases this month, Remove): "Anyone @<domain>, The whole domain is verified" for each verified domain, then each verified single address ("Single address, confirmed by a code on <date>"), then each pending one ("Waiting for the code"), the month's cases from forwarded mail since the first of the month in SAST, and the note "Mail from any other address never joins <organisation>' cases. It is handled as a public check, which only compares the mail with businesses registered as Protected." Source: board `Domains`. Done when: the page test reads each row, its count from seeded cases, and the note. Cheaper substitute: counts of every case of the organisation.
- [x] Read Protected identity per domain from `getIdentity(db, orgId).effective`: "Yes" on a verified domain while protection holds, "Not set up" while it does not, "After verifying" on a pending one. Done when: the page test reads each for an organisation with protection on and one without. Cheaper substitute: "Yes" for every verified domain.
- [x] Add a domain: the "Add a domain" button opens a field and Add on the same page (a form posting `/settings/domains` with `action=add`, the drawn organisation and the domain), run through `POST /api/org/domains` in process, then 303 to `/settings/domains/<domain>` (the claim page) with the TXT record; the refusals (not a domain an organisation can claim, verified by another organisation, too many pending) drawn under the field with the typed domain kept, never as a page. Done when: the page test adds a domain and lands on its claim page, and reads each refusal under the field. Cheaper substitute: a link to the API.
- [x] Audit the removals at their owner: `DELETE /api/org/domains/<domain>` and `DELETE /api/org/addresses/<address>` in `src/auth/domains.ts` record `remove-domain` and `remove-address` events (actor, target claim id, outcome `removed`, no domain or address text) through `recordAuthEvent`, the kinds added to `AuthEventKind` in `src/auth/audit.ts` (the app lane's, edit approved by the coordinator). Done when: `test/auth/domains.test.ts` reads the event for each removal through the JSON API and a removal of another organisation's claim records none. Cheaper substitute: an event written only by the page.
- [x] Remove a domain through a confirmation page at `/settings/domains/remove/<domain>` (the domain and what removing it really changes: mail accepted because of it is no longer accepted, not mail from an address verified separately under it; its verified status and receivers go with it; and Protected identity ends when it is the last verified domain; Remove and Cancel), the post carrying the drawn organisation and checked for the app's origin, run through `DELETE /api/org/domains/<domain>` in process, then 303 back with "<domain> was removed". Done when: the page test reads the claim and its receivers gone, the persisted `remove-domain` event, the sender lookup and `getIdentity().effective` read back after the removal, and Cancel and a foreign origin or organisation changing nothing. Cheaper substitute: removal on one press.
- [x] Remove a verified or pending single address the same way (`/settings/addresses/remove/<address>`, `DELETE /api/org/addresses/<address>`), its confirmation saying mail its verified domain admits is still accepted, and that removing the finance contact's address ends Protected identity. Done when: the page test reads it gone, the `remove-address` event, mail from the domain still accepted, protection read back after the finance contact's removal, and Cancel changing nothing. Cheaper substitute: none.
- [x] Draw every other answer of a change from the stored state: a claim already removed in another tab, a lost session, an API or database failure, each with the typed domain kept and never shown as done. Done when: `test/web/domains-list.test.ts` submits each failure through the forms and reads the stored state unchanged where the change did not happen. Cheaper substitute: the 503 page for everything.
- [x] Keep every control out of a member's reach: owners and admins get Add, Remove and Continue; a member reads both tables and the help with none, and a member's post answered 403 with the page. Done when: the page test reads each role's controls through real owner, admin and member sessions and a member's refused post. Cheaper substitute: hidden buttons with an open post.
- [x] Add the forwarding-as-attachment help for Outlook desktop, Outlook on the web and Gmail, with why the headers matter ("Forward it as an attachment, so the original sender details come with it. A normal forward loses them."), the three cards as the board draws them, the Gmail wording as the Cases first-run state's (design/SPEC.md M1 Deviation). Source: board `Domains`. Done when: the page test reads the three cards and the reason. Cheaper substitute: one paragraph.
- [x] Prove the page in Chromium in `test/node/domains-list-browser.test.tsx`: an add and a removal by keyboard, the confirm page's Cancel, a refusal under the field, and the accessibility scans at 360 and 1280 px in light and dark with the empty state and each row state. Done when: each passes. Cheaper substitute: rendered-HTML tests only.
- [x] Commit: `web: domains and sending addresses page`

> **Resolved:** Add a single address and a pending address's Continue -> XREF: D07 T04 §27 (built and stamped there)

**Test checkpoint:** `pnpm exec vitest run test/web/domains-list.test.ts test/auth/domains.test.ts` and `pnpm exec vitest run --project node test/node/domains-list-browser.test.tsx` pass, and fail if a member's post removes a domain or another organisation's domain is listed.

> **Verified:** 2026-10-31 | §4 | 7db38765ab8f7dc4f22b2abcd98ff0d12cfd9bca
> **Review:** `docs/reviews/d07-t04-s4.json`

## 5. Registrar-assisted domain verification

Adding a domain today means copying a TXT record into the registrar by hand and coming back to check (D07 T02 §5). Registrars that support Domain Connect can add the record themselves after the owner approves, so a supported domain verifies with no field typed by hand (D07 T02 §5 completion review, Part 2 item 1). DNS by hand and the emailed code stay as the other ways.

**Phase:** 7
**Needs:** none
**Surface:** yes

> **Started:** 2026-11-02T07:00:00Z

**Corrected 2026-11-02:** measured against the tree at be21e2f4. The plan holds: `checkDomain` (D07 T02 §5) runs the DNS check on return and the `_domainconnect` lookup rides the same Cloudflare DoH transport, both consumed unchanged. One gate the plan did not name: micro-step 1 adds a control to a boarded surface, so the M8 board change goes to the operator for approval before the step is drawn (AGENTS.md); the SPEC text and the two protocol micro-steps (discovery, signed hand-off) build first and do not wait for it.

**Corrected 2026-11-02 (plan review P1/P2):** the review's 5 gaps are answered in the Build order below. Discovery alone does not prove a hand-off works: the provider's Query Supported Template answer for IsItLegit's exact template decides whether Connect is offered, and the template plus the signing public key are publishable artefacts committed here, with one real provider's onboarding as the operator step that proves readiness; until a provider answers yes, every domain falls back to the manual and emailed ways with no dead button. The Connect option lives on the A5 verification page (`/settings/domains/:domain`), which M8's Add and each pending row's Continue already reach, so both boards (M8 and Verify-Domain) go to the operator together. Initiation and return are bound to the pending claim itself: both routes re-check owner or admin for the claim's organisation, the return answers for the claim's domain whatever organisation is active, an expired session returns through sign-in to the same claim, a repeated return reads the verified state, and a refusal leaves the claim untouched. The failure and delay states (discovery timeout, provider cancelled or errored, DNS not yet visible, check failed) each name their recovery on the page and are tested through the return route. The browser journey activates the real control against a stubbed provider and counts the common-case actions.

**Fidelity:** `design/SPEC.md` M8 (the domains page) and A5 (the verification page at `/settings/domains/:domain`), each extended with the registrar step; boards to the operator.
**Job:** an owner verifies a domain at a supported registrar in at most three actions (add the domain, approve at the registrar, return verified), typing no DNS value.
**Treatment:** the registrar option first on A5 when the provider supports IsItLegit's template, the manual record and the emailed code below it; the hand-off is a plain link, so no JavaScript is required.
**Chrome:** the verification page's own controls (D07 T04 §4), no new toolbar or dialog shape.

**Build order:**

1. Design the registrar step on A5 and find which registrars support it. Done when: the SPEC and its boards show the step, and a test lists a domain's Domain Connect support from its DNS.
2. Publish the template and key, then build the flow. Done when: a stubbed registrar adds the record and the domain verifies with no value typed, and one real provider's onboarding is evidenced.

- [ ] Add the registrar step to M8 and A5 in `design/SPEC.md` (the Connect control above the manual record, the hand-off, the return, discovery timeout, provider cancel and error, DNS not yet visible and check failed, each with its recovery action, and what an unsupported registrar shows), with both boards to the operator for approval. Done when: the SPEC sections and the boards exist and every control and state is named.
- [x] Discover Domain Connect support for a claimed domain (its `_domainconnect` TXT record and the provider's settings) in `src/auth/domain-connect.ts`. Done when: `test/auth/domain-connect.test.ts` finds support for a stubbed provider and none for a domain without the record. Cheaper substitute: a hard-coded registrar list, which rots as providers join and leave.
- [x] Commit the Domain Connect template for the `_isitlegit` TXT record and the signing public key as publishable artefacts, and ask the provider's Query Supported Template for IsItLegit's exact template before offering Connect. Done when: `test/auth/domain-connect.test.ts` offers Connect only on a yes, and an unsupported template or an unavailable provider falls back with no button. Cheaper substitute: offering Connect on discovery alone, which sends owners to providers that cannot apply the template.
- [x] Build the hand-off URL carrying the claim's token, signed as the protocol requires, from the verification page's Connect control; initiation re-checks owner or admin for the claim's organisation and refuses anyone else with the claim untouched. Done when: `test/auth/domain-connect.test.ts` builds the URL a stubbed provider accepts, and one with a changed token is refused. Cheaper substitute: an unsigned URL, which lets anyone point a claim at a registrar session.
- [ ] Operator: publish the template and the signing public key, onboard one real DNS provider, and record its Query Supported Template yes with the date in this section. Done when: the recorded evidence names the provider and its answer for IsItLegit's template.
- [ ] Return from the registrar to the verification page and run the DNS check (D07 T02 §5) automatically, showing the outcome; the return route re-checks owner or admin for the claim's organisation, binds by the claim's domain, treats a repeated return as a read of the verified state, and refuses with the claim unchanged. Done when: `test/web/domains-page.test.ts` returns from a stubbed registrar to a verified domain with its attribution and sender admission read back on a fresh GET, covers session expiry returning to the same claim, and proves each refusal leaves the claim as it was. Cheaper substitute: trusting the return URL's word, which verifies a domain nobody proved.
- [ ] Draw the recovery states on the verification page: discovery still running and timed out (Retry discovery, or the manual and emailed ways), the provider's cancel and error returns (Try again, claim kept), approval with DNS not yet visible (Check again), and a failed check (Check again or another way). Done when: `test/web/domains-page.test.ts` renders each state with its named action, including delayed visibility followed by a successful retry. Cheaper substitute: one generic failure sentence, which strands the owner mid-flow.
- [ ] Walk the journey in `test/node/domains-browser.test.tsx`: activate Connect on the verification page, follow the stubbed hand-off, return verified, keep the manual and emailed fallbacks usable, at 360 and 1280 px in both themes, keyboard only, axe clean, counting the common-case actions against the three-action promise. Done when: the browser test passes with three actions and no typed DNS value. Cheaper substitute: calling the return route directly, which passes with the control inert.
- [ ] Commit: `web: registrar-assisted domain verification`

**Test checkpoint:** `pnpm exec vitest run test/auth/domain-connect.test.ts test/web/domains-page.test.ts` passes and fails if a domain verifies without its token in DNS or an unsupported registrar shows the Connect button.

## 6. MSP console and own branding

Spec 2b prices an MSP tier for IT providers ("wholesale per client, MSP console, own branding"), and D07 T02 §8 names both as features (`msp-console`, `msp-branding`, on the trial and MSP), but no section built either (D07 T02 §8 completion review). An MSP manages its client organisations from one console and shows its own name and logo to them. Phase 7 is this run's scope decision (2026-10-29, D07 T02 §8), not the spec's: the spec prices MSP without deferring it, but the console has no design and no board yet, and during the event every organisation's trial already unlocks both features; the operator can bring it forward (recorded in `docs/phase-runs/2026-10-28-phase-1.md`).

**Phase:** 7
**Needs:** none
**Surface:** yes

> **Started:** 2026-11-02T18:45:00Z

**Corrected 2026-11-02 (validation before build):** the checklist as written cannot deliver the Job: no item builds the console page itself (the client list, one action into a client's cases), the branding settings page, or the MSP brand carried in a client's pages and mail, so those items are added below. Two gates stand before the surface work: the boards for two new pages go to the operator for approval (AGENTS.md, Interface rules), and the MSP relation migration takes a number from the coordinator. The relation store, its reads and the feature gates do not wait for the boards.

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
- [ ] Build the console page from its approved board: the MSP's client organisations, each opening that client's cases in one action, scoped by the stored relation. Done when: `test/web/msp-console.test.ts` reads only the MSP's clients and opens a client's cases, and the browser checkpoint drives it at phone width in both themes. Cheaper substitute: reusing the member Cases page unscoped, which reads every organisation the staff member belongs to rather than the managed clients.
- [ ] Build the branding settings page from its approved board and carry the MSP's name and logo in a managed client's pages and reply mail. Done when: `test/web/msp-console.test.ts` reads the MSP's brand on a client's page and in its mail, and the client's own brand where no MSP manages it. Cheaper substitute: branding the console only, which leaves the client's own surfaces carrying IsItLegit's brand.
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

> **Resolved:** the invoice and payment-document words in Type ("Email, invoice", "Payment document") -> XREF: D07 T04 §13

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` and `pnpm exec vitest run --project node test/node/cases-browser.test.tsx` pass, and fail if a search returns another organisation's case, a `%` in the search matches every case, "cafe" misses "CAFÉ", or typing in the search box redraws nothing.

> **Verified:** 2026-10-31 | §7 | aa6143fac032a2930bf0a4fff4f74bac38b77102
> **Review:** `docs/reviews/d07-t04-s7.json`

## 8. A chosen date range in the

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

A member looking for a check from a known week picks its dates instead of paging through a fixed period. Filed 2026-10-30 from D07 T04 §1's completion review (excellence item 2): the board `Cases` offers only fixed periods, so the control is a design change first.

**Phase:** 7
**Operator decision 2026-11-02:** Approve From and To dates beside the fixed periods on the Cases board (a board change first, as the section requires).

> **Started:** 2026-11-02T18:52:00Z

**Corrected 2026-11-02 (validation before build):** the interaction the plan did not name is settled here. From and To sit beside the period select; setting either date makes the range the date filter (the period is then ignored, and the filtered-empty words name the range instead of the period), and clearing both returns to the period. Days are SAST calendar days, both ends inclusive. A value that is not a real `YYYY-MM-DD` date is read as unset, as every other bad filter value reads as its default in `filtersFrom`. The dates ride `casesHref` with the other filters, so paging, Back and a reload keep the range.

**Corrected 2026-11-02 (plan review P2, `docs/reviews/07-app/D07-T04-s8.md`):** four gaps answered in the checklist below. While a range is active the period select is disabled and the page shows the active range with a Clear dates control that keeps the search, verdict and channel, so returning to a fixed period is one explicit action. A From after the To is no longer swapped in `filtersFrom` (the earlier wording above): the pair is kept as typed, matches nothing, and the page names the problem with a Swap them link carrying the corrected pair, so the visible inputs, the address and the results agree after every response, incremental or full. The page test gains boundary fixtures (just before, at and just after each SAST boundary, a same-day range, From only, To only, a range outside the chosen period, combined filters, another organisation's cases, counts and paging), and the browser test gains the date controls' own journey.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, once the operator approves a board change adding the date range
**Job:** a member finds the checks of a known week or month in one step
**Treatment:** a From and To date beside the period filter, in the query string with the other filters
**Chrome:** §1's filters

**Build order:**

1. Draw the date range on the board `Cases` and have the operator approve it. Done when: `design/SPEC.md` M1 lists the control.
2. Build it into §1's filters and `src/db/case-list.ts`. Done when: `test/web/cases-page.test.ts` filters by a range.

- [x] Add the date range to the board and SPEC M1 with the operator's approval. Done when: `design/SPEC.md` M1 names it.
- [x] Add `from` and `to` to `CaseFilters` and `filtersFrom` in `src/db/case-filters.ts`: each a real `YYYY-MM-DD` date or empty, both empty the default; `casesHref` in `src/web/pages/cases-view.tsx` keeps them in the address. Done when: the page test reads a hand-typed bad date as unset and `casesHref` round-trips both dates. Cheaper substitute: dates held only in the inputs and lost on the pager, Back or a reload.
- [x] Filter `listCases` by a From and To date (SAST days, inclusive) and draw the control. Done when: `test/web/cases-page.test.ts` reads a range's cases only, with fixtures just before, at and just after each SAST boundary, a same-day range, From only, To only, a range outside the chosen fixed period, combined verdict, channel and search filters, another organisation's cases in range, and the matching count and paging over more than one page of matches; each assertion fails on UTC-midnight bounds, an exclusive To day, or the period's lower bound surviving beside the range.
- [x] Draw From and To date inputs beside the period select in `Filters` (`src/web/pages/cases-view.tsx`), each with a visible label, their values from the address, applying on change like the other filters; `filterWords` names the range (for example "from 3 Oct to 9 Oct") when one is set, and Clear filters clears both dates. Done when: the page test reads both inputs with their values, the filtered-empty heading naming the range, and Clear filters' address holding neither date. Cheaper substitute: one generic "custom range" select value, which cannot name the week the member picked.
- [x] Show the active range state: while a range is set, the period select is disabled, the active range is named beside the inputs, and a Clear dates control returns to the fixed periods keeping the search, verdict and channel. A From after the To keeps both dates as typed, matches nothing, and offers a Swap them link carrying the corrected pair with the other filters. Done when: the page test enters a range, returns through Clear dates to a preset with its other filters kept, clears both dates by hand, and follows Swap them to the corrected range's cases. Cheaper substitute: leaving the period select live while the range silently wins, which strands the member on a range they cannot leave.
- [x] Drive the date controls in `test/node/cases-browser.test.tsx`: keyboard entry and clearing, automatic application on change, the no-JavaScript Apply, page reset to 1, paging inside a range, Back and reload read-back, a delayed earlier change never overwriting a newer one, and a failed request recovering with the range kept; the added controls join the phone and desktop, both-theme accessibility scans. Done when: each scenario passes in Chromium. Cheaper substitute: requesting the address directly, which never exercises the inputs.
- [x] Commit: `web: a chosen date range in the cases list`

> **Deferred:** calendar month and quarter shortcuts for the list -> XREF: D07 T04 §30
> **Deferred:** saved named Cases views -> XREF: D07 T04 §31

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if a case outside the range is listed.

> **Verified:** 2026-11-02 | §8 | f2690153be4f0b2f09b17bb452be5dfcf3b4c8f5
> **Review:** `docs/reviews/d07-t04-s8.json`

## 9. Next and previous case

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

A member reviewing a filtered run of cases steps from one report to the next without going back to the list. Filed 2026-10-30 from D07 T04 §1's completion review (excellence item 3): the board `Main` (M3) has no such control, so the control is a design change first.

**Phase:** 7
**Operator decision 2026-11-02:** Approve Previous and Next on the report, stepping through the currently filtered Cases list (a board change first).

> **Started:** 2026-11-02T19:45:00Z

**Corrected 2026-11-02 (validation before build):** the interactions the plan did not name are settled here. The Cases list's rows carry the current filters to the report in the address, and each step keeps them, so stepping never loses the filtered run. Previous and Next follow the list's own order (newest first): Previous is the case above this one in the list, Next the one below. At either end the control is drawn disabled, never a link that goes nowhere. The steps belong to the member view only: a signed link carries no filters and shows none, and a report opened without filters in its address shows none. A case the filters no longer match (the run changed since the list was drawn) shows no steps rather than stepping from a list it is not in. Neighbours are read with the list's own filter clause, scoped to the case's organisation.

**Corrected 2026-11-02 (plan review P2, `docs/reviews/07-app/D07-T04-s9.md`):** six gaps answered in the checklist below. Row links carry an explicit `list=1` marker with the filters, so entry from a plain `/cases` (all defaults) is told apart from a report opened directly, which shows no steps. The report's Cases breadcrumb returns to the originating filters and the page this case sits on, and a case the filters no longer match says so in one line with that breadcrumb standing, instead of the steps silently vanishing. The report parses the address with the Cases list's own `filtersFrom` (a malformed date is unset there, never a broader silent invention of this route), and the sign-in return and the error page's retry keep the validated navigation context. A failed neighbour read is the report's 500 page, never steps quietly missing; a genuine end of the run is a disabled control. The steps live outside the running report's polled region, so polls never remove them, and membership in the run is read again on every full page, so a retry that changes the verdict moves the case out with the note above. The browser checkpoint joins the access checkpoint.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M3 Report, once the operator approves a board change adding the step controls
**Job:** a member works through a filtered list of reports in order
**Treatment:** Previous and Next on the report, keeping the list's filters
**Chrome:** D07 T03 §1's report

**Build order:**

1. Draw the controls on the report board and have the operator approve them. Done when: `design/SPEC.md` M3 lists them.
2. Carry the list's filters to the report and step through them. Done when: `test/web/report-access.test.ts` steps to the next case under a filter.

- [x] Add Previous and Next to the report board and SPEC M3 with the operator's approval. Done when: `design/SPEC.md` M3 names them.
- [x] Carry the filters from `/cases` to `/r/<id>` and answer Previous and Next within them, scoped by the organisation. Done when: `test/web/report-access.test.ts` steps to the next filtered case and never to another organisation's.
- [x] Mark the list's origin: the Cases rows' report links in `src/web/pages/cases-view.tsx` carry `list=1` with the filters (defaults included), and the steps in `src/web/pages/report.tsx` answer only when it is present. Done when: the test opens a report from a plain `/cases` and steps, and opens `/r/<id>` directly and finds no steps. Cheaper substitute: treating any filter parameter as the marker, which a hand-typed address then fakes.
- [x] Read the neighbours with the list's own clause: add `caseNeighbours` beside `listCases` in `src/db/case-list.ts`, sharing its filter clause, returning the cases above and below this one in list order under the same verdict, channel, period, range and search, scoped to the organisation. Done when: the test steps across a page boundary of the list (past 25 matches) and past cases sharing one `created_at`, ordered by id as the list orders them. Cheaper substitute: stepping through one loaded page of the list, which stops at 25.
- [x] Return to the run: the report's Cases breadcrumb (`src/web/pages/report-view.tsx`) answers `casesHref` with the carried filters and the page this case sits on in the run, and a case the filters no longer match shows one line saying so with no steps and the breadcrumb standing. Done when: the test steps twice, follows the breadcrumb, and reads the same filtered page; and reads the note on a case a retry has moved out of the run. Cheaper substitute: a breadcrumb to a plain `/cases`, which throws away the investigation.
- [x] Keep the context through failures: the member's sign-in return and the report error page's retry in `src/web/pages/report.tsx` carry the validated filters and `list=1`; a failed neighbour read answers the 500 page, and the route parses the address with `filtersFrom` so a malformed date is unset as on the list. Done when: the test expires the session mid-run and signs back in onto the same report with its steps, and fails the neighbour read and reads the 500 page with the context in its retry. Cheaper substitute: rebuilding the context from defaults, which silently widens the run.
- [x] Draw Previous and Next on the member report (`src/web/pages/report-view.tsx`, fed from `src/web/pages/report.tsx`): each a link to its neighbour carrying the filters, the unavailable end drawn disabled, and no steps on a signed link, on a report opened without filters, or for a case the filters no longer match. Done when: `test/web/report-access.test.ts` follows each step in the browser-less page and reads the disabled end, and `test/node/report-browser.test.tsx` (or the report's own browser suite) drives the steps by keyboard. Cheaper substitute: steps that drop the filters, which return the member to a different run than the one they were working through.
- [x] Commit: `web: next and previous case from a report`

**Test checkpoint:** `pnpm exec vitest run test/web/report-access.test.ts` and `pnpm exec vitest run --project browser test/node/report-browser.test.tsx` pass and fail if a step leaves the filter or the organisation.

> **Verified:** 2026-11-02 | §9 | fab64ebc0b03e98f493c9509a7d91cb1627fabee
> **Review:** `docs/reviews/d07-t04-s9.json`

## 10. A Checked by filter in the

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

A member narrows the list to the cases one colleague checked. Filed 2026-10-30 at the checks lane's suggestion (D01 T03 §11's completion review, through the coordinator): the board `Cases` has no such filter, so the control is a design change first; it waits on §7 so an upload names its uploader.

**Phase:** 7
**Operator decision 2026-11-02:** Approve a Checked by select (Everyone, then each member) beside the channel filter (a board change first; it waits on section 7 naming uploaders).

> **Started:** 2026-11-02T20:40:00Z

**Corrected 2026-11-02 (validation before build):** the interactions the plan did not name are settled here. The select's value is the member's user id, carried as `checker` in the address with the other filters, so the pager, §9's steps and a reload keep it. Who checked a case is read as the list already reads it (`checkerSql` in `src/db/case-list.ts`): an upload by its uploader id, an email by its forwarding address matched to a member's account email. An id that is not a current member of this organisation matches nothing, never everyone, so a hand-typed address cannot widen the list; the select offers current members only, and a departed member's cases stay under Everyone. The filtered-empty words and the count name the member, as they name the other filters.

**Corrected 2026-11-02 (plan review P2, `docs/reviews/07-app/D07-T04-s10.md`):** four gaps answered in the checklist below. A checker who has left (or an unknown or foreign id in a bookmark) keeps the restrictive filter and is drawn as a disabled selected option, "Member no longer available", with Clear filters the way back to Everyone, and no other organisation's identity named. Two members sharing a name are told apart in the select by their email. The checker predicate joins the shared filter clause, so §9's neighbours and steps inherit it, proven through the report. The control's own browser journey and the member read's failure (the error page, its retry keeping the checker) join the checkpoints.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, once the operator approves a board change adding the filter
**Job:** a member reviews what one colleague has checked
**Treatment:** a Checked by select beside the channel filter (Everyone, then each member), in the query string with the other filters
**Chrome:** §1's filters

**Build order:**

1. Draw the filter on the board `Cases` and have the operator approve it. Done when: `design/SPEC.md` M1 lists the control.
2. Filter `listCases` by the member (their forwarding address for email, their user id for an upload) and draw the select. Done when: `test/web/cases-page.test.ts` filters by a member.

- [x] Add the Checked by filter to the board and SPEC M1 with the operator's approval. Done when: `design/SPEC.md` M1 names it.
- [x] Filter `src/db/case-list.ts` by one member of the organisation, refusing a member of another, and draw the select with the organisation's members. Done when: `test/web/cases-page.test.ts` lists only that member's cases and never another organisation's.
- [x] Add `checker` to `CaseFilters` and `filtersFrom` in `src/db/case-filters.ts` (a member's user id, or empty for everyone), kept by `casesHref`; the predicate joins the shared filter clause in `src/db/case-list.ts`, so the list and §9's `caseNeighbours` read the same run, matching an upload by `uploaded_by` and an email by `forwarded_by` against that member's account email, guarded by their membership of this organisation. Done when: the page test filters an email case and an upload case by the same member, a foreign member's id lists nothing, and removing the membership guard fails the test. Cheaper substitute: matching the name the row draws, which two members sharing a name would merge.
- [x] Draw the Checked by select beside the channel select in `Filters` (`src/web/pages/cases-view.tsx`), Everyone first then the organisation's current members by name (their email when the name is blank, and their email in brackets after the name where two members share one), its value from the address; read the members in `src/web/pages/cases.tsx` and name the member in `filterWords` and the filtered-empty heading. An id the members no longer include is drawn as a disabled selected option, "Member no longer available", the filter kept, with Clear filters returning to Everyone. Done when: the page test reads the select with both members (two sharing a name told apart), the chosen one selected, the unavailable option after a member leaves, and the filtered-empty heading naming them. Cheaper substitute: a free-text name field, which a typo empties silently.
- [x] Prove the run holds: follow Previous, Next and the Cases breadcrumb under a checker filter in `test/web/report-access.test.ts`, across a page boundary with another checker's cases between, the addresses and counts keeping the checker and the ends disabled. Done when: each step's address carries `checker` and the breadcrumb returns to the same filtered page. Cheaper substitute: proving the list alone, which leaves §9 stepping out of the run.
- [x] Drive the Checked by select in `test/node/cases-browser.test.tsx`: choosing a member and Everyone again, page reset, combined filters, reload and Back read-back, the no-JavaScript Apply, a failed request recovering with the checker kept, and the member read itself failing (the browser stub's member list withheld) with the retry keeping the checker; long member names join the phone and desktop, both-theme accessibility scans. Done when: each scenario passes in Chromium. Cheaper substitute: requesting the address directly, which never touches the select.
- [x] Commit: `web: a checked by filter in the cases list`

> **Deferred:** a searchable Checked by picker (name or email, one shortcut) -> XREF: D07 T04 §32

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if the filter lists a case another member checked.

> **Verified:** 2026-11-02 | §10 | 22e2f318969a538205491e3539b72f4a6aed8d1a
> **Review:** `docs/reviews/d07-t04-s10.json`

## 11. DNS help per provider

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

An owner who does not know where their DNS lives reaches the steps for their provider in one action from the domain page: where the TXT record goes, what the provider calls Name (host, `@`, or the whole name), the value, TTL, and what to do when Check now still finds nothing. Filed 2026-10-30 from D07 T02 §15's completion review (excellence item 2, against Microsoft 365's domain setup): the board `Verify-Domain` has no help entry, so it is a design change first.

**Phase:** 7
**Operator decision 2026-11-02:** Approve the provider help entry; written steps for Cloudflare, Hetzner, xneelo and Afrihost first, generic TXT instructions for every other provider.

> **Started:** 2026-11-02T21:20:00Z

**Corrected 2026-11-02 (plan review P2, `docs/reviews/07-app/D07-T04-s11.md`):** four gaps answered in the checklist below. Above the providers, the help first answers "I do not know where my DNS lives": how to tell the DNS host from the registrar (the nameservers decide), and what to do when someone else manages the DNS (send them the record's Name and Value, both copyable). The board itself changes through the canvas import with the operator's 2026-11-02 approval recorded, and the disclosures join the browser checkpoint, expanded and collapsed, at both widths and themes.

**Corrected 2026-11-02 (validation before build):** the help lives in the DNS card (`DnsCard` in `src/web/pages/domains-view.tsx`) as native disclosures, one per provider, so it opens in one action with no JavaScript and works by keyboard. Each provider's Name is derived from the claim: `_isitlegit` where the provider wants the sub-domain part only (Cloudflare, Hetzner, xneelo), the whole record name where it wants that (Afrihost), and both forms named in the generic steps. Steps were checked against each provider's own help (xneelo's Manage DNS and its quoted Destination, Afrihost's ClientZone DNS Editor, Cloudflare's and Hetzner's record forms) on 2026-11-02. Every provider's steps end with the same propagation troubleshooting: wait, check the name was not doubled, check the value has no pasted quotes where the provider adds its own.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` A5 Verify a domain, once the operator approves a board change adding the help entry
**Job:** an owner adds the TXT record at their own DNS provider without searching for how
**Treatment:** a "How do I add this at my provider?" entry beside the record, opening steps for the common South African and global providers, with propagation troubleshooting
**Chrome:** D07 T02 §15's page

**Build order:**

1. Draw the help entry on the board `Verify-Domain` and have the operator approve it. Done when: `design/SPEC.md` A5 lists the control.
2. Write and test the steps for each provider named. Done when: `test/web/domains-page.test.ts` opens each provider's steps from the page.

- [x] Add the help entry to the board and SPEC A5 with the operator's approval, naming the providers covered. Done when: `design/SPEC.md` A5 names it and the providers.
- [x] Write each provider's steps (where the record goes, what its Name field expects, TTL, propagation and troubleshooting), checked against that provider, and draw them from the page. Done when: `test/web/domains-page.test.ts` reaches each provider's steps in one action and reads the Name each expects.
- [x] Lead the help with finding the DNS host: one short passage in the DNS card (`src/web/pages/domains-view.tsx`) telling the owner that the nameservers, not the registrar's name on the invoice, decide where DNS lives, how to see them (their registrar's nameserver page), and to send the record's Name and Value to whoever manages their DNS when that is someone else. Done when: the page test reads the passage and the generic steps under it. Cheaper substitute: naming providers only, which strands the owner who does not know theirs.
- [x] Prove each provider's whole recipe in `test/web/domains-page.test.ts` with distinct stored claims: the exact record value and whole record name for this claim, the Name format that provider expects, its TTL or default, its save action, the way back to Check now, and its troubleshooting. Done when: changing a claim's value or domain changes what the steps print, and a wrong Name format in a step fails. Cheaper substitute: asserting the provider's name appears, which a heading alone passes.
- [x] Draw the help entry and one expanded disclosure on the board `Verify-Domain` and bring it in through `design/tools/export-mockups.py import --approve` with the operator's 2026-11-02 approval, then `export`. Done when: `design/tools/check-design.py` passes with the disclosures on the board, collapsed and expanded. Cheaper substitute: a SPEC line alone, which leaves the next board import free to erase the control.
- [x] Drive the disclosures in `test/node/domains-browser.test.tsx`: open and close every provider and the generic steps by keyboard alone with focus kept, expanded at 360 and 1280 px in both themes under the accessibility gate, and without JavaScript. Done when: each disclosure opens in one action in Chromium. Cheaper substitute: server-rendered assertions, which prove the words exist but not that anyone can open them.
- [x] Commit: `web: dns help for each provider on the domain page`

> **Deferred:** suggesting the DNS host's own guide from the nameservers -> XREF: D07 T04 §33

**Test checkpoint:** `pnpm exec vitest run test/web/domains-page.test.ts` passes and fails if a provider's steps name the wrong field for the record's name.

> **Verified:** 2026-11-02 | §11 | e0e0674decc4cf36e993d6c7f4212eed6a46fe2f
> **Review:** `docs/reviews/d07-t04-s11.json`

## 12. Remove a case checked by mistake

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

**Corrected 2026-10-31:** two live accounts are protected (operator, 2026-10-31, through the coordinator): demo@rizonetech.com in Fynbos Freight (`ZF5SufztotybeXIWVncExFAVu9GYZ8Fu`) and derick@rizonetech.com. No removal path deletes, resets or bulk-cleans either account, its organisation or its cases; the removal built here skips them, with a test.

Filed 2026-10-31 from D01 T03 §6's completion review (out-of-scope excellence item). A member who uploads the wrong file, or a private one by mistake, has no way to remove it: the case, its stored file and its evidence stay until the 30-day retention. VirusTotal Private Scanning lets its users delete a file alone or the file and its report. Whether a member may delete, who in the organisation may, and what is kept for audit are the operator's to decide; the stored objects are D01's (the checks lane), asked through the coordinator.

**Phase:** 7
**Operator decision 2026-11-02:** The uploading member only may remove a case, within 24 hours, keeping an audit row naming who removed what and when (never the file); the two protected test accounts are skipped by every removal path, with a test, as AGENTS.md requires.

> **Started:** 2026-11-02T21:58:00Z
> **Decided:** 2026-11-02 (operator decision recorded above): the uploading member only (an upload by its `uploaded_by`, an email by its forwarding address matched to their account), within 24 hours of the case's arrival, one audit row and no file kept.

**Corrected 2026-11-02 (validation before build):** who checked the case is read as the list reads it, so an email's uploader is the member whose account email its forwarding address matches. Removal is one page of its own, as domain removals confirm: Remove in the list row and on the report opens it, it names the case, and Cancel returns to where the member came from.

**Corrected 2026-11-02 (plan review P1/P2, `docs/reviews/07-app/D07-T04-s12.md`):** the audit row is not an `auth_events` row: those are swept at 12 months and their recorder swallows failures, either of which would lose the record a 410 answer stands on. A dedicated tombstone (a migration the coordinator numbers) is written first with a checked insert, one row per case by its primary key, holding the case id, its organisation, who removed it and when, never the file; the report's 410 reads it, authorised by membership of that organisation or a valid signed link for it, and everyone else keeps the non-disclosing answer. Deletion then removes the objects under `raw/<case>/` and `art/<case>/` (listed by prefix, twice, so an object written across the first sweep is caught by the second), the evidence and artefact rows, and the case; a halfway failure retries to the same end, inside or outside the 24 hours, because the tombstone already stands. The mutation is session-authenticated and organisation-scoped with the routes' own origin protection, rechecking the uploader, the 24-hour boundary (at submission, not at the confirmation's opening) and the protected accounts when submitted, and every refusal leaves storage unchanged. Removed reports get their own page, not the expired-link page. One thing this lane cannot fence: a pipeline write already in flight when the case row goes can still land an object afterwards. That fencing belongs to the checks lane's storage, so the section waits on it below rather than pretending two sweeps close it.



**Needs:** third-party
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

> **Started:** 2026-11-02T22:12:00Z

**Corrected 2026-11-02 (checked against the tree):** the classification is stored as evidence: `invoice.detected` (D06 T01 §1, `src/invoice/extract.ts`) on a case the invoice step read as an invoice or payment request, and `document.proof_of_payment` (D06 T02 §3) on one it read as a proof of payment. `listCases` returns it on `ListedCase` from those items, scoped by the case's organisation as every read there is. The words follow the board: an email classified an invoice reads "Email, invoice"; an upload classified a proof of payment reads "Payment document"; an upload classified only an invoice keeps "Document", and an unclassified case keeps today's words.

**Corrected 2026-11-02 (plan review P2, `docs/reviews/07-app/D07-T04-s13.md`):** bank letters are classified by the `document.type` item (`src/invoice/payment-doc.ts`), whose detail type is `pop` or `bank_letter` (an uploaded invoice is `invoice` there), so the payment flag reads that item as well as `document.proof_of_payment`. Classification is per attachment and a case can carry several: the list returns two independent flags (invoice, payment) read with EXISTS, so one row per case and its counts and paging never change, and the words take payment over invoice only where the board does (an upload); an email takes its invoice word. Both layouts (the table and the phone card) are asserted case by case.
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

- [x] Return the stored classification on `ListedCase` from `listCases` in `src/db/case-list.ts`, scoped by the organisation. Done when: the test reads it from a stored invoice case. Cheaper substitute: guessing from the file name.
- [x] Draw "Email, invoice" for an email whose classification is an invoice, in the table and the phone card. Source: board `Cases` Type column. Done when: the page test reads "Email, invoice". Cheaper substitute: "Invoice" alone, dropping the channel.
- [x] Draw "Payment document" for an upload classified as a proof of payment or bank letter. Source: board `Cases` Type column. Done when: the page test reads "Payment document". Cheaper substitute: "Document" for every PDF.
- [x] Commit: `web: invoice and payment-document words in the cases list`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if an unclassified document reads "Payment document".

> **Verified:** 2026-11-04 | §13 | c661d4d185a99c874a33947505703f8811eed767
> **Review:** `docs/reviews/d07-t04-s13.json`

## 14. Multi-word search in the Cases list

> **Started:** 2026-11-01T06:53Z

A member who remembers "Remittance 4471", or a sender and a subject word, finds the case in one search: every word must match, in any order, across the subject, sender and file name. Filed 2026-10-31 from D07 T04 §7's completion review (G4): §7 matches the words as one contiguous run within one field.

**Corrected 2026-11-01 (plan):** measured against the tree. (1) The search is `listCases` in `src/db/case-list.ts` (one `instr(UNFOLDED, ?) > 0` over `fold(f.q)`, `UNFOLDED` being the folded `search_text` column or, for a row not yet folded, SQLite's `lower()` of the same fields); the page, the htmx results and the filtered-empty words in `src/web/pages/cases-view.tsx` all read the same `filters.q`, so the change is in the parsing and the WHERE clause and nothing else reads the query differently. (2) The words are parsed by a new `searchTerms(q)` beside `fold` in `src/db/search-fold.ts` (pure, tested in `test/db/case-search.test.ts`): curly quotes read as straight, a quoted run of words (`"advice 4471"`) is one term kept contiguous, an unmatched quote is dropped as a space, each term folded as `fold` folds (case, accents, `%` and `_` literal), the rest split on spaces, duplicates removed, at most 8 terms. (3) A search past 8 search terms uses the first 8 and says so ("Searching the first 8 search terms. A quoted phrase counts as one."), so a member is never silently given a wider result than they typed; the sentence is in the case-count status line and at the head of the results, the two regions the htmx swap already replaces, so the focused search input is never replaced. (4) Each term is one `instr` over the same folded text, ANDed, scoped by the organisation, so a case must contain every term; the cost is one pass over the organisation's rows as today. (5) The "No cases match ..." words and the CSV/stat panels are unchanged apart from naming the terms the way they were typed. (6) The existing test that held one contiguous run is replaced by the quoted-phrase case, not weakened: an unquoted run is now AND of its words, which finds it too.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases (board `Cases`)
**Job:** a member finds a case from the scraps they remember, in one search
**Treatment:** the same search box; only what it matches changes
**Chrome:** §1's page

**Build order:**

1. Parse the query into terms and require each. Done when: `test/db/case-search.test.ts` reads `searchTerms` for plain, quoted, curly-quoted, unmatched-quote, accented, `%` and over-long queries, and `test/web/cases-page.test.ts` finds "Remittance advice 4471" by "remittance 4471".
2. Say the cap, and prove the page. Done when: the page and the browser tests read the cap sentence and the results by keyboard, with and without JavaScript.

- [x] Add `searchTerms(q)` to `src/db/search-fold.ts` and use it in `listCases` (`src/db/case-list.ts`): each term a bound `instr(UNFOLDED, ?) > 0` joined by AND, scoped by the organisation, at most 8 distinct terms (a quoted phrase is one term, duplicates are one). Done when: the page test finds a case by "remittance 4471", by a sender word with a subject word and a file-name word, in any order, never by a word it lacks, and never another organisation's case. Cheaper substitute: OR across the words, which floods the list.
- [x] Keep a quoted phrase ("advice 4471") as one contiguous run, curly quotes included, an unmatched quote read as a space. Done when: `test/db/case-search.test.ts` and the page test read a quoted phrase matching only the contiguous text, and an unmatched quote searching the words. Cheaper substitute: dropping the quotes and splitting the phrase.
- [x] Prove which terms constrain, against the database: with nine distinct terms a case holding the first eight and lacking the ninth matches, a case lacking any one of the first eight does not, and with duplicates and a quoted phrase at the boundary the cap counts distinct parsed terms (eight terms including a phrase, then nine). Done when: `test/web/cases-page.test.ts` reads each of these through `listCases` on stored cases. Cheaper substitute: asserting only the sentence.
- [x] Say when the query was cut: past 8 search terms the first 8 are used and "Searching the first 8 search terms. A quoted phrase counts as one." is said in the case-count status line (`#case-count`, announced) and at the head of the results (`#case-results`, visible), both of which the existing htmx swaps replace, so the search form and its focused input are never replaced and the notice updates as the member types. Done when: the page test reads the sentence in both places for nine terms, for a mixed phrase-and-word query, and none for eight terms or fewer, and the browser test types nine terms, reduces to eight and clears the box, reading the notice and the announcement each time with the input still focused. Cheaper substitute: cutting silently.
- [x] Prove it in Chromium: the search box with a multi-word query through the htmx results and the plain form, a quoted phrase, the cap notice appearing and going with the focus kept, with and without JavaScript. Done when: `test/node/cases-browser.test.tsx` passes the additions. Cheaper substitute: server-rendered tests only.
- [x] Commit: `web: every search word matched, in any order`

**Test checkpoint:** `pnpm exec vitest run test/db/case-search.test.ts test/web/cases-page.test.ts` and `pnpm exec vitest run --project browser test/node/cases-browser.test.tsx` pass, and the page test fails if a search word the case lacks still finds it.

> **Verified:** 2026-11-01 | §14 | 50742aa926b7ab689fd9256db71462f868993f0b
> **Review:** `docs/reviews/d07-t04-s14.json`

## 15. Slash shortcut to the

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

A member presses `/` anywhere on the Cases list, outside a text field, and lands in the search box, as Gmail and GitHub let them. Filed 2026-10-31 from D07 T04 §7's completion review (G5): the board shows no shortcut or its hint, so the shortcut and how it is discovered are a design decision first.

> **Started:** 2026-11-02T22:51:03Z

**Corrected 2026-11-02:** the 2026-11-01 deferral is superseded by the operator decision of 2026-11-02 recorded below approving the shortcut, so the section builds now.

**Corrected 2026-11-02 (plan review P2s, `docs/reviews/07-app/D07-T04-s15.md`):** (1) WCAG 2.1.4 needs an off switch for a character-key shortcut: the hint beside the search carries a Turn off / Turn on button for the `/` key, stored in the browser (`localStorage` key `iil-slash-search`), restored on every load, and recorded in SPEC M1 with the shortcut. (2) Discoverability is built and asserted, not only documented: the placeholder names the key and a rendered hint reads "Press / to search" with the toggle. (3) The event contract is explicit: no firing from an input (the From and To dates included), textarea, select or contenteditable descendant, none with a modifier or during composition, the activating slash never enters the query, later slashes stay text, no box on the page means no interception, and focus stays in the box across the list's own swaps (the input sits outside `#case-results`). (4) The checkpoint runs the browser project.

**Phase:** 7
**Operator decision 2026-11-02:** Approve slash to focus the Cases search, the key named in the placeholder or a hint, never firing while typing in a field (recorded in SPEC M1 first).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases (board `Cases`), once the SPEC records the shortcut and its hint
**Job:** a keyboard user reaches the search in one keystroke
**Treatment:** the search box's placeholder or a hint names the key; the key never fires while typing in a field
**Chrome:** §1's page

**Build order:**

1. Record the owner's decision (the key, its hint) as a SPEC M1 change. Done when: `design/SPEC.md` M1 names the shortcut.
2. Focus `#case-search` on `/` in `src/web/client/app.ts`. Done when: `test/node/cases-browser.test.tsx` reads focus moved by the key and text typed in a field untouched.

- [x] Record the owner's decision on the key and its hint in `design/SPEC.md` M1. Done when: the SPEC names both. Cheaper substitute: a shortcut nobody can discover.
- [x] Focus `#case-search` on `/` outside editable controls, in `src/web/client/app.ts`, with the off switch the plan review requires: a Turn off / Turn on hint button whose state `localStorage` (`iil-slash-search`) restores on load. Done when: the browser test reads focus in the box after `/`, a `/` typed in the search box, a date input or a select stays text, modifiers and composition never fire it, turning it off stops it and turning it on restores it, and the activating slash never enters the query. Cheaper substitute: a key handler that swallows `/` in fields, or a shortcut with no off switch.
- [x] Render the hint: the placeholder names the key and "Press / to search" with the toggle stands beside the search box in `src/web/pages/cases-view.tsx`. Done when: the page test reads both.
- [x] Commit: `web: slash focuses the cases search`

**Test checkpoint:** `pnpm exec vitest run --project browser test/node/cases-browser.test.tsx` passes and fails if `/` typed in a field is swallowed.

> **Verified:** 2026-11-03 | §15 | 2721fcbe3a8ad0a618eb3243a7ba1cd01d2981c2
> **Review:** `docs/reviews/d07-t04-s15.json`

## 16. Live Cases search latency vs Gmail

> **Operator 2026-11-01 03:30 SAST:** skipped for the competition; not built (relayed by the coordinator).

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

## 18. Threat kinds by verdict

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

The line under the board's Malicious or suspicious tile ("5 phishing, 3 invoice, 1 impersonation"): each flagged case's kind, counted. Filed 2026-10-31 from D07 T04 §2's start: no check stores a case-level kind and no spec defines the set, so which kinds and which evidence decides each is the owner's decision first.

> **Started:** 2026-11-02T23:22:25Z

**Corrected 2026-11-02 (checked against the tree, the kind rule the operator decision leaves to record):** the three kinds are reporting buckets by positive evidence, not a proven taxonomy: a malicious or suspicious case of the week takes at most one kind, from its current run's evidence (`run_id = COALESCE(c.run_id, c.id)`, as in `src/db/case-list.ts`), in this order: invoice when the invoice classification of D07 T04 §13 is stored (`invoice.detected`, or `document.type` with type `invoice`); else impersonation on a positive finding only (`domain.lookalike` at medium or high severity, its info "not compared" items excluded, or `vision.brand_domain_mismatch` with detail `confirmed` true, its unconfirmed items excluded); else phishing on a lure or credential item (`link.credential_form`, `link.card_form`, `link.lure_button` or `walkthrough.credential_target`). A flagged case with none of these (a malware-only case, say) counts in no kind, so the line lists only the kinds present, descending, and never claims to sum to the tile. It draws nothing when no kind is present. A safe or unfinished case is never counted, ties keep the board's order (phishing, invoice, impersonation), and no subject or sender text is read. SPEC M1 records the set, this rule and the no-sum statement.

**Corrected 2026-11-02 (plan review P1/P2, `docs/reviews/07-app/D07-T04-s18.md`):** the tests prove the counting contract, not only the seeded counts: stale-run and conflicting-run evidence, several findings on one case counted once, precedence, another organisation's evidence ignored, SAST Monday boundaries and arrival-week allocation, partial cases with verdicts counted and unfinished excluded, and the breakdown reconciled against `weeklyCounts`' malicious plus suspicious (kinds at most that total). The rendered line is asserted for reversed counts and a tie, and in the browser at phone width in both themes.

**Phase:** 7
**Operator decision 2026-11-02:** The board's three kinds (phishing, invoice fraud, impersonation); SPEC M1 names the kind set and the verdict evidence that decides each.

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, stats panel (board `Cases`)
**Job:** an owner sees what kind of attacks reached the business this week
**Treatment:** the board's muted line under the number, kinds in descending count
**Chrome:** §2's stats panel

**Build order:**

1. Record the owner's set of kinds and the rule deciding each (from the verdict's evidence) in `design/SPEC.md` M1. Done when: the SPEC names both.
2. Count them in `weeklyStats` and draw the line. Done when: `test/web/stats.test.ts` reads it.

- [x] Record the owner's kinds and their deciding evidence in `design/SPEC.md` M1. Done when: the SPEC names both. Cheaper substitute: kinds guessed from subject words.
- [x] Count this week's malicious and suspicious cases by kind in `src/db/case-stats.ts`, by the corrected positive-evidence rule on the current run. Done when: the test reads the counts from seeded evidence and proves the plan review's counting contract (stale runs, one count per case, precedence, tenant isolation, SAST boundaries, arrival week, partial counted, unfinished excluded). Cheaper substitute: one kind per case read from the headline text.
- [x] Draw the line under the tile, kinds in descending count, ties in board order, nothing drawn when no kind is present. Source: board `Cases`. Done when: the page test reads "5 phishing, 3 invoice, 1 impersonation" from a seeded week and the reversed and tied weeks read in their order, and the browser test reads the line at phone width in both themes. Cheaper substitute: none.
- [x] Commit: `web: threat kinds under malicious or suspicious`

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if a safe case is counted in a kind.

> **Verified:** 2026-11-03 | §18 | e1aee461040539ed28977fccc1bd2027e49cb2d2
> **Review:** `docs/reviews/d07-t04-s18.json`

## 19. Reporting period choice

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

An owner exports exactly a calendar month or quarter of counts, without trimming the 12-week CSV by hand. Filed 2026-10-31 from D07 T04 §2's completion review (out-of-scope 1): the board offers one Export link, so a period control is a design change first.

> **Started:** 2026-11-03T00:11:38Z

**Corrected 2026-11-02 (the control and granularity the operator decision leaves to record):** beside the one-press 12-week export, the stats panel carries From and To SAST date fields with an Export period button, plus This month and This quarter links that carry the current calendar month's and quarter's dates. The export endpoint takes `from` and `to`, returns one row per week for the weeks overlapping the range (the CSV's own week rows, unchanged), and refuses a reversed range, a range over 2 years, or an unreadable date with the 400 page. SPEC M1 records this.

**Corrected 2026-11-03 (plan review P2s, `docs/reviews/07-app/D07-T04-s19.md`):** (1) The window is anchored to the requested end: `weeklyCounts` is called with the range's end as its `now` and enough weeks for both overlapping Mondays (two calendar years can overlap 106 weeks); an old range, the maximum range, a leap-year boundary, a same-day range, zero-count weeks and a period before the organisation existed are all tested. A future period exports the weeks that exist up to today, the rest not invented. (2) The rows are whole weeks: the panel says so beside the controls ("Whole weeks that overlap your dates"), October 2026 exports the weeks beginning 28 September to 26 October, and the checkpoint fails on a week that does not overlap, never on a day outside the month inside an overlapping week. An exact date-clipped export is deferred (see the Deferred line). (3) Validation: both dates required and readable as real calendar dates, `to` not before `from`, and the inclusive span at most 2 years (731 days to cover a leap year); each failure is its own test. The refusal is an HTML 400 page naming the problem with a link back to Cases, never an attachment. (4) Every export control carries the displayed organisation as `org`, as the existing link does, and a stale-organisation submission redirects to Cases as today; sign-in, membership and outage refusals stay pages, and a retry after an outage keeps `org`, `from` and `to`. (5) The From and To values survive the stats panel's own redraws: they are kept in `sessionStorage` and restored by `src/web/client/app.ts` after a swap, and clearing both fields clears the stored pair.

**Phase:** 7
**Operator decision 2026-11-02:** Calendar month and calendar quarter beside the one-press 12-week export, which stays the default (recorded in SPEC M1 first).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, stats panel, once the SPEC records the period control
**Job:** an owner hands a month's or a quarter's numbers to the business without spreadsheet work
**Treatment:** the one-press 12-week export stays the default; a period choice sits beside it
**Chrome:** §2's stats panel

**Build order:**

1. Record the owner's decision on the periods offered and the control in `design/SPEC.md` M1. Done when: the SPEC names both.
2. Take the period in `GET /cases/stats.csv` in `src/web/pages/cases.tsx`. Done when: `test/web/stats.test.ts` reads a month's rows only.

- [x] Record the owner's periods and control in `design/SPEC.md` M1. Done when: the SPEC names both. Cheaper substitute: free date fields with no validation.
- [x] Draw the period controls in `StatsPanel` (`src/web/pages/cases-view.tsx`): labelled From and To dates, Export period, This month and This quarter, each carrying the displayed `org`, the one-press export untouched. Done when: the browser test submits by keyboard, downloads the period file with its filename, works with scripts off, and reads the fields restored after a filter redraw, at phone width in both themes.
- [x] Take `from` and `to` SAST dates in `GET /cases/stats.csv`, bounded to 2 years, one row per week for the weeks overlapping the range, the window anchored to the range's end. Done when: the test reads October 2026's rows only (the weeks beginning 28 September to 26 October), and a reversed, over-limit, missing or unreadable date is refused with the HTML 400 page. Cheaper substitute: filtering the 12-week rows.
- [x] Commit: `web: chosen period for the counts export`

> **Resolved:** exact calendar-date totals -> XREF: D07 T04 §34. Verified 2026-11-04 at `e00c997f`: inclusive SAST daily CSV alongside the preserved whole-week export.

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if a row outside the period is exported.

> **Verified:** 2026-11-03 | §19 | 6231086ad6f80ce66f47980bcf62315f4c831629
> **Review:** `docs/reviews/d07-t04-s19.json`

## 20. Opt-in weekly counts

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

An owner who opts in receives the week's counts by email every Monday, with a one-step unsubscribe, instead of visiting Cases to export them. Filed 2026-10-31 from D07 T04 §2's completion review (out-of-scope 2): the console's Adjacency declares it sends nothing, so a recurring report is an owner decision first.

> **Started:** 2026-11-03T01:23:33Z

**Corrected 2026-11-03 (checked against the tree):** the checklist's "Monday's report" is the operator decision's Friday 16:00 SAST send, and the decision wins. The store is migration 0090 (coordinator, 2026-11-03): `weekly_report_optins` (organisation and member, with the opt-in time) and the send itself rides the mail ledger's send key (`weekly:<org>:<member>:<week Monday>`), which is what makes a second run of the Friday window send nothing twice and a refused send retry on the next run. The opt-in is set and cleared on the Account page (M9) for the member's active organisation, and every email carries a one-step unsubscribe link (signed, per member and organisation) that clears it without signing in. The send runs from the quarter-hour schedule when it is Friday 14:00 UTC (16:00 SAST).

**Corrected 2026-11-03 (plan review, `docs/reviews/07-app/D07-T04-s20.md`):** (1) Every member may opt in, not only owners: the section's "owner" wording is the Job's shorthand, and the acceptance test includes a plain member receiving the report. (2) The send window runs from Friday 16:00 SAST to Monday 00:00 SAST, so a refused send retries on the next quarter-hour tick inside the window with the same send key; a pending or uncertain delivery is never resent (the reconciler owns it). (3) Like the trial notices, the provider call is guarded: current membership in the report's organisation and a current opt-in are rechecked before every attempt, failing closed when the check cannot be read, and the two protected accounts are never sent to even when opted in. (4) The unsubscribe link is `GET /weekly-report/unsubscribe` with an HMAC over the organisation, the member and the opt-in time it was sent to: it never expires while that opt-in stands, a link from an earlier opt-in is stale once the member opts in again, replay after unsubscribing answers "already unsubscribed", a departed member's link still clears their row, a tampered link is refused with the 400 page, and a failed delete never reports success. The Account page is the way back in. (5) The email names the week as it stands on Friday ("Your week so far", Monday to Friday) with the organisation named, the three tiles' numbers (checked, malicious or suspicious, median time to verdict, "No verdicts yet" when there are none), and a link to Cases; counts are read at send time, so a retry inside the window recounts. (6) The proof drives the Account POST and GET, the real `scheduled()` branch, the unsubscribe route and the mail ledger against a stubbed provider, counting provider requests across repeated runs.

**Phase:** 7
**Operator decision 2026-11-02:** Per-member opt-in weekly counts email, Fridays 16:00 SAST, the three tiles' numbers and a link to Cases, never message content, one-step unsubscribe (who, when and what recorded in the SPEC).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` notifications, once the SPEC records the weekly report
**Job:** an owner sees the week's protection numbers without opening the console
**Treatment:** a plain email of the three tiles' numbers and a link to Cases, never message content
**Chrome:** the transactional email layout

**Build order:**

1. Record the owner's decision (who may opt in, the day and hour, the content) in `design/SPEC.md`. Done when: the SPEC names each.
2. Send it from the 15-minute schedule through the existing mail sender. Done when: a test reads one send per opted-in owner per week.

- [x] Record the owner's decision on the weekly report in `design/SPEC.md`. Done when: the SPEC names who, when and what. Cheaper substitute: a report sent to every member unasked.
- [x] Store the opt-in per member with a timestamp, set and cleared from Account settings, bound to the organisation the page displays. Done when: a test reads it set and cleared, read back on a fresh GET, with a member of two organisations holding one preference each. Cheaper substitute: an organisation-wide flag.
- [x] Send Friday's report once per opted-in member from the schedule, idempotent per week, a failed send retried by the mail sender. Done when: a test reads one send per member per week across repeated ticks in the window, none after an unsubscribe, none to a departed or protected member, and the rendered email carrying the week's three numbers and no case content. Cheaper substitute: a send on every schedule tick.
- [x] Commit: `mail: opt-in weekly counts report`

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if an unsubscribed member is sent the report.

## 21. Invitations panel on the Team page

> **Started:** 2026-10-31T21:49Z

The board's invite panel (an email and a role, Send invitation) and its Pending invitations table (Email, Role, Sent by whom, Expires, Resend and Revoke), with an invite whose email did not go marked and sent again. Moved 2026-10-31 from §3, which bundled it.

**Corrected 2026-10-31 (plan):** measured against the tree. (1) `src/web/pages/team.tsx` draws members only; its `POST /team` already runs Better Auth's handler in process, so the panel adds actions `invite`, `resend` and `revoke` to it (fields `email`, `invitation`) and the pending table reads the stored `invitation` rows (`status = 'pending'`, the organisation's, newest first, with the inviter's name), never a remembered answer. (2) "Email not sent" is read from the stored send, not from the 502 the page just saw: the newest `mail_sends` row whose `send_key` starts `invite:<id>:` (`src/auth/auth.ts` `inviteSendKey`) with a status other than `sent` marks the row ("email not sent", or "not known if it went" for `uncertain` and `pending`), so the mark survives a reload; Send again is a resend and a `sent` row clears it. (3) An invitation past its expiry stays in the table marked Expired, with Resend (which makes it fresh); Revoke removes it. (4) An owner may invite as Owner, Admin or Member, an admin as Admin or Member; any refusal Better Auth still gives is drawn as the field's error. (5) The board has no row mark or inviter beyond "Today 09:02 by Thandi N.", which is the invitation's creation time and first inviter. (6) A member sees neither the panel nor the table, and posting an invite action as a member is the same 403 as any `POST /team`.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team (board `Team`)
**Job:** an owner or admin brings a colleague in and sees who has not joined yet
**Treatment:** the board's panel above the members and the pending table under them
**Chrome:** §3's page

**Build order:**

1. Draw the panel and the pending table in `src/web/pages/team-view.tsx` and post invites, resends and revokes through Better Auth's endpoints in process. Done when: `test/web/team-page.test.ts` reads each action made.

- [x] Draw the invite panel for owners and admins (Invite by email, Role with Member default, Send invitation; roles by the reader: an owner Owner, Admin or Member, an admin Admin or Member) and post it through Better Auth's `invite-member` in process (D07 T02 §3's allowlist and send key), 303 back with "Invitation sent to <address>". Source: board `Team`. Done when: `test/web/team-page.test.ts` reads the invitation stored and its send recorded, the role choices per reader, and a member posting the action refused 403 with nothing stored. Cheaper substitute: inserting the invitation row directly.
- [x] Draw Pending invitations (Email, Role, "Today 09:02 by Thandi N.", Expires in SAST, Resend, Revoke) from the stored `invitation` rows of the active organisation only, for owners and admins, nothing of them for a member, and the explicit "No pending invitations" line (the invite panel still shown) when there are none. Source: board `Team`. Done when: the page test reads each column, an expired invitation marked Expired with Resend, another organisation's invitations absent, and the empty line before the first invitation and after the last is revoked. Cheaper substitute: the invitation ids.
- [x] Resend through `invite-member` with `resend: true` and Revoke through `cancel-invitation`, each confirmed in words after (Resend of an expired invitation makes it fresh; an invitation answered, revoked or accepted meanwhile reads "That invitation is no longer pending" from the stored state, a failed call is "could not be confirmed" with the table redrawn from storage, never "done", and a lost session returns to sign-in). Done when: the test reads a resend recorded, a revoked invitation gone from the table and refused at `/invite/:id`, an expired invitation renewed and acceptable, and each stale, failed and signed-out answer. Cheaper substitute: revoke hiding the row only.
- [x] Mark an invitation whose email did not go from the stored send, not from the answer just seen: the `mail_sends` row for the exact key `invite:<id>:<expiresAt as ISO>` of the invitation's current expiry (`src/auth/auth.ts` `inviteSendKey`); status `sent` is no mark, `uncertain` and `pending` read "not known if it went", `failed`, refused or no row read "email not sent", each with Send again, which is a resend; the mark clears only when the new key's row is `sent`. Done when: `test/web/team-page.test.ts` sends an invitation (mark absent), then a resend the sender refuses without a row (mark present after a fresh GET), then a resend that goes (mark gone), and reads the key format from a real send so a drift fails it. Cheaper substitute: a flag set on the 502.
- [x] Draw the panel's refusals (an existing member, an address that is not an address, the open-invitation limit of 100) as the field's error with the address kept, announced to assistive technology; the recipient allowlist is not one of them, because the invitation itself makes its address an invitee the allowlist admits (`isInvitee`, `src/mail/allowlist.ts`), and a per-recipient send limit shows as the saved invitation's "email not sent" mark. Done when: the test reads each refusal under the field. Cheaper substitute: the 403 page.
- [x] Prove the controls in Chromium in `test/node/team-invites-browser.test.tsx` (beside `test/node/team-browser.test.tsx`, whose members fixtures the panel does not touch): Send invitation, Resend, Send again and Revoke by keyboard with JavaScript and the same posts without it, the busy state, the address kept on a refusal, the outcome announced, and the axe rules at 360 and 1280 px in both themes. Done when: the browser test passes and fails if a control is unreachable by keyboard. Cheaper substitute: string assertions on the rendered page.
- [x] Commit: `web: invitations on the team page`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if a revoked invitation can still be accepted.

> **Verified:** 2026-11-01 | §21 | 7c653e865a15ecf66a74541699b90c96ef7c6bbd
> **Review:** `docs/reviews/d07-t04-s21.json`

## 22. Invite several colleagues at once

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

One submit invites several addresses with one shared role, each address's outcome listed and only the failed ones retried. Moved 2026-10-31 from §3; a SPEC change to the board `Team` first.

> **Started:** 2026-11-03T00:41:41Z

**Corrected 2026-11-03 (checked against the tree):** the invite field becomes a several-line field taking up to 20 addresses separated by commas or new lines, one shared role. Each address goes through its own `invite-member` request, as today, so the allowlist and send key run per address. The answer is the Team page with one outcome per address (sent, not sent, unknown, refused with its reason), and a Retry button that resubmits only the addresses that did not go. A single address keeps today's one-address flow and messages.

**Corrected 2026-11-03 (plan review P2s, `docs/reviews/07-app/D07-T04-s22.md`):** (1) The batch answer is its own server-rendered Team page (the signed one-name redirect outcome cannot carry it), with every address, its outcome and reason, and the pending table reread from storage. (2) Outcomes: sent (the request answered ok); not sent (a 502: the invitation stands, its mail did not go, Retry sends it through the same per-address request); unknown (the answer was lost: the stored invitations are checked first, one found reads "invitation made, check it below" and stays out of Retry, none found joins Retry); refused (already a member, already pending, a malformed address, the invitation limit, or throttling, each with its reason; the limit and throttling stop the batch and every unattempted address is listed as refused with that reason). (3) Parsing: commas, new lines and CRLF separate; whitespace trimmed; case-insensitive duplicates invite once and read "listed twice, invited once" (duplicates count once toward the limit); over 20 addresses refuses the whole submit with nothing sent and the field and role kept; the form reader's `email` bound rises to fit 20 addresses. (4) The batch and Retry keep the organisation binding, the owner/admin role rules and the member refusal; an organisation switched before Retry switches the answer as today. (5) Browser proof in `test/node/team-invites-browser.test.tsx`: the multiline field, shared role, keyboard submission, scripts-off submission, failure-only Retry, retained input, announced results, and wrapping at phone and desktop widths in both themes.

**Phase:** 7
**Operator decision 2026-11-02:** Multi-address invite approved: comma or newline separated, up to 20 addresses per submit, one shared role, an outcome listed per address and only the failures retried (recorded in SPEC M7 first).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, once the SPEC records the multi-address invite
**Job:** an owner brings a whole office in at once
**Treatment:** the invite field takes several addresses; the outcome lists each
**Chrome:** §21's panel

**Build order:**

1. Record the owner's decision on the multi-address invite in `design/SPEC.md` M7. Done when: the SPEC names it.
2. Send one invite request per address. Done when: `test/web/team-page.test.ts` reads ten outcomes.

- [x] Record the multi-address invite (separator, limit, outcome list) in `design/SPEC.md` M7. Done when: the SPEC names each. Cheaper substitute: a comma-separated field with one result.
- [x] Invite each address through its own request (the allowlist and its own send key, D07 T02 §3) and list each outcome (sent, not sent, unknown, refused), retrying only the ones that did not go. Done when: `test/web/team-page.test.ts` invites ten addresses with one submit, one refused by SMTP2GO, reads ten outcomes with their stored invitations, and a retry sends only that one; twenty addresses pass, twenty-one send nothing, duplicates send once, and a member or an over-reaching admin is refused on the batch and on Retry. Cheaper substitute: one request with a single overall result. Source: D07 T02 §3 completion review (Part 2 item 2).
- [x] Prove the batch in the browser in `test/node/team-invites-browser.test.tsx`: multiline field, shared role, keyboard and scripts-off submission, failure-only Retry, retained input and announced results at phone and desktop widths in both themes. Done when: the browser test reads each.
- [x] Commit: `web: invite several colleagues at once`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if a retry resends an address that went.

> **Verified:** 2026-11-03 | §22 | a08cf551a9719cf44ac57e6c11cc5b43f86dc79c
> **Review:** `docs/reviews/d07-t04-s22.json`

## 23. Team history for owners

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

The organisation's role changes, revocations and removals (D07 T02 §6's owner-only read), newest first, filtered by action and date, on the Team page for owners. Moved 2026-10-31 from §3; no board draws it, so a SPEC change first.

> **Started:** 2026-11-03T01:44:01Z

**Corrected 2026-11-03 (checked against the tree):** the page reads `readTeamHistory` (`src/auth/audit.ts`, the reader behind D07 T02 §6's owner-only endpoint) on the server, as every Team read does, filtered by the page's own `action`, `from` and `to` query values. Columns: When, What (the action in plain words), Who (the actor's name or email, "A member who has left" when they have), Whom, and Outcome. An owner who is no longer a member of the organisation reads nothing; admins and members never receive the section at all, not even its heading.

**Corrected 2026-11-03 (plan review P2s, `docs/reviews/07-app/D07-T04-s23.md`):** (1) Filters are a GET form (Apply and Clear) with the four stored actions (role changed, invitation revoked, member removed, member left); dates are SAST calendar days, both inclusive; an unknown action, an unreadable date or a reversed pair is a visible refusal on the section, never a silent all-actions read. (2) Names resolve inside this organisation only: a current member by name or email (the reader reads "You"), anyone else "A member who has left" or "An invitation that is gone" for a revoked invitation whose row is missing; no raw id is drawn when a name exists. (3) What and Outcome read an allowlist of the stored detail: a role change as "Role changed, Member to Admin", a removal saying whether its sessions ended (the writer stores that as a boolean, never a count), a refused attempt worded as refused, never raw JSON or an internal marker. (4) The list shows the latest 100 matches and says so when more exist; paging through matches is D07 T04 §24's, deferred there. (5) A failed history read draws the section's error with Try again and leaves the rest of the page standing; the proof is mounted `/team` requests after real changes.

**Phase:** 7
**Operator decision 2026-11-02:** Owner-only team history under the pending invitations, filtered by action and date (SPEC M7 names place, columns, filters and the empty and error states).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, once the SPEC records the history
**Job:** an owner sees who changed what on the team, and when
**Treatment:** a history table under the pending invitations, owners only
**Chrome:** §3's page

**Build order:**

1. Record the history's place and filters in `design/SPEC.md` M7. Done when: the SPEC names them.
2. Draw it from `GET /api/team/history` (D07 T02 §6). Done when: a rendered test reads it filtered.

- [x] Record the team history in `design/SPEC.md` M7 (place, columns, filters, empty and error states). Done when: the SPEC names each. Cheaper substitute: the raw audit rows.
- [x] Draw the history newest first, filtered by action and date, its empty and error states, for owners only. Done when: a rendered test shows it filtered, empty and failed, and an admin sees none. Cheaper substitute: history for every role. Source: D07 T02 §6 plan review.
- [x] Prove it in the browser: the filters by keyboard and with scripts off, the error and retry, at phone and desktop widths in both themes. Done when: `test/node/team-browser.test.tsx` reads each.
- [x] Commit: `web: team history for owners`

> **Resolved:** paging through history matches -> XREF: D07 T04 §24 (built and stamped there)

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if an admin sees the history.

> **Verified:** 2026-11-03 | §23 | eba24b50ee941887bdb36f68d419c4024515f8b1
> **Review:** `docs/reviews/d07-t04-s23.json`

## 24. Team history by person

Filter the team history by one person, as the actor or the target, in one step, paging through every match. Moved 2026-10-31 from §3.

> **Started:** 2026-11-03T02:56:56Z

**Corrected 2026-11-03 (checked against the tree, plan review `docs/reviews/07-app/D07-T04-s24.md`):** `readTeamHistory` takes only action, dates and cursor today, so the person predicate goes into it at the database layer, before its 100-row limit: organisation, action and dates, AND (actor is the person OR target is the person). The endpoint `GET /api/team/history` (D07 T02 §6) gains separate `actor` and `target` parameters with the same predicates. The page's person filter is one select of the organisation's members (plus Anyone), populated from the whole membership however §26's find stands, its selection restored on reload. Paging follows the reader's cursor: a More link carrying the cursor and every filter (person, action, dates, find), hidden at the end, and any filter change restarts from the first page. A malformed person, a person from another organisation, or a malformed cursor is refused in words on the page and as the endpoint's 400, never silently widened; a member who leaves after being chosen is answered plainly. People who have left stay named as §23 names them and are not offered in the select; choosing a departed person by name is D07 T04 §36's.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, as §23 records it
**Job:** an owner sees everything one person did or had done to them on the team
**Treatment:** a person filter beside §23's filters
**Chrome:** §23's history

**Build order:**

1. Add `actor` and `target` to `GET /api/team/history` and a person filter to the history. Done when: a rendered test pages through one person's changes.

- [x] Add `actor` and `target` to `GET /api/team/history` (D07 T02 §6) and a person filter, paging through every match. Done when: a rendered test picks a member and reads every change by and to them across pages, with endpoint tests in `test/auth/audit.test.ts` for the two parameters. Cheaper substitute: filtering one page in the browser. Source: D07 T02 §6 completion review (E2).
- [x] Prove the person select and More in the browser: keyboard and scripts-off, retained selection, both layouts, at phone and desktop widths in both themes. Done when: `test/node/team-browser.test.tsx` reads each.
- [x] Commit: `web: team history by person`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` and `pnpm exec vitest run test/auth/audit.test.ts` pass and fail if another person's change appears under the filter.

> **Deferred:** choosing a departed person in the history -> XREF: D07 T04 §36

> **Verified:** 2026-11-03 | §24 | 4229908ec060fb919f64214ec3a54b90852e3d80
> **Review:** `docs/reviews/d07-t04-s24.json`

## 25. Protected accounts refused on the Team page

> **Started:** 2026-11-01T04:39Z

> **Operator 2026-11-01 03:30 SAST:** the third-party Need is dropped, because the app lane's protected-accounts refusal is on main (D07 T02 §21, `src/auth/protected.ts`); build it when it is next in order (relayed by the coordinator).

The Team page's answer when an owner tries to remove a protected account (operator, 2026-10-31: demo@rizonetech.com in Fynbos Freight, `ZF5SufztotybeXIWVncExFAVu9GYZ8Fu`, and derick@rizonetech.com): a notice like the last-owner guard's, nothing changed. Moved 2026-10-31 from §3's plan review: the refusal itself is the app lane's change to the remove-member path in `src/auth/auth.ts` with the list in `src/auth/protected.ts`, not yet built, so this waits on it (Needs third-party until the app lane's section is named and merged here, then its ref joins Depends).

**Corrected 2026-11-01 (plan):** measured against the tree. (1) The app lane's refusal is on main (D07 T02 §21: the remove-member hook in `src/auth/auth.ts` answers 403 with code `PROTECTED_ACCOUNT` to an owner or admin who removes a protected member, and `src/auth/protected.ts` holds the list), and this section already depends on D07 T04 §3, so build-order step 1 is done: the edge is not needed and the Need is already none. (2) "No Remove on the row" is corrected to the page's own pattern for a control that cannot be used: Remove stays on the row as a disabled button whose reason is read ("This is a protected demo account"), as the only-owner Remove already is, so an owner sees why and a screen reader is told; a reader who could not remove the member anyway (a member, an admin on an owner) sees what they saw before and learns nothing of protection. (3) The typed-address route (`GET /team/remove/:id`) says the same notice instead of asking, and the in-process `remove-member` answer `PROTECTED_ACCOUNT` is the `protected` outcome whatever the page offered, so a stale page or a hand-made post gets the notice with nothing removed. (4) The Team page's tests run the protected members through the real removal endpoint (`POST /team`), not a fixture of the answer.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, last-owner guard's notice (board `Team`)
**Job:** an owner sees why a protected demo account cannot be removed
**Treatment:** the guard's notice, with the reason in words
**Chrome:** §3's page

**Build order:**

1. Refuse in words wherever the page offers or takes a removal. Done when: `test/web/team-page.test.ts` reads the disabled Remove and its reason on a fresh `GET /team`, the notice on `GET /team/remove/:id`, and the notice after a real `POST /team`, for both protected accounts.
2. Prove it in a browser. Done when: `test/node/team-browser.test.tsx` reads the reason's association and the announced notice, with and without JavaScript, in both themes at phone and desktop widths.

- [x] Add the app lane's protected-account section to this section's Depends and remove `third-party` once it is merged here. Done when: `validate` accepts the edge. Cheaper substitute: none. Corrected: done by the app lane's merge (D07 T02 §21, `src/auth/auth.ts` remove-member hook, `src/auth/protected.ts`), and `Needs` is already none; no edge is added because this section depends on D07 T04 §3, which the hook's page consumes.
- [x] Draw the protected member's Remove as a disabled control with its reason in `RemoveCell` (`src/web/pages/team-view.tsx`) for a reader who could otherwise remove the member (an owner on anyone else, an admin on an admin or member), both table and card layouts, naming `isProtectedAccount(member.email)` from `src/auth/protected.ts`; a reader who could not remove them anyway sees what they saw before. Done when: `test/web/team-page.test.ts` reads, on a fresh `GET /team`, the disabled Remove with `aria-describedby` or the existing disabled-reason text "This is a protected demo account" for demo@rizonetech.com and for derick@rizonetech.com as owner and admin readers, no active Remove link for them, and an unchanged page (no reason, no hint of protection) for a member reader and for an admin looking at an owner. Cheaper substitute: hiding the Remove button only.
- [x] Answer the typed-address route and the post with the notice: `GET /team/remove/:id` for a protected member the reader may remove returns 303 back with the `protected` outcome instead of the confirmation (`src/web/pages/team.tsx`), and `POST /team` `remove-member` maps Better Auth's `PROTECTED_ACCOUNT` answer (403, `src/auth/auth.ts`) to the same outcome, "<name> is a protected demo account and cannot be removed.", through `answerOf` and the `Outcome` list in `src/web/pages/team-view.tsx`. Done when: the test follows a real `POST /team` redirect for each protected account in a Fynbos Freight-like fixture and in an ordinary organisation, reads the notice, finds the membership row still stored, the audit row `refused-protected` written, no `removed` notice, and the direct confirmation URL never drawing a Remove form. Cheaper substitute: a generic "no permission" notice.
- [x] Prove the page in Chromium: extend `test/node/team-browser.test.tsx` with a protected member, reading the disabled Remove's accessible name and reason, a stale-page submission (the row's removal posted anyway) answered with the announced notice and the member kept, the direct URL path, with JavaScript on and off, in both themes at 360 and 1280 px with the accessibility rules. Done when: the browser test passes. Cheaper substitute: server-rendered text assertions only.
- [x] Commit: `web: protected accounts refused on the team page`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if a protected account can be removed, and `pnpm exec vitest run --project browser test/node/team-browser.test.tsx` passes.

> **Verified:** 2026-11-01 | §25 | 7d30dc570fa819b2486a0a8aa781dd9858eb8d33
> **Review:** `docs/reviews/d07-t04-s25.json`

## 26. Find a person on the Team page

> **Operator 2026-11-01 03:30 SAST:** deferred until after the competition; not built before then (relayed by the coordinator).

A search over the team's names and emails that finds one person in one step, keyboard focus kept and an explicit no-results line, for an organisation too large to scan. Filed 2026-10-31 from D07 T04 §3's completion review (out-of-scope 1): the board `Team` has no find control, so a SPEC M7 change is the owner's decision first.

> **Started:** 2026-11-03T02:13:59Z

**Corrected 2026-11-03 (checked against the tree):** the find field filters the members the page already read, by folded name or email (`fold` in `src/db/search-fold.ts`, the Cases search's folding), in the `find` query value, so a shared or bookmarked address keeps working and no other organisation's member can appear. The pending invitations and the team history are not the find's business and stay whole. With a find in place the field keeps the keyboard focus on the redrawn page.

**Corrected 2026-11-03 (plan review P2s, `docs/reviews/07-app/D07-T04-s26.md`):** (1) Only the displayed rows are filtered: owner counts, permissions and history name resolution keep the whole member list, so a hidden second owner still counts. (2) The find rides the management round trip: role forms, remove links, the confirmation and its Cancel, and the POST outcome redirects all carry `find`, and after a removal the page shows the remaining matches or the no-results line; a management outcome announcement takes focus precedence over the find field. (3) The find and history forms preserve each other's filters. (4) A find over 200 characters is refused in words with the whole team shown, never silently shortened. (5) The proof asserts exact member rows in both layouts with mixed-case and decomposed-accent fixtures, an identically matching person in another organisation, and browser focus after submitting, refining and clearing, with scripts off and on, at phone and desktop widths in both themes.

**Phase:** 7
**Operator decision 2026-11-02:** A find field above the members list, matching a name or email substring with case and accent folded, and 'No one on the team matches' for no result (recorded in SPEC M7 first).

**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, once the SPEC records the find control
**Job:** an owner of a large team reaches one person without scanning the list
**Treatment:** a search field above the members, as the Cases list's search
**Chrome:** §3's page

**Build order:**

1. Record the owner's decision on the find control in `design/SPEC.md` M7. Done when: the SPEC names it.
2. Filter the members by name or email in `src/web/pages/team.tsx`. Done when: `test/web/team-page.test.ts` finds one member and reads the no-results line.

- [x] Record the find control (place, what it matches, its no-results words) in `design/SPEC.md` M7. Done when: the SPEC names each. Cheaper substitute: the browser's own find.
- [x] Filter the members by a name or email substring, case- and accent-insensitive as the Cases search folds (`src/db/search-fold.ts`), in the query string. Done when: the page test finds one member by a name part and by an email part, reads "No one on the team matches", and never another organisation's member. Cheaper substitute: filtering in the browser only.
- [x] Prove the find in the browser: focus kept after submitting, refining and clearing, the management round trip keeping the find, with scripts off and on at phone and desktop widths in both themes. Done when: `test/node/team-browser.test.tsx` reads each.
- [x] Commit: `web: find a person on the team page`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if a search shows another organisation's member.

> **Verified:** 2026-11-03 | §26 | 98dc5baf9d0d0afce77eada66a7142f591b7bbd7
> **Review:** `docs/reviews/d07-t04-s26.json`

## 27. Add a single address and verify it by code

> **Started:** 2026-11-01T05:50Z

The board's second button and its address flow: "Add a single address" takes an address and mails it a code, and a page takes the code for a pending address (Continue). The JSON routes exist (D07 T02 §5: `/api/org/addresses`, `/code`, `/verify`); no page does. Filed 2026-10-31 from D07 T04 §4's start.

**Corrected 2026-11-01 (plan):** measured against the tree. (1) The JSON routes are `POST /api/org/addresses` (claim and send), `/addresses/code` (send again), `/addresses/verify` and `DELETE /addresses/:address` in `src/auth/domains.ts` (`domainRoutes`, `addressCode`, `proveByCode`); the pages call them in process as §4's page calls the domain routes (`domainRoutes.fetch` with the member's cookie and the app's origin), so their hooks, limits and audit rows run unchanged and nothing is reimplemented. (2) The domain claim page (`src/web/pages/domains.tsx`, `domains-view.tsx`, D07 T02 §15) is the pattern: a private `GET` and a `POST` with the signed redirect outcome, the organisation named by the form and checked, owner and admin only. This page mirrors it for an address in new files `src/web/pages/addresses.tsx` and `addresses-view.tsx`; the code state it reads (`expires_at`, `attempts`, `locked_until`, the next-code time) is read by a new `addressClaimView` beside `domainClaimView` in `src/auth/domains.ts`, with its type in `src/auth/domain-claim.ts`. (3) `/settings/addresses/remove/<address>` is already the removal confirmation; the address page is constrained to an address's shape (one segment containing `@`), so `remove` is never read as an address, and an address that is not the organisation's own answers as no such claim. (4) A verified address is shown on the page as verified, with how it was proved, and the page answers a claim of another organisation or none as the same not-found, revealing nothing. (5) The board's second button in the empty state ("Add a single address") joins "Add a domain" here, and a pending address's Continue opens the page; the Addresses table's pending rows already carry no Continue, so the link is added by this section. (6) The SPEC M8 states are recorded first, in this section's first commit, as the plan's order requires.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M8 Domains and addresses (board `Domains`; the code page follows the domain claim page, board `Verify-Domain`, once the SPEC records it)
**Job:** an admin lets one address, not a whole domain, forward mail for checking
**Treatment:** an Add a single address field on the Addresses table; a pending address's Continue opens a page that takes the mailed code, with Send a new code
**Chrome:** §4's page and the claim page's pieces (D07 T02 §15)

**Build order:**

1. Record the address page's states in `design/SPEC.md` M8. Done when: the SPEC names each state below.
2. Build the add form and the address page through the address routes in process. Done when: `test/web/addresses-page.test.ts` adds, sends, verifies with the code the stubbed sender captured, refuses, and reads the stored claim and the sender lookup.
3. Prove the controls in Chromium. Done when: `test/node/addresses-browser.test.tsx` passes by keyboard, with and without JavaScript, in both themes at 360 and 1280 px with the accessibility rules.

- [x] Record the address claim page's states in `design/SPEC.md` M8 first: add (sent, uncertain, failed with the claim kept, already verified, not an address, taken by another organisation, too many pending, send limits), a pending address with no code, a code mailed (with when it was sent and its lifetime), a wrong code (attempts left), locked (until when), expired, no code waiting, malformed, taken by another organisation meanwhile, gone, unavailable, and verified. Done when: the SPEC names each with its words and next step. Cheaper substitute: a form with no states.
- [x] Add `addressClaimView(db, orgId, address)` to `src/auth/domains.ts` beside `domainClaimView` (type in `src/auth/domain-claim.ts`): the claim's state, when it was verified and how, and the code's `expires_at`, `attempts`, `locked_until` and next-code time, read only for the organisation's own address. Done when: `test/auth/domains.test.ts` reads each state and null for another organisation's or no claim.
- [x] Add "Add a single address" to §4's page (`src/web/pages/domains-list.tsx`, `domains-list-view.tsx`): a field and Add on the Addresses table and as the empty state's second action, `POST /api/org/addresses` in process, then 303 to the address page with the outcome carried signed: sent ("A code was mailed to <address>"), uncertain (202: "The code may not have gone; check the inbox before sending another", the claim kept), failed (502: "The code could not be sent. The address is saved as pending; send a new code from its page", the claim kept), already verified ("<address> is already verified"), and the refusals under the field with the typed address kept (not an address, verified by another organisation, too many waiting, the code limits). Done when: the page test reads each outcome through the mounted page and a fresh `GET`, and that a failed or uncertain send leaves the pending claim and its Continue. Cheaper substitute: the API only.
- [x] Build the address page `GET` and `POST /settings/addresses/:address` in `src/web/pages/addresses.tsx` and `addresses-view.tsx` (the address constrained to one segment containing `@`, so `/settings/addresses/remove/...` is never read as an address; another organisation's address or none the same not-found page; owner and admin only, a member the role refusal page), mirroring `domains.tsx`: the signed redirect outcome, the organisation named by the form and checked, a post from another origin refused. Done when: the page test reads the page for an owner, a member, a foreign address and a missing one, and the origin and organisation checks.
- [x] Draw every state with its words and a usable next step: the code field with Verify; Send a new code with the remaining wait from the challenge read, disabled with an associated reason and a stated time while waiting and while locked (the lock time stated), enabled with the controls working again once the deadline passes; a wrong code with the attempts left; expired (send a new one); no code waiting (send one); malformed (six digits); taken by another organisation meanwhile (409, the claim cannot be verified, remove it); gone (404, back to the list); unavailable (503, the retryable page); and verified. None may say verified unless the stored claim is. Done when: the page test reads each state and next step, advances the clock across the lock and the wait and finds the controls enabled and a new code verifying, and proves a resent code invalidates the previous one (the old code is refused, the new verifies). Cheaper substitute: one generic failure line.
- [x] Prove the verification is real: send a code, take the code the stubbed sender captured, verify it through the page, then read the stored `org_addresses` row as verified, a fresh `GET` of the address page and of the Domains table showing it verified, the sender lookup (`findMemberBySender`) recognising the address, and the audit row of each attempt; with a wrong code, another organisation's claim and a verified-elsewhere address kept as negatives. Done when: the page test passes and fails if a wrong code verifies an address or another organisation's claim is read. Cheaper substitute: an audit row alone.
- [x] Give a pending address's Continue its link in §4's table. Done when: the page test reads it and its target.
- [x] Prove the flow in Chromium (`test/node/addresses-browser.test.tsx`): the empty-state and the table entry points, Continue, Add, Verify and Send a new code reached and operated by keyboard, their busy states and held controls, the typed address kept after a refusal, field errors associated with the field, each outcome announced, with and without JavaScript, in both themes at 360 and 1280 px with the accessibility rules run on every state. Done when: the browser test passes. Cheaper substitute: rendered-HTML tests only.
- [x] Commit: `web: add a single address and verify it by code`

**Test checkpoint:** `pnpm exec vitest run test/web/addresses-page.test.ts test/auth/domains.test.ts` and `pnpm exec vitest run --project browser test/node/addresses-browser.test.tsx` pass, and the page test fails if a wrong code verifies an address or another organisation's claim is read.

> **Verified:** 2026-11-01 | §27 | 0c3c955c9e4ca086d951ca1ff33f49ec91748d45
> **Review:** `docs/reviews/d07-t04-s27.json`

## 28. Verifier's name on the Domains page

> **Started:** 2026-11-01T15:14:26Z

**Corrected 2026-11-01:** D07 T02 §24 is Verified on `main` (migration 0058 deployed), so the wait in Build order step 1 is met. A single address draws its verifier in its "Why it is allowed" wording ("Single address, confirmed by a code on 12 Oct 2026 by Thandi N."); a verified domain's "Anyone @domain" row keeps "The whole domain is verified", because the Domains table already names that domain's verifier.

The board's "How it was proved" reads "DNS TXT record, 12 Oct 2026 by Thandi N."; the page draws the method and the date only, because the verifying member was not stored (`design/SPEC.md` M8 Deviation, D07 T04 §4). The app lane's D07 T02 §24 stores it (migration 0058 `verified_by` on `org_domains` and `org_addresses`, written by both verification paths) and serves it as `verifiedBy: { kind: "member"; name } | { kind: "former" } | null` from `GET /api/org/domains` and `domainClaimView`. This section reads and draws it, and closes the Deviation. Filed 2026-11-01 at the app lane's request.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M8 (board `Domains`)
**Job:** an owner sees who proved a domain or address, and when
**Treatment:** the board's "by Thandi N." after the method and date, in the How it was proved cell
**Chrome:** §4's page

**Build order:**

1. Once D07 T02 §24 is on main (the app lane lists this section as its Deferred owner; the dependency edge is added when its row reaches this tree), read `verifiedBy` for the rows in `readClaims` and draw it in `provedText`. Done when: `test/web/domains-list.test.ts` reads each state through the mounted page.

- [x] Read `verifiedBy` for verified domains and addresses in `readClaims` (`src/web/pages/domains-list.tsx`) through the shared verifier reader the app lane serves (never the raw user id), for every role, read-only. **Corrected 2026-11-01 (plan review P2):** `GET /api/org/domains` refuses ordinary members (`src/auth/domains.ts:597`), so the page cannot read through it; export the organisation-scoped `verifierSql` and `verifiedByOf` from `src/auth/domains.ts` (the management API's restrictions unchanged) and select the verifier in `readClaims`' own queries. Done when: `test/web/domains-list.test.ts` verifies claims through the real verification paths and finds the name in the table for an owner, an admin and a member, and a verifier who belongs only to another organisation reads as a former member here. Cheaper substitute: inserting `verified_by` directly.
- [x] Draw the four states in `provedText` (`src/web/pages/domains-list-view.tsx`): a named member "by Thandi N." (first name and last initial, as the Team page's pending table), an unnamed member by their email's local part, a departed member "by a former member", and none (old claims, pending ones) with the method and date only. Done when: the view test reads each wording, and an escaped hostile name. Cheaper substitute: the name unabbreviated.
- [x] Close the SPEC M8 Deviation (D07 T04 §4) for the verifier's name, and keep any part that still differs. Done when: `design/SPEC.md` M8 no longer lists the omission and `design/tools/check-design.py` passes. Cheaper substitute: leaving the Deviation.
- [x] Prove the cell at both widths and in both themes. Done when: `test/node/domains-list-browser.test.tsx` passes with a named verifier. **Corrected 2026-11-01 (plan review P2):** the browser test asserts the visible verifier wording on a domain row and a single-address row at 360 px and 1280 px in both themes, so it fails when either visible attribution is removed. Cheaper substitute: rendered-HTML tests only.
- [x] Commit: `web: the verifier's name on the domains page`

**Test checkpoint:** `pnpm exec vitest run test/web/domains-list.test.ts` passes and fails if a member's id is drawn instead of their name.

> **Resolved:** unambiguous verifier identity and the exact verification time, one activation from the proved cell -> XREF: D07 T04 §29. Resolved 2026-11-02 by D07 T04 §29 in `a85f4ac4`, `fa6c7e71` and `022754d9`: the proved cell's native disclosure (`VerifierDetail`) with the full name, account email and exact SAST time for a current member, and "a former member" with the date for a departed one, keyboard-operable with no JavaScript at both widths in both themes.

> **Verified:** 2026-11-01 | §28 | 8eb8c1e2b6df979d9184c68dd5fee7ccff3ebfed
> **Review:** `docs/reviews/d07-t04-s28.json`

## 29. Verifier detail on the Domains page

> **Started:** 2026-11-02T04:38Z

> **Corrected 2026-11-02 (validation before build):** the shared verifier reader yields the name, else the email, as one string (`verifierSql`, `src/auth/domains.ts:111`), so a named member's email is not available to the page. Item 2 below is corrected to read the email through the same org-scoped reader (the Team page already shows members' emails to the organisation, `src/web/pages/team-view.tsx:617`), never the raw user id.

§28 draws "by Thandi N." and the date, as the board writes it; two members can share that abbreviation ("Thandi Nkosi" and "Thandi Ndlovu") and the exact time is not shown (D07 T04 §28's completion review, 2026-11-01). This section adds a detail view, one keyboard-accessible activation from the row, that names the current-member verifier unambiguously and shows the verification time with its timezone. A former member stays "a former member": nothing new about a departed member is shown. Filed 2026-11-01 from §28's completion review.

**Operator decision 2026-11-01 21:27 SAST (through the coordinator):** option A, disclosure in the proved cell. A native disclosure on the proved wording opens in place with the verifier's full name and email and the exact verification time in SAST, keyboard-accessible with no JavaScript, on the table and the phone list; a former member opens the same place and reads only "a former member" and the date. The brief is in `docs/phase-runs/2026-11-01-console-phase-7.md` at `2512b42c`. Recorded 2026-11-01 by the successor coordinator (reed-planetoid) after the operator confirmed the decision had already been made but was nowhere in the record.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M8 (board `Domains`); the M8 extension below is the design to approve first
**Job:** an owner tells two same-abbreviation verifiers apart and reads the exact verification time
**Treatment:** one activation from the proved cell to a detail view with the full name and the time in SAST
**Chrome:** §4's page

**Build order:**

1. Extend `design/SPEC.md` M8 with the detail view (its control, states and wording) and get the operator's approval of that extension before any code. Done when: M8 names the control and `design/tools/check-design.py` passes.
2. Serve the detail from `readClaims`' verifier read (`src/web/pages/domains-list.tsx`), never the raw user id, for every role, read-only. Done when: `test/web/domains-list.test.ts` reads the full name and the SAST time for a current member and "a former member" with no name for a departed one.
3. Draw the detail view beside the proved cell (`src/web/pages/domains-list-view.tsx`), reachable and closable by keyboard alone. Done when: `test/node/domains-list-browser.test.tsx` opens and closes it by keyboard at 360 px and 1280 px in both themes.

- [x] Extend `design/SPEC.md` M8 with the verifier detail view and record the operator's approval in the section. Done when: M8 names the control, its states and its wording, and `design/tools/check-design.py` passes. Cheaper substitute: building the view with no SPEC entry. **Added 2026-11-02 (plan review P1):** the extension also covers verified single-address rows' "Why it is allowed" wording in both layouts; "Anyone @domain" rows keep "The whole domain is verified" with no disclosure. **Approved 2026-11-02 06:56 SAST (coordinator, overnight authority, inbox):** M8b as drafted implements the operator's own 2026-11-01 21:27 Option A decision, so no new operator decision is needed.
- [x] Read the verifier's full name, email and verification time in `readClaims` (`src/web/pages/domains-list.tsx`) through the shared verifier reader extended with the member's email from the same org-scoped join, for every role, read-only, never the raw user id. Done when: `test/web/domains-list.test.ts` finds the full name, the email and the SAST time on the page for an owner, an admin and a member. Cheaper substitute: drawing the abbreviated name again.
- [x] Keep a departed verifier as "a former member" with no name and no added detail (`src/web/pages/domains-list-view.tsx`). Done when: the page test removes the verifier's membership and finds no name in the detail. Cheaper substitute: showing the departed member's stored name. **Added 2026-11-02 (plan review P1):** the disclosure stays operable and shows "a former member" with the date; the returned HTML carries no name, email or user id of the departed verifier, including departure while the user still belongs to another organisation.
- [x] Draw the detail view (`src/web/pages/domains-list-view.tsx`) as one keyboard-accessible activation from the proved cell, closable by keyboard, at both widths. Done when: `test/node/domains-list-browser.test.tsx` opens and closes it by keyboard at 360 px and 1280 px in both themes. Cheaper substitute: a hover-only title. **Added 2026-11-02 (plan review P2):** Tab reaches the visible layout's summary, opening and closing run by keyboard with hidden/visible/hidden assertions and retained focus, the no-JavaScript matrix is covered, and axe plus overflow run with the disclosure open in both themes and widths including long names and emails.
- [x] Commit: `web: verifier detail on the domains page`

**Test checkpoint:** `pnpm exec vitest run test/web/domains-list.test.ts` and `pnpm exec vitest run --project browser test/node/domains-list-browser.test.tsx` pass; the page test fails if a departed verifier's name is drawn. **Added 2026-11-02 (plan review P1/P2):** row-scoped detail assertions from a fresh mounted GET use a named verifier distinct from the reader with two verifiers sharing an abbreviation, expected emails through the extended org-scoped reader, the SAST time including a UTC-to-SAST date rollover, email-only wording for an unnamed member, and no disclosure when no verifier was recorded.

> **Verified:** 2026-11-02 | §29 | e4b0dc807387ac790eb3921829a0ebfc07968b5c
> **Review:** `docs/reviews/d07-t04-s29.json`

## 30. Calendar month and quarter ranges in the Cases list

A member looking at one month's checks picks the month instead of typing its first and last days. Filed 2026-11-02 from D07 T04 §8's completion review (out-of-scope G6): the approved treatment is two date inputs, so a named-period choice is a design change first.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, once the SPEC records the named-period control
**Job:** a member sees a named month or quarter of cases in one choice
**Treatment:** a Month and Quarter choice beside the period, filling the From and To of §8
**Chrome:** §1's filters

**Build order:**

1. Record the named periods and control in `design/SPEC.md` M1 with the operator's approval. Done when: the SPEC names them.
2. Fill §8's range from the chosen period. Done when: `test/web/cases-page.test.ts` reads a month's cases only.

- [ ] Record the Month and Quarter choice in `design/SPEC.md` M1 and on the board with the operator's approval. Done when: M1 names the control and its states. Cheaper substitute: more fixed day counts, which never name a calendar month.
- [ ] Add the named-period choice to `Filters` in `src/web/pages/cases-view.tsx`: choosing a month or quarter sets `from` and `to` to its SAST calendar bounds through `casesHref`, and the active range of §8 shows it. Done when: the page test reads October 2026's cases only after the choice, with the dates in the address. Cheaper substitute: a second date filter beside §8's, which can disagree with the range it fills.
- [ ] Commit: `web: calendar month and quarter ranges in the cases list`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if a case outside the named month is listed.

## 31. Saved Cases views

A member who runs the same investigation every week saves its filters once and reopens them in one choice. Filed 2026-11-02 from D07 T04 §8's completion review (out-of-scope G7): nothing in the console stores a named view today, and the store, its permissions and its surface are their own design.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, once the SPEC records the saved-views control
**Job:** a member reopens a named set of Cases filters in one choice
**Treatment:** a saved view stores the whole filter set of §1, §7 and §8 and applies it through the address
**Chrome:** §1's filters

**Build order:**

1. Design the saved-views control and store. Done when: the SPEC names it and a migration the coordinator numbers stores a view per member.
2. Build save, apply, rename and delete. Done when: `test/web/cases-views.test.ts` reopens a saved view with its filters intact.

- [ ] Record the saved-views control, its states and its store in `design/SPEC.md` M1 with the operator's approval. Done when: M1 names the control, the empty, error and delete states. Cheaper substitute: browser bookmarks, which the member manages outside the product and cannot share with the team.
- [ ] Store a member's saved views (a migration the coordinator numbers, and its reads in `src/db/case-views.ts`), scoped to the member and their organisation. Done when: the test reads a member's own view back and refuses another member's and another organisation's. Cheaper substitute: storing views in the address only, which is the bookmark again.
- [ ] Draw save, apply, rename and delete in `Filters` in `src/web/pages/cases-view.tsx`, applying a view through `casesHref` with every filter it stored. Done when: `test/web/cases-views.test.ts` saves a filtered list, reopens it with verdict, channel, search and range intact, renames it, and deletes it with the list unchanged. Cheaper substitute: applying only the dates, which silently drops the rest of the investigation.
- [ ] Commit: `web: saved cases views`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-views.test.ts` passes and fails if a saved view loses a filter or another member's view is read.

## 32. Searchable Checked by picker

A member of a larger team finds a colleague by typing part of their name or email instead of scrolling the Checked by select. Filed 2026-11-02 from D07 T04 §10's completion review (out-of-scope G5): the approved treatment is a native select, so a searchable picker is a design change first.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, once the SPEC records the picker
**Job:** a member filters to one colleague's cases by typing their name or email
**Treatment:** a searchable picker over the same member ids §10 filters by
**Chrome:** §1's filters

**Build order:**

1. Record the picker and its shortcut in `design/SPEC.md` M1 with the operator's approval. Done when: M1 names them.
2. Build the picker over `membersOf`. Done when: `test/web/cases-page.test.ts` filters by a typed email fragment.

- [ ] Record the searchable picker, its open, empty and chosen states and its keyboard shortcut in `design/SPEC.md` M1 and on the board with the operator's approval. Done when: M1 names the control and its states. Cheaper substitute: a longer select, which a forty-person team scrolls.
- [ ] Build the picker in `Filters` (`src/web/pages/cases-view.tsx`) over the members `src/web/pages/cases.tsx` reads: typing a name or email fragment narrows to matching members, Enter chooses one and sets `checker` as §10 reads it, Esc closes it unchanged. Done when: the page test filters by a typed email fragment and the browser checkpoint chooses a member by keyboard alone. Cheaper substitute: browser find in the open select, which never reaches a member by their email.
- [ ] Commit: `web: searchable checked by picker`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if a typed fragment lists another member's cases.

## 33. Suggest the DNS host's own guide

An owner adding a TXT record is shown the guide for their actual DNS host first, found from the domain's nameservers, instead of finding their provider in the list. Filed 2026-11-02 from D07 T04 §11's completion review (out-of-scope item 12): §11's approved treatment is written guidance for everyone, and host discovery is its own integration.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` A5 Verify a domain, once the SPEC records the suggestion
**Job:** an owner opens the verification page and their provider's steps are already the ones in front of them
**Treatment:** read the domain's nameservers, suggest the matching provider's steps from §11, and keep the full list one action away
**Chrome:** D07 T02 §15's page

**Build order:**

1. Record the suggestion and its correction in `design/SPEC.md` A5 with the operator's approval. Done when: A5 names it.
2. Suggest from the nameservers. Done when: `test/web/domains-page.test.ts` suggests Cloudflare for a Cloudflare-hosted domain and keeps the list.

- [ ] Record the nameserver-based suggestion, its wrong-suggestion correction and its failure state in `design/SPEC.md` A5 and on the board with the operator's approval. Done when: A5 names the suggestion and how the owner corrects it. Cheaper substitute: guessing from the registrar's name, which is wrong whenever DNS lives elsewhere.
- [ ] Read the claimed domain's nameservers beside the claim read in `src/web/pages/domains.tsx` and open the matching provider's steps from §11 (`ProviderHelp` in `src/web/pages/domains-view.tsx`) as the suggested one, the rest closed and reachable. Done when: the page test suggests the right provider for two different hosts, a lookup failure suggests none and loses nothing, and choosing another provider sticks. Cheaper substitute: preselecting by the domain's registrar field, which §11's own guidance says does not decide where DNS lives.
- [ ] Commit: `web: suggest the dns host's own guide`

**Test checkpoint:** `pnpm exec vitest run test/web/domains-page.test.ts` passes and fails if a Cloudflare-hosted domain is suggested the generic steps first.

## 34. Exact calendar-period counts export

> **Started:** 2026-11-04T08:54:12.733199+00:00

An owner exports counts clipped to the exact calendar dates chosen, not whole overlapping weeks. Filed 2026-11-03 from D07 T04 §19's plan review (P3): §19's approved whole-week export cannot give exact calendar-month or quarter totals.

**Coordinator decision 2026-11-04:** `exact-counts-surface-approved` authorizes the second Daily counts CSV submit button in the existing From/To form, name=exact/value=1, native required dates and existing refusal paths. `docs/specs/2026-11-04-exact-counts-export-design.md` records the scoped contract; coordinator owns its M1 SPEC incorporation, required before completion. No shared SPEC edits by console.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases, stats panel, and the coordinator-approved `docs/specs/2026-11-04-exact-counts-export-design.md`; shared SPEC incorporation is required before completion
**Job:** an owner hands finance a month's exact numbers
**Treatment:** one row per day inside the chosen dates, the whole-week export beside it unchanged
**Chrome:** §19's export controls

**Build order:**

1. Record the clipped export and its day rows in `design/SPEC.md` M1. Done when: the SPEC names both.
2. Clip the counts to the dates. Done when: `test/web/stats.test.ts` reads only the chosen dates' rows.

- [x] Record the exact-period export, its day rows and its filename in `design/SPEC.md` M1 beside §19's whole-week export. Done when: the SPEC names them. Cheaper substitute: presenting whole weeks as a month's totals.
- [x] Take `from` and `to` in `GET /cases/stats.csv` with `exact=1` and count arrivals by SAST day in `src/db/case-stats.ts`, one row per day in the range, the same validation and organisation binding as §19. Done when: the test reads the chosen dates only and a case on an adjacent day is absent. Cheaper substitute: trimming week rows by hand.
- [x] Add the Daily counts CSV submit button and labelled required inputs to the existing form in `src/web/pages/cases-view.tsx`, preserving weekly actions and date read-back after redraw. Done when: `test/node/cases-browser.test.tsx` downloads daily counts by keyboard at 360 px in both themes, preserves dates and weekly exports, and reports no overflow or missing accessible names. Cheaper substitute: an unbound link or a second independent date-state control. Source: coordinator exact-counts surface approval.
- [x] Prove exact SAST bounds, zeros, state/median totals, same-day/leap-day/maximum-span cases, privacy and tenant/refusal behaviour in `test/web/stats.test.ts`. Done when: adjacent dates and other organisations never enter rows, each day's counts reconcile, and invalid or unauthorised requests never download a CSV. Cheaper substitute: checking only a happy-path month total. Source: approved companion contract.
- [x] Commit: `web: exact calendar-period counts export`

**Test checkpoint:** `pnpm exec vitest run --project worker test/web/stats.test.ts` and `pnpm exec vitest run test/node/cases-browser.test.tsx -t "daily counts|exports a chosen period"` pass and fail if a case outside the selected dates is exported or the daily submitter loses its mode, keyboard path or chosen dates. The 360 px both-theme proof and actual M1 SPEC incorporation are required before completion.

> **Verified:** 2026-11-04 | §34 | e00c997f81fd67b61b150265c77d7e930310f55f
> **Review:** `docs/reviews/d07-t04-s34.json`

## 35. Phone forwarding guidance on the Cases page

> **Started:** 2026-11-04T09:19:08.030238+00:00

The Cases first-run page tells a member on a phone how to forward mail from desktop Outlook, Outlook on the web and Gmail (`HOW_TO` in `src/web/pages/cases-view.tsx`), but not from a phone mail app, and it does not say when uploading the file instead is the better route (D07 T01 §14 completion review, 2026-11-02). A member whose only device is a phone is left to guess the step this page exists to teach.

**Coordinator scope correction 2026-11-04:** research/plan approved at11:09SAST. Official sources establish desktop original-message paths, not mobile original-file export. The companion `docs/specs/2026-11-04-phone-forwarding-guidance-design.md` proposes honest Apple Mail/Gmail desktop fallbacks and upload of an already saved original file or clearly limited screenshot/PDF. Exact wording approval and coordinator-owned M1 incorporation are required; no invented mobile save command.

**Phase:** 7
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 (Cases, first-run state), board `Cases-Empty`
**Job:** a member on a phone forwards a suspicious email as an attachment, or uploads it, without guessing
**Treatment:** the first-run how-to tiles name verified desktop fallbacks for phone apps and when an already saved file can be uploaded, with original-header limits
**Chrome:** `EmptyState` (§8 of D07 T01) on the Cases page (D07 T04 §1)

**Build order:**

1. Name the phone steps in `design/SPEC.md` M1. Done when: M1 names the phone mail app steps and the upload choice, and `python3 design/tools/check-design.py` passes.
2. Draw the phone guidance in the first-run how-to tiles (`src/web/pages/cases-view.tsx`). Done when: `test/node/cases-browser.test.tsx` reads the phone steps and the upload choice at 360 px in both themes.

- [ ] Obtain coordinator approval and incorporation of the exact source-backed companion wording into `design/SPEC.md` M1, naming Apple Mail/Gmail desktop fallbacks and existing-file upload limits. Done when: M1 names each step and `python3 design/tools/check-design.py` passes. Cheaper substitute: leaving the desktop-only steps, which a phone member cannot follow.
- [ ] Draw the phone steps and the upload choice in the `HOW_TO` tiles of `FirstRun` (`src/web/pages/cases-view.tsx`), beside the desktop steps. Done when: the page at 360 px shows each phone step without overflow in both themes. Cheaper substitute: a help link away from the page the member is on.
- [ ] Prove it in `test/node/cases-browser.test.tsx`: the first-run page at 360 px in both themes with scripts on and off reads the phone fallback steps, original-header limits and upload choice, follows Upload a file by keyboard to the rendered upload form, and the desktop steps are unchanged. Done when: the test passes and fails with the phone tile removed.
- [ ] Commit: `web: phone forwarding guidance on the Cases page`

**Test checkpoint:** `pnpm exec vitest run test/node/cases-browser.test.tsx` passes with the phone guidance read at 360 px in both themes.

## 36. Choose a departed person in the team history

An owner investigating someone who has left the team cannot pick them in §24's person select, because the page offers only current members and names the departed alike. Filed 2026-11-03 from D07 T04 §24's plan review (P3). Needs the auth owner's agreement on which historical identities may be shown, organisation-scoped, and for how long.

**Phase:** 7
**Needs:** third-party
**Surface:** yes
**Fidelity:** `design/SPEC.md` M7 Team, as §23 records it
**Job:** an owner sees everything one departed person did or had done to them
**Treatment:** departed people offered in the history's person select by the name they were known by here
**Chrome:** §23's history

**Build order:**

1. Record with the auth owner which stored identity a departed person keeps here, and its retention. Done when: the section and SPEC M7 name it.
2. Offer departed people in the person select, scoped to this organisation's history. Done when: the rendered test picks a departed person and reads only their changes.

- [ ] Record the departed person's shown identity and its retention in `design/SPEC.md` M7 and here, agreed with the auth owner (D07 T02). Done when: both name it. Cheaper substitute: one "A member who has left" entry for everyone who left.
- [ ] Add departed people, by their scoped stored identity, to the person select in `src/web/pages/team.tsx`, filtered exactly as §24 filters. Done when: `test/web/team-page.test.ts` picks a departed person and reads their changes and no one else's. Cheaper substitute: filtering in the browser only.
- [ ] Commit: `web: choose a departed person in the team history`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if a departed person's changes mix with another's.

## 37. Gateway relay range settings

Coordinator assignment 2026-11-04: member surface for the checks-owned immutable gateway relay lifecycle. Requires D02 T02 §10 storage to be stamped and merged, and coordinator approval of the scoped treatment; the resolving graph edge is added at that merge boundary.

**Phase:** 7
**Needs:** third-party
**Surface:** yes
**Fidelity:** `docs/specs/2026-11-04-gateway-relay-surfaces-design.md` member settings; existing `design/SPEC.md` Domains card chrome, pending scoped treatment approval
**Job:** an administrator proposes, edits, revokes or restores automatic relay configuration and sees the stored result
**Treatment:** verified-domain/gateway/provider selector, CIDR editor, revision/status and separately confirmed lifecycle actions
**Chrome:** existing Domains card and AppShell

**Build order:**

1. Confirm the scoped treatment in `docs/specs/2026-11-04-gateway-relay-surfaces-design.md` and import the checks lifecycle contract. Done when: approval and the resolving prerequisite edge are recorded.
2. Build `src/web/pages/gateway-ranges.tsx` through the checks lifecycle API. Done when: every action reads back its stored revision.
3. Prove refusals and recovery in `test/web/gateway-ranges.test.ts` and browser tests. Done when: foreign claims, stale forms and failed reads cannot mutate trust.

- [ ] Record coordinator surface approval in `docs/specs/2026-11-04-gateway-relay-surfaces-design.md`. Done when: every control and state has an approved treatment without conflicting edits to `design/SPEC.md`. Cheaper substitute: treating assignment as board approval. Source: coordinator delivery decision 2026-11-04.
- [ ] Implement proposal and edit in `src/web/pages/gateway-ranges.tsx` using verified binding selectors and the checks API. Done when: read-back shows the exact pending revision and editing retires old configured trust. Cheaper substitute: direct table writes. Source: gateway relay ranges design.
- [ ] Implement confirmed revoke and restore-automatic actions in `src/web/pages/gateway-ranges.tsx`. Done when: revoked hold and fresh-discovery requirement survive reload. Cheaper substitute: hiding the editor while trust stays active. Source: gateway relay ranges design.
- [ ] Implement validation, permission, conflict, failed-read and retry states in `src/web/pages/gateway-ranges.tsx`. Done when: attempted text survives conflict separately, retry is idempotent and foreign or unverified claims are refused. Cheaper substitute: displaying an empty configuration after read failure. Source: scoped surface contract.
- [ ] Prove the persisted lifecycle in `test/web/gateway-ranges.test.ts`. Done when: each action and refusal reads the actual store and checks no unintended revision or audit entry.
- [ ] Prove keyboard operation, focus return, statuses and layout in `test/node/gateway-ranges-browser.test.tsx`. Done when: both themes at 360 px exercise confirmations and conflict recovery without overflow.
- [ ] Commit: `web: gateway relay range settings`

**Test checkpoint:** `pnpm exec vitest run test/web/gateway-ranges.test.ts test/node/gateway-ranges-browser.test.tsx` passes and fails if stale or foreign configuration changes trust.

## Verification

- A member finds cases, reads stats and exports counts; owners manage team and domains, with permissions enforced on the server.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
