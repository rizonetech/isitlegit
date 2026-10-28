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
| 2 | §2 | Weekly stats, money at risk and CSV export | §1 | [ ] |
| 3 | §3 | Team and invites page | D07 T02 §3, D07 T01 §10 | [ ] |
| 4 | §4 | Domains and sending addresses page | D07 T02 §7 | [ ] |

## 1. Cases list with filters and search

Every case of the organisation, newest first, with verdict, channel, sender (display only for members), subject and time; filters by verdict, channel and date; search by sender or subject words; paged 25 at a time.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, cases list
**Job:** a member finds a past check without its link
**Treatment:** a scannable table, verdict first, filters that keep their state in the URL
**Chrome:** `AppShell`, `VerdictBadge`, `EmptyState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

**Build order:**

1. Build `GET /cases` behind `requireSession` (D07 T02 §1). Done when: filters, search and paging work in a rendered test, and an anonymous request is sent to `/sign-in`.

- [ ] Store `subject` and `sender_display` on cases at parse time (members only see their own organisation's). Done when: the parse test stores both.
- [ ] Build `src/web/pages/cases.tsx` with the table, verdict and channel filters, date range, search box and pager, state in query parameters, updated with htmx. Done when: `test/web/cases-page.test.ts` covers each filter and a search. Cheaper substitute: an unfiltered list.
- [ ] Show the empty state with how to forward the first mail. Done when: a new organisation sees it.
- [ ] Commit: `web: cases list with filters and search`

**Test checkpoint:** `pnpm exec vitest run test/web/cases-page.test.ts` passes and fails if another organisation's case appears.

## 2. Weekly stats, money at risk and CSV export

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
- [ ] Add the forwarding-as-attachment help for Outlook (desktop and web) and Gmail, with the reason headers matter. Done when: the help section renders.
- [ ] Commit: `web: domains and sending addresses page`

**Test checkpoint:** `pnpm exec vitest run test/web/domains-settings.test.ts` passes.

## Verification

- A member finds cases, reads stats and exports counts; owners manage team and domains, with permissions enforced on the server.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
