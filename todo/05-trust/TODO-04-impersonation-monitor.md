---
schema_version: 1
id: impersonation-monitor
domain: 05-trust
status: active
title: "TODO-04 -- Impersonation Monitor for Fake Websites"
track: day-6
---

# TODO-04 -- Impersonation Monitor for Fake Websites

> **Goal:** Every day the monitor generates lookalike domains for each protected business, checks which resolve, screens new or changed live pages cheaply (Loupe, a Muse Glimmer LoRA tuned on Fireworks, with Muse Spark as failover, D03 T04 §1; corrected 2026-10-28 20:45 SAST: Loupe replaces base Glimmer; corrected 2026-10-28, operator decision; corrected 2026-10-27, was Glimmer or Spark), sends flagged pages through the full vision pipeline and, where a form exists, the walkthrough, and alerts the business with a takedown pack (domain, registrar and host from RDAP, screenshots, abuse contacts).

> **Current state:** Measured 2026-10-26 20:00 SAST. The confusables module (D02 T03 §1), vision pipeline (D03) and walkthrough (D04 T02) are planned before this file. Certificate-transparency search is first on the cut list (spec section 8) and is after the event.

## Inputs

- Design spec 4.11 (candidates, daily run, alert, takedown pack, cost guard), 2b (paid Protect feature; trial unlocks it), 8 (cut order).
- -> XREF: D02 T03 §1 -- the confusables and edit-distance module the candidate generator reuses
- -> XREF: D03 T04 §15 -- `wakeGlimmer`, called at the start of the daily run before candidate resolution

## Outcome

- For the fictional demo business, a lookalike site hosted by us on a fixture domain is found by the daily run before the fake mail arrives, and the alias receives an alert with the takedown pack.

**Adjacency:** list=applicable @ D05 T04 §5; document=applicable @ D05 T04 §5; settings=not-applicable (candidate caps and schedule are fixed in code from spec 4.11); reporting=applicable @ D07 T04 §2; notifications=applicable @ D05 T04 §5; permissions=applicable @ D05 T04 §2; audit=applicable @ D05 T04 §2; exchange=not-applicable (nothing is imported or exported); reverse=applicable @ D05 T04 §5

**Adjacency rationale:** Findings are listed on the protected business's console with their takedown pack as the carried document; the business can dismiss a finding (reverse); only protected organisations on the trial or Protect plan are monitored (permission); every run is logged.

## Implementation Order

| Order | Section | Deliverable | Depends On | Status |
| ----- | ------- | ----------- | ---------- | ------ |
| 1 | §1 | Lookalike candidate generator | D02 T03 §1, D05 T01 §1 | [x] |
| 2 | §2 | Daily run with DNS liveness checks | §1, D03 T04 §15 | [ ] |
| 3 | §3 | Screening new or changed live pages | §2, D03 T04 §1 | [ ] |
| 4 | §4 | Full pipeline on flagged pages | §3, §9, D04 T02 §6 | [ ] |
| 5 | §5 | Monitor alerts and takedown pack | §4 | [ ] |
| 6 | §6 | Demo lookalike site found by the monitor | §5 | [ ] |
| 7 | §7 | Certificate-transparency search for brand tokens | §5 | [ ] |
| 8 | §8 | Daily re-screen of live candidates | §3 | [ ] |
| 9 | §9 | Spark second look before walkthrough | §3 | [ ] |
| 10 | §10 | Findings exported to Loupe's training | §5 | [ ] |

## 1. Lookalike candidate generator

Variants of each verified domain (spec 4.11): confusable characters, single typos (omission, repetition, swap, adjacent key), added words (`-payments`, `-invoice`, `-za`, `online`, `secure`), and other TLDs (`.com`, `.co`, `.africa`, `.net`, `.org`), capped at 300 per business.

> **Started:** 2026-10-31T17:53Z

