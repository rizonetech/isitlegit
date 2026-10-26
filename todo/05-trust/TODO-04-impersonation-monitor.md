---
schema_version: 1
id: impersonation-monitor
domain: 05-trust
status: active
title: "TODO-04 -- Impersonation Monitor for Fake Websites"
track: day-6
---

# TODO-04 -- Impersonation Monitor for Fake Websites

> **Goal:** Every day the monitor generates lookalike domains for each protected business, checks which resolve, screens new or changed live pages cheaply (Glimmer or Spark, D03 T04 §2), sends flagged pages through the full vision pipeline and, where a form exists, the walkthrough, and alerts the business with a takedown pack (domain, registrar and host from RDAP, screenshots, abuse contacts).

> **Current state:** Measured 2026-10-26 20:00 SAST. The confusables module (D02 T03 §1), vision pipeline (D03) and walkthrough (D04 T02) are planned before this file. Certificate-transparency search is first on the cut list (spec section 8) and is after the event.

## Inputs

- Design spec 4.11 (candidates, daily run, alert, takedown pack, cost guard), 2b (paid Protect feature; trial unlocks it), 8 (cut order).
- -> XREF: D02 T03 §1 -- the confusables and edit-distance module the candidate generator reuses

## Outcome

- For the fictional demo business, a lookalike site hosted by us on a fixture domain is found by the daily run before the fake mail arrives, and the alias receives an alert with the takedown pack.

**Adjacency:** list=applicable @ D05 T04 §5; document=applicable @ D05 T04 §5; settings=not-applicable (candidate caps and schedule are fixed in code from spec 4.11); reporting=applicable @ D07 T04 §2; notifications=applicable @ D05 T04 §5; permissions=applicable @ D05 T04 §2; audit=applicable @ D05 T04 §2; exchange=not-applicable (nothing is imported or exported); reverse=applicable @ D05 T04 §5

**Adjacency rationale:** Findings are listed on the protected business's console with their takedown pack as the carried document; the business can dismiss a finding (reverse); only protected organisations on the trial or Protect plan are monitored (permission); every run is logged.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Lookalike candidate generator | D02 T03 §1, D05 T01 §1 | [ ] |
| 2 | §2 | Daily run with DNS liveness checks | §1 | [ ] |
| 3 | §3 | Screening new or changed live pages | §2, D03 T04 §2 | [ ] |
| 4 | §4 | Full pipeline on flagged pages | §3, D04 T02 §6 | [ ] |
| 5 | §5 | Monitor alerts and takedown pack | §4 | [ ] |
| 6 | §6 | Demo lookalike site found by the monitor | §5 | [ ] |
| 7 | §7 | Certificate-transparency search for brand tokens | §5 | [ ] |

## 1. Lookalike candidate generator

Variants of each verified domain (spec 4.11): confusable characters, single typos (omission, repetition, swap, adjacent key), added words (`-payments`, `-invoice`, `-za`, `online`, `secure`), and other TLDs (`.com`, `.co`, `.africa`, `.net`, `.org`), capped at 300 per business.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Write `candidatesFor(domain)` in `src/monitor/candidates.ts`. Done when: tests list the expected variants for a fixture domain within the cap.

- [ ] Generate confusable variants from the reversed confusables map (one substitution per variant). Done when: `test/monitor/candidates.test.ts` includes the Cyrillic `а` variant for `fynbosfreight`.
- [ ] Generate typo, added-word and TLD variants, deduplicate, and drop the original. Done when: the test counts each class.
- [ ] Rank by likelihood (TLD swaps and added words first) and cap at 300. Done when: the cap holds for a long domain.
- [ ] Commit: `monitor: lookalike candidate generator`

**Test checkpoint:** `pnpm exec vitest run test/monitor/candidates.test.ts` passes.

## 2. Daily run with DNS liveness checks

A daily Cron Trigger (stack doc) resolves each candidate over DNS-over-HTTPS, records which resolve, and fetches only new or changed hosts (by response hash) for screening (spec 4.11 cost guard). Only protected organisations on trial or Protect are monitored.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Add the `scheduled` handler and cron. Done when: a test invocation processes one organisation's candidates.

- [ ] Add migration `0013_monitor.sql` with `monitor_hosts` (`org_id`, `domain`, `resolves`, `content_hash`, `first_seen`, `last_seen`, `status`). Done when: it applies locally.
- [ ] Add `"triggers": { "crons": ["15 4 * * *"] }` (06:15 SAST) and a `scheduled` handler running the monitor as a Workflow per organisation. Done when: `wrangler deploy --dry-run` lists the cron and `test/monitor/cron.test.ts` runs one organisation.
- [ ] Resolve candidates with DoH (`cloudflare-dns.com`, A and AAAA) at most 20 in parallel, and fetch the homepage of new or changed resolving hosts through Browser Run (downloads blocked). Done when: unchanged hosts are not re-fetched in the test.
- [ ] Monitor only organisations whose plan flag allows it (trial or Protect). Done when: a free organisation is skipped.
- [ ] Commit: `monitor: daily run with DNS liveness and change tracking`

**Test checkpoint:** `pnpm exec vitest run test/monitor/cron.test.ts` passes.

## 3. Screening new or changed live pages

