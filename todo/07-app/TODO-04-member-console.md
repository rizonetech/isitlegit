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

## Outcome

- A member finds any case by sender, subject words, verdict or date; sees this week's counts and money at risk caught; owners manage team and domains.

**Adjacency:** list=applicable @ D07 T04 §1; document=not-applicable (each case's document is its report); settings=applicable @ D07 T04 §4; reporting=applicable @ D07 T04 §2; notifications=not-applicable (the console sends nothing); permissions=applicable @ D07 T04 §3; audit=applicable @ D07 T02 §6; exchange=applicable @ D07 T04 §2; reverse=applicable @ D07 T04 §3

**Adjacency rationale:** The cases list is the find path; stats are the reporting with a CSV export of counts; team management carries roles (permission) and removal (reverse); domains and addresses are the organisation's settings; changes are recorded in `auth_events`.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Cases list with filters and search | D07 T03 §1 | [ ] |
| 2 | §2 | Weekly stats, money at risk, CSV export | §1 | [ ] |
| 3 | §3 | Team and invites page | D07 T02 §3, D07 T01 §10 | [ ] |
| 4 | §4 | Domains and sending addresses page | D07 T02 §15 | [ ] |
| 5 | §5 | Registrar-assisted domain verification | §4 | [ ] |
| 6 | §6 | MSP console and own branding | D07 T02 §8 | [ ] |
| 7 | §7 | Subject, sender and search in the Cases list | §1 | [ ] |

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

1. Build `GET /cases` behind `requireSession` (D07 T02 §1). Done when: filters, search and paging work in a rendered test, and an anonymous request is sent to `/signin`.

- [ ] Read one page of the organisation's cases in `src/db/case-list.ts` (`listCases(db, orgId, { verdict, channel, period, page }, now)`): newest first by `created_at` then `id`, 25 a page, scoped by `org_id`, with the matching count and the organisation's total; the period's start in SAST days (7, 30 or 90, or all time). Done when: `test/db/case-list.test.ts` reads each filter, the page edges and another organisation's cases never appearing, and a bad filter value is refused, not ignored.
- [ ] Name who checked each email case: the `forwarded_by` address matched to a member of the organisation (`"user".name`, else the address), in the same read. Done when: the test shows a member's name, a former member's address, and "Not recorded" for an upload.
- [ ] Build `src/web/pages/cases.tsx` (`GET /cases` behind `requireSession` and the active organisation): heading "Cases" and "Everything <organisation> has checked", Check a file (`/upload`, D01 T03 §6), the verdict segmented filter (All, Malicious, Suspicious, Safe), channel (All channels, Email, Upload) and period (Last 7 days, Last 30 days, Last 90 days, All time; Last 30 days by default), the table (Verdict, Case, Type, Checked by, When; every row opens `/r/<id>`), "Showing 1 to 25 of 64" and Previous and Next. Filters and page live in the query string; a bad value answers the default, never a 500. Done when: `test/web/cases-page.test.ts` covers each filter, paging and every row's link.
- [ ] Keep the filters working without JavaScript (a GET form with its own Apply button) and, with htmx (D07 T01 §9), redraw only the results on each change and push the URL, so Back returns to the previous filters. Done when: `test/node/cases-browser.test.tsx` changes a filter, sees the URL and rows change, presses Back and sees the earlier rows.
- [ ] Write "When" as SAST: "Just now" under a minute, the time today, "Yesterday", then "Fri 24 Oct", with the full date and time in the cell's `datetime` and title. Done when: unit cases cover each band and the SAST midnight edge.
- [ ] Show the first-run state (board `Cases-Empty`) when the organisation has no cases: the eyebrow, heading and sentence, the check address with Copy address (D07 T01 §9's copy script), the three how-to tiles, and "Only mail sent from <verified domains>, your verified domain(s), is accepted." with Or upload a file; with no verified domain yet, the line says so and links Domains and addresses (`/settings/domains`, D07 T04 §4). Done when: a new organisation sees it, and a domain-less one sees the domain line.
- [ ] Show the filtered-empty state when filters match nothing: 'No cases match Malicious, last 7 days.', "64 cases in total. Try a wider date range or another verdict." and Clear filters (`/cases`). Done when: the page test reads it.
- [ ] Answer a member with no active organisation, or one just removed, with the E3 403 page (`ErrorState` 403), and a read that fails with the E5 page (503, its reference logged as the report's is). Done when: the page test covers both.
- [ ] Pass the accessibility gate's rules at 360 and 1280 px in both themes, the table a real table with its caption and column headers, the segmented filter a labelled radio group, on a phone the table reflowing to one card per case with no sideways scroll. Done when: the browser test scans each and measures the width.
- [ ] Commit: `web: cases list with filters and search`

> **Deferred:** the row's subject and original sender, the search box that searches them, the uploader's name and the invoice words in Type (boards `Cases`) -> XREF: D07 T04 §7

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if another organisation's case appears.

## 2. Weekly stats, money at risk, CSV export

**Corrected 2026-10-28:** the title read "Weekly stats, money at risk and CSV export"; shortened by a word so the Phase 6 plan table stays within 100 characters once 11-character references (D01 T01 §10, D05 T04 §10) joined it.

This week and last: cases checked, verdict mix, median time to verdict, invoice flags and the money at risk caught (sum of flagged invoice amounts), with a CSV export of the counts (never message content).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, stats panel
**Job:** an owner sees what IsItLegit did for the business this week
**Treatment:** four numbers and one small chart, money in rand
**Chrome:** `AppShell` plus uPlot 1.6.32 chart from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Compute and render the stats. Done when: a fixture week renders the right numbers.

- [ ] Write `weeklyStats(orgId, weekStart)` (counts, verdict mix, median ms, invoice flags, money at risk in cents). Done when: `test/web/stats.test.ts` checks a seeded week.
- [ ] Render the panel with a uPlot daily chart (self-hosted, MIT, in `NOTICE.md`). Done when: the page test finds the numbers and the chart container.
- [ ] Export the counts as CSV (`GET /cases/stats.csv`). Done when: the CSV has a header row and no subject or sender column.
- [ ] Commit: `web: weekly stats, money at risk and CSV export`

**Test checkpoint:** `pnpm exec vitest run test/web/stats.test.ts` passes and fails if the CSV includes subjects.

## 3. Team and invites page

Owners and admins invite by email, change roles and remove members; members see the team (spec 4.8, D07 T02 §3).

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, team section
**Job:** an owner brings the finance clerk in and removes someone who left
**Treatment:** one list, one invite field, removal confirmed
**Chrome:** `AppShell`, `Field`, `Button` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build `GET /team`. Done when: invite, role change, revoke and removal work through the page.

- [ ] Build `src/web/pages/team.tsx` listing members and pending invites with role selectors and remove buttons for owners and admins. Done when: `test/web/team-page.test.ts` covers each action. Cheaper substitute: invites only through a script.
- [ ] Prevent removing the last owner. Done when: the attempt shows an error and changes nothing.
- [ ] Show an invite whose email did not go and offer to send it again: an invite answered 502 (D07 T02 §3) stays in the pending list marked "email not sent", with a "Send again" button that repeats the invite request with `resend: true`. Done when: `test/web/team-page.test.ts` gets a 502 for an invite, finds the pending row marked and the button by name, and the resend answering 200 clears the mark. Cheaper substitute: a toast saying "failed" with the invite gone from the list fails the test. Source: D07 T02 §3 plan review (P2 3).
- [ ] Invite several colleagues at once: add a multi-address invite (one shared role, one submit) to the Team board in `design/SPEC.md` first, then build it as one invite request per address (each through the allowlist and its own send key, D07 T02 §3), listing each address's outcome (sent, not sent, unknown, refused) and retrying only the ones that did not go. Done when: the SPEC section and board show it, and `test/web/team-page.test.ts` invites ten addresses with one submit, one refused by SMTP2GO, finds ten outcomes, and a retry sends only that one. Cheaper substitute: one comma-separated request with a single overall result fails the test. Source: D07 T02 §3 completion review (Part 2 item 2).
- [ ] Show the organisation's team history to its owners: the role changes, revocations and removals D07 T02 §6 records, newest first, filtered by action and date, from its owner-only read; empty and error states drawn; admins and members do not see it. Done when: a rendered test shows the history filtered, its empty state and its error state, and an admin sees no history. Source: D07 T02 §6 plan review.
- [ ] Filter the team history by one person, as the actor or the target, in one step, paging through every match (`GET /api/team/history` gains `actor` and `target`, D07 T02 §6). Done when: a rendered test picks a member and sees every change by and to them across pages. Source: D07 T02 §6 completion review (E2).
- [ ] Commit: `web: team and invites page`

**Test checkpoint:** `pnpm exec vitest run test/web/team-page.test.ts` passes and fails if the last owner can be removed.

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

Each row named as the board names it: the original's subject over its sender, the search box that finds a case by either, the uploader in Checked by and the invoice and payment-document words in Type. Filed 2026-10-30 from D07 T04 §1's start, where the stored fields did not yet exist.

**Phase:** 2
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` M1 Cases (board `Cases`)
**Job:** a member finds a past check by what it was about or who sent it
**Treatment:** the board's two-line cell, subject over sender; search as the board's input, in the query string with the filters
**Chrome:** §1's page

**Build order:**

1. Wait for D01 T01 §16 (the checks lane: the original's subject and sender stored on the case, migration 0038) to reach main and this branch, then add it to this section's Depends with its XREF. Done when: `validate` accepts the edge.
2. Draw the two-line cell and search; draw the uploader and Type words once their rows exist (asked of the checks and invoice lanes through the coordinator). Done when: `test/web/cases-page.test.ts` reads each.

- [ ] Add D01 T01 §16 to this section's Depends once it is on main and merged here. Done when: `validate` accepts the edge.
- [ ] Draw the subject over the sender (name and address; "Uploaded PDF" and the like for a document with neither), and Search by sender or subject over both, case-insensitively, in the query string. Done when: `test/web/cases-page.test.ts` finds a case by a subject word and by a sender address, and another organisation's never.
- [ ] Draw the uploader's name in Checked by for an upload, from the field the checks lane stores. Done when: the page test reads it.
- [ ] Draw the invoice and payment-document words in Type from the invoice checks' stored classification (D06). Done when: the page test reads "Email, invoice".
- [ ] Commit: `web: subject, sender and search in the cases list`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if a search returns another organisation's case.

## Verification

- A member finds cases, reads stats and exports counts; owners manage team and domains, with permissions enforced on the server.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