**Corrected 2026-10-31** (at start, checked against the repository): (1) a candidate is kept only when the lookalike check recognises it as imitating the domain (`techniqueOf` in `src/checks/domain-lookalike.ts`, over the same registrable-domain split, built here with `tldts` since the check's own `split` is private), so the monitor never watches a domain the check would not flag; (2) the confusable substitutions come from the vendored UTS #39 table the check uses (`src/checks/confusables-map.json`, its `prototypes` reversed), one per variant, and every candidate is written in its ASCII form (an A-label, `xn--...`) as DNS and RDAP need it; (3) the added words are the check's own `ADDED_WORDS` (`src/checks/lookalike.ts`), joined by `-` or nothing, before or after, which already holds the plan's `payments`, `invoice`, `za`, `online` and `secure`; (4) a typo is an edit the check counts (optimal string alignment distance 1, both labels at least 6 characters), so a short label gets no typo variants; (5) the input is a verified domain reduced to its registrable domain, and each candidate is a registrable domain too.

**Corrected 2026-10-31** (plan review, 3 P2, `docs/reviews/05-trust/D05-T04-s1.md`): (6) the confusable fixture is Latin `o` to Cyrillic `о` in `fynbosfreight` (it holds no `a`), asserted as its exact A-label with `techniqueOf` answering `skeleton`; (7) the cap is the business's: `candidatesForBusiness(domains)` merges the candidates of every verified domain, drops any that is itself one of the business's domains, deduplicates, ranks and caps the whole at 300; (8) each variant class is proven by exact examples: omission, repetition, adjacent swap and adjacent key typos; an added word before and after, with `-` and with nothing; each listed TLD; and by assertions that every candidate is unique, none is the original, a label under 6 characters gets no typo, an input subdomain is reduced to its registrable domain, and when more than 300 compete the TLD swaps and added words fill the list before the confusables and typos. **Corrected 2026-10-31** (completion review, `docs/reviews/05-trust/D05-T04-s1.md`): (9) the TLD swaps add South Africa's `co.za` to spec 4.11's list, and an internationalised domain is varied as its Unicode label, each variant encoded afterwards.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Write `candidatesFor(domain)` in `src/monitor/candidates.ts`. Done when: tests list the expected variants for a fixture domain within the cap.

- [x] Generate confusable variants from the reversed confusables map (one substitution per variant) (**Corrected 2026-10-31**, corrections 1 and 2: in ASCII form, each recognised by `techniqueOf` as `skeleton`). Done when: `test/monitor/candidates.test.ts` includes the Cyrillic `а` variant for `fynbosfreight` (as its A-label), and every candidate `techniqueOf` recognises against the original. Done 2026-10-31: `candidatesFor` in `src/monitor/candidates.ts` (the reversed `confusables-map.json`); test "includes the Cyrillic о variant".
- [x] Generate typo, added-word and TLD variants, deduplicate, and drop the original (**Corrected 2026-10-31**, correction 8). Done when: the test finds an exact example of each typo operation, each added-word placement and separator and each listed TLD, every candidate is unique and recognised, none is the original, a short label has no typo, and a subdomain input yields its registrable domain's candidates. Done 2026-10-31: tests "holds an exact example of each", "is unique, never the original", "gives a label under 6 characters no typo".
- [x] Rank by likelihood (TLD swaps and added words first) and cap at 300, per business through `candidatesForBusiness(domains)` (**Corrected 2026-10-31**, corrections 7 and 8). Done when: the cap holds for a long domain and for a business with several domains, the business's own domains never appear, and with more than 300 competing every TLD swap and added word is kept before any confusable or typo. Done 2026-10-31: `candidatesForBusiness`; tests "caps at 300" and "merges a business's domains".
- [x] Commit: `monitor: lookalike candidate generator`

**Test checkpoint:** `pnpm exec vitest run test/monitor/candidates.test.ts` passes.

> **Verified:** 2026-10-31 | §1 | 0dd9ac320ef2c811371ef4e58a35ec146ea131ac
> **Review:** `docs/reviews/d05-t04-s1.json`

## 2. Daily run with DNS liveness checks

A daily Cron Trigger (stack doc) resolves each candidate over DNS-over-HTTPS, records which resolve, and fetches only new or changed hosts (by response hash) for screening (spec 4.11 cost guard). Only protected organisations on trial or Protect are monitored.

> **Started:** 2026-10-31T21:43Z

**Corrected 2026-10-31** (at start, checked against the repository; Cloudflare reachable, `wrangler whoami` 2026-10-31T21:41Z): (1) migration `0013_monitor.sql` is long taken; the coordinator's number is 0063 (`0063_monitor.sql`, 2026-10-31), and `monitor_hosts` also keeps `dns_hash` (the sorted A and AAAA answers' SHA-256) and is unique on (`org_id`, `domain`); (2) "new or changed" is read from DNS, the only signal before a fetch: a host is fetched when it resolves and is new or its answers changed since the last run, and its homepage hash recorded, so an unchanged host is never fetched again (default; a periodic refetch would cost Browser Run time); (3) the cron joins the three existing ones in `wrangler.jsonc`, and the `scheduled` handler gains its branch (`MONITOR_CRON`), starting one instance of a new Workflow (`MONITOR` binding, `MonitorWorkflow`, `src/monitor/workflow.ts`) per organisation, its id the organisation and the SAST day so a repeated tick the same day starts nothing new; (4) an organisation is monitored when its identity's protection is in effect and its plan has `monitor` (`hasFeature`), and its candidates are `candidatesForBusiness` (§1) over its verified domains; (5) `wakeGlimmer` (`src/vision/glimmer-wake.ts`) is called with the run's id as the burst and the candidate count (capped at §1's 300) as the expected calls, before the first DNS request; screening the fetched pages is §3's; (6) DoH is `https://cloudflare-dns.com/dns-query` with `accept: application/dns-json`, at most 20 requests in flight, and a failed lookup leaves the host as it was, retried the next day.

**Corrected 2026-10-31** (plan review, 3 P1, 4 P2, `docs/reviews/05-trust/D05-T04-s2.md`): (7) correction 2 is narrowed: a resolving host is also fetched when its last successful capture is older than 7 days, the 50 oldest such hosts a run at most, so a parked domain that becomes a lure behind the same DNS is seen within a week (gap 1); (8) `monitor_hosts` keeps the last DNS observation (`dns_hash`, `dns_at`) apart from the last successful capture (`captured_at`, `capture_key`) and the last failure (`capture_failed_at`, `capture_failures`); a failed capture leaves the host eligible the next run, up to 5 consecutive failures, and the browser session is closed in every case (gap 2); (9) a capture is kept for §3 in R2 under `monitor/<org id>/<host>/<captured at>/` (the screenshot and the page text), its key on the host's row, scoped to the organisation; an unchanged eligible host keeps its last capture (gap 3); (10) the run keeps `wakeGlimmer`'s answer on its run row for §3, and its last step calls `settleGlimmer` with what was used (zero when no page was captured or the run stopped), so an unused reservation never eats the next run's allowance (gap 4); (11) the `scheduled` branch dispatches every eligible organisation, one Workflow creation failing is logged and the rest go on, a repeated tick the same SAST day starts nothing new, the next day starts again, and the three existing cron branches behave as before (gap 5); (12) the Workflow checks eligibility again when it starts (protection in effect, `monitor` in the plan), so an organisation revoked after dispatch makes no wake, DNS or browser request (gap 6); (13) every run writes one row in `monitor_runs` (same migration): organisation, SAST day, outcome `completed`, `partial`, `skipped` or `failed`, counts (resolved, not resolving, lookup failed, captured, capture failed) and error classes; a DoH answer of NXDOMAIN or no address is "not resolving", while a failed or timed-out lookup of either family is "lookup failed" and leaves the host's last observation untouched (gap 7).

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Add the `scheduled` handler and cron. Done when: a test invocation processes one organisation's candidates.

- [x] Add migration `0063_monitor.sql` (**Corrected 2026-10-31:** was `0013_monitor.sql`) with `monitor_hosts` (`org_id`, `domain`, `resolves`, `dns_hash`, `dns_at`, `content_hash`, `captured_at`, `capture_key`, `capture_failed_at`, `capture_failures`, `first_seen`, `last_seen`, `status`; unique on `org_id`, `domain`) and `monitor_runs` (corrections 8 and 13). Done when: a migration test applies it and the columns read back.
- [x] Add `"triggers": { "crons": ["15 4 * * *"] }` (06:15 SAST) and a `scheduled` handler running the monitor as a Workflow per organisation. Done when: `wrangler deploy --dry-run` lists the `MONITOR` Workflow, `wrangler.jsonc` lists the cron (**Corrected 2026-11-01:** was "the dry run lists the cron"; Wrangler 4's dry run prints no schedules, the existing three included, so the cron is read from the config and dispatched by `test/monitor/cron.test.ts`), and `test/monitor/cron.test.ts` runs one organisation.
- [x] Resolve candidates with DoH (`cloudflare-dns.com`, A and AAAA) at most 20 in parallel, and fetch the homepage of new or changed resolving hosts through Browser Run (downloads blocked). Done when: unchanged hosts are not re-fetched in the test.
- [x] Monitor only organisations whose plan flag allows it (trial or Protect). Done when: a free organisation is skipped.
- [x] Call `wakeGlimmer` (D03 T04 §15) at the start of the run's Workflow, before candidate resolution, so the screener's warm-up overlaps the DNS checks, and screen no page on Glimmer until it answers (added 2026-10-28, operator decision on the tuned Glimmer deployment). Done when: `test/monitor/cron.test.ts` shows the wake request before the first DNS lookup.
- [x] Run the daily monitor only for organisations with `monitor` (`hasFeature`, D07 T02 §8). Done when: a lapsed organisation's run makes no DNS or browser request, an entitled one's runs, and removing the check fails the test. Source: D07 T02 §8 plan review.
- [x] Capture new, DNS-changed, week-old and previously failed resolving hosts into R2 for §3, retry a failed capture the next run, and settle Glimmer's reservation at the run's end (corrections 7 to 10). Done when: `test/monitor/cron.test.ts` shows a host whose page becomes a lure behind identical DNS captured again after 7 days, a failed first capture followed by a successful one after a Workflow restart, readable capture artefacts under the organisation's prefix, an unchanged host reusing its capture, and `settleGlimmer` called with zero when nothing was captured.
- [x] Dispatch, recheck eligibility and log every run (corrections 11 to 13). Done when: `test/monitor/cron.test.ts` drives the scheduled branch for three organisations (one creation failing, the others run), a repeated tick the same day and the next day, the three existing crons unchanged, an organisation with protection switched off or its last verified domain removed making no wake, DNS or browser request, and each run's `monitor_runs` row with its outcome and counts, a lookup failure kept apart from not resolving.
- [x] Commit: `monitor: daily run with DNS liveness and change tracking`

**Test checkpoint:** `pnpm exec vitest run test/monitor/cron.test.ts` passes.

## 3. Screening new or changed live pages

Each fetched page's screenshot and visible text go to `screenPage` with the screener `MONITOR_SCREENER` names (D03 T04 §1: Loupe on Fireworks, Muse Spark when it is warming, out of minutes or failing; corrected 2026-10-28 20:45 SAST: Loupe replaces base Glimmer; corrected 2026-10-28, operator decision; corrected 2026-10-27: was D03 T04 §2 with a later switch to Glimmer, removed); only pages judged as lures go further (spec 4.11).

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
**Chrome:** `AppShell`, `EvidenceCard`, `Button`, `EmptyState` from D07 T01 §3 and §6 to §8, proven together in D07 T01 §10

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


## 8. Daily re-screen of live candidates

§3 screens a page when it is new or has changed, so a parked domain whose page stays byte-identical for days and then flips is caught only when its bytes change. Every candidate that still resolves is screened again each day, so a lookalike that turns into a lure is flagged the day it flips (operator decision 2026-10-28 22:42 SAST; spec 4.11). Loupe makes the daily volume cheap; the day's screening stays inside Loupe's 30 minutes and the Fireworks caps (D03 T04 §14), and pages past them go to Spark under the Meta caps.

**Phase:** 6
**Needs:** none
**Surface:** no

**Build order:**

1. Re-screen every live candidate daily. Done when: an unchanged live page is screened again on the next day's run, and a page that flipped to a lure is flagged that day.

- [ ] In the daily run (`src/monitor/run.ts`, §2), queue every candidate whose DNS still resolves for screening, not only new or changed pages, keeping §3's parked-page rule. Done when: `test/monitor/rescreen.test.ts` shows an unchanged live page screened on day two, and a parked page skipped. Cheaper substitute: screening only changed pages.
- [ ] Order the queue so new and changed pages go first, then unchanged ones by how long since their last screening, so a day cut short by Loupe's minutes or the caps screens the likeliest flips first. Done when: the test's capped day screens the new page and the longest-unscreened page before the others.
- [ ] Record each screening's day, screener (Loupe or Spark) and verdict on the candidate, so a flip shows when it happened. Done when: the test reads day one's benign and day two's lure verdicts for the flipped fixture.
- [ ] Commit: `monitor: re-screen every live candidate daily`

**Test checkpoint:** `pnpm exec vitest run test/monitor/rescreen.test.ts` passes, and fails if an unchanged live page is skipped or a parked one is screened.

## 9. Spark second look before walkthrough

A page Loupe flags goes to the full pipeline (§4), whose Muse Wonder walkthrough is the costliest step. A Muse Spark second look on the flagged page's screenshot and text, a few cents, confirms the flag before the walkthrough runs, so a false flag costs a Spark call instead of a walkthrough (operator decision 2026-10-28 22:42 SAST; spec 4.11). A page Spark already screened (Loupe was warming or out of minutes) needs no second look.

**Phase:** 6
**Needs:** meta-api
**Surface:** no

**Build order:**

1. Confirm a Loupe flag with Spark before §4 runs. Done when: a page Spark does not confirm stops before the walkthrough, and a confirmed one goes on.

- [ ] Write `secondLook(page, ctx)` in `src/monitor/second-look.ts` asking `muse-spark-1.3` through `metaResponses` (D03 T01 §1) the same `PageScreen` question (`src/vision/page-screen.ts`) on the flagged page's screenshot and text in an untrusted block. Done when: `test/monitor/second-look.test.ts` confirms a lure fixture and declines a benign one with a stubbed transport. Cheaper substitute: walking every flagged page.
- [ ] Call it in the daily run between §3 and §4 for pages Loupe flagged, skipping pages Spark screened, and record both verdicts on the candidate. Done when: the test shows a declined flag never reaching §4 and a Spark-screened page not asked twice.
- [ ] Keep a declined flag as a training example for Loupe (a likely false positive), named in §10's export. Done when: the declined candidate carries `second_look = declined` in the store §10 reads.
- [ ] Commit: `monitor: Spark second look before the walkthrough`

**Test checkpoint:** `pnpm exec vitest run test/monitor/second-look.test.ts` passes, and fails if a declined flag reaches the walkthrough.

## 10. Findings exported to Loupe's training

Loupe gets better on real South African lures only if what the monitor learns flows back into its training set (operator decision 2026-10-28 22:42 SAST: Loupe's learning is "extremely important"). Each labelled outcome becomes a training page: a lure the full pipeline confirmed, a flag Spark declined (§9), and a finding the business dismissed as not a fake (§5). Production deletes stored artefacts after 30 days (spec 4.8), and this machine may be off for days, so a labelled finding's public page is copied in production the moment it is labelled, into R2 under `training/`, and a local export copies it into Loupe's training store (operator question 2026-10-28 22:51 SAST: how production data reaches the store). **Operator decision (2026-10-28 22:56 SAST):** no retention is set on `training/`: no lifecycle rule and no deletion, so the R2 copies stay as the durable record of every monitor-labelled page, and the local store can be rebuilt from them. The store lives outside every repository at `~/isitlegit-data/glimmer` (`GLIMMER_DATA_DIR` moves it; `storeDir()` in `scripts/glimmer/store.ts`), with origin `monitor`, so the glimmer lane's retraining (D03 T04, its own section) takes them into Loupe's next version.

**Phase:** 6
**Needs:** cloudflare
**Surface:** no

**Build order:**

1. Copy each labelled finding's public page into R2 `training/` in production when it is labelled. Done when: a labelled finding's copy survives the 30-day deletion of its case artefacts.
2. Copy `training/` into the training store from this machine. Done when: a run adds each new copy to the store once, leaves R2 unchanged, and a second run adds nothing.

- [ ] Write `copyForTraining(finding, label, env)` in `src/monitor/training.ts`, called where a finding gets its label (the full pipeline's confirmation in §4, a declined second look in §9, a dismissal in §5), writing the fetched page's screenshot and visible text with a `meta.json` (finding id, host, URL, fetch time, label `lure` or `benign`, why) to R2 `training/<finding id>/`, once per finding. Done when: `test/monitor/training.test.ts` sees one copy per labelled finding, none for an unlabelled one, and the copy kept after the case's artefacts are deleted; no lifecycle rule covers `training/` (`wrangler r2 bucket lifecycle list` names none for it). Cheaper substitute: exporting from the case's own artefacts, which are deleted after 30 days.
- [ ] Disclose the copy: the privacy page (D07 T06) states that public lookalike pages the monitor finds are kept to train Loupe, with no fixed expiry, and that a business can ask for its findings' pages to be removed. Done when: D07 T06's processors paragraph names it, with a dated note there.
- [ ] Write `scripts/monitor-export.ts` listing R2 `training/` (through the Cloudflare API with the vault's R2 credentials, never printed), storing each copy with `putPage` (`scripts/glimmer/store.ts`) as origin `monitor` with its host, label and finding id, and never deleting or changing anything in R2 (no retention is set, operator 2026-10-28). Done when: `test/node/monitor-export.test.ts` stores a confirmed lure, a declined flag and a dismissed finding from a stubbed bucket with the right labels, and sends the bucket no delete or write. Cheaper substitute: copying screenshots by hand.
- [ ] Run the export daily from this machine (a user systemd timer, `infra/systemd/monitor-export.timer`) and at the start of every Loupe retraining run (the glimmer lane's runbook, `docs/glimmer/retraining.md`). Done when: `systemctl --user list-timers` shows it, and the runbook's first step names the export.
- [ ] Keep the export resumable and exact: the last exported finding is recorded in the store, an interrupted run resumes after it, and a finding already stored is never stored twice. Done when: the test's interrupted run, rerun, leaves each finding stored once.
- [ ] Export only the public page the daily run fetched (its screenshot and visible text, with the URL and fetch time), never a walkthrough capture taken after a form was filled or anything from a member's own account, and record in the store's manifest why each left-out item was skipped. Done when: the test exports the fetched page of a walked-through fixture, not its post-form captures, and the manifest names what was left out.
- [ ] Commit: `monitor: findings exported for Loupe's training`

**Test checkpoint:** `pnpm exec vitest run test/monitor/training.test.ts test/node/monitor-export.test.ts` passes, and fails if a finding is stored twice, mislabelled, or exported with a post-form capture.

## Verification

- The demo lookalike is found by the scheduled run, screened, investigated and alerted with a takedown pack.
- `pnpm test` passes; `python3 scripts/todo-graph.py validate` and `plan --check` pass.