Each fetched page's screenshot and visible text go to `screenPage` with the screener `MONITOR_SCREENER` names (D03 T04 §2 ships Spark; D03 T04 §3 switches to Glimmer only if it measures as good); only pages judged as lures go further (spec 4.11).

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Screen pages with `screenPage`. Done when: a stubbed lure page is flagged and a parked-domain page is not.

- [ ] Call the chosen screener for each fetched page with the text in an untrusted block. Done when: `test/monitor/screen.test.ts` covers lure and benign stubs.
- [ ] Mark parked, for-sale and empty pages as `status = parked` without screening (rules on known parking providers and page size). Done when: a parked fixture skips the model.
- [ ] Commit: `monitor: screening of new or changed pages`

**Test checkpoint:** `pnpm exec vitest run test/monitor/screen.test.ts` passes.

## 4. Full pipeline on flagged pages

Flagged pages get the full treatment (spec 4.11): screenshot, SAM logo crop compared with the business's registered logo, Muse Spark reading, and the walkthrough when a login or payment form is present.

**Phase:** 6
**Needs:** meta-api, cloudflare
**Surface:** no

**Build order:**

1. Run the case pipeline on a flagged page as a monitor case. Done when: a flagged fixture page yields logo, reading and walkthrough evidence.

- [ ] Create a case with `channel = "monitor"` for each flagged page and run the vision and walkthrough steps (skipping mail-only checks). Done when: `test/monitor/pipeline.test.ts` passes with stubs.
- [ ] Compare logo crops with the registered logo (not the brand table) for monitor cases. Done when: the fixture's logo match is recorded.
- [ ] Commit: `monitor: full pipeline on flagged pages`

**Test checkpoint:** `pnpm exec vitest run test/monitor/pipeline.test.ts` passes.

## 5. Monitor alerts and takedown pack

The business gets an alert with the evidence and a takedown pack: domain, registrar and hosting provider from RDAP, screenshots, abuse contacts (spec 4.11). We never contact registrars or hosts for them during the event. Findings are listed on the console, where the business can dismiss one.

**Phase:** 6
**Needs:** none
**Surface:** yes
**Fidelity:** `design/SPEC.md` member console, impersonation monitor section
**Job:** a business owner learns a fake site exists and has what they need to get it taken down
**Treatment:** the finding first, the takedown steps second, nothing sent on their behalf
**Chrome:** `AppShell`, `EvidenceCard`, `Button`, `EmptyState` from D07 T01 §3

**Build order:**

1. Build the takedown pack. Done when: a finding has a downloadable pack with RDAP facts and screenshots.
2. Alert and list. Done when: the alias receives the alert and the console lists the finding with dismiss.

- [ ] Write `takedownPack(finding)` building a Markdown and PDF pack (domain, registrar, abuse contact, hosting network and abuse contact from RDAP for the IP, first seen, screenshots, evidence summaries). Done when: `test/monitor/takedown.test.ts` checks every field for a fixture.
- [ ] Send one alert per new finding with `sendMail({ kind: "alert" })` to the identity's alert address. Done when: a second run on the same finding sends nothing.
- [ ] Build the console findings list (`src/web/pages/monitor.tsx`) with status, first seen, pack download and dismiss (with reason). Done when: the page test dismisses a finding and it stays dismissed on the next run. Cheaper substitute: alert mail only.
- [ ] Commit: `monitor: alerts, takedown pack and findings list`

**Test checkpoint:** `pnpm exec vitest run test/monitor/takedown.test.ts test/web/monitor-page.test.ts` passes.

## 6. Demo lookalike site found by the monitor

The demo needs the monitor to find a real live page: a lookalike of the fictional demo business, hosted by us on a fixture domain under `fixtures.isitlegit.co.za`, wired into the demo business's candidate list as an extra seed so the daily run finds it (spec 4.11, plan "Demo fixture").

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Host the lookalike and seed it. Done when: running the monitor for the demo business finds it and sends the alert.

- [ ] Host `fixtures/fynbos-lookalike/` (fictional Fynbos Freight login copy) on the fixtures host with `noindex`. Done when: the page answers.
- [ ] Add `monitor_seeds` for demo businesses only, so the fixture host is checked with the candidates. Done when: the seed table exists and is used only for organisations flagged `demo`.
- [ ] Run the monitor for the demo business and record the alert time in `docs/live-checks.md`. Done when: the entry exists.
- [ ] Commit: `monitor: demo lookalike found by the daily run`

**Test checkpoint:** `pnpm exec tsx scripts/run-monitor.ts --org demo-fynbos --wait 300` exits 0 after a finding for the fixture host is stored.

## 7. Certificate-transparency search for brand tokens

New certificates whose names contain the business's brand tokens reveal lookalikes before they are used (spec 4.11). First on the monitor's cut list (spec section 8), so this runs after the event.

**Phase:** 7
**Needs:** none
**Surface:** no

**Build order:**

1. Query a certificate-transparency search source daily for brand tokens. Done when: new matching names join the candidate list.

- [ ] Choose a CT search source whose terms allow our use (crt.sh or a commercial API), record its terms in `NOTICE.md`, and query it for each brand token. Done when: `test/monitor/ct.test.ts` with a stubbed response adds new names.
- [ ] Commit: `monitor: certificate-transparency search`

**Test checkpoint:** `pnpm exec vitest run test/monitor/ct.test.ts` passes.

## Verification

- The demo lookalike is found by the scheduled run, screened, investigated and alerted with a takedown pack.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
